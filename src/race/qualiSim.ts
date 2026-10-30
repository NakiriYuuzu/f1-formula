/**
 * Qualifying lap-time simulation for cars not driven by humans. Each AI driver's lap is predicted with a
 * quasi-steady point-mass lap simulation on the racing line using the same capability model and pace parameters
 * as the on-track AI (car spec from team ratings — the closer AI ratings for AI-only teams — and part development, difficulty, driver pace, wet skill, weather / compound, rubber,
 * DRS on straights, trail braking and kerb use from pace / consistency), scaled by a calibration factor fitted to headless AI flying laps, plus ~0.15 % seeded noise.
 */
import type { BuiltTrack, CarPartGains, CarSpec, DriverDef, SessionConfig, TeamDef, TireCompound, WeatherKind } from '../core/types';
import { AIR_DENSITY, nextRandom } from '../core/math';
import { DEFAULT_SETUP } from '../core/defaults';
import {
  aiCarTeam,
  capability,
  cornerSpeed,
  brakingDecel,
  difficulty01,
  driverStyle,
  kerbSkill,
  paceParams,
  styleFactors,
  styleGrip,
  trailBraking,
  wetBrakeFactor,
  wetPaceFactor,
  wetTechnique,
  type Capability,
} from '../ai/index';
import { createCarSpec, tyreGrip } from '../physics/index';
import { inRangeS } from '../track/track';
import { kerbData, lineData } from '../ai/profile';

/**
 * Calibration: real AI flying laps / point-mass prediction, fitted in headless runs (solo AI qualifying laps on
 * several layouts, teams, difficulties, weather and both regulations; residual ≈ ±0.6 %). Phase 2 refit (with
 * ERS_SHARE / POWER_SHARE / TRACTION_SHARE): best of 2 timed laps, 1920 runs — 20 layouts × 8 drivers (4 teams each
 * set) × difficulty 0–110 × dry / light rain / heavy rain × 2025 / 2026: residual rms 0.58 % (90 % within ±1 %,
 * extremes −2.0 / +1.9 %); fitted on 12 layouts / 4 drivers, the other 8 layouts / 4 drivers hold out at 0.57 % rms.
 */
export function qualiCalibration(difficulty: number, regulation: SessionConfig['regulation']): number {
  return (0.989 + 0.034 * difficulty01(difficulty)) * (regulation === '2026' ? 0.998 : 1);
}
/** Seeded per-driver noise amplitude (fraction of the lap time). */
const NOISE = 0.0015;
/**
 * Average ERS deployment fraction on full throttle over a flying lap (ERS assist cycles medium / hotlap). 2026: the
 * 4 MJ battery cannot hold the 350 kW hotlap deploy for a lap — measured 0.40–0.48 on the straights (2025: 0.67–0.81).
 */
const ERS_SHARE: Record<SessionConfig['regulation'], number> = { '2025': 0.7, '2026': 0.42 };
/** Share of the peak ICE + ERS wheel power a flying lap averages on full throttle (power curve, shift cuts; fitted). */
const POWER_SHARE = 0.9;
/** Share of the friction circle left after cornering that drives the car out of a corner (AI on medium TC; fitted). */
const TRACTION_SHARE = 0.81;
const QUALI_FUEL = 10;
const QUALI_RUBBER = 0.45;
const WETNESS: Record<WeatherKind, number> = { clear: 0, overcast: 0, lightRain: 0.45, heavyRain: 0.9 };

/** Compound an AI picks for a flying lap at this wetness. */
export function qualifyingCompound(wetness: number): TireCompound {
  if (wetness > 0.7) return 'wet';
  if (wetness > 0.35) return 'inter';
  return 'soft';
}

export interface LapPrediction {
  spec: CarSpec;
  cap: Capability;
  power: number;
  mass: number;
}

/**
 * Point-mass lap time (s) on the racing line for a capability, power (W) and mass: corner limits, forward pass
 * (power, traction share, drag), backward braking pass, iterated around the closed loop. `kerbUse` (0..1) blends the
 * line's curvature toward the kerb-use line (as the on-track AI drives it).
 */
