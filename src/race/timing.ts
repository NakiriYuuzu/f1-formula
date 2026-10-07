/**
 * Per-car timing: monotonic race progress from the projected s, interpolated line / sector crossings, lap and
 * sector times with personal / overall bests, lap validity, finishing rules, checkpoint times for gaps, DRS
 * detection and control-line crossing records, and ghost recording (human cars outside races).
 *
 * Laps: race — lap 1 starts at lights out (the grid is behind the line), lap k completes when progress reaches
 * k·length. Practice / qualifying / time trial — the car starts on an out lap (lap 0, progress < 0); timing
 * starts when progress crosses 0. Qualifying ends a car's run after `qualifyingLaps` timed laps (in / out laps
 * through the pit lane do not count).
 */
import type { BuiltTrack, CarEntry, WorldState } from '../core/types';
import { angleDiff, clamp01 } from '../core/math';
import { forwardDistance } from '../track/track';
import { crossingTime, emit, isHuman, mod } from './events';
import { radioFinalLap, radioLap } from './radio';
import { chequer, finishCar } from './session';

/** Ghost sample interval (s). */
export const GHOST_DT = 0.05;
/** Longest recordable ghost lap (samples). */
const GHOST_MAX_SAMPLES = 6000;

/** Record DRS detection / control-line crossing times for this step (read by the DRS pass). */
function recordCrossings(track: BuiltTrack, car: CarEntry, prevS: number, ds: number, t0: number, dt: number): void {
  if (!(ds > 0)) return;
  const r = car.race;
  const zones = track.drsZones;
  for (let z = 0; z < zones.length; z++) {
    const d = forwardDistance(track, prevS, zones[z].detection);
    if (d < ds) r.drsDetTimes[z] = t0 + dt * (d / ds);
  }
  const dl = forwardDistance(track, prevS, 0);
  if (dl < ds) r.lineTime = t0 + dt * (dl / ds);
}

function recordCheckpoints(world: WorldState, car: CarEntry, prev: number, next: number, t0: number, dt: number): void {
  if (!(next > prev)) return;
  const r = car.race;
  const sp = world.race.cpSpacing;
  const n = world.race.cpCount;
  if (!(sp > 0) || n <= 0) return;
  const last = Math.floor(next / sp);
  const first = Math.max(r.cpLast + 1, Math.floor(prev / sp) + 1, last - 4);
  for (let k = first; k <= last; k++) {
    const slot = mod(k, n);
    r.cpTimes[slot] = crossingTime(t0, dt, prev, next, k * sp);
    r.cpAbs[slot] = k;
    r.cpLast = k;
  }
}

/** Append ghost samples of the current lap up to world time `upTo` (interpolated within the step). */
function recordGhost(world: WorldState, car: CarEntry, t0: number, dt: number, upTo: number): void {
  if (!isHuman(car) || world.config.kind === 'race' || car.timing.lap < 1) return;
  const r = car.race;
  const p = car.phys;
  let i = Math.floor(r.ghostCur.length / 4);
  while (i < GHOST_MAX_SAMPLES) {
    const ts = car.timing.lapStart + i * GHOST_DT;
    if (ts > upTo + 1e-9) break;
    const f = dt > 0 ? clamp01((ts - t0) / dt) : 1;
    r.ghostCur.push(
      r.prevX + (p.x - r.prevX) * f,
      r.prevY + (p.y - r.prevY) * f,
      r.prevZ + (p.z - r.prevZ) * f,
      r.prevYaw + angleDiff(r.prevYaw, p.yaw) * f,
    );
    i++;
  }
}

function startLap(world: WorldState, car: CarEntry, time: number, lap: number): void {
  const t = car.timing;
  t.lap = lap;
  t.lapStart = time;
  t.currentLapTime = 0;
  t.sector = 0;
  t.sectors = [null, null, null];
  t.lapValid = !(world.config.kind !== 'race' && car.pit.phase !== 'none');
  car.race.pitLap = car.pit.phase !== 'none';
  car.race.sectorStart = time;
  car.race.ghostCur = [];
  if (lap > world.session.leaderLap) world.session.leaderLap = lap;
}

function completeSector(world: WorldState, car: CarEntry, index: number, time: number): void {
  const t = car.timing;
  const r = car.race;
  const sectorTime = time - r.sectorStart;
  r.sectorStart = time;
  t.sectors[index] = sectorTime;
  t.sector = Math.min(2, index + 1);
  let personalBest = false;
  let overallBest = false;
  if (t.lapValid && sectorTime > 0) {
    const pb = t.bestSectors[index];
    personalBest = pb === null || pb === undefined || sectorTime < pb;
    if (personalBest) t.bestSectors[index] = sectorTime;
    const ob = world.race.bestSectors[index];
    overallBest = ob === null || ob === undefined || sectorTime < ob;
    if (overallBest) world.race.bestSectors[index] = sectorTime;
  }
  emit(world, { type: 'sector', carId: car.id, sector: index, time: sectorTime, personalBest, overallBest });
}

