/**
 * window.render_game_to_text() payload (pure): a concise, JSON-safe description of what is on screen — app
 * screen, session state, the viewed player car (and player 2's car in split-screen), the nearest cars ahead /
 * behind on track, who a spectating player watches, weather and replay.
 */
import type { BuiltTrack, CarEntry, GameMode, WorldState } from '../core/types';
import { msToKmh } from '../core/math';
import { signedDeltaS } from '../track/track';

export const COORDINATE_NOTE = 'x/z metres on the ground plane, y up; yaw 0 faces +Z; turning right decreases yaw';

export type AppScreen = 'boot' | 'menu' | 'loading' | 'session' | 'results' | 'replay';

export interface TextStateInput {
  screen: AppScreen;
  menuOpen: boolean;
  paused: boolean;
  world: WorldState | null;
  track: BuiltTrack | null;
  /** player 0's car (the first view's own car, whichever car it shows while spectating) */
  viewCarId: number;
  /** split-screen: player 1's car (second view); null / omitted otherwise */
  player2CarId?: number | null;
  /** per view: the car its player watches while spectating (null = their own); omitted = none */
  watching?: readonly (number | null)[];
  replay: { time: number; duration: number; playing: boolean; speed: number } | null;
}

const r1 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const r2 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const r3 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);
const opt3 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : r3(v));

interface NearbyCar {
  carId: number;
  abbr: string;
  position: number;
  /** metres along the track (positive) */
  distance: number;
  /** their lateral offset minus ours (m, + = right) */
  lateralOffset: number;
  speedKmh: number;
}

function nearby(track: BuiltTrack, me: CarEntry, cars: readonly CarEntry[]): { ahead: NearbyCar | null; behind: NearbyCar | null } {
  let ahead: { car: CarEntry; d: number } | null = null;
  let behind: { car: CarEntry; d: number } | null = null;
  for (const c of cars) {
    if (c.id === me.id || c.status === 'retired' || c.pit.phase === 'stopped') continue;
    const d = signedDeltaS(track, me.phys.s, c.phys.s);
    if (!Number.isFinite(d)) continue;
    if (d >= 0 && (!ahead || d < ahead.d)) ahead = { car: c, d };
    if (d < 0 && (!behind || d > behind.d)) behind = { car: c, d };
  }
  const describe = (e: { car: CarEntry; d: number } | null): NearbyCar | null =>
    e
      ? {
          carId: e.car.id,
          abbr: e.car.abbr,
          position: e.car.timing.position,
          distance: r1(Math.abs(e.d)),
          lateralOffset: r1(e.car.phys.lateral - me.phys.lateral),
          speedKmh: r1(msToKmh(e.car.phys.speed)),
        }
      : null;
  return { ahead: describe(ahead), behind: describe(behind) };
}

/** Telemetry of one player car. */
function describePlayer(car: CarEntry): Record<string, unknown> {
  const p = car.phys;
  return {
    carId: car.id,
    abbr: car.abbr,
    x: r2(p.x),
    y: r2(p.y),
    z: r2(p.z),
    yaw: r3(p.yaw),
    speedKmh: r1(msToKmh(p.speed)),
    gear: p.gear,
    rpm: Math.round(Number.isFinite(p.rpm) ? p.rpm : 0),
    throttle: r2(p.throttle),
    brake: r2(p.brake),
    steerAngle: r3(p.steerAngle),
    position: car.timing.position,
    lap: car.timing.lap,
    currentLap: r3(car.timing.currentLapTime),
    lastLap: opt3(car.timing.lastLap),
    bestLap: opt3(car.timing.bestLap),
    lapValid: car.timing.lapValid,
    s: r1(p.s),
    lateral: r2(p.lateral),
    surface: p.surface,
    status: car.status,
    tyre: { compound: p.tire.compound, wear: r3(p.tire.wear), temp: r1(p.tire.temp) },
    ers: { charge: r3(p.ers.charge), mode: p.ers.mode },
    drs: { available: p.drs.available, open: p.drs.open },
    damage: {
      frontWing: r2(p.damage.frontWing),
      rearWing: r2(p.damage.rearWing),
      floor: r2(p.damage.floor),
      suspension: r2(p.damage.suspension),
    },
    pitPhase: car.pit.phase,
    pitRequested: car.pit.requested,
    trackLimitWarnings: car.penalties.trackLimitWarnings,
    penaltySec: car.penalties.timeSec,
  };
}