export function pointMassLap(track: BuiltTrack, spec: CarSpec, cap: Capability, power: number, mass: number, kerbUse = 0): number {
  const n = track.count;
  if (n < 4) return track.referenceLapTime;
  const line = lineData(track);
  const ku = Number.isFinite(kerbUse) ? Math.min(1, Math.max(0, kerbUse)) : 0;
  let curv = line.curv;
  let ds = line.ds;
  if (ku > 0) {
    const kerb = kerbData(track);
    curv = new Float64Array(n);
    ds = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      curv[i] = line.curv[i] + ku * (kerb.curv[i] - line.curv[i]);
      ds[i] = line.ds[i] + ku * (kerb.ds[i] - line.ds[i]);
    }
  }
  const lim = new Float64Array(n);
  let start = 0;
  for (let i = 0; i < n; i++) {
    lim[i] = Math.max(5, cornerSpeed(cap, curv[i]));
    if (lim[i] < lim[start]) start = i;
  }
  const drsDrag = new Float64Array(n).fill(1);
  for (const z of track.drsZones) {
    for (let i = 0; i < n; i++) if (inRangeS(track, i * track.spacing, z.activation, z.end)) drsDrag[i] = spec.drsDragScale;
  }
  const v = Float64Array.from(lim);
  const dragK = (0.5 * AIR_DENSITY * spec.dragArea) / mass;
  for (let iter = 0; iter < 6; iter++) {
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const j = (i + 1) % n;
      const vi = Math.max(3, v[i]);
      const grip = cap.latA + cap.latB * vi * vi;
      const lat = vi * vi * Math.abs(curv[i]);
      const traction = TRACTION_SHARE * Math.sqrt(Math.max(0, grip * grip - lat * lat));
      const drive = Math.min(power / (mass * vi), traction);
      const a = drive - dragK * drsDrag[i] * vi * vi - 0.11;
      const reach = Math.sqrt(Math.max(0, vi * vi + 2 * a * ds[i]));
      if (reach < v[j]) v[j] = reach;
    }
    for (let k = 0; k < n; k++) {
      const j = (start - k + n) % n;
      const i = (j - 1 + n) % n;
      const reach = Math.sqrt(v[j] * v[j] + 2 * brakingDecel(cap, v[j], curv[j]) * ds[i]);
      if (reach < v[i]) v[i] = reach;
    }
  }
  let t = 0;
  for (let i = 0; i < n; i++) t += ds[i] / Math.max(1, 0.5 * (v[i] + v[(i + 1) % n]));
  return Number.isFinite(t) && t > 0 ? t : track.referenceLapTime;
}

/** Predicted flying-lap time (s) of an AI driver in a team car with its part development (no calibration / noise). */
export function predictLapTime(
  track: BuiltTrack,
  team: TeamDef,
  driver: DriverDef,
  difficulty: number,
  regulation: SessionConfig['regulation'],
  wetness: number,
  parts: CarPartGains = {},
): number {
  const spec = createCarSpec(team, DEFAULT_SETUP, regulation, parts);
  const sk = driver.skill;
  const pace = paceParams(difficulty, sk.pace);
  const wetF = wetPaceFactor(wetness, sk.wet);
  const wetT = wetTechnique(wetness, sk.wet);
  const compound = qualifyingCompound(wetness);
  const tyre = tyreGrip(compound, 0, compoundMidTemp(compound), wetness);
  const grip = tyre * (1 + 0.03 * QUALI_RUBBER) * (1 + (pace.performance - 1) * 0.6);
  // the driver's style, as the on-track AI applies it (createAIState / driveAI)
  const style = styleFactors(driverStyle(driver));
  const brakeF = Math.min(0.99, Math.min(0.97, pace.brakeFactor * style.brake) * wetF * wetBrakeFactor(wetness, sk.wet));
  const trail = trailBraking(difficulty, sk.pace, sk.consistency) * wetT;
  const cap = capability(spec, grip, QUALI_FUEL, pace.latFactor * wetF, brakeF, undefined, trail);
  cap.latA *= styleGrip(style.low, pace.latFactor);
  cap.latB *= styleGrip(style.high, pace.latFactor);
  const mass = spec.mass + QUALI_FUEL;
  const power = (spec.icePower * pace.performance + spec.ersPower * (ERS_SHARE[regulation] ?? ERS_SHARE['2025']) * pace.performance) * spec.drivetrainEfficiency * POWER_SHARE;
  return pointMassLap(track, spec, cap, power, mass, kerbSkill(difficulty, sk.pace, sk.consistency) * wetT);
}

