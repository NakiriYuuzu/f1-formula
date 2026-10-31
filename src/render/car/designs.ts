/**
 * Body concepts of the 2026 cars: every car follows the same rules (dims.ts), but teams differ in where the nose meets
 * the front wing and how wide / high it is, the sidepod concept (inlet shape, how the top falls away, undercut), the
 * engine cover (saddle cooler, serrated spine into the fin), cooling louvres, the airbox intake and the wing endplate
 * details — the spread seen across the real 2026 grid, assigned to the fictional teams by team code. Unknown codes
 * (custom / career teams) get BASE_DESIGN. Geometry is cached per design id (carGeometry.acquireCarGeometry).
 */
import { carDims, type CarDims } from './dims';

export type NoseTip = 'main' | 'middle';
export type PodInlet = 'oval' | 'letterbox' | 'overbite' | 'tall';
export type FrontEndplate = 'diveplane' | 'winglet' | 'squared';
export type RearEndplate = 'round' | 'swage';

export interface CarDesign {
  /** geometry cache key */
  id: string;
  nose: {
    /** element the nose tip meets: the mainplane (long nose) or the middle element (short nose) */
    tip: NoseTip;
    /** width multiplier of the front of the nose (wide ≈ 1.3, slender ≈ 0.85) */
    width: number;
    /** raise (m) of the nose front (high noses come with a cockpit further forward) */
    lift: number;
  };
  pod: {
    inlet: PodInlet;
    /** height (m) of the sidepod top at the inlet */
    inletTop: number;
    /** fore-aft shift (m, + forward) of the inlet */
    inletShift: number;
    /** how fast the top falls behind the inlet: 0 = level shoulder, 1 = steep downwash ramp */
    downwash: number;
    /** undercut multiplier (0.6 = shallow, 1.3 = full-length deep undercut) */
    undercut: number;
    /** width multiplier (thin tube pods ≈ 0.82, wide tops ≈ 1.08) */
    width: number;
  };
  cover: {
    /** saddle cooler bulge (m) on the engine cover above the power unit */
    saddle: number;
    /** serrated spine running into the shark fin */
    serrated: boolean;
  };
  /** rows of cooling louvres on each sidepod top (0 = none) */
  louvres: number;
  /** airbox intake size multiplier (large inlet with small pods, small with generous radiator inlets) */
  airbox: number;
  frontEndplate: FrontEndplate;
  rearEndplate: RearEndplate;
  /** spokes of the team's open 18" rim (no wheel covers since 2026) */
  rimSpokes: number;
}

/** The plain 2026 car (also every team without its own concept). */
export const BASE_DESIGN: CarDesign = {
  id: 'base',
  nose: { tip: 'main', width: 1, lift: 0 },
  pod: { inlet: 'oval', inletTop: 0.66, inletShift: 0, downwash: 0.35, undercut: 1, width: 1 },
  cover: { saddle: 0, serrated: false },
  louvres: 0,
  airbox: 1,
  frontEndplate: 'diveplane',
  rearEndplate: 'round',
  rimSpokes: 10,
};

const design = (id: string, d: Omit<CarDesign, 'id'>): CarDesign => ({ id, ...d });

