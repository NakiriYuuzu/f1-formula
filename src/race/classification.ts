/**
 * Live classification. Race: finished cars by laps then total time incl. penalties (a car still racing that will
 * take the flag with more laps stays ahead of them), then racing cars by progress (4 m hysteresis so side-by-side
 * cars do not flicker), retired cars last; gaps from checkpoint times (every ~50 m), laps down from progress;
 * overtake events for real on-track passes. Practice / qualifying / time trial: by best valid lap.
 */
import type { BuiltTrack, CarEntry, WorldState } from '../core/types';
import { emit, fin, isRacing, mod } from './events';
import { notePass } from './legality';
import { radioOvertake } from './radio';

/** Progress margin (m, ≈ 0.7 car length) a car needs to be classified ahead of the car in front. */
const POSITION_HYSTERESIS = 4;

/** Race time incl. time penalties of a finished car (null before it finished). */
export function raceTotal(world: WorldState, car: CarEntry): number | null {
  const start = world.session.startTime;
  if (car.timing.finishTime === null || start === null) return null;
  return car.timing.finishTime - start + car.penalties.timeSec;
}

/** Order of two finished race cars: more laps first, then lower total time incl. penalties. */
export function compareFinishers(world: WorldState, a: CarEntry, b: CarEntry): number {
  if (a.timing.lapsCompleted !== b.timing.lapsCompleted) return b.timing.lapsCompleted - a.timing.lapsCompleted;
  return (raceTotal(world, a) ?? Infinity) - (raceTotal(world, b) ?? Infinity) || a.id - b.id;
}

/** A car still racing classifies ahead of a finished one when it will take the flag with more laps. */
const runsAheadOf = (racing: CarEntry, finished: CarEntry): boolean => racing.timing.lapsCompleted >= finished.timing.lapsCompleted;

/** Classified position of a race car that has just finished (same rules as the live race order). */
export function finishPosition(world: WorldState, car: CarEntry): number {
  let ahead = 0;
  for (const o of world.cars) {
    if (o === car) continue;
    if (o.status === 'finished' ? compareFinishers(world, o, car) < 0 : isRacing(o) && runsAheadOf(o, car)) ahead++;
  }
  return ahead + 1;
}

/** Time gap (s) of `behind` to `front` using checkpoint times; estimates from distance when not comparable. */
function gapBetween(world: WorldState, track: BuiltTrack, behind: CarEntry, front: CarEntry): number {
  const bt = behind.timing;
  const ft = front.timing;
  if (bt.finishTime !== null && ft.finishTime !== null && bt.lapsCompleted === ft.lapsCompleted) {
    return Math.max(0, fin(raceTotal(world, behind) ?? 0) - fin(raceTotal(world, front) ?? 0));
  }
  const n = world.race.cpCount;
  const c = behind.race.cpLast;
  if (n > 0) {
    const slot = mod(c, n);
    if (front.race.cpAbs[slot] === c && behind.race.cpAbs[slot] === c) {
      return Math.max(0, fin(behind.race.cpTimes[slot]) - fin(front.race.cpTimes[slot]));
    }
  }
  const lapTime = bt.lastLap ?? ft.lastLap ?? track.referenceLapTime * 1.1;
  const speed = Math.max(15, track.length / Math.max(30, lapTime));
  return Math.max(0, (ft.progress - bt.progress) / speed);
}

function lapsBetween(track: BuiltTrack, behind: CarEntry, leader: CarEntry): number {
  if (behind.timing.finishTime !== null && leader.timing.finishTime !== null) {
    return Math.max(0, leader.timing.lapsCompleted - behind.timing.lapsCompleted);
  }
  return Math.max(0, Math.floor((leader.timing.progress - behind.timing.progress) / track.length));
}