function compoundMidTemp(c: TireCompound): number {
  switch (c) {
    case 'soft':
      return 92;
    case 'medium':
      return 97;
    case 'hard':
      return 100;
    case 'inter':
      return 62;
    case 'wet':
      return 52;
  }
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Solo qualifying benchmark: the best simulated lap of the AI field that is not on track, split into sectors by
 * the reference speed profile. Purple (overall best) timing must beat it, otherwise a lone player would see
 * every lap and sector purple while the classification (which includes these simulated laps) ranks them lower.
 */
export function qualifyingBenchmark(config: SessionConfig, track: BuiltTrack, onTrack: readonly string[]): { lap: number; sectors: [number, number, number] } | null {
  const sim = simulateQualifying(config, track);
  let lap = Infinity;
  for (const [id, t] of Object.entries(sim)) if (!onTrack.includes(id) && t < lap) lap = t;
  if (!Number.isFinite(lap)) return null;
  const ref = [0, 0, 0];
  for (let i = 0; i < track.count; i++) {
    const s = track.s[i] ?? i * track.spacing;
    const k = s >= track.sectorStarts[2] ? 2 : s >= track.sectorStarts[1] ? 1 : 0;
    ref[k] += track.spacing / Math.max(1, track.speedProfile[i] ?? 1);
  }
  const total = ref[0] + ref[1] + ref[2];
  if (!(total > 0)) return null;
  return { lap, sectors: [(lap * ref[0]) / total, (lap * ref[1]) / total, (lap * ref[2]) / total] };
}

/** Simulated best lap (s) per non-human driverId in the session roster. */
export function simulateQualifying(config: SessionConfig, track: BuiltTrack): Record<string, number> {
  const out: Record<string, number> = {};
  const humans = new Set(config.players.map((p) => p.driverId));
  const humanTeams = new Set(config.players.map((p) => p.teamId));
  for (const g of config.grid) {
    if (g.playerIndex === -1) continue;
    humans.add(g.driverId);
    humanTeams.add(g.teamId);
  }
  const wetness = WETNESS[config.weather] ?? 0;
  const cache = new Map<string, number>();
  const calibration = qualiCalibration(config.aiDifficulty, config.regulation);
  const seed = Number.isFinite(config.seed) ? Math.floor(Math.abs(config.seed)) >>> 0 : 1;
  for (const driver of config.drivers) {
    if (humans.has(driver.id)) continue;
    const team = config.teams.find((t) => t.id === driver.teamId);
    if (!team) continue;
    const key = `${team.id}|${driver.id}|${driver.skill.pace}|${driver.skill.wet}|${driver.skill.consistency}`;
    let base = cache.get(key);
    if (base === undefined) {
      // same car as on track (world.ts): AI-only teams run the closer AI car ratings, plus the team's part development
      const carTeam = humanTeams.has(team.id) ? team : aiCarTeam(team);
      const parts = config.development?.[team.id] ?? {};
      base = predictLapTime(track, carTeam, driver, config.aiDifficulty, config.regulation, wetness, parts) * calibration;
      cache.set(key, base);
    }
    const rng = { s: (seed ^ hashString(driver.id) ^ hashString(track.id)) >>> 0 };
    const noise = (nextRandom(rng) * 2 - 1) * NOISE;
    const time = base * (1 + noise);
    if (Number.isFinite(time) && time > 0) out[driver.id] = Math.round(time * 1000) / 1000;
  }
  return out;
}
