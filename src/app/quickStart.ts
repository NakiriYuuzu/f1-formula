/**
 * URL quick start (pure): `?quick=race|quali|practice|tt|split&layout=<id>&laps=N&weather=<kind>&reg=2025|2026&ai=0..110`
 * (+ optional `seed`, `sc=off|reduced|standard|increased`, `redflag=0|1`, `formation=0|1`, `wake=0|1`, `sprint=1`) → QuickStartParams for meta/sessionBuilder.buildQuickStart. Invalid values are dropped so
 * the builder's defaults apply; an absent / unknown `quick` means "no quick start".
 */
import { clamp } from '../core/math';
import { SAFETY_CAR_SETTINGS } from '../meta/guards';
import type { QuickKind, QuickStartParams } from '../meta/sessionBuilder';

const QUICK_KINDS: readonly QuickKind[] = ['race', 'quali', 'practice', 'tt', 'split'];
const AI_MIN = 0;
const AI_MAX = 110;
const LAPS_MAX = 200;

function intParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.round(v) : null;
}

/** 0 / 1 → false / true; anything else → null (default applies). */
function flagParam(params: URLSearchParams, name: string): boolean | null {
  const raw = params.get(name);
  return raw === '1' ? true : raw === '0' ? false : null;
}

/**
 * Parse a location.search string. `isLayout` validates layout ids (unknown ids are omitted → first layout).
 * Returns null when the URL does not request a quick start.
 */
export function parseQuickStart(search: string, isLayout: (id: string) => boolean): QuickStartParams | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const quick = params.get('quick');
  const kind = QUICK_KINDS.find((k) => k === quick);
  if (!kind) return null;
  const out: QuickStartParams = { kind };
  const layout = params.get('layout');
  if (layout && isLayout(layout)) out.layoutId = layout;
  const laps = intParam(params, 'laps');
  if (laps !== null && laps >= 1) out.laps = Math.min(laps, LAPS_MAX);
  const weather = params.get('weather');
  if (weather) out.weather = weather;
  const reg = params.get('reg');
  if (reg === '2025' || reg === '2026') out.regulation = reg;
  const ai = intParam(params, 'ai');
  if (ai !== null) out.aiDifficulty = clamp(ai, AI_MIN, AI_MAX);
  const sc = SAFETY_CAR_SETTINGS.find((s) => s === params.get('sc'));
  if (sc) out.safetyCar = sc;
  const redFlag = flagParam(params, 'redflag');
  if (redFlag !== null) out.redFlags = redFlag;
  const formation = flagParam(params, 'formation');
  if (formation !== null) out.formationLap = formation;
  const wake = flagParam(params, 'wake');
  if (wake !== null) out.aeroWake = wake;
  if (params.get('sprint') === '1') out.sprint = true;
  const seed = intParam(params, 'seed');
  if (seed !== null) out.seed = seed >>> 0;
  return out;
}
