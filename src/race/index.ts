/**
 * Race runtime (owner: race/AI agent). Pure logic — must NOT import three.js or DOM APIs.
 * Owns session flow, start lights, timing & sectors, positions & gaps, DRS/overtake eligibility, pit lane autopilot,
 * penalties/track limits, weather evolution, collisions dispatch, AI qualifying simulation, results, ghosts.
 *
 * Everything lives in the plain-data WorldState (structuredClone-safe); the BuiltTrack is passed alongside.
 * stepWorld is deterministic for (world, inputs): all randomness comes from world.rng / per-car AI rng state.
 */
import type {
  BuiltTrack,
  CarEntry,
  ControlInput,
  ErsMode,
  GhostData,
  RenderFrame,
  SessionConfig,
  SessionResult,
  StandingRow,
  TireCompound,
  WorldState,
  PlayerIndex,
} from '../core/types';
import { concludeRace as conclude } from './conclude';
import { ghostOf, renderFrame } from './frame';
import { simulateQualifying } from './qualiSim';
import { sessionResult, standings } from './results';
import { requestEnd, retire, sessionOver } from './session';
import { advanceWorld, queuePit } from './step';
import { forceIncident as forceRaceIncident } from './control';
import { buildWorld } from './world';

export type { CarRaceInternal, WorldRaceInternal } from './types';
export { formatRaceTime, evaluateObjective } from './results';
export { predictLapTime, pointMassLap, qualifyingCompound, qualiCalibration } from './qualiSim';
export { GHOST_DT } from './timing';
export { PRE_LIGHTS, LIGHT_INTERVAL, CHEQUERED_TIMEOUT, RETIRE_BY_CHOICE, mandatoryStopOpen } from './session';
export { FREE_WARNINGS, TRACK_LIMIT_PENALTY } from './limits';
export { DRS_GAP, DRS_WET_LIMIT } from './drs';
export { GRID_FRONT, GRID_GAP, GRID_LATERAL, FLYING_START, BOX_SPACING, BOX_SLOTS } from './world';
export { RAIN_LEVEL } from './weather';
export { COLLISION_EVENT_IMPULSE } from './contact';
export { COAST_INPUT, predictHumanStep } from './step';
export { estimatePitLoss, pitLossFactor, PIT_LOSS_FALLBACK, SC_ENDING_PIT_LOSS_FACTOR, SC_PIT_LOSS_FACTOR, VSC_PIT_LOSS_FACTOR } from './pitlane';

const ERS_MODES: readonly ErsMode[] = ['none', 'medium', 'hotlap', 'overtake'];

/** Build the initial world: cars placed on the grid (race) / on track (practice, quali, time trial). */
export function createWorld(config: SessionConfig, track: BuiltTrack): WorldState {
  return buildWorld(config, track);
}

/**
 * Advance the whole session by dt (= SIM_DT). `inputs[playerIndex]` is the human input for that player (null = none).
 * One-shot flags in inputs are honoured exactly once per call. Appends GameEvents to world.events.
 * Pure function of (world, inputs) — deterministic for a given seed.
 */
export function stepWorld(world: WorldState, track: BuiltTrack, inputs: (ControlInput | null)[], dt: number): void {
  advanceWorld(world, track, inputs, dt);
}

function carById(world: WorldState, carId: number): CarEntry | null {
  return Number.isInteger(carId) && carId >= 0 && carId < world.cars.length ? world.cars[carId] : null;
}

/** Pit request for the next pass of the pit entry (box this lap). Updates the compound if already queued / in the lane. */
export function requestPit(world: WorldState, carId: number, compound: TireCompound): void {
  const car = carById(world, carId);
  if (car) queuePit(world, car, compound);
}

/** Cancel a pit request that has not reached the pit entry yet. */
export function cancelPit(world: WorldState, carId: number): void {
  const car = carById(world, carId);
  if (car && car.pit.phase === 'none') car.pit.requested = false;
}

/** Select an ERS mode (physics overrides it every step while the car's ersAssist is on). */
export function setErsMode(world: WorldState, carId: number, mode: ErsMode): void {
  const car = carById(world, carId);
  if (car && ERS_MODES.includes(mode)) car.phys.ers.mode = mode;
}

/** Player retires (race) / ends session early. */
export function retireCar(world: WorldState, carId: number, reason: string): void {
  const car = carById(world, carId);
  if (car) retire(world, car, typeof reason === 'string' ? reason : '');
}

/**
 * World time a flashback has to go back before to undo this car's crash: when its suspension broke, else when it
 * retired (null = nothing to undo).
 */
export function crashTime(world: WorldState, carId: number): number | null {
  const car = carById(world, carId);
  if (!car) return null;
  return car.race.brokenAt ?? (car.status === 'retired' ? car.race.retiredAt : null);
}

/** True once results are final (all cars classified, or time trial/practice ended by the player). */
export function isSessionOver(world: WorldState): boolean {
  return sessionOver(world);
}

/** Player chooses to end a practice / time trial / qualifying session now. */
export function endSession(world: WorldState): void {
  requestEnd(world);
}

/**
 * Race fast-forward fallback: classify every car still racing at the finish its average pace predicts, then end
 * the session (any other session simply ends).
 */
export function concludeRace(world: WorldState, track: BuiltTrack): void {
  conclude(world, track);
}

/** Independent deep copy (structuredClone) for flashback. */
export function snapshotWorld(world: WorldState): WorldState {
  return structuredClone(world);
}

/** View-model for renderer + audio (includes the time-trial ghost car with carId -1 if config.ghost). */
export function buildRenderFrame(world: WorldState, track: BuiltTrack): RenderFrame {
  return renderFrame(world, track);
}

/** Live classification for HUD timing tower. */
export function getStandings(world: WorldState): StandingRow[] {
  return standings(world);
}

/** Final classification (call when isSessionOver). Points per POINTS_TABLE for races; objective evaluated if set. */
export function buildSessionResult(world: WorldState): SessionResult {
  return sessionResult(world);
}

/**
 * Qualifying for cars not driven by humans: simulated best lap times from referenceLapTime, team/driver ratings,
 * difficulty, weather and seeded noise. Returns lap time per driverId.
 */
export function simulateLapTimes(config: SessionConfig, track: BuiltTrack): Record<string, number> {
  return simulateQualifying(config, track);
}

/** Best-lap ghost of a car recorded during the session (time trial), or null. */
export function extractGhost(world: WorldState, carId: number): GhostData | null {
  return ghostOf(world, carId);
}

/** Car id driven by a human player (0–3), or -1. */
export function getPlayerCarId(world: WorldState, playerIndex: PlayerIndex = 0): number {
  const car = world.cars.find((c) => c.playerIndex === playerIndex);
  return car ? car.id : -1;
}

/** Ids of all human-driven cars (player 0 first). */
export function playerCarIds(world: WorldState): number[] {
  return world.cars
    .filter((c) => c.playerIndex !== -1)
    .sort((a, b) => a.playerIndex - b.playerIndex)
    .map((c) => c.id);
}

/**
 * Debug / test hook: create an incident answered with `kind` right now (yellow flag, VSC, safety car or red flag).
 * Returns false when the session is not a race in phase 'running' or a neutralisation is already active.
 */
export function forceIncident(world: WorldState, track: BuiltTrack, kind: 'yellow' | 'vsc' | 'sc' | 'red'): boolean {
  return forceRaceIncident(world, track, kind);
}
