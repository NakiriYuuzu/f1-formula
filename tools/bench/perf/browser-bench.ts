// Drives the browser benchmark (?bench=1, src/app/bench) through cua-driver and collects the rows.
//   gpu  <url> <out.tsv>   run the URL in a driver-owned isolated Chrome (the machine's real GPU); needs `prepare` first
//   soft <url> <out.tsv>   run the URL in a fresh Chrome instance rendered by SwiftShader (--use-angle=swiftshader)
//   prepare                launch the isolated Chrome and store its ids in /tmp/f1bench-state.json
//   close                  end the session (closes the isolated Chrome)
// Nothing here touches the user's own browser or profile: both instances use a throwaway --user-data-dir.
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const SESSION = 'f1bench';
const STATE = '/tmp/f1bench-state.json';
const SOFT_PROFILE = '/tmp/f1-swift-profile';

function cua(tool: string, args: Record<string, unknown>): any {
  const r = Bun.spawnSync(['cua-driver', tool, JSON.stringify(args)], { stdout: 'pipe', stderr: 'pipe' });
  const text = r.stdout.toString();
  try {
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    throw new Error(`cua-driver ${tool} failed: ${text.slice(0, 200)} ${r.stderr.toString().slice(0, 200)}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function prepare(): void {
  const prep = cua('browser_prepare', { session: SESSION, allow_launch: true, profile: { mode: 'isolated_new' } });
  const pid = prep.prepared_pid as number;
  const win = cua('list_windows', { pid }).windows[0];
  const bound = cua('get_browser_state', { pid, window_id: win.window_id, session: SESSION });
  writeFileSync(STATE, JSON.stringify({ pid, window_id: win.window_id, target_id: bound.target_id, tab_id: bound.tabs[0].tab_id }));
  console.log('prepared', readFileSync(STATE, 'utf8'));
}

/** The panel's raw rows (tab-separated in the page, flattened to spaces by the accessibility tree). */
function rowsFromOutline(outline: string): string[][] | null {
  const m = /statictext "(run variant quality[^"]*)"/.exec(outline);
  if (!m) return null;
  const tokens = (m[1] ?? '').trim().split(/\s+/);
  const width = tokens.indexOf('errors') + 1;
  const header = tokens.slice(0, width);
  const rows: string[][] = [header];
  const body = tokens.slice(width);
  for (let i = 0; i + width <= body.length; i += width) rows.push(body.slice(i, i + width));
  return rows;
}

async function gpu(url: string, out: string): Promise<void> {
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  cua('browser_navigate', { target_id: s.target_id, tab_id: s.tab_id, session: SESSION, url });
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(4000);
    const snap = cua('get_browser_state', { target_id: s.target_id, tab_id: s.tab_id, session: SESSION, snapshot_format: 'semantic_v2' });
    const outline: string = snap.outline ?? '';
    if (outline.includes('測試中斷')) throw new Error('bench aborted: ' + /測試中斷[^"]*/.exec(outline)?.[0]);
    if (/statictext "完成：/.test(outline)) {
      const rows = rowsFromOutline(outline);
      if (!rows) throw new Error('no rows in the panel');
      writeFileSync(out, rows.map((r) => r.join('\t')).join('\n') + '\n');
      console.log(`${out}: ${rows.length - 1} rows`);
      return;
    }
  }
  throw new Error('timeout waiting for the benchmark');
}

/** Quit a Chrome instance the driver cannot kill (it was started through LaunchServices) with its own menu item. */
function quit(pid: number, windowId: number): void {
  const ws = cua('get_window_state', { pid, window_id: windowId, session: SESSION, include_screenshot: false, query: 'terminate' });
  const m = /AXMenuBarItem "([^"]+)"[^\n]*\n\s+- \[\d+\] AXMenu[^\n]*\n\s+- \[\d+\] AXMenuItem "([^"]+)" \[id=terminate:/.exec(String(ws.tree_markdown ?? ''));
  if (m) cua('invoke_menu', { pid, window_id: windowId, path: [m[1], m[2]], session: SESSION });
  else console.error(`could not find the quit item of pid ${pid}; close it by hand`);
}

async function soft(url: string, out: string): Promise<void> {
  if (existsSync(SOFT_PROFILE)) rmSync(SOFT_PROFILE, { recursive: true, force: true });
  const launched = cua('launch_app', {
    bundle_id: 'com.google.Chrome',
    creates_new_application_instance: true,
    additional_arguments: [`--user-data-dir=${SOFT_PROFILE}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1300,900', url],
  });
  const pid = launched.pid as number;
  const windowId = launched.windows[0].window_id as number;
  try {
    const deadline = Date.now() + 40 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const title: string = cua('list_windows', { pid }).windows?.[0]?.title ?? '';
      if (!title.startsWith('NB DONE')) continue;
      for (let tries = 0; tries < 6; tries++) {
        const ws = cua('get_window_state', { pid, window_id: windowId, session: SESSION, include_screenshot: false, query: 'variant' });
        const m = /= "(run\tvariant[\s\S]*?)"\n/.exec(String(ws.tree_markdown ?? ''));
        if (m) {
          writeFileSync(out, `${m[1]}\n`);
          console.log(`${out}: ${(m[1] ?? '').split('\n').length - 1} rows`);
          return;
        }
        await sleep(2000);
      }
      throw new Error('finished, but the rows were not readable from the page');
    }
    throw new Error('timeout waiting for the software-rendered benchmark');
  } finally {
    quit(pid, windowId);
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'prepare') prepare();
else if (cmd === 'gpu' && a && b) await gpu(a, b);
else if (cmd === 'soft' && a && b) await soft(a, b);
else if (cmd === 'close') console.log(JSON.stringify(cua('end_session', { session: SESSION })));
else console.log('usage: browser-bench.ts prepare | gpu <url> <out.tsv> | soft <url> <out.tsv> | close');