function raceOrder(world: WorldState, track: BuiltTrack): void {
  const cars = world.cars;
  const s = world.session;
  const finished = cars.filter((c) => c.status === 'finished').sort((a, b) => compareFinishers(world, a, b));
  const racing: number[] = [];
  for (const id of world.race.order) {
    const c = cars[id];
    if (c && c.status !== 'finished' && c.status !== 'retired' && !racing.includes(id)) racing.push(id);
  }
  for (const c of cars) {
    if (c.status !== 'finished' && c.status !== 'retired' && !racing.includes(c.id)) racing.push(c.id);
  }
  const live = s.phase === 'running' || s.phase === 'chequered';
  const swaps: [number, number][] = [];
  for (let pass = 0; pass < racing.length; pass++) {
    let changed = false;
    for (let i = 0; i + 1 < racing.length; i++) {
      const a = cars[racing[i]];
      const b = cars[racing[i + 1]];
      if (b.timing.progress > a.timing.progress + POSITION_HYSTERESIS) {
        racing[i] = b.id;
        racing[i + 1] = a.id;
        swaps.push([b.id, a.id]);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const retired = cars
    .filter((c) => c.status === 'retired')
    .sort((a, b) => b.timing.progress - a.timing.progress || (b.race.retiredAt ?? 0) - (a.race.retiredAt ?? 0) || a.id - b.id);
  const order: number[] = [];
  let j = 0;
  for (const f of finished) {
    while (j < racing.length && runsAheadOf(cars[racing[j]], f)) order.push(racing[j++]);
    order.push(f.id);
  }
  while (j < racing.length) order.push(racing[j++]);
  for (const c of retired) order.push(c.id);
  world.race.order = order;
  for (let i = 0; i < order.length; i++) cars[order[i]].timing.position = i + 1;

  const leader = order.length > 0 ? cars[order[0]] : null;
  for (let i = 0; i < order.length; i++) {
    const car = cars[order[i]];
    const t = car.timing;
    if (!leader || i === 0 || !live) {
      t.gapToLeader = 0;
      t.interval = 0;
      t.lapsDown = 0;
      continue;
    }
    const ahead = cars[order[i - 1]];
    t.gapToLeader = gapBetween(world, track, car, leader);
    t.interval = gapBetween(world, track, car, ahead);
    t.lapsDown = lapsBetween(track, car, leader);
  }

  if (!live) return;
  for (const [passer, passed] of swaps) {
    const a = cars[passer];
    const b = cars[passed];
    if (a.pit.phase !== 'none' || b.pit.phase !== 'none' || a.timing.lap < 1 || b.timing.lap < 1) continue;
    emit(world, { type: 'overtake', carId: a.id, passedCarId: b.id, position: a.timing.position });
    radioOvertake(world, a, b);
    notePass(world, track, a, b);
  }
}

function timedOrder(world: WorldState): void {
  const cars = world.cars;
  const sorted = [...cars].sort((a, b) => {
    const ra = a.status === 'retired' ? 1 : 0;
    const rb = b.status === 'retired' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const ba = a.timing.bestLap ?? Infinity;
    const bb = b.timing.bestLap ?? Infinity;
    if (ba !== bb) return ba - bb;
    return a.timing.gridPosition - b.timing.gridPosition || a.id - b.id;
  });
  world.race.order = sorted.map((c) => c.id);
  const leaderBest = sorted.length > 0 ? sorted[0].timing.bestLap : null;
  let prevBest: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i].timing;
    t.position = i + 1;
    t.lapsDown = 0;
    t.gapToLeader = t.bestLap !== null && leaderBest !== null ? Math.max(0, t.bestLap - leaderBest) : 0;
    t.interval = t.bestLap !== null && prevBest !== null ? Math.max(0, t.bestLap - prevBest) : 0;
    prevBest = t.bestLap;
  }
}

/** Recompute positions / gaps (call once per step after timing). Frozen once the session is finished. */
export function updateClassification(world: WorldState, track: BuiltTrack): void {
  if (world.session.phase === 'finished') return;
  if (world.session.kind === 'race') raceOrder(world, track);
  else timedOrder(world);
}
