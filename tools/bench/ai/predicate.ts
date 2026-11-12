/**
 * The racecraft predicate and its guardrails, one row per group of races (same layout / mode / difficulty / file prefix).
 *   bun run tools/bench/ai/predicate.ts <outDir> <file-prefix>...
 * Files are <prefix>_<layout>_<mode>_s<seed>.json from probe.ts. Columns:
 *   bf5     mean finishing position of the five fastest cars (they start 16-20 in reverse mode; pace alone says 3.0)
 *   held%   FAST CAR HELD stints (tyre-aware pace edge > 0.4 %, >= 10 s within 1 s) that ended in a pass, over all of them
 *   med1s   median time (laps) within 1 s before the pass, over passes by a car > 0.3 % faster (static pace)
 *   sp      mean spearman(paceStatic, final)
 *   pass    on-track passes a race (no lap 1, no pit); repass = re-passes within 20 s over those
 *   coll    collision events a race, heavy (impulse > 5000), retirements
 *   fast    fastest lap of the race (s) and clean-air lap vs pace (% over paceStatic, median of laps run alone on the road)
 */
import { readdirSync } from 'node:fs';
const [OUT = '', ...specs] = process.argv.slice(2);
/** `name` takes every seed, `name@4` seeds 1-4 only. */
const parsed = specs.map((s) => { const [name, max] = s.split('@'); return { name, max: max ? Number(max) : Infinity }; });
const seedOf = (file: string): number => Number(/_s(\d+)\.json$/.exec(file)?.[1] ?? 0);
const files = readdirSync(OUT)
  .filter((f) => f.endsWith('.json') && parsed.some((p) => f.startsWith(p.name + '_') && seedOf(f) <= p.max))
  .sort();
const median = (a: number[]): number => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
function rank(a: number[]): number[] { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => (r[i] = k)); return r; }
function spearman(a: number[], b: number[]): number {
  const ra = rank(a), rb = rank(b); const ma = mean(ra), mb = mean(rb); let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}
const groups = new Map<string, any[]>();
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  if (o.seat) continue;
  const key = `${file.split('_')[0]} ${o.layoutId} ${o.mode} d${o.difficulty}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(o);
}
console.log('group'.padEnd(34), 'n  bf5   held%  med1s   sp     pass repass  coll heavy ret  fastest  clean%  | back-five per seed');
for (const [key, runs] of groups) {
  const bf5: number[] = [], perSeed: string[] = [], sp: number[] = [], passes: number[] = [], repass: number[] = [], fastest: number[] = [], clean: number[] = [];
  const held: any[] = [], fastPassed: number[] = [];
  for (const o of runs) {
    const ids = (o.backFive ?? []).map((d: string) => o.drivers.indexOf(d));
    if (ids.length) { const m = mean(ids.map((id: number) => o.final.indexOf(id) + 1)); bf5.push(m); perSeed.push(`s${o.seed}:${f(m, 1)}`); }
    const finalPos = new Array(o.drivers.length); o.final.forEach((id: number, i: number) => (finalPos[id] = i + 1));
    sp.push(spearman(o.paceStatic, finalPos));
    const ev = o.events.filter((e: any) => !e.lap1 && !e.pit);
    passes.push(ev.length);
    repass.push(ev.filter((e: any) => ev.some((g: any) => g.passer === e.passed && g.passed === e.passer && g.t > e.t && g.t - e.t < 20)).length);
    const st = o.stints.filter((s: any) => s.t1 > 0.05);
    for (const s of st) {
      if (s.deltaNow > 0.004 && s.t1 >= 10) held.push(s);
      if (s.deltaStatic > 0.003 && s.reason === 'passed') fastPassed.push(s.t1 / o.ref);
    }
    fastest.push(Math.min(...o.bestLap.filter((x: number | null) => x !== null && x > 0)));
    const cl = o.lapRecs.filter((r: any) => r.near < 0.02 && r.meanAhead > 3).map((r: any) => (r.time / r.pace - 1) * 100);
    if (cl.length) clean.push(median(cl));
  }
  const heldPass = held.filter((s) => s.reason === 'passed').length / Math.max(1, held.length) * 100;
  const rp = repass.reduce((a, b) => a + b, 0) / Math.max(1, passes.reduce((a, b) => a + b, 0)) * 100;
  console.log(
    key.padEnd(34), String(runs.length).padStart(1), f(mean(bf5), 1).padStart(5), f(heldPass, 0).padStart(6), f(median(fastPassed), 2).padStart(6), f(mean(sp), 3).padStart(6),
    f(mean(passes), 1).padStart(6), (f(rp, 0) + '%').padStart(5), f(mean(runs.map((o) => o.collisions)), 1).padStart(5), f(mean(runs.map((o) => o.heavy)), 1).padStart(5),
    f(mean(runs.map((o) => o.retired.length)), 1).padStart(3), f(mean(fastest), 2).padStart(8), f(mean(clean), 2).padStart(6), ' |', perSeed.join(' '),
  );
}
