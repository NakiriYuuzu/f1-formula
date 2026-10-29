/**
 * The broadcast-style original themes (pure data, see musicScore.ts for the shared helpers and the race track):
 *
 * - "Lights Out" (menus): a cinematic grid-walk theme in E minor at 126 BPM. A driving 3-3-2 string ostinato under
 *   an octave-doubled brass melody, toms and crashes. 32 bars:
 *     intro (4)  build (8)  theme (8)  bridge (4)  theme 2 (8)
 *   The last bar is the B major dominant, which resolves into the intro's E minor.
 * - "Champagne" (results): a triumphant podium anthem in D major at 100 BPM. Brass fanfare over timpani, a
 *   half-time anthem and a full-band lift. 24 bars:
 *     fanfare (4)  anthem (8)  lift (8)  turn (4)
 *   The turn ends on A major, which resolves into the fanfare's D major.
 *
 * Composed for this game: the progressions and melodies quote no existing song or broadcast theme.
 */
import {
  chord,
  loopEvents,
  note,
  POLE_POSITION,
  sectionLayout,
  STEPS_PER_BAR,
  type Chord,
  type MusicEvent,
  type MusicScene,
  type MusicVoice,
  type Phrase,
  type Score,
} from './musicScore';

/** bar index inside its section, step in bar, the bar's chord → events */
type Layer = (b: number, k: number, c: Chord, out: MusicEvent[]) => void;

interface ThemeSection {
  name: string;
  chords: readonly string[];
  layers: readonly Layer[];
}

const ev = (voice: MusicVoice, notes: readonly number[], dur: number, vel: number): MusicEvent => ({ voice, notes, dur, vel });

function buildTheme(sections: readonly ThemeSection[]): { totalSteps: number; layout: Score['layout']; at: Score['at'] } {
  const totalSteps = sections.reduce((n, s) => n + s.chords.length, 0) * STEPS_PER_BAR;
  const chords = sections.map((s) => s.chords.map(chord));
  const at = loopEvents(totalSteps, (step) => {
    let bar = Math.floor(step / STEPS_PER_BAR);
    const k = step % STEPS_PER_BAR;
    let i = 0;
    while (bar >= (sections[i] as ThemeSection).chords.length) bar -= (sections[i++] as ThemeSection).chords.length;
    const c = (chords[i] as Chord[])[bar] as Chord;
    const out: MusicEvent[] = [];
    for (const layer of (sections[i] as ThemeSection).layers) layer(bar, k, c, out);
    return out;
  });
  return { totalSteps, layout: sectionLayout(sections.map((s) => ({ name: s.name, bars: s.chords.length }))), at };
}

// ───────────────────────────── layers ─────────────────────────────

const pad =
  (vel: number): Layer =>
  (_b, k, c, out) => {
    if (k === 0) out.push(ev('pad', c.triad, STEPS_PER_BAR, vel));
  };

/** brass chord held from `at` for `dur` steps on every bar */
const brassChord =
  (vel: number, at = 0, dur = STEPS_PER_BAR - at): Layer =>
  (_b, k, c, out) => {
    if (k === at) out.push(ev('brass', c.triad, dur, vel));
  };

/** melody: one phrase per bar (cycled); `double` adds the octave below (horn section) */
const melody =
  (phrases: readonly Phrase[], voice: MusicVoice, vel: number, double = false): Layer =>
  (b, k, _c, out) => {
    for (const [at, name, dur] of phrases[b % phrases.length] as Phrase) {
      if (at !== k) continue;
      const n = note(name);
      out.push(ev(voice, double ? [n, n - 12] : [n], Math.min(dur, STEPS_PER_BAR - k), vel));
    }
  };

/** 3-3-2 accents of the 16th ostinato and the bass pulse */
const ACCENTS = new Set([0, 3, 6, 8, 11, 14]);

/** 16th-note ostinato on the chord root (`octave` above the bass), fifth on 6 / 14, octave on 15 */
const strings16 =
  (vel: number, octave: number): Layer =>
  (_b, k, c, out) => {
    const offset = k === 6 || k === 14 ? 7 : k === 15 ? 12 : 0;
    out.push(ev('strings', [c.bass + octave + offset], 0.9, ACCENTS.has(k) ? vel : vel * 0.6));
  };

const ARP8 = [0, 1, 2, 3, 2, 1, 2, 1];

