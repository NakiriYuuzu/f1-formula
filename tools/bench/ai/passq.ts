/**
 * Who passes whom: on-track passes (no lap 1, no pit) by the passer's static pace edge over the car it passes, and how many are
 * undone within 20 s. A pass by a slower car is churn: it costs the faster one a place until it takes it back.
 *   bun run tools/bench/ai/passq.ts <outDir> <file-prefix>...
 */
import { readdirSync } from 'node:fs';
const [OUT = '', ...prefixes] = process.argv.slice(2);
const files = readdirSync(OUT).filter((f) => prefixes.some((p) => f.startsWith(p + '_')) && f.endsWith('.json')).sort();
const groups = new Map<string, any[]>();
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  if (o.seat) continue;
  const key = `${file.split('_')[0]} ${o.layoutId} d${o.difficulty}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(o);
}
const buckets: [string, (d: number) => boolean][] = [
  ['passer slower >0.3%', (d) => d < -0.003],
  ['passer slower 0-0.3%', (d) => d >= -0.003 && d < 0],
  ['passer faster 0-0.3%', (d) => d >= 0 && d < 0.003],
  ['passer faster 0.3-0.8%', (d) => d >= 0.003 && d < 0.008],
  ['passer faster >0.8%', (d) => d >= 0.008],
];
for (const [key, runs] of groups) {
  console.log(`\n=== ${key} (${runs.length} races) ===`);
  const evs = runs.flatMap((o) => {
    const clean = o.events.filter((e: any) => !e.lap1 && !e.pit);
    return clean.map((e: any) => ({ d: (e.paceB - e.paceA) / e.paceB, undone: clean.some((g: any) => g.passer === e.passed && g.passed === e.passer && g.t > e.t && g.t - e.t < 20) }));
  });
  for (const [name, pred] of buckets) {
    const r = evs.filter((e) => pred(e.d));
    console.log(`  ${name.padEnd(24)} ${(r.length / runs.length).toFixed(1).padStart(6)} a race (${((r.length / Math.max(1, evs.length)) * 100).toFixed(0).padStart(3)}%) | undone within 20 s ${((r.filter((e) => e.undone).length / Math.max(1, r.length)) * 100).toFixed(0)}%`);
  }
}
