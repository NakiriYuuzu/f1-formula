/**
 * Why a faster car sits behind a slower one: what the attack decision said while it was within 1 s. Needs races run on a
 * tree where planTraffic sets ai.dbgGate (see tools/bench/ai/diag-gates.patch); probe.ts then fills stint.gate.
 *   bun run tools/bench/ai/gates.ts <outDir> <file-prefix>...
 * Gates: atk-* an attack phase | free no car in the path | train DRS train without the edge | noAdv no closing / not held
 * up long enough | corner braking for a corner (no new move) | cooldown | noSide no room | banned flag | hold team order.
 */
import { readdirSync } from 'node:fs';
const [OUT = '', ...prefixes] = process.argv.slice(2);
const files = readdirSync(OUT).filter((f) => prefixes.some((p) => f.startsWith(p + '_')) && f.endsWith('.json')).sort();
const f = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const groups = new Map<string, any[]>();
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  const key = `${file.split('_')[0]} ${o.layoutId} ${o.mode} d${o.difficulty}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(o);
}
const order = ['atk-stalk', 'atk-feint', 'atk-commit', 'atk-switchback', 'atk-none', 'train', 'noAdv', 'corner', 'cooldown', 'noSide', 'far', 'hold', 'banned', 'free', 'recover'];
for (const [key, runs] of groups) {
  console.log(`\n=== ${key} (${runs.length} races) ===`);
  const sets: [string, (s: any, o: any) => boolean][] = [
    ['FAST CAR HELD (delta now > 0.4 %, >= 10 s within 1 s)', (s) => s.deltaNow > 0.004 && s.t1 >= 10],
    ['  ... ended in a pass', (s) => s.deltaNow > 0.004 && s.t1 >= 10 && s.reason === 'passed'],
    ['  ... not passed (dropped / reordered / end)', (s) => s.deltaNow > 0.004 && s.t1 >= 10 && s.reason !== 'passed'],
    ['0.15-0.4 % faster, >= 10 s within 1 s', (s) => s.deltaNow > 0.0015 && s.deltaNow <= 0.004 && s.t1 >= 10],
  ];
  for (const [label, pred] of sets) {
    const rows = runs.flatMap((o) => o.stints.filter((s: any) => s.gate && pred(s, o)));
    const total: Record<string, number> = {};
    let t1 = 0, lim = 0, drs = 0;
    for (const s of rows) {
      for (const [g, v] of Object.entries(s.gate as Record<string, number>)) total[g] = (total[g] ?? 0) + v;
      t1 += s.t1; lim += s.lim ?? 0; drs += s.drs;
    }
    const sum = Object.values(total).reduce((a, b) => a + b, 0) || 1;
    const parts = order.filter((g) => total[g]).map((g) => `${g} ${f((total[g] / sum) * 100, 0)}%`);
    console.log(`${label}: n=${rows.length}, ${f(t1 / Math.max(1, rows.length), 0)} s within 1 s each | follow limit binding ${f((lim / Math.max(1, t1)) * 100, 0)}% | DRS open ${f((drs / Math.max(1, t1)) * 100, 0)}%`);
    console.log(`    ${parts.join(' | ')}`);
  }
}