/** 8th-note broken chord */
const strings8 =
  (vel: number): Layer =>
  (_b, k, c, out) => {
    if (k % 2 !== 0) return;
    const pool = [c.triad[0], c.triad[1], c.triad[2], c.triad[0] + 12];
    out.push(ev('strings', [pool[ARP8[k / 2] as number] as number], 1.8, k % 8 === 0 ? vel : vel * 0.75));
  };

const ARP16 = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 2, 3];

const arp =
  (vel: number): Layer =>
  (_b, k, c, out) => {
    const pool = [c.triad[0] + 12, c.triad[1] + 12, c.triad[2] + 12, c.triad[0] + 24];
    out.push(ev('arp', [pool[ARP16[k] as number] as number], 1, vel));
  };

const bassPulse: Layer = (_b, k, c, out) => {
  if (ACCENTS.has(k)) out.push(ev('bass', [c.bass], 2, k === 0 || k === 8 ? 0.9 : 0.7));
};

const bassDrive: Layer = (_b, k, c, out) => {
  if (k % 2 === 0) out.push(ev('bass', [k === 6 || k === 14 ? c.bass + 12 : c.bass], 1.6, k % 8 === 0 ? 1 : 0.8));
};

const bassLong: Layer = (_b, k, c, out) => {
  if (k === 0 || k === 8) out.push(ev('bass', [c.bass], 7, k === 0 ? 0.9 : 0.7));
};

/** drums of every bar: [voice, velocity, pitch for toms, length] by step */
type Hit = readonly [MusicVoice, number, number?, number?];
const drums =
  (pattern: (b: number, k: number) => readonly Hit[]): Layer =>
  (b, k, _c, out) => {
    for (const [voice, vel, pitch, dur] of pattern(b, k)) out.push(ev(voice, pitch === undefined ? [] : [pitch], dur ?? 1, vel));
  };

const crashOn =
  (bars: readonly number[]): Layer =>
  (b, k, _c, out) => {
    if (k === 0 && bars.includes(b)) out.push(ev('crash', [], 8, 0.8));
  };

const TOM_HI = 50;
const TOM_MID = 45;
const TOM_LO = 40;

/** timpani on the chord root, kept between D2 and A2 */
const timpani =
  (hits: (b: number, k: number) => number): Layer =>
  (b, k, c, out) => {
    const vel = hits(b, k);
    if (vel > 0) out.push(ev('tom', [c.bass < 38 ? c.bass + 12 : c.bass], k % 4 === 0 ? 3 : 1, vel));
  };

const snareRoll = (k: number, from: number): readonly Hit[] => (k >= from ? [['snare', 0.3 + (0.55 * (k - from)) / (15 - from)]] : []);

// ───────────────────────────── Lights Out (menus) ─────────────────────────────

const LO_THEME_CHORDS = ['Em', 'C', 'G', 'D', 'Em', 'C', 'Am', 'B'];

const LO_THEME: Phrase[] = [
  [[0, 'E5', 3], [3, 'B4', 3], [6, 'E5', 2], [8, 'G5', 3], [11, 'F#5', 3], [14, 'E5', 2]],
  [[0, 'G5', 6], [6, 'A5', 2], [8, 'G5', 4], [12, 'E5', 4]],
  [[0, 'D5', 3], [3, 'B4', 3], [6, 'D5', 2], [8, 'G5', 3], [11, 'A5', 3], [14, 'B5', 2]],
  [[0, 'A5', 8], [8, 'F#5', 4], [12, 'D5', 4]],
  [[0, 'E5', 3], [3, 'B4', 3], [6, 'E5', 2], [8, 'G5', 3], [11, 'B5', 3], [14, 'C6', 2]],
  [[0, 'C6', 6], [6, 'B5', 2], [8, 'G5', 4], [12, 'E5', 4]],
  [[0, 'A5', 3], [3, 'E5', 3], [6, 'A5', 2], [8, 'B5', 4], [12, 'C6', 4]],
  [[0, 'B5', 8], [8, 'F#5', 4], [12, 'D#5', 4]],
];

const LO_BRIDGE: Phrase[] = [
  [[0, 'E5', 6], [6, 'G5', 2], [8, 'C6', 8]],
  [[0, 'D6', 6], [6, 'C6', 2], [8, 'A5', 8]],
  [[0, 'B5', 6], [6, 'G5', 2], [8, 'E5', 8]],
  [[0, 'F#5', 4], [4, 'A5', 4], [8, 'B5', 8]],
];

