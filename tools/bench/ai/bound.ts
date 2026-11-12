/**
 * Zero-friction bound on the back-five mean finishing position: each car keeps its end-of-lap-1 time and then runs the remaining laps
 * alone at its own pace (paceStatic x the field's median clean-air ratio), nobody holds anybody up. Races need crossT (probe.ts).
 *   bun run tools/bench/ai/bound.ts <outDir> <file-prefix>...
 */
import { readdirSync } from 'node:fs';
const [OUT = '', ...prefixes] = process.argv.slice(2);
const files = readdirSync(OUT).filter((f) => prefixes.some((p) => f.startsWith(p + '_')) && f.endsWith('.json')).sort();
const median = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const groups = new Map<string, number[][]>();
const traj = new Map<string, { bound: number[][]; actual: number[][] }>();
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  if (!o.crossT || !o.backFive?.length || o.seat) continue;
  const clean = o.lapRecs.filter((r: any) => r.near < 0.02 && r.meanAhead > 3).map((r: any) => r.time / r.pace);
  const kappa = median(clean);
  const t = o.drivers.map((_: string, i: number) => o.crossT[i][0] + (o.laps - 1) * kappa * o.paceStatic[i]);
  const order = [...t.keys()].sort((a, b) => t[a] - t[b]);
  const ids = o.backFive.map((d: string) => o.drivers.indexOf(d));
  const pos = ids.map((id: number) => order.indexOf(id) + 1);
  const key = `${o.layoutId} d${o.difficulty} ${file.split('_')[0]}`;
  const tr = traj.get(key) ?? { bound: [], actual: [] };
  traj.set(key, tr);
  const bRow: number[] = [], aRow: number[] = [];
  for (let L = 1; L <= o.laps; L++) {
    const tL = o.drivers.map((_: string, i: number) => o.crossT[i][0] + (L - 1) * kappa * o.paceStatic[i]);
    const ord = [...tL.keys()].sort((a, b) => tL[a] - tL[b]);
    bRow.push(mean(ids.map((id: number) => ord.indexOf(id) + 1)));
    const snap = L === o.laps ? o.final : o.snaps.find((s: any) => s.leaderLaps === L)?.order;
    aRow.push(snap ? mean(ids.map((id: number) => snap.indexOf(id) + 1)) : NaN);
  }
  tr.bound.push(bRow);
  tr.actual.push(aRow);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push([mean(pos), mean(ids.map((id: number) => o.final.indexOf(id) + 1)), mean(ids.map((id: number) => o.crossT[id].length ? [...o.snaps.find((s: any) => s.leaderLaps === 1)?.order ?? o.final].indexOf(id) + 1 : 0))]);
}
for (const [key, rows] of groups) console.log(`${key.padEnd(28)} n=${rows.length} bound ${mean(rows.map((r) => r[0])).toFixed(2)}  actual ${mean(rows.map((r) => r[1])).toFixed(2)}  after lap 1 ${mean(rows.map((r) => r[2])).toFixed(2)}`);

for (const [key, tr] of traj) {
  const col = (rows: number[][], i: number): string => mean(rows.map((r) => r[i])).toFixed(1);
  console.log(`${key}: by lap bound  ${tr.bound[0].map((_, i) => col(tr.bound, i)).join(' ')}`);
  console.log(`${' '.repeat(key.length)}  actual ${tr.actual[0].map((_, i) => col(tr.actual, i)).join(' ')}`);
}
