/**
 * Session flow: race start lights (pre → 5 lights 1 s apart → random hold → lights out), timed-session clock and
 * chequered flag, car finishing (incl. the mandatory-stop penalty), session end (all classified or 3 min after the
 * flag), player-initiated end and retirement.
 */
import type { CarEntry, WorldState } from '../core/types';
import { setCarHeld } from '../physics/index';
import { finishPosition } from './classification';
import { emit, isRacing } from './events';
import { radioAll, radioFinish } from './radio';

/** Seconds of 'pre' before the first start light. */
export const PRE_LIGHTS = 2;
/** Seconds between start lights. */
export const LIGHT_INTERVAL = 1;
/** Seconds after the chequered flag before unfinished cars are classified where they are. */
export const CHEQUERED_TIMEOUT = 180;
/** Time penalty (s) for not serving the mandatory stop. */
export const MANDATORY_STOP_PENALTY = 30;

/** Advance start lights (race) or the session clock (practice / qualifying). */
export function stepSessionClock(world: WorldState): void {
  const s = world.session;
  const r = world.race;
  if (s.kind === 'race') {
    if (s.phase !== 'pre' && s.phase !== 'lights') return;
    const t = world.time - r.lightsStart;
    if (t < 0) return;
    if (s.phase === 'pre' && !r.formationDone) {
      startFormation(world);
      return;
    }
    if (s.phase === 'pre') s.phase = 'lights';
    const lit = Math.min(5, Math.floor(t / LIGHT_INTERVAL) + 1);
    while (s.lightsOn < lit) {
      s.lightsOn += 1;
      emit(world, { type: 'lightsOn', count: s.lightsOn });
    }
    if (t >= 4 * LIGHT_INTERVAL + r.lightsHold) lightsOut(world);
    return;
  }
  if (s.phase === 'running' && s.timeRemaining !== null) {
    const limit = world.config.timeLimit ?? 0;
    const start = s.startTime ?? 0;
    s.timeRemaining = Math.max(0, limit - (world.time - start));
    if (s.timeRemaining <= 0) chequer(world);
  }
}

/** Formation lap: release the grid; race control queues the field and parks it again (control.ts). */
function startFormation(world: WorldState): void {
  const s = world.session;
  const c = s.control;
  s.phase = 'formation';
  for (const car of world.cars) {
    if (car.status === 'retired') continue;
    setCarHeld(car.phys, false);
    car.race.formationDist = 0;
    car.race.ctlS = car.phys.s;
    car.race.parked = false;
    car.race.parking = false;
  }
  const previous = c.mode;
  c.mode = 'formation';
  c.since = world.time;
  c.reason = '暖胎圈';
  emit(world, { type: 'raceControl', mode: 'formation', previous, reason: c.reason });
  radioAll(world, '暖胎圈開始，保持隊形，不得超車。');
}

/** Red-flag restart: lap counters are kept, every car starts a fresh current lap at lights out. */
function restartLightsOut(world: WorldState): void {
  const s = world.session;
  const c = s.control;
  world.race.restart = false;
  s.lightsOn = 0;
  s.phase = 'running';
  for (const car of world.cars) {
    if (car.status === 'retired' || car.status === 'finished') continue;
    if (car.status === 'grid') car.status = 'running';
    setCarHeld(car.phys, false);
    car.race.parked = false;
    const t = car.timing;
    t.lap = t.lapsCompleted + 1;
    t.lapStart = world.time;
    t.currentLapTime = 0;
    t.sector = 0;
    t.sectors = [null, null, null];
    t.lapValid = true;
    car.race.sectorStart = world.time;
    car.race.pitLap = false;
    if (t.lap > s.leaderLap) s.leaderLap = t.lap;
  }
  const previous = c.mode;
  c.mode = 'green';
  c.since = world.time;
  c.reason = '';
  c.drsLockUntilLap = s.leaderLap + 2;
  world.race.greenAt = world.time;
  emit(world, { type: 'lightsOut' });
  emit(world, { type: 'raceControl', mode: 'green', previous, reason: '' });
  radioAll(world, '重新起跑，加油！');
}

function lightsOut(world: WorldState): void {
  if (world.race.restart) {
    restartLightsOut(world);
    return;
  }
  const s = world.session;
  s.lightsOn = 0;
  s.phase = 'running';
  s.startTime = world.time;
  s.leaderLap = 1;
  // drsEnabled is left to updateDrs (same step), so the 2026 straight-mode opening emits its event + radio call
  for (const car of world.cars) {
    if (car.status === 'retired') continue;
    if (car.status === 'grid') car.status = 'running';
    setCarHeld(car.phys, false);
    car.timing.lap = 1;
    car.timing.lapStart = world.time;
    car.timing.currentLapTime = 0;
    car.race.sectorStart = world.time;
  }
  emit(world, { type: 'lightsOut' });
  emit(world, { type: 'sessionStart' });
  if (s.totalLaps <= 1 && !world.race.finalLapAnnounced) {
    world.race.finalLapAnnounced = true;
    emit(world, { type: 'finalLap' });
  }
}

