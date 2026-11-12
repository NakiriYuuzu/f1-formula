/**
 * Held cars and the pit wall, one row per group of races (same file prefix / layout / mode / difficulty).
 *   bun run tools/bench/ai/pitwindow.ts <outDir> <file-prefix>[@maxSeed]... [--pairs]
 * Files are <prefix>_<layout>_<mode>_s<seed>.json from probe.ts, races long enough for stops (25 laps).
 *
 * A held stint is a FAST CAR HELD stint of predicate.ts (tyre-aware pace edge > 0.4 %, >= 10 s within 1 s). It is at
 * the pit window when it began before the first stop of either car of the pair and lasted to within WINDOW_LAPS laps
 * of it; one per pair (the latest). It is settled SETTLE s after the later of the two cars' first pit exits: is the held
 * car ahead then? How it got ahead:
 *   track     already ahead when the first of the two stops began (an on-track pass)
 *   undercut  it stopped on an earlier lap than the car that held it
 *   overcut   it stopped on a later lap
 *   same      both stopped on the same lap
 * Columns:
 *   held      held stints at the window, per race; ahead% settled ahead, then the mechanism counts (all races summed)
 *   still pit%  of them, still behind when the first of the two stops began (a race), and the share of those settled ahead
 *   flag%     held car ahead at the flag
 *   behind    still behind: stopped earlier / same lap / later
 *   bf5 sp    back-five mean finish (reverse grid), spearman(paceStatic, final)
 *   stops     mean stops per car; dbl = a car stopping twice within 2 laps; cliff = cars past 0.85 wear (max wear)
 *   win       winner's race time (s)
 *   uc        undercut calls a race / of them by a car within 1 s of the car ahead; ucPos = share that got ahead of the
 *             car ahead at the call once both had stopped, ucFin = mean (position at the call - final position)
 *   vsBase    with --vs=<prefix>: for the cars that made a call within 1 s, mean (final position in the <prefix> race of
 *             the same layout / mode / seed - final position here): > 0 = they finish higher than without the rule
 */
import { existsSync, readdirSync } from 'node:fs';
const args = process.argv.slice(2);
const showPairs = args.includes('--pairs');
const vs = args.find((a) => a.startsWith('--vs='))?.slice(5);
const [OUT = '', ...specs] = args.filter((a) => !a.startsWith('--'));
const WINDOW_LAPS = 3;
const SETTLE = 10;
const parsed = specs.map((s) => { const [name, max] = s.split('@'); return { name, max: max ? Number(max) : Infinity }; });
const seedOf = (file: string): number => Number(/_s(\d+)\.json$/.exec(file)?.[1] ?? 0);
const files = readdirSync(OUT)
  .filter((f) => f.endsWith('.json') && parsed.some((p) => f.startsWith(p.name + '_') && seedOf(f) <= p.max))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
