/**
 * Weather: initial state from the session config, a seeded forecast for dynamic weather, and per-step evolution —
 * rain intensity eases toward the current kind's level, track water lags the rain (fast wetting, slow
 * temperature-dependent drying), temperatures follow the sky, rubber builds up in the dry and washes off in rain.
 */
import type { BuiltTrack, SessionConfig, WeatherKind, WeatherState, WorldState } from '../core/types';
import { clamp, clamp01, moveToward, nextRandom, type RngState } from '../core/math';
import { emit, fin } from './events';

/** Rain intensity each weather kind settles at. */
export const RAIN_LEVEL: Record<WeatherKind, number> = { clear: 0, overcast: 0, lightRain: 0.42, heavyRain: 0.92 };
/** Track water level each kind settles at (lags the rain). */
const WETNESS_LEVEL: Record<WeatherKind, number> = { clear: 0, overcast: 0, lightRain: 0.45, heavyRain: 0.9 };
const BIOME_TEMP: Record<string, number> = { desert: 8, city: 2, coastal: 0, temperate: -2, autumn: -6 };
const TIME_TEMP: Record<string, number> = { day: 26, dusk: 22, night: 19 };
const SUN_HEAT: Record<string, number> = { day: 14, dusk: 7, night: 3 };

function airTemperature(config: SessionConfig, track: BuiltTrack, kind: WeatherKind): number {
  const base = (TIME_TEMP[config.timeOfDay] ?? 24) + (BIOME_TEMP[track.def.biome] ?? 0);
  const sky = kind === 'clear' ? 0 : kind === 'overcast' ? -3 : kind === 'lightRain' ? -5 : -7;
  return base + sky;
}

function trackTemperature(config: SessionConfig, air: number, kind: WeatherKind): number {
  const sun = kind === 'clear' ? (SUN_HEAT[config.timeOfDay] ?? 10) : kind === 'overcast' ? 4 : 0;
  return air + sun - (kind === 'heavyRain' ? 4 : kind === 'lightRain' ? 2 : 0);
}

/** Next kind in a dynamic forecast: dry skies tend toward rain, rain tends to ease. */
function nextKind(kind: WeatherKind, rng: RngState): WeatherKind {
  const r = nextRandom(rng);
  switch (kind) {
    case 'clear':
      return r < 0.65 ? 'lightRain' : 'overcast';
    case 'overcast':
      return r < 0.7 ? 'lightRain' : 'clear';
    case 'lightRain':
      return r < 0.45 ? 'heavyRain' : 'overcast';
    case 'heavyRain':
      return r < 0.75 ? 'lightRain' : 'overcast';
  }
}

/** Initial weather. `duration` = expected session length (s) used to place forecast changes. */
export function createWeather(config: SessionConfig, track: BuiltTrack, rng: RngState, duration: number): WeatherState {
  const kind: WeatherKind = config.kind === 'timeTrial' ? 'clear' : config.weather;
  const dynamic = config.dynamicWeather && config.kind !== 'timeTrial';
  const forecast: { time: number; kind: WeatherKind }[] = [];
  if (dynamic) {
    const span = Math.max(120, fin(duration, 600));
    const changes = 1 + (nextRandom(rng) < 0.5 ? 1 : 0);
    const times: number[] = [];
    for (let i = 0; i < changes; i++) times.push(span * (0.18 + 0.6 * nextRandom(rng)));
    times.sort((a, b) => a - b);
    let k = kind;
    for (const t of times) {
      k = nextKind(k, rng);
      forecast.push({ time: Math.round(t), kind: k });
    }
  }
  const air = airTemperature(config, track, kind);
  const rubber = config.kind === 'timeTrial' ? 0.6 : config.kind === 'race' ? 0.35 : config.kind === 'qualifying' ? 0.45 : 0.25;
  return {
    kind,
    rain: RAIN_LEVEL[kind],
    wetness: WETNESS_LEVEL[kind],
    dynamic,
    forecast,
    airTemp: air,
    trackTemp: trackTemperature(config, air, kind),
    rubber: kind === 'lightRain' || kind === 'heavyRain' ? rubber * 0.5 : rubber,
  };
}

/** Step (s) of the wetness prediction. */
const PREDICT_STEP = 1;

/**
 * Track wetness expected `ahead` seconds after world time `now`: the forecast entries become current at their times,
 * the rain eases toward each kind's level and the water follows it (the rates of stepWeather; the track temperature is
 * held at its current value). Pure — used by the AI strategy to read the forecast.
 */
export function predictWetness(w: WeatherState, now: number, ahead: number): number {
  let kind = w.kind;
  let rain = clamp01(fin(w.rain));
  let wet = clamp01(fin(w.wetness));
  const dryRate = 0.0022 * (1 + Math.max(0, fin(w.trackTemp, 25) - 18) / 22);
  const span = Math.max(0, fin(ahead));
  let next = 0;
  for (let t = 0; t < span; t += PREDICT_STEP) {
    const h = Math.min(PREDICT_STEP, span - t);
    while (next < w.forecast.length && fin(now) + t >= w.forecast[next].time) kind = w.forecast[next++].kind;
    rain = clamp01(moveToward(rain, RAIN_LEVEL[kind], h / 70));
    const target = clamp01(rain * (WETNESS_LEVEL.heavyRain / RAIN_LEVEL.heavyRain));
    wet = wet < target ? clamp01(wet + (target - wet) * (1 - Math.exp(-h / 30))) : Math.max(target, wet - dryRate * h);
  }
  return wet;
}

/** Advance the weather by dt; emits weatherChange when a forecast entry becomes current. */
export function stepWeather(world: WorldState, track: BuiltTrack, dt: number): void {
  const w = world.weather;
  while (w.forecast.length > 0 && world.time >= w.forecast[0].time) {
    const next = w.forecast.shift();
    if (next && next.kind !== w.kind) {
      w.kind = next.kind;
      emit(world, { type: 'weatherChange', kind: next.kind });
    }
  }
  const rainTarget = RAIN_LEVEL[w.kind];
  w.rain = clamp01(moveToward(fin(w.rain), rainTarget, dt / 70));
  const wetTarget = clamp01(w.rain * (WETNESS_LEVEL.heavyRain / RAIN_LEVEL.heavyRain));
  const wet = clamp01(fin(w.wetness));
  if (wet < wetTarget) {
    w.wetness = clamp01(wet + (wetTarget - wet) * (1 - Math.exp(-dt / 30)));
  } else {
    const dryRate = 0.0022 * (1 + Math.max(0, fin(w.trackTemp, 25) - 18) / 22);
    w.wetness = Math.max(wetTarget, wet - dryRate * dt);
  }
  const air = airTemperature(world.config, track, w.kind);
  w.airTemp = moveToward(fin(w.airTemp, air), air, dt / 60);
  const tt = trackTemperature(world.config, w.airTemp, w.kind) - 10 * w.wetness;
  w.trackTemp = moveToward(fin(w.trackTemp, tt), tt, dt / 40);
  const rubber = clamp01(fin(w.rubber));
  w.rubber = clamp(rubber + dt * (w.wetness < 0.15 ? 0.0004 * (1 - rubber) : -0.0012 * w.rain), 0, 1);
  if (w.wetness > world.race.maxWetness) world.race.maxWetness = w.wetness;
}
