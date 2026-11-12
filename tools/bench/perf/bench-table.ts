// Aggregates benchmark runs: the tab-separated raw rows of the panel, or the JSON its copy button puts on the clipboard.
//   bench-table.ts A=a1.tsv,a2.json            one table: median of the per-run medians, spread, counters
//   bench-table.ts A=a1.tsv,a2.json B=b1.tsv   the same plus B and the change B vs A per cell
// One file per page load. Save the clipboard of the copy button as a .json file, or the raw rows as a .tsv file.
import { readFileSync } from 'node:fs';

interface Cell {
  med: number[];
  p95: number[];
  p99: number[];
  cpu: number[];
  wait: number[];
  first: Record<string, string>;
}

const med = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  return s.length % 2 ? (s[(s.length - 1) / 2] as number) : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2;
};
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '-');

function cellOf(cells: Map<string, Cell>, key: string, first: Record<string, string>): Cell {
  let c = cells.get(key);
  if (!c) {
    c = { med: [], p95: [], p99: [], cpu: [], wait: [], first };
    cells.set(key, c);
  }
  return c;
}

/** Rows of a copied `window.__benchResult`, keyed like the raw-row header of the panel. */
function rowsOfJson(file: string): Record<string, string>[] {
  const result = JSON.parse(readFileSync(file, 'utf8')) as { rows: Record<string, any>[] };
  return result.rows.map((r) => ({
    run: String(r.run), variant: r.variant, quality: r.quality, dpr: r.dpr ?? 'device', pixelRatio: String(r.pixelRatio), scenario: r.scenario, frames: String(r.frames),
    medianMs: String(r.frameMs.median), p95Ms: String(r.frameMs.p95), p99Ms: String(r.frameMs.p99), meanMs: String(r.frameMs.mean),
    cpuMedianMs: String(r.cpuMs.median), gpuWaitMedianMs: String(r.gpuWaitMs.median),
    drawCalls: String(r.counters.drawCalls), triangles: String(r.counters.triangles), programs: String(r.counters.programs), canvasPixels: String(r.counters.canvasPixels),
    canvasSamples: String(r.counters.canvasSamples), sceneSamples: String(r.counters.sceneSamples), fullscreenPasses: String(r.counters.fullscreenPasses),
    postFillMpx: String(r.counters.postFillMpx), shadowRenders: String(r.counters.shadowRenders), lights: String(r.counters.lights), shadowLights: String(r.counters.shadowLights),
    ibl: r.counters.ibl ? '1' : '0', phaseEnd: r.phaseEnd, errors: String(r.errors),
  }));
}

function rowsOfTsv(file: string): Record<string, string>[] {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const head = (lines[0] ?? '').split('\t');
  return lines.slice(1).map((line) => {
    const v = line.split('\t');
    const r: Record<string, string> = {};
    head.forEach((h, i) => (r[h] = v[i] ?? ''));
    return r;
  });
}

function loadRuns(files: string[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const file of files) {
    for (const r of file.endsWith('.json') ? rowsOfJson(file) : rowsOfTsv(file)) {
      if (r.errors !== '0') console.error(`warning: ${file} ${r.quality} ${r.scenario} had ${r.errors} errors`);
      const c = cellOf(cells, `${r.variant === 'tuned' ? `${r.quality}*` : r.quality}\t${r.scenario}\t${r.dpr}`, r);
      c.med.push(Number(r.medianMs));
      c.p95.push(Number(r.p95Ms));
      c.p99.push(Number(r.p99Ms));
      c.cpu.push(Number(r.cpuMedianMs));
      c.wait.push(Number(r.gpuWaitMedianMs));
    }
  }
  return cells;
}

const args = process.argv.slice(2);
const sets = args
  .filter((a) => a.includes('='))
  .map((a) => ({ name: a.split('=')[0] ?? '', cells: loadRuns((a.split('=')[1] ?? '').split(',')) }));
const order = ['low', 'medium', 'high', 'ultra'];
const keys = [...new Set(sets.flatMap((s) => [...s.cells.keys()]))].sort((a, b) => {
  const [qa = '', sa = '', da = ''] = a.split('\t');
  const [qb = '', sb = '', db = ''] = b.split('\t');
  return order.indexOf(qa.replace('*', '')) - order.indexOf(qb.replace('*', '')) || qa.localeCompare(qb) || sa.localeCompare(sb) || da.localeCompare(db);
});
const A = sets[0];
const B = sets[1];
const head = ['quality', 'scenario', 'dpr', `${A?.name} med`, '[min-max]', 'p95', 'p99', 'cpu', 'gpuWait', 'calls', 'trisK', 'Mpx', 'smp', 'pass', 'postMpx', 'shR', 'lights', 'ibl', 'n'];
if (B) head.push(`${B.name} med`, '[min-max]', 'p95', 'change%');
console.log(head.join('\t'));
for (const key of keys) {
  const a = A?.cells.get(key);
  const row = key.split('\t');
  if (a) {
    const o = a.first;
    row.push(
      f(med(a.med)),
      `${f(Math.min(...a.med))}-${f(Math.max(...a.med))}`,
      f(med(a.p95)),
      f(med(a.p99)),
      f(med(a.cpu)),
      f(med(a.wait)),
      o.drawCalls ?? '-',
      o.triangles ? String(Math.round(Number(o.triangles) / 1000)) : '-',
      o.canvasPixels ? f(Number(o.canvasPixels) / 1e6) : '-',
      `${o.canvasSamples ?? '-'}/${o.sceneSamples ?? '-'}`,
      o.fullscreenPasses ?? '-',
      o.postFillMpx ?? '-',
      o.shadowRenders ?? '-',
      o.lights ?? '-',
      o.ibl ?? '-',
      String(a.med.length),
    );
  } else row.push(...Array<string>(16).fill('-'));
  if (B) {
    const b = B.cells.get(key);
    if (b && a) row.push(f(med(b.med)), `${f(Math.min(...b.med))}-${f(Math.max(...b.med))}`, f(med(b.p95)), ((med(b.med) / med(a.med) - 1) * 100).toFixed(1));
    else row.push('-', '-', '-', '-');
  }
  console.log(row.join('\t'));
}
