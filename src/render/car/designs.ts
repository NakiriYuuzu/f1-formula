/**
 * Body concepts of the 2026 cars: every car follows the same rules (dims.ts), but teams differ in where the nose meets
 * the front wing and how wide / high it is, the sidepod concept (inlet shape, how the top falls away, undercut), the
 * engine cover (saddle cooler, serrated spine into the fin), cooling louvres, the airbox intake and the wing endplate
 * details — the spread seen across the real 2026 grid. Looked up by team id (TeamDef.id: the fictional teams of
 * data/teams.ts, the real 2026 teams of data/realGrid.ts); team codes are not unique across rosters. Unknown ids
 * (My Team, roster packs) get BASE_DESIGN. Geometry is cached per design id (carGeometry.acquireCarGeometry).
 */
import { carDims, type CarDims } from './dims';

export type NoseTip = 'main' | 'middle';
export type PodInlet = 'oval' | 'letterbox' | 'overbite' | 'tall';
export type FrontEndplate = 'diveplane' | 'winglet' | 'squared' | 'plain';
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

/** Team id → body concept: fictional teams (data/teams.ts). */
export const TEAM_DESIGNS: Readonly<Record<string, CarDesign>> = {
  // low nose on the mainplane, generous inlets, full-length undercut with a strong downwash, serrated spine
  vanta: design('vanta', {
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
  aurora: design('aurora', {
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
  kestrel: design('kestrel', {
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
  nordlys: design('nordlys', {
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
  helix: design('helix', {
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
  meridian: design('meridian', {
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
  tempest: design('tempest', {
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
  solace: design('solace', {
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
  ironbark: design('ironbark', {
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
  corvid: design('corvid', {
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

/**
 * Team id → body concept: the real 2026 teams (data/realGrid.ts), from launch-to-mid-season technical coverage (The Race
 * / Mark Hughes and Gary Anderson, Autosport, PlanetF1, RacingNews365, motorsport.tech); where the sources were silent
 * or disagreed, a plausible value. Approximations of the visible concept, not measurements.
 */
export const REAL_TEAM_DESIGNS: Readonly<Record<string, CarDesign>> = {
  // short nose on the middle element, held high; high inlets over a wide top and full-length undercut, coke louvres;
  // large footplate with a small fin
  mercedes: design('mercedes', {
    nose: { tip: 'middle', width: 1, lift: 0.06 },
    pod: { inlet: 'letterbox', inletTop: 0.67, inletShift: 0.02, downwash: 0.4, undercut: 1.3, width: 1.04 },
    cover: { saddle: 0, serrated: false },
    louvres: 2,
    airbox: 0.9,
    frontEndplate: 'squared',
    rearEndplate: 'round',
    rimSpokes: 10,
  }),
  // low narrow nose; P-shaped high inlets, high-waisted undercut, bulky pods; compact airbox, saw-tooth spine into the
  // fin; plain twisted endplates (no dive plane)
  ferrari: design('ferrari', {
    nose: { tip: 'main', width: 0.85, lift: -0.02 },
    pod: { inlet: 'tall', inletTop: 0.66, inletShift: 0, downwash: 0.3, undercut: 1.2, width: 1.06 },
    cover: { saddle: 0, serrated: true },
    louvres: 0,
    airbox: 0.85,
    frontEndplate: 'plain',
    rearEndplate: 'round',
    rimSpokes: 12,
  }),
  // high narrow nose; wide top with a steeper downslope, undercut stopping short of the coke; winglet-topped endplates
  mclaren: design('mclaren', {
    nose: { tip: 'main', width: 0.85, lift: 0.04 },
    pod: { inlet: 'oval', inletTop: 0.65, inletShift: 0.02, downwash: 0.75, undercut: 0.9, width: 1.05 },
    cover: { saddle: 0, serrated: false },
    louvres: 0,
    airbox: 1,
    frontEndplate: 'winglet',
    rearEndplate: 'round',
    rimSpokes: 10,
  }),
  // much wider nose; tiny radiator inlets, a full downwash ramp, big airbox; curved endplate into a narrow footplate
  'red-bull': design('red-bull', {
    nose: { tip: 'main', width: 1.3, lift: 0 },
    pod: { inlet: 'letterbox', inletTop: 0.6, inletShift: 0.04, downwash: 0.9, undercut: 1.1, width: 0.9 },
    cover: { saddle: 0.02, serrated: false },
    louvres: 0,
    airbox: 1.3,
    frontEndplate: 'plain',
    rearEndplate: 'round',
    rimSpokes: 10,
  }),
  // drooped teardrop inlet forming the shoulder, half ramp then an abrupt drop; endplate moved inboard over a big tray
  'racing-bulls': design('racing-bulls', {
    nose: { tip: 'main', width: 1, lift: 0.02 },
    pod: { inlet: 'oval', inletTop: 0.64, inletShift: 0, downwash: 0.6, undercut: 1, width: 0.95 },
    cover: { saddle: 0, serrated: false },
    louvres: 0,
    airbox: 1.1,
    frontEndplate: 'squared',
    rearEndplate: 'round',
    rimSpokes: 12,
  }),
  // a conservative pod concept with a level shoulder; large endplate strake
  alpine: design('alpine', {
    nose: { tip: 'main', width: 1, lift: 0 },
    pod: { inlet: 'oval', inletTop: 0.66, inletShift: 0, downwash: 0.3, undercut: 0.9, width: 1.04 },
    cover: { saddle: 0.02, serrated: false },
    louvres: 1,
    airbox: 1,
    frontEndplate: 'diveplane',
    rearEndplate: 'round',
    rimSpokes: 9,
  }),
  // long nose past the wing's leading edge; large high inlets, gills on the pod top, very deep undercut; big dive plane
  haas: design('haas', {
    nose: { tip: 'main', width: 1, lift: 0 },
    pod: { inlet: 'oval', inletTop: 0.68, inletShift: 0.04, downwash: 0.6, undercut: 1.3, width: 1 },
    cover: { saddle: 0, serrated: false },
    louvres: 3,
    airbox: 1.1,
    frontEndplate: 'diveplane',
    rearEndplate: 'round',
    rimSpokes: 10,
  }),
  // deep-chinned nose; inverted inlet reaching forward and up the side, top gully ramping into the floor; big dive plane
  audi: design('audi', {
    nose: { tip: 'main', width: 1.05, lift: -0.02 },
    pod: { inlet: 'tall', inletTop: 0.64, inletShift: 0.06, downwash: 0.8, undercut: 1.1, width: 0.95 },
    cover: { saddle: 0, serrated: false },
    louvres: 0,
    airbox: 1,
    frontEndplate: 'diveplane',
    rearEndplate: 'swage',
    rimSpokes: 12,
  }),
  // pods tapering down to the rear over a small undercut, a smaller inlet
  williams: design('williams', {
    nose: { tip: 'main', width: 0.95, lift: 0 },
    pod: { inlet: 'letterbox', inletTop: 0.63, inletShift: 0, downwash: 0.6, undercut: 0.8, width: 1 },
    cover: { saddle: 0, serrated: false },
    louvres: 0,
    airbox: 1,
    frontEndplate: 'diveplane',
    rearEndplate: 'swage',
    rimSpokes: 10,
  }),
  // wide nose on the second element; slim tube pods with a sharp downslope and a cavernous undercut, top louvres
  'aston-martin': design('aston-martin', {
    nose: { tip: 'middle', width: 1.25, lift: 0.02 },
    pod: { inlet: 'tall', inletTop: 0.62, inletShift: 0, downwash: 1, undercut: 1.3, width: 0.82 },
    cover: { saddle: 0, serrated: false },
    louvres: 3,
    airbox: 1.1,
    frontEndplate: 'winglet',
    rearEndplate: 'swage',
    rimSpokes: 14,
  }),
  // benign pods: a shallow, wide rounded inlet into the shoulder, a gentle ramp to the floor; large dive plane
  cadillac: design('cadillac', {
    nose: { tip: 'main', width: 1, lift: 0.01 },
    pod: { inlet: 'letterbox', inletTop: 0.65, inletShift: 0, downwash: 0.5, undercut: 0.9, width: 1.05 },
    cover: { saddle: 0, serrated: false },
    louvres: 0,
    airbox: 1,
    frontEndplate: 'diveplane',
    rearEndplate: 'round',
    rimSpokes: 10,
  }),
};

/** Body concept of a team (by TeamDef.id; BASE_DESIGN for My Team and unknown teams). */
export function designForTeam(teamId: string | undefined): CarDesign {
  if (!teamId) return BASE_DESIGN;
  if (Object.hasOwn(TEAM_DESIGNS, teamId)) return TEAM_DESIGNS[teamId];
  if (Object.hasOwn(REAL_TEAM_DESIGNS, teamId)) return REAL_TEAM_DESIGNS[teamId];
  return BASE_DESIGN;
}
