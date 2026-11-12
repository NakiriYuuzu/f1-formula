/**
 * Attack episodes (a car's attackPhase leaving 'none' until it is back): how many, how long each phase lasts, which ones end
 * in a pass of the car attacked (an overtake of it within the episode or 2 s after), by how much faster the attacker is.
 *   bun run tools/bench/ai/attacks.ts <outDir> <file-prefix>...
 */
import { readdirSync } from 'node:fs';
const [OUT = '', ...prefixes] = process.argv.slice(2);
const files = readdirSync(OUT).filter((f) => prefixes.some((p) => f.startsWith(p + '_')) && f.endsWith('.json')).sort();
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const groups = new Map<string, any[]>();
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  if (!o.attacks) continue;
  const key = `${file.split('_')[0]} ${o.layoutId} ${o.mode} d${o.difficulty}${o.seat ? ' seat' : ''}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(o);
}
const buckets: [string, (d: number) => boolean][] = [
  ['slower/equal', (d) => d <= 0],
  ['0-0.4%', (d) => d > 0 && d <= 0.004],
  ['0.4-0.8%', (d) => d > 0.004 && d <= 0.008],
  ['>0.8%', (d) => d > 0.008],
];
for (const [key, runs] of groups) {
  console.log(`\n=== ${key} (${runs.length} races) ===`);
  const eps = runs.flatMap((o) =>
    o.attacks
      .filter((e: any) => e.lap >= 1)
      .map((e: any) => {
        const passed = o.events.some((v: any) => v.passer === e.car && v.passed === e.target && v.t >= e.t0 - 0.1 && v.t <= e.t1 + 2);
        const d = o.paceStatic[e.target] > 0 ? (o.paceStatic[e.target] - o.paceStatic[e.car]) / o.paceStatic[e.target] : 0;
        return { ...e, passed, d, dur: e.t1 - e.t0 };
      }),
  );
  console.log(`episodes ${f(eps.length / runs.length, 0)} a race, ${f((eps.filter((e) => e.passed).length / Math.max(1, eps.length)) * 100, 0)}% end in a pass; mean duration ${f(mean(eps.map((e) => e.dur)))} s (stalk ${f(mean(eps.map((e) => e.ph.stalk ?? 0)))} feint ${f(mean(eps.map((e) => e.ph.feint ?? 0)))} commit ${f(mean(eps.map((e) => e.ph.commit ?? 0)))} switchback ${f(mean(eps.map((e) => e.ph.switchback ?? 0)))})`);
  for (const [name, pred] of buckets) {
    const b = eps.filter((e) => pred(e.d));
    if (!b.length) continue;
    const c = b.filter((e) => (e.ph.commit ?? 0) > 0);
    console.log(`  attacker ${name.padEnd(13)} n=${String(b.length).padStart(4)} pass ${f((b.filter((e) => e.passed).length / b.length) * 100, 0)}% | reached commit ${f((c.length / b.length) * 100, 0)}% (of those pass ${f((c.filter((e) => e.passed).length / Math.max(1, c.length)) * 100, 0)}%) | stalk only: ${b.length - c.length}, duration median ${f([...b.map((e) => e.dur)].sort((x, y) => x - y)[Math.floor(b.length / 2)])} s | start gap ${f(mean(b.map((e) => e.ivStart)), 2)} s end gap ${f(mean(b.map((e) => e.ivEnd)), 2)} s`);
  }
}