/** Complete the current lap at `time`; returns true when the car finished (no new lap started). */
function completeLap(world: WorldState, car: CarEntry, time: number): boolean {
  const t = car.timing;
  const r = car.race;
  const s = world.session;
  if (t.sector === 2) completeSector(world, car, 2, time);
  const lapTime = time - t.lapStart;
  const valid = t.lapValid && lapTime > 1;
  t.lastLap = lapTime;
  t.lastSectors = t.sectors.slice();
  let personalBest = false;
  let overallBest = false;
  if (valid) {
    personalBest = t.bestLap === null || lapTime < t.bestLap;
    if (personalBest) t.bestLap = lapTime;
    overallBest = (s.fastestLap === null || lapTime < s.fastestLap.time) && (world.race.benchLap === null || lapTime < world.race.benchLap);
    if (overallBest) s.fastestLap = { carId: car.id, time: lapTime, lap: t.lap };
  }
  emit(world, { type: 'lapComplete', carId: car.id, lap: t.lap, time: lapTime, valid, personalBest, overallBest });
  if (valid && isHuman(car) && world.config.kind !== 'race' && r.ghostCur.length >= 32) {
    if (r.ghostBestTime === null || lapTime < r.ghostBestTime) {
      r.ghostBest = r.ghostCur.slice();
      r.ghostBestTime = lapTime;
    }
  }
  t.lapsCompleted += 1;
  if (!r.pitLap) r.timedLaps += 1;
  car.phys.tire.laps += 1;
  car.phys.ers.deployedLap = 0;
  car.phys.ers.harvestedLap = 0;
  radioLap(world, car, lapTime, valid, overallBest);

  if (s.kind === 'race') {
    if (s.phase === 'running' && t.lapsCompleted >= s.totalLaps) {
      chequer(world);
      finishCar(world, car, time);
      return true;
    }
    if (s.phase === 'chequered') {
      finishCar(world, car, time);
      return true;
    }
    if (t.lapsCompleted + 1 === s.totalLaps && !world.race.finalLapAnnounced) {
      world.race.finalLapAnnounced = true;
      emit(world, { type: 'finalLap' });
      radioFinalLap(world);
    }
  } else if (s.phase === 'chequered' || (s.kind === 'qualifying' && r.timedLaps >= Math.max(1, world.config.qualifyingLaps))) {
    finishCar(world, car, time);
    return true;
  }
  startLap(world, car, time, t.lapsCompleted + 1);
  return false;
}

/**
 * Advance a car's timing after this step's movement. `t0` = world time at the start of the step, `dt` = step.
 * Must run after physics, collisions and the pit autopilot (uses car.phys.s).
 */
export function updateCarTiming(world: WorldState, track: BuiltTrack, car: CarEntry, t0: number, dt: number): void {
  const p = car.phys;
  const t = car.timing;
  const r = car.race;
  const s = world.session;
  const prevS = r.lastS;
  const ds = Number.isFinite(p.s) ? signedStep(track, prevS, p.s) : 0;
  r.lastS = Number.isFinite(p.s) ? p.s : prevS;
  if (car.status === 'retired' || car.status === 'finished' || s.phase === 'finished') return;
  if (s.kind === 'race' && (s.phase === 'pre' || s.phase === 'formation' || s.phase === 'lights')) return;

  const prev = t.progress;
  const next = prev + ds;
  t.progress = next;
  if (car.pit.phase !== 'none') r.pitLap = true;
  if (p.speed > t.topSpeed && Number.isFinite(p.speed)) t.topSpeed = p.speed;
  if (s.kind === 'race') recordCheckpoints(world, car, prev, next, t0, dt);
  recordCrossings(track, car, prevS, ds, t0, dt);

  const t1 = t0 + dt;
  const L = track.length;
  if (t.lap < 1) {
    if (s.kind !== 'race' && prev < 0 && next >= 0) {
      const tc = crossingTime(t0, dt, prev, next, 0);
      if (s.phase === 'chequered') {
        finishCar(world, car, tc);
        return;
      }
      startLap(world, car, tc, 1);
      recordGhost(world, car, t0, dt, t1);
    }
    return;
  }
  const base = t.lapsCompleted * L;
  for (let k = 1; k <= 2; k++) {
    const b = base + track.sectorStarts[k];
    if (t.sector === k - 1 && prev < b && next >= b) completeSector(world, car, k - 1, crossingTime(t0, dt, prev, next, b));
  }
  const lapEnd = base + L;
  if (prev < lapEnd && next >= lapEnd) {
    const tc = crossingTime(t0, dt, prev, next, lapEnd);
    recordGhost(world, car, t0, dt, tc);
    if (completeLap(world, car, tc)) return;
  }
  recordGhost(world, car, t0, dt, t1);
  t.currentLapTime = Math.max(0, world.time - t.lapStart);
}

/** Signed s change between two projections (shortest way around the loop). */
function signedStep(track: BuiltTrack, a: number, b: number): number {
  const L = track.length;
  let d = (b - a) % L;
  if (d > L / 2) d -= L;
  else if (d <= -L / 2) d += L;
  return Number.isFinite(d) ? d : 0;
}
