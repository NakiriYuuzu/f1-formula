/**
 * createWorld: builds the initial WorldState for a session — cars (spec, setup, assists, AI brain, fuel, tyres,
 * team pit box), placement (race: staggered two-column grid behind the line, held in neutral; practice /
 * qualifying / time trial: flying lap from ~450 m before the line on the racing line), weather, session state
 * (race 'pre' → lights; others 'running' at once) and the runtime's internal bookkeeping.
 */
import type {
  BuiltTrack,
  CarEntry,
  CarTiming,
  DriverDef,
  GridEntry,
  SessionConfig,
  SessionState,
  TeamDef,
  TireCompound,
  WorldState,
  PlayerIndex,
} from '../core/types';
import { AI_ASSISTS, COMPOUNDS, DEFAULT_ASSISTS, DEFAULT_SETUP } from '../core/defaults';
import { clamp, forwardX, forwardZ, randRange } from '../core/math';
import { DRIVERS, TEAMS } from '../data/teams';
import { COMPOUND_PARAMS, createCarPhysics, createCarSpec, fuelPerKm } from '../physics/index';
import { poseAt, sampleAt, wrapS } from '../track/track';
import { aiCarTeam, applyRaceForm, createAIState, isDry } from '../ai/index';
import { emit, mod } from './events';
import type { CarRaceInternal } from './types';
import { gearForSpeed } from './pitlane';
import { PRE_LIGHTS } from './session';
import { predictLapTime, qualiCalibration, qualifyingBenchmark } from './qualiSim';
import { createWeather } from './weather';
import { createCarFlags, createControlState } from './control';
import { gridSlot } from './gridPark';

export { GRID_FRONT, GRID_GAP, GRID_LATERAL } from './gridPark';
/** Flying-lap start distance (m) before the line and spacing (m) between cars. */
export const FLYING_START = 450;
const FLYING_GAP = 90;
/** Practice / qualifying: AI cars are spread over the lap, starting this far ahead of the players' start... */
const AI_SPREAD_AHEAD = 320;
/** ...and ending this far behind it, so nobody starts on top of a player's flying lap. */
const AI_SPREAD_BEHIND = 260;
/** Pit boxes: spacing (m) and number of slots around pit.box (11 roster-pack teams + My Team; same 154 m row as 11 × 14 m). */
export const BOX_SPACING = 12.8;
export const BOX_SLOTS = 12;
/** Fuel (kg) when fuel use is off / outside races. */
const LIGHT_FUEL = 10;
/** Checkpoint spacing target (m) for gaps. */
const CHECKPOINT_SPACING = 50;

function findDriver(config: SessionConfig, id: string): DriverDef | null {
  return config.drivers.find((d) => d.id === id) ?? DRIVERS.find((d) => d.id === id) ?? null;
}

function findTeam(config: SessionConfig, id: string): TeamDef | null {
  return config.teams.find((t) => t.id === id) ?? TEAMS.find((t) => t.id === id) ?? null;
}

function defaultNextCompound(start: TireCompound): TireCompound {
  if (start === 'soft') return 'medium';
  if (start === 'medium') return 'hard';
  if (start === 'hard') return 'medium';
  return start;
}

function fuelLoad(config: SessionConfig, track: BuiltTrack, perKm: number): number {
  if (!config.rules.fuel) return LIGHT_FUEL;
  const km = track.length / 1000;
  if (config.kind === 'race') return Math.max(1, config.laps) * km * perKm * 1.05 + 1;
  if (config.kind === 'qualifying') return (Math.max(1, config.qualifyingLaps) + 2) * km * perKm + 1;
  if (config.kind === 'practice') {
    // enough for the whole clock at reference pace (pit stops do not refuel), plus out lap and margin
    const limit = config.timeLimit;
    const laps = limit !== null && limit > 0 ? Math.ceil(limit / Math.max(30, track.referenceLapTime)) + 2 : 8;
    return laps * km * perKm + 1;
  }
  return LIGHT_FUEL;
}

function boxSlot(config: SessionConfig, teamId: string, order: string[]): number {
  let idx = config.teams.findIndex((t) => t.id === teamId);
  if (idx < 0) {
    idx = order.indexOf(teamId);
    if (idx < 0) {
      order.push(teamId);
      idx = order.length - 1;
    }
  }
  return mod(idx, BOX_SLOTS);
}

