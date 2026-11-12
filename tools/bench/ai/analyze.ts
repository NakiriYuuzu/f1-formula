// usage: bun run tools/bench/ai/analyze.ts <outDir> <file-prefix> ...
import { readdirSync } from 'node:fs';
const [OUT = '', ...prefixes] = process.argv.slice(2);
const files = readdirSync(OUT).filter((f) => prefixes.some((p) => f.startsWith(p)) && f.endsWith('.json')).sort();
const median = (a: number[]): number => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
function spearman(a: number[], b: number[]): number {
  const n = a.length; const ra = rank(a), rb = rank(b);
  const ma = mean(ra), mb = mean(rb); let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}
function rank(a: number[]): number[] { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => (r[i] = k)); return r; }
const groups = new Map<string, any[]>();
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  const key = `${o.layoutId}|${o.mode}|d${o.difficulty}|${o.laps}L|${file.split("_")[0]}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(o);
}
for (const [key, runs] of groups) {
  console.log(`\n=== ${key}  (${runs.length} races, seeds ${runs.map((r) => r.seed).join(',')}) ===`);
  let tot = 0, aft = 0, onTrack = 0, repass = 0, tricks = 0;
  const perLap: number[] = [];
  const kend: number[] = []; const spGrid: number[] = [], spPace: number[] = [], disp: number[] = [];
  for (const o of runs) {
    const ev = o.events;
    const clean = ev.filter((e: any) => !e.lap1 && !e.pit);
    tot += ev.length; aft += ev.filter((e: any) => !e.lap1).length; onTrack += clean.length;
    for (const e of clean) {
      if (e.aiTrick) tricks++;
      if (clean.some((g: any) => g.passer === e.passed && g.passed === e.passer && g.t > e.t && g.t - e.t < 20)) repass++;
    }
    const nl = o.laps; perLap.push(clean.length / Math.max(1, nl - 1));
    // grid / pace correlation with final
    const finalPos = new Array(o.drivers.length); o.final.forEach((id: number, i: number) => (finalPos[id] = i + 1));
    spGrid.push(spearman(o.gridPos, finalPos)); spPace.push(spearman(o.paceStatic, finalPos));
    // displacement: sum |pos_end - pos_grid| / 2 over all cars (net swaps)
    {
      const s1 = o.snaps.find((s: any) => s.leaderLaps === 1)?.order ?? o.final;
      const pos1 = new Array(o.drivers.length); s1.forEach((id: number, i: number) => (pos1[id] = i));
      const posF = new Array(o.drivers.length); o.final.forEach((id: number, i: number) => (posF[id] = i));
      let d = 0; for (let a = 0; a < pos1.length; a++) for (let b = a + 1; b < pos1.length; b++) if ((pos1[a] - pos1[b]) * (posF[a] - posF[b]) < 0) d++;
      kend.push(d);
    }
    disp.push(o.gridPos.reduce((a: number, g: number, id: number) => a + Math.abs(finalPos[id] - g), 0) / 2);
  }
  console.log(`events (all): ${(tot / runs.length).toFixed(1)}/race | after lap 1: ${(aft / runs.length).toFixed(1)} | on-track (excl lap1, excl pit-related): ${(onTrack / runs.length).toFixed(1)}/race = ${f(mean(perLap))}/lap | re-pass<20s: ${(repass / runs.length).toFixed(1)}/race | feint/switchback-credited: ${(tricks / runs.length).toFixed(1)}/race`);
  console.log(`pairs whose order differs between end of lap 1 and the flag (Kendall distance, net): ${f(mean(kend), 1)}/race vs gross on-track passes ${f(onTrack / runs.length, 1)} -> churn x${f(onTrack / runs.length / Math.max(1, mean(kend)), 2)}`);
  console.log(`spearman(grid, final) mean ${f(mean(spGrid), 3)} | spearman(paceStatic, final) mean ${f(mean(spPace), 3)} | net displacement grid->final (sum|dpos|/2) mean ${f(mean(disp), 1)} | pit stops/race ${f(mean(runs.map((r) => r.stops.reduce((a: number, b: number) => a + b, 0))), 1)} | collisions ${f(mean(runs.map((r) => r.collisions)), 1)} heavy ${f(mean(runs.map((r) => r.heavy)), 1)} | retired ${f(mean(runs.map((r) => r.retired.length)), 1)}`);
  // pace spread
  const spreads = runs.map((o) => { const p = [...o.paceStatic].sort((a: number, b: number) => a - b); const gaps = p.slice(1).map((v: number, i: number) => (v - p[i]) / p[0] * 100); return { total: (p[p.length - 1] - p[0]) / p[0] * 100, p90_10: (p[17] - p[2]) / p[0] * 100, medGap: median(gaps), meanGap: mean(gaps), absTotal: p[p.length - 1] - p[0] }; });
  console.log(`paceStatic spread: total ${f(mean(spreads.map((s) => s.total)))}% (${f(mean(spreads.map((s) => s.absTotal)), 2)} s) | 3rd..18th ${f(mean(spreads.map((s) => s.p90_10)))}% | adjacent gap median ${f(mean(spreads.map((s) => s.medGap)), 3)}% mean ${f(mean(spreads.map((s) => s.meanGap)), 3)}%`);
  // reverse: back five trajectory
  if (runs[0].mode !== 'normal') {
    const laps = runs[0].laps; const rows: string[] = [];
    const traj: number[][] = [];
    for (const o of runs) {
      const ids = o.backFive.map((d: string) => o.drivers.indexOf(d));
      const t: number[] = []; const g0 = ids.map((id: number) => o.gridPos[id]);
      t.push(mean(g0));
      for (let L = 1; L <= laps; L++) {
        const snap = o.snaps.find((s: any) => s.leaderLaps === L);
        const order = L === laps ? o.final : snap?.order;
        if (!order) { t.push(NaN); continue; }
        t.push(mean(ids.map((id: number) => order.indexOf(id) + 1)));
      }
      traj.push(t);
      const finalPos = ids.map((id: number) => o.final.indexOf(id) + 1).sort((a: number, b: number) => a - b);
      rows.push(`  seed ${o.seed}: back-five ${o.backFive.join(',')}  grid mean ${f(g0 && mean(g0), 1)}  final positions ${finalPos.join(',')}  mean ${f(mean(finalPos), 1)}  (paceStatic ranks 1..5 -> if pace alone decided: mean 3.0)`);
    }
    console.log(rows.join('\n'));
    console.log('  mean position of fastest-5 by leader lap (0 = grid): ' + traj[0].map((_, i) => f(mean(traj.map((t) => t[i])), 1)).join(' '));
  }
  // stints
  const st = runs.flatMap((o) => o.stints.filter((s: any) => s.t1 > 0.05).map((s: any) => ({ ...s, laps: o.laps, ref: o.ref })));
  const buckets: [string, (d: number) => boolean][] = [
    ['A faster by <=0 (slower/equal)', (d) => d <= 0],
    ['A faster 0-0.15%', (d) => d > 0 && d <= 0.0015],
    ['A faster 0.15-0.4%', (d) => d > 0.0015 && d <= 0.004],
    ['A faster 0.4-0.8%', (d) => d > 0.004 && d <= 0.008],
    ['A faster >0.8%', (d) => d > 0.008],
  ];
  for (const useNow of [false, true]) {
    console.log(`  follow stints (A within 1.0s of B, lap>=1, no pit) by ${useNow ? 'CURRENT tyre-aware estimatedPace delta' : 'static paceTime delta'}: n=${st.length}`);
    for (const [name, pred] of buckets) {
      const s = st.filter((x: any) => pred(useNow ? x.deltaNow : x.deltaStatic));
      if (!s.length) continue;
      const passed = s.filter((x: any) => x.reason === 'passed');
      const ended = s.filter((x: any) => x.reason !== 'end');
      const tr = s.reduce((a: number, x: any) => a + x.t1, 0);
      const atkT = s.reduce((a: number, x: any) => a + (x.atk.stalk ?? 0) + (x.atk.commit ?? 0) + (x.atk.feint ?? 0) + (x.atk.switchback ?? 0), 0);
      const dr = s.reduce((a: number, x: any) => a + x.drs, 0), cons = s.reduce((a: number, x: any) => a + x.conserve, 0), tn = s.reduce((a: number, x: any) => a + x.train, 0);
      console.log(`    ${name.padEnd(30)} n=${String(s.length).padStart(3)} passRate=${f(passed.length / Math.max(1, ended.length) * 100, 0)}% median t<1s=${f(median(s.map((x: any) => x.t1)), 1)}s (${f(median(s.map((x: any) => x.t1 / x.ref)), 2)} laps) meanT=${f(tr / s.length, 1)}s | in 'attack' ${f(atkT / tr * 100, 0)}% DRS-open ${f(dr / tr * 100, 0)}% conserve ${f(cons / tr * 100, 0)}% inTrain ${f(tn / tr * 100, 0)}% | passed-stint median t1 ${f(median(passed.map((x: any) => x.t1)), 1)}s`);
    }
  }
  {
    const fastPassed = st.filter((x: any) => x.deltaStatic > 0.003 && x.reason === 'passed');
    const fastAll = st.filter((x: any) => x.deltaStatic > 0.003 && x.reason !== 'end');
    console.log(`  FAST (static delta>0.3%) stints ended: ${fastAll.length}, passed ${fastPassed.length} (${f(fastPassed.length / Math.max(1, fastAll.length) * 100, 0)}%); time within 1 s before the pass: mean ${f(mean(fastPassed.map((x: any) => x.t1 / x.ref)), 2)} laps, median ${f(median(fastPassed.map((x: any) => x.t1 / x.ref)), 2)} laps, p90 ${f([...fastPassed.map((x: any) => x.t1 / x.ref)].sort((a: number, b: number) => a - b)[Math.floor(fastPassed.length * 0.9)], 2)}; mean delta ${f(mean(fastPassed.map((x: any) => x.deltaStatic * 100)), 2)}%; not-passed ones (dropped/reorder/pit): mean t1 ${f(mean(fastAll.filter((x: any) => x.reason !== 'passed').map((x: any) => x.t1 / x.ref)), 2)} laps`);
  }
  const reasons: Record<string, number> = {}; for (const s of st) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  console.log('  stint end reasons: ' + JSON.stringify(reasons));
  // fast-car-held: stints with deltaNow > 0.4% and t1 >= 10s
  const held = st.filter((x: any) => x.deltaNow > 0.004 && x.t1 >= 10);
  console.log(`  FAST CAR HELD (delta now>0.4%, >=10 s within 1 s): n=${held.length}, ended in pass ${held.filter((x: any) => x.reason === 'passed').length}, dropped ${held.filter((x: any) => x.reason === 'dropped').length}, other/end ${held.filter((x: any) => !['passed', 'dropped'].includes(x.reason)).length}; mean t<1s ${f(mean(held.map((x: any) => x.t1)), 1)}s, mean delta ${f(mean(held.map((x: any) => x.deltaNow * 100)), 2)}%`);
  // lap-time excess near vs clean (per-lap-number reference from clean laps)
  const recs = runs.flatMap((o) => o.lapRecs.map((r: any) => ({ ...r, seed: o.seed })));
  const exByLap = new Map<string, number[]>();
  for (const r of recs) if (r.meanAhead > 3 && r.near < 0.02) { const k = `${r.seed}:${r.lap}`; if (!exByLap.has(k)) exByLap.set(k, []); exByLap.get(k)!.push(r.time / r.pace - 1); }
  const rel = (r: any): number => { const ref = exByLap.get(`${r.seed}:${r.lap}`); return ref && ref.length >= 3 ? (r.time / r.pace - 1 - median(ref)) * 100 : NaN; };
  const near = recs.filter((r) => r.near > 0.6).map(rel).filter(Number.isFinite), mid = recs.filter((r) => r.near > 0.2 && r.near <= 0.6).map(rel).filter(Number.isFinite), clean = recs.filter((r) => r.near < 0.02 && r.meanAhead > 3).map(rel).filter(Number.isFinite);
  console.log(`  lap-time vs same-lap clean-air median (control for fuel/tyre trend), %: followed >60% of lap within 1s: mean ${f(mean(near), 2)}% (n=${near.length}) | 20-60%: ${f(mean(mid), 2)}% (n=${mid.length}) | clean: ${f(mean(clean), 2)}% (n=${clean.length}, spread sd) `);
  // tricks
  console.log('  tricks (sum over cars/races): feints ' + runs.reduce((a, o) => a + o.tricks.reduce((x: number, t: any) => x + t.f, 0), 0) + ' feintPasses ' + runs.reduce((a, o) => a + o.tricks.reduce((x: number, t: any) => x + t.fp, 0), 0) + ' switchbacks ' + runs.reduce((a, o) => a + o.tricks.reduce((x: number, t: any) => x + t.s, 0), 0) + ' switchbackPasses ' + runs.reduce((a, o) => a + o.tricks.reduce((x: number, t: any) => x + t.sp, 0), 0));
}