/** Team code → body concept (fictional teams, data/teams.ts). */
export const TEAM_DESIGNS: Readonly<Record<string, CarDesign>> = {
  // low nose on the mainplane, generous inlets, full-length undercut with a strong downwash, serrated spine
  VAN: design('VAN', {
    nose: { tip: 'main', width: 0.88, lift: -0.02 },
    pod: { inlet: 'oval', inletTop: 0.66, inletShift: 0.04, downwash: 0.75, undercut: 1.25, width: 1 },
    cover: { saddle: 0, serrated: true },
    louvres: 0,
    airbox: 0.85,
    frontEndplate: 'diveplane',
    rearEndplate: 'round',
    rimSpokes: 10,
  }),
  // high nose (cockpit forward), overbite inlet, gentle downwash
  AUR: design('AUR', {
    nose: { tip: 'main', width: 1, lift: 0.06 },
    pod: { inlet: 'overbite', inletTop: 0.64, inletShift: 0, downwash: 0.25, undercut: 1, width: 0.94 },
    cover: { saddle: 0, serrated: false },
    louvres: 2,
    airbox: 1,
    frontEndplate: 'winglet',
    rearEndplate: 'round',
    rimSpokes: 12,
  }),
  // wide nose, thin tube pods with a fuller undercut
  KES: design('KES', {
    nose: { tip: 'main', width: 1.3, lift: 0 },
    pod: { inlet: 'tall', inletTop: 0.62, inletShift: -0.04, downwash: 0.45, undercut: 1.2, width: 0.82 },
    cover: { saddle: 0.03, serrated: false },
    louvres: 0,
    airbox: 1.1,
    frontEndplate: 'squared',
    rearEndplate: 'swage',
    rimSpokes: 14,
  }),
  // short nose on the middle element, wide top rising towards the rear behind a narrow inlet, louvre panel
  NRD: design('NRD', {
    nose: { tip: 'middle', width: 1, lift: 0.02 },
    pod: { inlet: 'tall', inletTop: 0.6, inletShift: 0, downwash: 0, undercut: 1.3, width: 1.08 },
    cover: { saddle: 0, serrated: false },
    louvres: 3,
    airbox: 1,
    frontEndplate: 'diveplane',
    rearEndplate: 'round',
    rimSpokes: 9,
  }),
  // wide nose, tiny heavily downwashing pods around small letterbox inlets, big airbox, saddle cooler
  HLX: design('HLX', {
    nose: { tip: 'main', width: 1.25, lift: 0 },
    pod: { inlet: 'letterbox', inletTop: 0.58, inletShift: 0.06, downwash: 1, undercut: 0.7, width: 0.86 },
    cover: { saddle: 0.05, serrated: false },
    louvres: 0,
    airbox: 1.3,
    frontEndplate: 'winglet',
    rearEndplate: 'round',
    rimSpokes: 12,
  }),
  // slender elongated nose, wide shallow pods angled steeply down, steep endplate swage
  MER: design('MER', {
    nose: { tip: 'main', width: 0.82, lift: 0.01 },
    pod: { inlet: 'letterbox', inletTop: 0.6, inletShift: 0, downwash: 0.85, undercut: 0.75, width: 1.06 },
    cover: { saddle: 0, serrated: false },
    louvres: 1,
    airbox: 1,
    frontEndplate: 'winglet',
    rearEndplate: 'swage',
    rimSpokes: 10,
  }),
  // short nose, overbite inlet, serrated spine
  TMP: design('TMP', {
    nose: { tip: 'middle', width: 0.95, lift: 0.04 },
    pod: { inlet: 'overbite', inletTop: 0.65, inletShift: 0.02, downwash: 0.55, undercut: 1.1, width: 0.95 },
    cover: { saddle: 0, serrated: true },
    louvres: 0,
    airbox: 0.95,
    frontEndplate: 'squared',
    rearEndplate: 'round',
    rimSpokes: 14,
  }),
  // plain conservative car: level shoulder, oval inlet, louvres
  SOL: design('SOL', {
    nose: { tip: 'main', width: 1.05, lift: 0 },
    pod: { inlet: 'oval', inletTop: 0.66, inletShift: 0, downwash: 0.15, undercut: 0.9, width: 1 },
    cover: { saddle: 0.02, serrated: false },
    louvres: 2,
    airbox: 1,
    frontEndplate: 'diveplane',
    rearEndplate: 'round',
    rimSpokes: 12,
  }),
  // high nose, tall inlets, strong downwash
  IRB: design('IRB', {
    nose: { tip: 'main', width: 0.92, lift: 0.07 },
    pod: { inlet: 'tall', inletTop: 0.66, inletShift: 0.03, downwash: 0.7, undercut: 1.15, width: 0.92 },
    cover: { saddle: 0, serrated: false },
    louvres: 1,
    airbox: 1.15,
    frontEndplate: 'squared',
    rearEndplate: 'swage',
    rimSpokes: 9,
  }),
  // short wide nose, letterbox inlets, saddle cooler, serrated spine
  CRV: design('CRV', {
    nose: { tip: 'middle', width: 1.2, lift: 0 },
    pod: { inlet: 'letterbox', inletTop: 0.62, inletShift: -0.02, downwash: 0.5, undercut: 1, width: 0.9 },
    cover: { saddle: 0.04, serrated: true },
    louvres: 2,
    airbox: 1.05,
    frontEndplate: 'diveplane',
    rearEndplate: 'swage',
    rimSpokes: 7,
  }),
};

/** Nose tip z of a short nose resting on the middle front-wing element (the long nose ends over the mainplane). */
const SHORT_NOSE_TIP_Z = 2.4;

/** Car dimensions with the design's nose length. */
export function designDims(design: CarDesign): CarDims {
  const d = carDims();
  return design.nose.tip === 'middle' ? { ...d, noseTipZ: SHORT_NOSE_TIP_Z } : d;
}

/** Body concept for a team code (BASE_DESIGN for custom / unknown teams). */
export function designForTeam(teamShort: string | undefined): CarDesign {
  return (teamShort && TEAM_DESIGNS[teamShort.toUpperCase()]) || BASE_DESIGN;
}
