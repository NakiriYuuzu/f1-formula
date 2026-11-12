/**
 * Where a follower closes on the car in front and where it loses ground: closing speed (m/s, + = gaining) by 100 m stretch for cars
 * within 1 s of the car ahead, for followers faster than it by > 0.3 % (tyre-aware) or not. Needs races from probe.ts with seg
 * (and a diag tree for the share of time the follow limit binds).
 *   bun run tools/bench/ai/segments.ts <outDir> <file-prefix> [layout]
 */
import { readdirSync } from 'node:fs';
const [OUT = '', prefix = '', layout = ''] = process.argv.slice(2);
const files = readdirSync(OUT).filter((f) => f.startsWith(prefix + '_') && f.includes(layout) && f.endsWith('.json')).sort();
let acc: Record<string, { t: number[]; close: number[]; lim: number[] }> | null = null;
let corners: number[][] = [];
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  if (!o.seg) continue;
  corners = o.corners;
  if (!acc) acc = JSON.parse(JSON.stringify(o.seg));
  else for (const k of Object.keys(acc)) for (const f of ['t', 'close', 'lim'] as const) o.seg[k][f].forEach((v: number, i: number) => (acc![k][f][i] += v));
}
if (!acc) throw new Error('no seg data');
const inCorner = (a: number, b: number): string => {
  const c = corners.filter(([s, , e]) => (s <= b && e >= a) || (s > e && (s <= b || e >= a)));
  return c.length ? 'C' : '.';
};
const n = acc.fast.t.length;
console.log('stretch  corner | fast: time(s)  closing m/s  limit% | even: time(s)  closing m/s');
let totF = 0, totE = 0, clF = 0, clE = 0;
for (let i = 0; i < n; i++) {
  const f = acc.fast, e = acc.even;
  totF += f.t[i]; totE += e.t[i]; clF += f.close[i]; clE += e.close[i];
  console.log(`${String(i * 100).padStart(5)}   ${inCorner(i * 100, i * 100 + 100)}       | ${f.t[i].toFixed(0).padStart(6)} ${(f.close[i] / Math.max(0.01, f.t[i])).toFixed(2).padStart(8)} ${((f.lim[i] / Math.max(0.01, f.t[i])) * 100).toFixed(0).padStart(7)} | ${e.t[i].toFixed(0).padStart(6)} ${(e.close[i] / Math.max(0.01, e.t[i])).toFixed(2).padStart(8)}`);
}
console.log(`mean closing: fast ${(clF / totF).toFixed(3)} m/s over ${totF.toFixed(0)} s | even ${(clE / totE).toFixed(3)} m/s over ${totE.toFixed(0)} s`);
