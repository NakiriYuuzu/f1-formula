// Drives the browser benchmark (?bench=1, src/app/bench) through cua-driver and collects the rows.
//   gpu  <url> <out.tsv>   run the URL in a driver-owned isolated Chrome (the machine's real GPU); needs `prepare` first
//   soft <url> <out.tsv>   run the URL in a fresh Chrome instance rendered by SwiftShader (--use-angle=swiftshader)
//   shot <url> <out.png>   a ?bench=1&hold=1 URL: wait for the frozen frame and save the viewport as a PNG
//   prepare                launch the isolated Chrome and store its ids in /tmp/f1bench-state.json
//   close                  end the session (closes the isolated Chrome)
// Nothing here touches the user's own browser or profile: both instances use a throwaway --user-data-dir.
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const SESSION = 'f1bench';
const STATE = '/tmp/f1bench-state.json';
const SOFT_PROFILE = '/tmp/f1-swift-profile';
/** Column names of the panel's raw rows (benchPanel.ts COLUMNS), tab-separated. */
const HEADER = [
  'run', 'variant', 'quality', 'dpr', 'pixelRatio', 'scenario', 'frames', 'medianMs', 'p95Ms', 'p99Ms', 'meanMs', 'cpuMedianMs', 'gpuWaitMedianMs',
  'drawCalls', 'triangles', 'programs', 'canvasPixels', 'canvasSamples', 'sceneSamples', 'fullscreenPasses', 'postFillMpx', 'shadowRenders', 'lights', 'shadowLights', 'ibl', 'phaseEnd', 'errors',
].join('\t');

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

/** The panel's raw rows: one text node per row, tab-separated in the page and flattened to spaces by the outline. */
function rowsFromOutline(outline: string): string[][] {
  const rows: string[][] = [];
  for (const m of outline.matchAll(/statictext "((?:run variant|\d+ (?:base|tuned) )[^"]*)"/g)) rows.push((m[1] ?? '').trim().split(/\s+/));
  return rows;
}

async function gpu(url: string, out: string): Promise<void> {
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  cua('browser_navigate', { target_id: s.target_id, tab_id: s.tab_id, session: SESSION, url: 'about:blank' });
  cua('browser_navigate', { target_id: s.target_id, tab_id: s.tab_id, session: SESSION, url });
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(4000);
    const snap = cua('get_browser_state', { target_id: s.target_id, tab_id: s.tab_id, session: SESSION, snapshot_format: 'semantic_v2' });
    const outline: string = snap.outline ?? '';
    if (outline.includes('測試中斷')) throw new Error('bench aborted: ' + /測試中斷[^"]*/.exec(outline)?.[0]);
    const done = /statictext "完成：(\d+) 筆/.exec(outline);
    if (done) {
      const rows = rowsFromOutline(outline);
      if (rows.length - 1 !== Number(done[1])) continue;
      writeFileSync(out, rows.map((r) => r.join('\t')).join('\n') + '\n');
      console.log(`${out}: ${rows.length - 1} rows`);
      return;
    }
  }
  throw new Error('timeout waiting for the benchmark');
}

async function shot(url: string, out: string): Promise<void> {
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  cua('browser_navigate', { target_id: s.target_id, tab_id: s.tab_id, session: SESSION, url: 'about:blank' });
  cua('browser_navigate', { target_id: s.target_id, tab_id: s.tab_id, session: SESSION, url });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const snap = cua('get_browser_state', { target_id: s.target_id, tab_id: s.tab_id, session: SESSION, snapshot_format: 'semantic_v2', include_screenshot: true });
    if (/statictext "hold"/.test(String(snap.outline ?? '')) && snap.screenshot_png_b64) {
      writeFileSync(out, Buffer.from(snap.screenshot_png_b64 as string, 'base64'));
      console.log(`${out}: ${snap.screenshot_width}x${snap.screenshot_height}`);
      return;
    }
  }
  throw new Error('timeout waiting for the held frame');
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
        const ws = cua('get_window_state', { pid, window_id: windowId, session: SESSION, include_screenshot: false, query: 'base' });
        const lines = [...String(ws.tree_markdown ?? '').matchAll(/AXStaticText = "(\d+\t(?:base|tuned)\t[^"]*)"/g)].map((m) => m[1] ?? '');
        if (lines.length > 0) {
          writeFileSync(out, `${HEADER}\n${lines.join('\n')}\n`);
          console.log(`${out}: ${lines.length} rows`);
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
else if (cmd === 'shot' && a && b) await shot(a, b);
else if (cmd === 'close') console.log(JSON.stringify(cua('end_session', { session: SESSION })));
else console.log('usage: browser-bench.ts prepare | gpu <url> <out.tsv> | soft <url> <out.tsv> | shot <url> <out.png> | close');