function rank(a: number[]): number[] { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => (r[i] = k)); return r; }
function spearman(a: number[], b: number[]): number {
  const ra = rank(a), rb = rank(b); const ma = mean(ra), mb = mean(rb); let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

interface Pair { seed: number; a: string; b: string; ahead: boolean; pre: boolean; how: string; flag: boolean; lapA: number; lapB: number; reasonA: string; reasonB: string }
const groups = new Map<string, any[]>();
for (const file of files) {
  const o = JSON.parse(await Bun.file(OUT + '/' + file).text());
  if (o.seat || !o.pits) continue;
  const key = `${file.split('_')[0]} ${o.layoutId} ${o.mode} d${o.difficulty}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(o);
}

console.log('group'.padEnd(30), 'n  held ahead%  trk  uc  oc same | still pit% | flag% | behind e/s/l |  bf5    sp   stops dbl cliff maxW |   win   | uc  <1s ucPos ucFin');
for (const [key, runs] of groups) {
  const pairs: Pair[] = [];
  const bf5: number[] = [], sp: number[] = [], stops: number[] = [], win: number[] = [], maxW: number[] = [];
  let dbl = 0, cliff = 0, ucCalls = 0, ucNear = 0;
  const ucPos: number[] = [], ucFin: number[] = [], vsBase: number[] = [];
  for (const o of runs) {
    const baseFile = vs ? `${OUT}/${vs}_${o.layoutId}_${o.mode}_s${o.seed}.json` : '';
    const base = baseFile && existsSync(baseFile) ? JSON.parse(await Bun.file(baseFile).text()) : null;
    const n = o.drivers.length;
    const at = (t: number): number[] => o.ord[Math.max(0, Math.min(o.ord.length - 1, Math.floor(t - o.ordT0)))];
    const ahead = (t: number, x: number, y: number): boolean => { const ord = at(t); return ord.indexOf(x) < ord.indexOf(y); };
    const pits = o.pits.filter((p: any) => p.tEntry >= 0 && p.tExit >= 0).sort((p: any, q: any) => p.tEntry - q.tEntry);
    const first = (c: number): any => pits.find((p: any) => p.car === c);
    const finalPos = new Array(n); o.final.forEach((id: number, i: number) => (finalPos[id] = i + 1));
    const ids = (o.backFive ?? []).map((d: string) => o.drivers.indexOf(d));
    if (ids.length) bf5.push(mean(ids.map((id: number) => finalPos[id])));
    sp.push(spearman(o.paceStatic, finalPos));
    stops.push(mean(o.stops));
    const w = o.finishTime[o.final[0]];
    if (w !== null && o.startTime !== null) win.push(w - o.startTime);
    for (let c = 0; c < n; c++) {
      const mine = pits.filter((p: any) => p.car === c);
      for (let i = 1; i < mine.length; i++) if (mine[i].lap - mine[i - 1].lap <= 2) dbl++;
      if (o.maxWear[c] > 0.85) cliff++;
    }
    maxW.push(Math.max(...o.maxWear));
    // undercut calls: places against the car ahead at the call once both have stopped; positions to the flag
    for (const p of pits) {
      if (p.reason !== 'undercut') continue;
      ucCalls++;
      if (p.interval < 1) {
        ucNear++;
        if (base) vsBase.push(base.final.indexOf(base.drivers.indexOf(o.drivers[p.car])) + 1 - finalPos[p.car]);
      }
      ucFin.push(p.pos - finalPos[p.car]);
      const q = p.ahead >= 0 ? pits.find((r: any) => r.car === p.ahead && r.tExit > p.tReq) : undefined;
      if (q) ucPos.push(ahead(Math.max(p.tExit, q.tExit) + SETTLE, p.car, p.ahead) ? 1 : 0);
    }
    // held stints at the window, the latest per pair
    const byPair = new Map<string, any>();
    for (const s of o.stints) {
      if (!(s.t1 > 0.05 && s.deltaNow > 0.004 && s.t1 >= 10)) continue;
      const pa = first(s.a), pb = first(s.b);
      if (!pa || !pb) continue;
      const tFirst = Math.min(pa.tEntry, pb.tEntry);
      const end = s.start + s.tot;
      if (!(s.start < tFirst && end >= tFirst - WINDOW_LAPS * o.ref)) continue;
      const k = `${s.a}-${s.b}`;
      if (!byPair.has(k) || byPair.get(k).start < s.start) byPair.set(k, s);
    }
    for (const s of byPair.values()) {
      const pa = first(s.a), pb = first(s.b);
      const tFirst = Math.min(pa.tReq >= 0 ? pa.tReq : pa.tEntry, pb.tReq >= 0 ? pb.tReq : pb.tEntry);
      const tRes = Math.max(pa.tExit, pb.tExit) + SETTLE;
      const pre = ahead(tFirst - 1, s.a, s.b);
      const now = ahead(tRes, s.a, s.b);
      const how = pre ? 'track' : pa.lap < pb.lap ? 'undercut' : pa.lap > pb.lap ? 'overcut' : 'same';
      pairs.push({ seed: o.seed, a: o.drivers[s.a], b: o.drivers[s.b], ahead: now, pre, how, flag: finalPos[s.a] < finalPos[s.b], lapA: pa.lap, lapB: pb.lap, reasonA: pa.reason, reasonB: pb.reason });
    }
  }
  const got = pairs.filter((p) => p.ahead);
  const cnt = (xs: Pair[], h: string): number => xs.filter((p) => p.how === h).length;
  const behind = pairs.filter((p) => !p.ahead && !p.pre);
  const still = pairs.filter((p) => !p.pre);
  console.log(
    key.padEnd(30), String(runs.length).padStart(1), f(pairs.length / runs.length, 1).padStart(5), (f((got.length / Math.max(1, pairs.length)) * 100, 0) + '%').padStart(6),
    String(cnt(got, 'track')).padStart(5), String(cnt(got, 'undercut')).padStart(3), String(cnt(got, 'overcut')).padStart(3), String(cnt(got, 'same')).padStart(4), ' |',
    f(still.length / runs.length, 1).padStart(5), (f((still.filter((p) => p.ahead).length / Math.max(1, still.length)) * 100, 0) + '%').padStart(5), ' |',
    (f((pairs.filter((p) => p.flag).length / Math.max(1, pairs.length)) * 100, 0) + '%').padStart(5), ' |',
    `${cnt(behind, 'undercut')}/${cnt(behind, 'same')}/${cnt(behind, 'overcut')}`.padStart(9), '   |',
    f(mean(bf5), 1).padStart(5), f(mean(sp), 3).padStart(6), f(mean(stops), 2).padStart(6), String(dbl).padStart(3), String(cliff).padStart(4), f(Math.max(...maxW), 2).padStart(5), ' |',
    f(mean(win), 1).padStart(7), ' |', f(ucCalls / runs.length, 1).padStart(4), String(ucNear).padStart(4), f(mean(ucPos), 2).padStart(5), f(mean(ucFin), 2).padStart(5),
    vs ? `| vsBase ${f(mean(vsBase), 2)} (n ${vsBase.length})` : '',
  );
  if (showPairs) for (const p of pairs) console.log(`   s${p.seed} ${p.a} behind ${p.b}: stops lap ${p.lapA} (${p.reasonA}) / ${p.lapB} (${p.reasonB}) -> ${p.ahead ? 'AHEAD' : 'behind'} via ${p.how}, flag ${p.flag ? 'ahead' : 'behind'}`);
}