function newTiming(progress: number, gridPosition: number): CarTiming {
  return {
    lap: 0,
    lapsCompleted: 0,
    progress,
    lapStart: 0,
    currentLapTime: 0,
    lastLap: null,
    bestLap: null,
    sector: 0,
    sectors: [null, null, null],
    lastSectors: [null, null, null],
    bestSectors: [null, null, null],
    lapValid: true,
    position: gridPosition,
    gridPosition,
    gapToLeader: 0,
    interval: 0,
    lapsDown: 0,
    finishTime: null,
    topSpeed: 0,
  };
}

function newRaceInternal(
  s: number,
  pose: { x: number; y: number; z: number; yaw: number },
  boxS: number,
  compound: TireCompound,
  zones: number,
  cpCount: number,
  cpLast: number,
): CarRaceInternal {
  return {
    lastS: s,
    prevX: pose.x,
    prevY: pose.y,
    prevZ: pose.z,
    prevYaw: pose.yaw,
    sectorStart: 0,
    cpTimes: new Array<number>(cpCount).fill(-1e9),
    cpAbs: new Array<number>(cpCount).fill(-1e9),
    cpLast,
    drsDetTimes: new Array<number>(zones).fill(-1e9),
    drsZone: -1,
    lineTime: -1e9,
    limitTimer: 0,
    limitFlagged: false,
    pitStartLat: 0,
    pitSpeed: 0,
    pitLat: 0,
    pitStopS: boxS,
    pitStopTotal: 0,
    pitRepair: false,
    pitManual: false,
    pitAuto: false,
    pitSpeeding: false,
    usedCompounds: isDry(compound) ? [compound] : [],
    usedWetTyre: !isDry(compound),
    mandatoryPenaltyApplied: false,
    stuckTime: 0,
    stuckProgress: -1e9,
    slowTime: 0,
    collisionCooldown: 0,
    reportedDamage: [0, 0, 0],
    drsWasAvailable: false,
    drsWasOpen: false,
    radioCooldown: 4,
    radioWearWarned: false,
    radioDamageWarned: false,
    radioWeatherWarned: false,
    radioMandatoryWarned: false,
    radioGapTimer: 20,
    ghostCur: [],
    ghostBest: [],
    ghostBestTime: null,
    retiredAt: null,
    pitLap: false,
    timedLaps: 0,
    neutralLap: true,
    lastCleanLap: 0,
    gridS: s,
    gridLat: 0,
    formationDist: 0,
    parking: false,
    parked: false,
    parkStartD: 0,
    parkStartLat: 0,
    formationAuto: false,
    formationIdle: 0,
    stopTime: 0,
    impactPeak: 0,
    carContactAt: null,
    hazard: false,
    ctlS: s,
    vscPenalised: false,
    warnCooldown: 0,
    blueFor: -1,
    blueTimer: 0,
    scAheadTime: 0,
    wake: { drag: 1, frontDownforce: 1, rearDownforce: 1 },
  };
}

/**
 * Expected flying-lap time of a driver in a team car (cached per team / skill within one world build): the calibrated
 * point-mass prediction (simulated qualifying without its noise), on the same scale as real laps — paceOf compares it
 * with a human's lap times.
 */
function paceEstimate(
  cache: Record<string, number>,
  track: BuiltTrack,
  team: TeamDef,
  driver: DriverDef,
  config: SessionConfig,
  wetness: number,
): number {
  const key = `${team.id}|${driver.skill.pace}|${driver.skill.wet}|${driver.skill.consistency}`;
  const hit = cache[key];
  if (hit !== undefined) return hit;
  const t =
    predictLapTime(track, team, driver, config.aiDifficulty, config.regulation, wetness, config.development?.[team.id] ?? {}) *
    qualiCalibration(config.aiDifficulty, config.regulation);
  cache[key] = Number.isFinite(t) && t > 0 ? t : 0;
  return cache[key];
}