/** Show the chequered flag (race: leader completed the distance; timed sessions: clock ran out). */
export function chequer(world: WorldState): void {
  const s = world.session;
  if (s.phase === 'chequered' || s.phase === 'finished') return;
  s.phase = 'chequered';
  s.chequeredAt = world.time;
  if (s.timeRemaining !== null) s.timeRemaining = 0;
  emit(world, { type: 'chequered' });
}

/** Classify a car as finished at world time `time`. */
export function finishCar(world: WorldState, car: CarEntry, time: number): void {
  if (car.status === 'finished' || car.status === 'retired') return;
  const s = world.session;
  car.status = 'finished';
  car.timing.finishTime = time;
  car.pit.requested = false;
  if (!s.finishOrder.includes(car.id)) s.finishOrder.push(car.id);
  if (s.kind === 'race') {
    applyMandatoryStopRule(world, car);
    car.timing.position = finishPosition(world, car);
  }
  emit(world, { type: 'carFinished', carId: car.id, position: car.timing.position });
  radioFinish(world, car);
}

/** Dry race with the mandatory-stop rule: a finisher that never ran two dry compounds gets a time penalty. */
function applyMandatoryStopRule(world: WorldState, car: CarEntry): void {
  const r = car.race;
  if (!world.config.rules.mandatoryPitStop || world.config.sprint === true || r.mandatoryPenaltyApplied) return;
  if (world.race.maxWetness > 0.35 || r.usedWetTyre) return;
  if (r.usedCompounds.length >= 2) return;
  r.mandatoryPenaltyApplied = true;
  car.penalties.timeSec += MANDATORY_STOP_PENALTY;
  const reason = '未履行強制進站規定';
  car.penalties.log.push(`+${MANDATORY_STOP_PENALTY} 秒：${reason}`);
  emit(world, { type: 'penalty', carId: car.id, seconds: MANDATORY_STOP_PENALTY, reason });
}

/** Whether the mandatory-stop rule is still open for this car (used by AI strategy / radio). */
export function mandatoryStopOpen(world: WorldState, car: CarEntry): boolean {
  if (world.config.kind !== 'race' || !world.config.rules.mandatoryPitStop || world.config.sprint === true) return false;
  if (world.race.maxWetness > 0.35 || car.race.usedWetTyre) return false;
  return car.race.usedCompounds.length < 2;
}

function finishSession(world: WorldState): void {
  const s = world.session;
  if (s.phase === 'finished') return;
  s.phase = 'finished';
  if (s.chequeredAt === null) s.chequeredAt = world.time;
  emit(world, { type: 'sessionEnd' });
}

/** End-of-session checks after timing: everyone classified, chequered timeout, no cars left racing. */
export function checkSessionEnd(world: WorldState): void {
  const s = world.session;
  if (s.phase === 'finished') return;
  if (world.race.endRequested) {
    finishSession(world);
    return;
  }
  const pending = world.cars.some(isRacing);
  if (s.phase === 'pre' || s.phase === 'formation' || s.phase === 'lights') {
    // everyone retired before the start: nothing left to run
    if (!pending) finishSession(world);
    return;
  }
  if (s.phase === 'chequered') {
    if (!pending || (s.chequeredAt !== null && world.time - s.chequeredAt > CHEQUERED_TIMEOUT)) finishSession(world);
    return;
  }
  // running: every car finished its laps (qualifying) or retired (or there is nobody on track at all)
  if (!pending) {
    chequer(world);
    finishSession(world);
  }
}

/** True once results are final. */
export function sessionOver(world: WorldState): boolean {
  return world.session.phase === 'finished';
}

/** Player ends the session now (practice / time trial / qualifying; also accepted for races). */
export function requestEnd(world: WorldState): void {
  if (world.session.phase === 'finished') return;
  world.race.endRequested = true;
  finishSession(world);
}

/** Retire a car: parked (held, hidden), out of the running order. */
export function retire(world: WorldState, car: CarEntry, reason: string): void {
  if (car.status === 'retired') return;
  car.status = 'retired';
  car.race.retiredAt = world.time;
  car.pit.requested = false;
  car.pit.phase = 'none';
  car.phys.limiter = false;
  setCarHeld(car.phys, true);
  car.phys.drs.available = false;
  car.phys.drs.eligible = false;
  car.phys.ers.overtakeAvailable = false;
  const text = reason.trim().length > 0 ? reason.trim() : '退出比賽';
  emit(world, { type: 'retired', carId: car.id, reason: text });
  checkSessionEnd(world);
}