/** full-band groove of the theme; the last bar ends on a tom fill */
const themeDrums = (b: number, k: number): readonly Hit[] => {
  if (b === 7 && k >= 12) return [['tom', 0.9, [TOM_HI, TOM_MID, TOM_LO, TOM_LO][k - 12] as number, k === 15 ? 1 : 2], ...(k === 12 ? [['kick', 1] as Hit] : [])];
  const hits: Hit[] = [];
  if (k % 4 === 0) hits.push(['kick', 1]);
  if (k === 4 || k === 12) hits.push(['snare', 0.85]);
  if (k % 4 === 2) hits.push(['openHat', 0.35, undefined, 2]);
  else if (k % 4 === 3) hits.push(['hat', 0.18]);
  return hits;
};

const LIGHTS_OUT_DATA = buildTheme([
  {
    name: 'intro',
    chords: ['Em', 'Em', 'C', 'D'],
    layers: [
      pad(0.7),
      (b, k, c, out) => strings16(0.4 + 0.08 * b, 12)(b, k, c, out),
      brassChord(0.45, 8),
      drums((b, k) => {
        if (b === 2) return k === 0 || k === 8 ? [['kick', 0.8]] : k === 12 || k === 14 ? [['tom', 0.7, k === 12 ? TOM_MID : TOM_LO, 2]] : [];
        if (b === 3) {
          const fill: Record<number, number> = { 0: TOM_LO, 3: TOM_LO, 6: TOM_LO, 8: TOM_MID, 10: TOM_MID, 12: TOM_HI, 13: TOM_HI, 14: TOM_MID, 15: TOM_LO };
          const pitch = fill[k];
          return pitch === undefined ? [] : [['tom', 0.6 + 0.025 * k, pitch, 1]];
        }
        return [];
      }),
    ],
  },
  {
    name: 'build',
    chords: LO_THEME_CHORDS,
    layers: [
      pad(0.7),
      strings16(0.7, 12),
      bassPulse,
      brassChord(0.5),
      crashOn([0]),
      drums((b, k) => {
        if (b === 7 && k >= 8) return [...snareRoll(k, 8), ...(k === 8 ? [['kick', 0.9] as Hit] : [])];
        const hits: Hit[] = [];
        if (k === 0 || k === 8) hits.push(['kick', 0.9]);
        if (k === 4 || k === 12) hits.push(['snare', 0.45]);
        if (k % 2 === 0) hits.push(['hat', 0.22]);
        return hits;
      }),
    ],
  },
  {
    name: 'theme',
    chords: LO_THEME_CHORDS,
    layers: [pad(0.75), strings16(0.75, 12), bassDrive, crashOn([0, 4]), melody(LO_THEME, 'brass', 0.85, true), drums(themeDrums)],
  },
  {
    name: 'bridge',
    chords: ['C', 'D', 'Em', 'B'],
    layers: [
      pad(0.8),
      strings16(0.45, 12),
      bassLong,
      brassChord(0.55),
      melody(LO_BRIDGE, 'lead', 0.7),
      arp(0.4),
      drums((b, k) => {
        if (b === 3 && k >= 8) return snareRoll(k, 8);
        const hits: Hit[] = [];
        if (k === 0) hits.push(['kick', 1]);
        if (k === 10) hits.push(['kick', 0.7]);
        if (k === 8) hits.push(['snare', 0.8]);
        if (k % 4 === 0) hits.push(['hat', 0.2]);
        return hits;
      }),
    ],
  },
  {
    name: 'theme2',
    chords: LO_THEME_CHORDS,
    layers: [pad(0.8), strings16(0.8, 12), bassDrive, crashOn([0, 4]), melody(LO_THEME, 'brass', 0.95, true), arp(0.45), drums(themeDrums)],
  },
]);

export const LIGHTS_OUT: Score = {
  id: 'menu',
  title: 'Lights Out',
  bpm: 126,
  stepSeconds: 60 / 126 / 4,
  ...LIGHTS_OUT_DATA,
};

// ───────────────────────────── Champagne (results) ─────────────────────────────

const CH_FANFARE: Phrase[] = [
  [[0, 'A4', 2], [2, 'D5', 2], [4, 'F#5', 4], [8, 'A5', 8]],
  [[0, 'B4', 2], [2, 'D5', 2], [4, 'G5', 4], [8, 'B5', 8]],
  [[0, 'C#5', 2], [2, 'E5', 2], [4, 'A5', 4], [8, 'C#6', 8]],
  [[0, 'D6', 12], [12, 'A5', 4]],
];

