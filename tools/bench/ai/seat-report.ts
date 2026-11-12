/**
 * What the player feels, from races with a car in the player's seat (probe.ts ... slow|fast [mistakes]).
 *   bun run tools/bench/ai/seat-report.ts <outDir> <file-prefix>...
 * Per group (prefix / layout / role / mistakes / difficulty):
 *  - behind the seat: stints of a car within 1 s behind the seat, by how much faster it is (static pace) — pass rate and the
 *    time (laps) it sat within 1 s before getting by
 *  - seat behind an AI car: the same, by the seat's pace advantage — how hard it is for the seat to pass the AI's defence
 *  - scripted mistakes: windows (from the error's start, MISTAKE_WINDOW s) in which the car behind took the seat's place
 *  - contacts involving the seat (the seat's own collision events), by where the other car was
 */
import { readdirSync } from 'node:fs';
const [OUT = '', ...prefixes] = process.argv.slice(2);
const files = readdirSync(OUT).filter((f) => prefixes.some((p) => f.startsWith(p + '_')) && f.endsWith('.json')).sort();
const median = (a: number[]): number => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = (a: number[], p: number): number => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a');
const groups = new Map<string, any[]>();
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  if (!o.seat) continue;
  const key = `${file.split('_')[0]} ${o.layoutId} ${o.seat.role}${o.seat.mistakes ? '+mistakes' : ''} d${o.difficulty} ${o.mode}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(o);
}
const buckets: [string, (d: number) => boolean][] = [
  ['<=0 (slower/equal)', (d) => d <= 0],
  ['0-0.3%', (d) => d > 0 && d <= 0.003],
  ['0.3-0.8%', (d) => d > 0.003 && d <= 0.008],
  ['>0.8%', (d) => d > 0.008],
];
for (const [key, runs] of groups) {
  console.log(`\n=== ${key} (${runs.length} races, seeds ${runs.map((r) => r.seed).join(',')}) ===`);
  const gap = runs.map((o) => { const s = [...o.paceStatic].sort((a: number, b: number) => a - b); return (o.seat.pace / s[Math.floor(s.length / 2)] - 1) * 100; });
  console.log(`seat pace vs field median: ${f(mean(gap), 2)}% (${f(Math.min(...gap), 2)}..${f(Math.max(...gap), 2)}) | seat finishes ${runs.map((o) => o.seat.finalPos).join(',')} (mean ${f(mean(runs.map((o) => o.seat.finalPos)), 1)}) retired ${runs.filter((o) => o.seat.retired).length}`);
  const behind: { delta: number; t1: number; ref: number; reason: string }[] = [];
  const ahead: { delta: number; t1: number; ref: number; reason: string }[] = [];
  for (const o of runs) {
    for (const s of o.stints) {
      if (s.t1 <= 0.05) continue;
      if (s.b === o.seat.id) behind.push({ delta: (o.paceStatic[s.b] - o.paceStatic[s.a]) / o.paceStatic[s.b], t1: s.t1, ref: o.ref, reason: s.reason });
      else if (s.a === o.seat.id) ahead.push({ delta: (o.paceStatic[s.b] - o.paceStatic[s.a]) / o.paceStatic[s.b], t1: s.t1, ref: o.ref, reason: s.reason });
    }
  }
  const table = (label: string, rows: typeof behind): void => {
    console.log(`  ${label}`);
    for (const [name, pred] of buckets) {
      const r = rows.filter((x) => pred(x.delta));
      if (!r.length) continue;
      const ended = r.filter((x) => x.reason !== 'end');
      const passed = r.filter((x) => x.reason === 'passed');
      const laps = passed.map((x) => x.t1 / x.ref);
      console.log(`    ${name.padEnd(20)} n=${String(r.length).padStart(3)} passRate=${pct(passed.length, ended.length).padStart(4)} | within 1 s before the pass: median ${f(median(laps), 2)} laps p90 ${f(q(laps, 0.9), 2)} | all stints mean ${f(mean(r.map((x) => x.t1 / x.ref)), 2)} laps`);
    }
    const fast = rows.filter((x) => x.delta > 0.003 && x.reason !== 'end');
    const fp = fast.filter((x) => x.reason === 'passed');
    console.log(`    FAST (>0.3%): ended ${fast.length}, passed ${fp.length} (${pct(fp.length, fast.length)}), median time within 1 s before the pass ${f(median(fp.map((x) => x.t1 / x.ref)), 2)} laps`);
  };
  table('cars behind the seat, by how much faster than the seat they are', behind);
  table('seat behind an AI car, by how much faster than it the seat is (the AI defends)', ahead);
  const m = runs.flatMap((o) => o.seat.mistakeRecs.filter((r: any) => r.t0 >= 0));
  if (m.length) {
    const row = (label: string, rows: any[]): void => {
      const taken = rows.filter((r) => r.taken);
      console.log(`    ${label.padEnd(26)} windows ${String(rows.length).padStart(3)} | taken ${String(taken.length).padStart(3)} (${pct(taken.length, rows.length)}) after ${f(median(taken.map((r) => r.taken.after)), 1)} s | closest gap median ${f(median(rows.map((r) => r.gapMin)), 2)} s (at start ${f(median(rows.map((r) => r.iv0)), 2)} s)`);
    };
    console.log('  scripted mistakes (window 15 s from the error):');
    row('all', m);
    for (const kind of ['lift', 'brake']) row(kind, m.filter((r) => r.kind === kind));
    row('behind faster (>0.15%)', m.filter((r) => r.deltaBehind > 0.0015));
    row('behind similar', m.filter((r) => Math.abs(r.deltaBehind) <= 0.0015));
    row('behind slower (<-0.15%)', m.filter((r) => r.deltaBehind < -0.0015));
    row('gap at arm <= 0.5 s', m.filter((r) => r.iv0 <= 0.5));
  }
  const c = runs.flatMap((o) => o.seat.contactRecs);
  const heavy = c.filter((r: any) => r.impulse > 5000).length;
  const fromBehind = c.filter((r: any) => r.ds < -3).length, hitAhead = c.filter((r: any) => r.ds > 3).length;
  console.log(`  contacts involving the seat: ${f(c.length / runs.length, 2)} a race (heavy ${f(heavy / runs.length, 2)}) | other car behind ${fromBehind} ahead ${hitAhead} beside ${c.length - fromBehind - hitAhead} | during a scripted mistake ${c.filter((r: any) => r.inMistake).length} | AI collision events per car and race ${f(mean(runs.map((o) => o.collisions / o.drivers.length)), 2)}`);
}