/** Plain object for JSON.stringify. */
/** Race-control mode, sector flags and the safety car (distance ahead of the viewed car along the track, m). */
function raceControlState(world: WorldState, track: BuiltTrack | null, car: CarEntry | null): Record<string, unknown> | null {
  if (world.session.kind !== 'race') return null;
  const c = world.session.control;
  const sc = c.safetyCar;
  const ahead = sc.onTrack && car && track ? r1(((signedDeltaS(track, car.phys.s, sc.s) % track.length) + track.length) % track.length) : null;
  return {
    mode: c.mode,
    reason: c.reason,
    sectorFlags: c.sectorFlags.slice(),
    counts: { ...c.counts },
    safetyCar: sc.onTrack ? { lightsOn: sc.lightsOn, speedKmh: r1(msToKmh(sc.speed)), aheadOfPlayer: ahead } : null,
    playerFlag: car ? car.flags.shown : null,
    playerDelta: car && car.flags.delta !== null ? r2(car.flags.delta) : null,
  };
}

export function buildTextState(input: TextStateInput): Record<string, unknown> {
  const { world, track } = input;
  const base: Record<string, unknown> = {
    coordinates: COORDINATE_NOTE,
    screen: input.screen,
    menuOpen: input.menuOpen,
    paused: input.paused,
    replay: input.replay
      ? { time: r2(input.replay.time), duration: r2(input.replay.duration), playing: input.replay.playing, speed: input.replay.speed }
      : null,
  };
  if (!world) return { ...base, mode: null, session: null, player: null, player2: null, spectating: [], ahead: null, behind: null, weather: null };

  const s = world.session;
  const mode: GameMode = world.config.mode;
  const car = world.cars[input.viewCarId] ?? world.cars.find((c) => c.playerIndex === 0) ?? null;
  const near = car && track ? nearby(track, car, world.cars) : { ahead: null, behind: null };
  const p2Id = input.player2CarId;
  const car2 = p2Id !== null && p2Id !== undefined && p2Id !== car?.id ? (world.cars[p2Id] ?? null) : null;
  const near2 = car2 && track ? nearby(track, car2, world.cars) : { ahead: null, behind: null };
  return {
    ...base,
    mode,
    session: {
      kind: s.kind,
      phase: s.phase,
      time: r2(world.time),
      lights: s.lightsOn,
      lightsOut: s.kind !== 'race' || (s.phase !== 'pre' && s.phase !== 'formation' && s.phase !== 'lights'),
      lap: s.leaderLap,
      totalLaps: s.totalLaps,
      timeRemaining: s.timeRemaining === null ? null : r1(s.timeRemaining),
      layout: world.config.layoutId,
      cars: world.cars.length,
      sprint: world.config.sprint === true,
    },
    raceControl: raceControlState(world, track, car),
    player: car ? describePlayer(car) : null,
    /** split-screen second player (same fields + its own nearest cars), null otherwise */
    player2: car2 ? { ...describePlayer(car2), ahead: near2.ahead, behind: near2.behind } : null,
    /** per view: the car watched while that player spectates (own car out of a multiplayer race), else null */
    spectating: (input.watching ?? []).map((id) => {
      const w = id === null ? undefined : world.cars[id];
      return w ? { carId: w.id, abbr: w.abbr, position: w.timing.position } : null;
    }),
    ahead: near.ahead,
    behind: near.behind,
    weather: { kind: world.weather.kind, rain: r2(world.weather.rain), wetness: r2(world.weather.wetness) },
  };
}