const CH_ANTHEM: Phrase[] = [
  [[0, 'F#5', 6], [6, 'E5', 2], [8, 'D5', 4], [12, 'A4', 4]],
  [[0, 'C#5', 6], [6, 'D5', 2], [8, 'E5', 8]],
  [[0, 'F#5', 4], [4, 'B5', 4], [8, 'A5', 4], [12, 'F#5', 4]],
  [[0, 'G5', 8], [8, 'E5', 4], [12, 'D5', 4]],
  [[0, 'F#5', 6], [6, 'E5', 2], [8, 'D5', 4], [12, 'F#5', 4]],
  [[0, 'A5', 6], [6, 'G5', 2], [8, 'E5', 8]],
  [[0, 'D5', 4], [4, 'E5', 4], [8, 'G5', 4], [12, 'F#5', 4]],
  [[0, 'E5', 12], [12, 'A4', 4]],
];

const CH_LIFT: Phrase[] = [
  [[0, 'B5', 6], [6, 'A5', 2], [8, 'G5', 4], [12, 'D5', 4]],
  [[0, 'C#6', 6], [6, 'B5', 2], [8, 'A5', 8]],
  [[0, 'A5', 4], [4, 'C#6', 4], [8, 'F#5', 8]],
  [[0, 'B5', 4], [4, 'D6', 4], [8, 'F#5', 8]],
  [[0, 'G5', 4], [4, 'B5', 4], [8, 'D6', 8]],
  [[0, 'C#6', 4], [4, 'E6', 4], [8, 'A5', 8]],
  [[0, 'D6', 12], [12, 'A5', 4]],
  [[0, 'D6', 16]],
];

const CHAMPAGNE_DATA = buildTheme([
  {
    name: 'fanfare',
    chords: ['D', 'G', 'A', 'D'],
    layers: [
      pad(0.7),
      brassChord(0.6, 0, 4),
      melody(CH_FANFARE, 'brass', 0.9, true),
      crashOn([0]),
      drums((b, k) => (b === 0 && k === 0 ? [['kick', 1]] : [])),
      timpani((b, k) => (b === 3 ? (k >= 8 ? 0.4 + 0.07 * (k - 8) : k === 0 ? 1 : 0) : k === 0 ? 1 : k === 8 ? 0.7 : 0)),
    ],
  },
  {
    name: 'anthem',
    chords: ['D', 'A', 'Bm', 'G', 'D', 'A', 'G', 'A'],
    layers: [
      pad(0.75),
      strings8(0.45),
      bassLong,
      melody(CH_ANTHEM, 'brass', 0.75),
      drums((b, k) => {
        if (b === 7 && (k === 12 || k === 14)) return [['tom', 0.8, k === 12 ? TOM_MID : TOM_LO, 2]];
        const hits: Hit[] = [];
        if (k === 0) hits.push(['kick', 0.85]);
        if (k === 10) hits.push(['kick', 0.6]);
        if (k === 8) hits.push(['snare', 0.6]);
        if (k % 4 === 2) hits.push(['hat', 0.18]);
        return hits;
      }),
    ],
  },
  {
    name: 'lift',
    chords: ['G', 'A', 'F#m', 'Bm', 'G', 'A', 'D', 'D'],
    layers: [
      pad(0.8),
      strings16(0.55, 24),
      bassDrive,
      melody(CH_LIFT, 'brass', 0.95, true),
      arp(0.4),
      crashOn([0, 4]),
      drums((_b, k) => {
        const hits: Hit[] = [];
        if (k % 4 === 0) hits.push(['kick', 1]);
        if (k === 4 || k === 12) hits.push(['snare', 0.8]);
        if (k % 4 === 2) hits.push(['openHat', 0.3, undefined, 2]);
        return hits;
      }),
    ],
  },
  {
    name: 'turn',
    chords: ['G', 'A', 'Bm', 'A'],
    layers: [
      pad(0.8),
      brassChord(0.6),
      strings8(0.4),
      bassLong,
      drums((_b, k) => (k === 0 ? [['kick', 0.8]] : [])),
      timpani((b, k) => (b === 3 && k >= 8 ? 0.35 + 0.08 * (k - 8) : k === 0 ? 0.8 : 0)),
    ],
  },
]);

export const CHAMPAGNE: Score = {
  id: 'results',
  title: 'Champagne',
  bpm: 100,
  stepSeconds: 60 / 100 / 4,
  ...CHAMPAGNE_DATA,
};

/** Which original piece each music scene plays. */
export const SCENE_SCORES: Readonly<Record<MusicScene, Score>> = {
  menu: LIGHTS_OUT,
  race: POLE_POSITION,
  results: CHAMPAGNE,
};