function validEntries(config: SessionConfig): { g: GridEntry; driver: DriverDef; team: TeamDef; playerIndex: -1 | PlayerIndex }[] {
  const out: { g: GridEntry; driver: DriverDef; team: TeamDef; playerIndex: -1 | PlayerIndex }[] = [];
  const seen: string[] = [];
  const usedPlayers: number[] = [];
  for (const g of config.grid) {
    if (!g || typeof g.driverId !== 'string' || seen.includes(g.driverId)) continue;
    const driver = findDriver(config, g.driverId);
    if (!driver) continue;
    const team = findTeam(config, g.teamId) ?? findTeam(config, driver.teamId);
    if (!team) continue;
    seen.push(g.driverId);
    let playerIndex: -1 | PlayerIndex = g.playerIndex === 0 || g.playerIndex === 1 || g.playerIndex === 2 || g.playerIndex === 3 ? g.playerIndex : -1;
    if (playerIndex !== -1 && usedPlayers.includes(playerIndex)) playerIndex = -1;
    if (playerIndex !== -1) usedPlayers.push(playerIndex);
    out.push({ g, driver, team, playerIndex });
  }
  return out;
}

/** Build the initial world: cars placed on the grid (race) / on a flying lap (practice, quali, time trial). */
export function buildWorld(input: SessionConfig, track: BuiltTrack): WorldState {
  const config = structuredClone(input);
  const kind = config.kind;
  const race = kind === 'race';
  const seed = Number.isFinite(config.seed) ? Math.floor(Math.abs(config.seed)) >>> 0 : 1;
  const rng = { s: (seed ^ 0x2545f491) >>> 0 };
  const L = track.length;
  const cpCount = Math.max(8, Math.round(L / CHECKPOINT_SPACING));
  const cpSpacing = L / cpCount;
  const totalLaps = race ? clamp(Math.round(Number.isFinite(config.laps) ? config.laps : 1), 1, 500) : kind === 'qualifying' ? Math.max(1, config.qualifyingLaps) : 0;
  config.laps = race ? totalLaps : config.laps;
  const duration = race ? totalLaps * track.referenceLapTime * 1.12 + 20 : (config.timeLimit ?? 0);
  const weather = createWeather(config, track, rng, duration);

  const cars: CarEntry[] = [];
  const teamOrder: string[] = [];
  const paceCache: Record<string, number> = {};
  const entries = validEntries(config);
  const aiTotal = entries.filter((e) => e.playerIndex === -1).length;
  const humanTeams = new Set(entries.filter((e) => e.playerIndex !== -1).map((e) => e.team.id));
  let humanOrdinal = 0;
  let aiOrdinal = 0;
  for (let i = 0; i < entries.length; i++) {
    const { g, driver, team, playerIndex } = entries[i];
    // AI-only teams run the closer AI car ratings (aiCarTeam); a human's team-mate keeps the human's car
    const carTeam = humanTeams.has(team.id) ? team : aiCarTeam(team);
    const slot = playerIndex !== -1 ? config.players.find((p) => p.playerIndex === playerIndex) : undefined;
    const setup = slot ? { ...DEFAULT_SETUP, ...slot.setup } : { ...DEFAULT_SETUP };
    const assists = playerIndex !== -1 ? { ...DEFAULT_ASSISTS, ...(slot?.assists ?? {}) } : { ...AI_ASSISTS };
    const spec = createCarSpec(carTeam, setup, config.regulation, config.development?.[team.id] ?? {});
    const compound: TireCompound = (COMPOUNDS as readonly string[]).includes(g.startCompound) ? g.startCompound : 'medium';
    const fuel = fuelLoad(config, track, fuelPerKm(spec));

    let s: number;
    let lateral: number;
    if (race) {
      const slot = gridSlot(track, i);
      s = slot.s;
      lateral = slot.lateral;
    } else if (playerIndex !== -1 || aiTotal === 0) {
      s = wrapS(track, L - FLYING_START - FLYING_GAP * humanOrdinal++);
      lateral = sampleAt(track, track.racingLine, s);
    } else {
      const span = Math.max(0, L - AI_SPREAD_AHEAD - AI_SPREAD_BEHIND);
      s = wrapS(track, L - FLYING_START + AI_SPREAD_AHEAD + (span * aiOrdinal++) / aiTotal);
      lateral = sampleAt(track, track.racingLine, s);
    }
    const pose = poseAt(track, s, lateral);
    const phys = createCarPhysics(pose, compound, fuel, spec, race ? 'grid' : 'running');
    phys.s = s;
    phys.lateral = lateral;
    phys.trackIndex = Math.round(s / track.spacing) % track.count;
    if (!race) {
      const v = Math.min(85, Math.max(20, sampleAt(track, track.speedProfile, s) * 0.9));
      const g2 = gearForSpeed(spec, v);
      phys.vx = forwardX(pose.yaw) * v;
      phys.vz = forwardZ(pose.yaw) * v;
      phys.speed = v;
      phys.vLong = v;
      phys.gear = g2.gear;
      phys.rpm = g2.rpm;
      const params = COMPOUND_PARAMS[compound];
      phys.tire.temp = (params.windowLo + params.windowHi) / 2;
    }
    const boxS = wrapS(track, track.pit.box + (boxSlot(config, team.id, teamOrder) - (BOX_SLOTS - 1) / 2) * BOX_SPACING);
    const progress = s - L;
    const ai = createAIState(driver, config.aiDifficulty, (seed * 31 + (i + 1) * 7919) >>> 0);
    ai.plannedCompound = defaultNextCompound(compound);
    ai.stintStartProgress = progress;
    ai.paceTime = paceEstimate(paceCache, track, carTeam, driver, config, weather.wetness);
    if (race && playerIndex === -1) applyRaceForm(ai);
    const zones = track.drsZones.length;
    cars.push({
      id: cars.length,
      driverId: driver.id,
      teamId: team.id,
      playerIndex,
      displayName: `${driver.firstName} ${driver.lastName}`.trim(),
      abbr: driver.abbr,
      number: driver.number,
      livery: { ...team.livery },
      phys,
      spec,
      setup,
      assists,
      ai,
      timing: newTiming(progress, cars.length + 1),
      pit: { requested: false, nextCompound: defaultNextCompound(compound), phase: 'none', timer: 0, stops: 0, boxS },
      penalties: { timeSec: 0, trackLimitWarnings: 0, log: [] },
      status: race ? 'grid' : 'running',
      race: newRaceInternal(s, pose, boxS, compound, zones, cpCount, Math.floor(progress / cpSpacing)),
      flags: createCarFlags(),
    });
    if (race) cars[cars.length - 1].race.gridLat = lateral;
  }

  const session: SessionState = {
    kind,
    phase: race ? 'pre' : 'running',
    lightsOn: 0,
    startTime: race ? null : 0,
    totalLaps,
    timeRemaining: kind === 'practice' || kind === 'qualifying' ? Math.max(1, config.timeLimit ?? 600) : null,
    leaderLap: 0,
    drsEnabled: !race && weather.wetness <= 0.4,
    chequeredAt: null,
    finishOrder: [],
    fastestLap: null,
    control: createControlState(),
  };
  if (session.timeRemaining !== null && !(config.timeLimit !== null && config.timeLimit > 0)) config.timeLimit = session.timeRemaining;

  const bench = kind === 'qualifying' ? qualifyingBenchmark(config, track, cars.map((c) => c.driverId)) : null;
  const world: WorldState = {
    time: 0,
    tick: 0,
    config,
    session,
    weather,
    cars,
    events: [],
    rng,
    flashbacksUsed: 0,
    race: {
      lightsStart: PRE_LIGHTS,
      lightsHold: race ? randRange(rng, 0.5, 2.5) : 0,
      order: cars.map((c) => c.id),
      cpCount,
      cpSpacing,
      bestSectors: bench ? [...bench.sectors] : [null, null, null],
      benchLap: bench ? bench.lap : null,
      maxWetness: weather.wetness,
      finalLapAnnounced: false,
      forecastWarned: -1,
      endRequested: false,
      formationDone: !(race && config.rules.formationLap === true),
      restart: false,
      incidents: [],
      incidentSeq: 0,
      incidentDrawLap: 0,
      incidentDueAt: null,
      scDeployLaps: -1,
      scGoneLaps: -1,
      scPitDist: -1,
      scHeld: false,
      scExitDist: -1,
      scPickedUp: false,
      scDueSince: null,
      redRegroupAt: null,
      greenAt: -1e9,
      sectorClearedAt: [-1e9, -1e9, -1e9],
    },
  };
  if (!race) emit(world, { type: 'sessionStart' });
  return world;
}
