/**
 * Original background-music score (pure data + a tiny sequencer, no WebAudio): "Pole Position Anthem", an upbeat
 * electronic stadium-anthem piece in D minor at 132 BPM. 40 bars in six sections that loop seamlessly
 * (the last chorus ends on the A major dominant, which resolves into the intro's D minor):
 *
 *   intro (4)  verse (8)  chorus (8)  break (4)  verse 2 (8)  final chorus (8)
 *
 * The chord progressions and melodies below are composed for this game; they quote no existing song.
 * Everything is a deterministic function of the step number (16th notes): `eventsAtStep(step)`.
 */

export const BPM = 132;
export const STEPS_PER_BAR = 16;
/** seconds per 16th note */
export const STEP_SECONDS = 60 / BPM / 4;

export type MusicVoice = 'kick' | 'snare' | 'hat' | 'openHat' | 'bass' | 'stab' | 'pad' | 'lead' | 'arp';

export interface MusicEvent {
  voice: MusicVoice;
  /** MIDI notes (one for bass / lead / arp, the triad for stab / pad, empty for drums) */
  notes: readonly number[];
  /** length in steps (may be fractional) */
  dur: number;
  /** 0..1 */
  vel: number;
}

export type SectionName = 'intro' | 'verse' | 'chorus' | 'break' | 'verse2' | 'chorus2';

const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C#5' / 'Bb4' → MIDI note number */
function note(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const pc = (NOTE_PC[m[1] as string] as number) + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (Number(m[3]) + 1) * 12 + pc;
}

type ChordName = 'Dm' | 'Bb' | 'Gm' | 'A' | 'C' | 'F';
const CHORD_ROOT: Record<ChordName, { pc: number; minor: boolean }> = {
  Dm: { pc: 2, minor: true },
  Bb: { pc: 10, minor: false },
  Gm: { pc: 7, minor: true },
  A: { pc: 9, minor: false },
  C: { pc: 0, minor: false },
  F: { pc: 5, minor: false },
};

interface Chord {
  bass: number;
  triad: readonly [number, number, number];
}

/** Bass root in A1..G#2, triad in root position inside A3..G#4. */
function chord(name: ChordName): Chord {
  const { pc, minor } = CHORD_ROOT[name];
  const base = 57 + ((((pc - 57) % 12) + 12) % 12);
  return { bass: 33 + ((((pc - 33) % 12) + 12) % 12), triad: [base, base + (minor ? 3 : 4), base + 7] };
}

/** [step in bar, note, length in steps] */
type Phrase = readonly (readonly [number, string, number])[];

const VERSE_CHORDS: ChordName[] = ['Dm', 'Dm', 'Bb', 'Bb', 'Gm', 'Gm', 'A', 'A'];
const CHORUS_CHORDS: ChordName[] = ['Bb', 'C', 'Dm', 'F', 'Bb', 'C', 'A', 'A'];

const VERSE_LEAD: Phrase[] = [
  [[2, 'A4', 2], [6, 'D5', 2], [10, 'F5', 2], [14, 'E5', 2]],
  [[2, 'D5', 2], [6, 'A4', 2], [10, 'C5', 4]],
  [[2, 'D5', 2], [6, 'F5', 2], [10, 'D5', 2], [14, 'C5', 2]],
  [[2, 'Bb4', 2], [6, 'D5', 2], [10, 'F5', 4]],
  [[2, 'G4', 2], [6, 'Bb4', 2], [10, 'D5', 2], [14, 'C5', 2]],
  [[2, 'Bb4', 2], [6, 'D5', 2], [10, 'G5', 4]],
  [[0, 'E5', 2], [4, 'A4', 2], [8, 'C#5', 2], [12, 'E5', 2]],
  [[0, 'E5', 4], [8, 'A4', 6]],
];

const CHORUS_LEAD: Phrase[] = [
  [[0, 'F5', 3], [4, 'F5', 2], [6, 'D5', 2], [8, 'F5', 4], [12, 'G5', 4]],
  [[0, 'E5', 3], [4, 'E5', 2], [6, 'C5', 2], [8, 'E5', 4], [12, 'G5', 4]],
  [[0, 'A5', 6], [8, 'F5', 2], [10, 'D5', 2], [12, 'F5', 4]],
  [[0, 'A5', 3], [4, 'G5', 2], [6, 'F5', 2], [8, 'C5', 8]],
  [[0, 'F5', 3], [4, 'F5', 2], [6, 'D5', 2], [8, 'F5', 4], [12, 'A5', 4]],
  [[0, 'G5', 3], [4, 'G5', 2], [6, 'E5', 2], [8, 'G5', 4], [12, 'C6', 4]],
  [[0, 'A5', 2], [2, 'G5', 2], [4, 'F5', 2], [6, 'E5', 2], [8, 'C#5', 2], [10, 'E5', 2], [12, 'A5', 4]],
  [[0, 'A5', 8], [12, 'E5', 2], [14, 'A5', 2]],
];

const BREAK_LEAD: Phrase[] = [
  [[0, 'D5', 8], [8, 'F5', 8]],
  [[0, 'G5', 8], [8, 'F5', 4], [12, 'D5', 4]],
  [[0, 'C5', 8], [8, 'F5', 8]],
  [[0, 'E5', 4], [4, 'C#5', 4], [8, 'A4', 8]],
];

type DrumStyle = 'none' | 'hats' | 'light' | 'verse' | 'drop' | 'fill' | 'roll';
type BassStyle = 'sparse' | 'drive';

interface SectionDef {
  name: SectionName;
  chords: readonly ChordName[];
  lead: readonly Phrase[] | null;
  /** drum style of bar `b` of the section */
  drums: (b: number) => DrumStyle;
  bass: BassStyle | null;
  stabs: boolean;
  arp: boolean;
  /** lead loudness */
  leadVel: number;
}

const SECTIONS: readonly SectionDef[] = [
  { name: 'intro', chords: ['Dm', 'Bb', 'Gm', 'A'], lead: null, drums: (b) => (b < 2 ? 'hats' : 'light'), bass: null, stabs: false, arp: true, leadVel: 0 },
  { name: 'verse', chords: VERSE_CHORDS, lead: VERSE_LEAD, drums: () => 'verse', bass: 'sparse', stabs: false, arp: false, leadVel: 0.55 },
  { name: 'chorus', chords: CHORUS_CHORDS, lead: CHORUS_LEAD, drums: (b) => (b % 4 === 3 ? 'fill' : 'drop'), bass: 'drive', stabs: true, arp: false, leadVel: 0.85 },
  { name: 'break', chords: ['Bb', 'Gm', 'F', 'A'], lead: BREAK_LEAD, drums: (b) => (b === 3 ? 'roll' : 'none'), bass: null, stabs: false, arp: false, leadVel: 0.6 },
  { name: 'verse2', chords: VERSE_CHORDS, lead: VERSE_LEAD, drums: () => 'verse', bass: 'drive', stabs: true, arp: true, leadVel: 0.7 },
  { name: 'chorus2', chords: CHORUS_CHORDS, lead: CHORUS_LEAD, drums: (b) => (b % 4 === 3 ? 'fill' : 'drop'), bass: 'drive', stabs: true, arp: true, leadVel: 0.95 },
];

export const TOTAL_BARS = SECTIONS.reduce((n, s) => n + s.chords.length, 0);
export const TOTAL_STEPS = TOTAL_BARS * STEPS_PER_BAR;

/** Section list for tests / documentation: name + first bar + bar count. */
export const SECTION_LAYOUT: readonly { name: SectionName; startBar: number; bars: number }[] = (() => {
  let bar = 0;
  return SECTIONS.map((s) => {
    const entry = { name: s.name, startBar: bar, bars: s.chords.length };
    bar += s.chords.length;
    return entry;
  });
})();

const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 2, 3];
const STAB_STEPS: readonly (readonly [number, number])[] = [[0, 0.9], [3, 0.6], [6, 0.7], [10, 0.7]];

function drumEvents(style: DrumStyle, k: number): MusicEvent[] {
  const out: MusicEvent[] = [];
  const ev = (voice: MusicVoice, vel: number, dur = 1): void => {
    out.push({ voice, notes: [], dur, vel });
  };
  switch (style) {
    case 'hats':
      if (k % 2 === 0) ev('hat', k % 4 === 0 ? 0.3 : 0.2);
      break;
    case 'light':
      if (k % 4 === 0) ev('kick', 0.7);
      if (k % 2 === 0) ev('hat', k % 4 === 0 ? 0.3 : 0.2);
      break;
    case 'verse':
      if (k === 0 || k === 8) ev('kick', 0.9);
      if (k === 4 || k === 12) ev('snare', 0.6);
      if (k % 4 === 2) ev('hat', 0.3);
      break;
    case 'drop':
    case 'fill': {
      if (k % 4 === 0) ev('kick', 1);
      if (k === 4 || k === 12) ev('snare', 0.85);
      if (k % 4 === 2) ev('openHat', 0.4, 2);
      else if (k % 4 === 3) ev('hat', 0.2);
      if (style === 'fill' && k >= 12 && k !== 12) ev('snare', 0.45 + 0.1 * (k - 12));
      break;
    }
    case 'roll':
      ev('snare', 0.3 + (0.6 * k) / 15);
      if (k % 2 === 0) ev('hat', 0.2);
      break;
    case 'none':
      break;
  }
  return out;
}

function bassEvents(style: BassStyle, root: number, k: number): MusicEvent[] {
  const bassNote = (m: number, dur: number, vel: number): MusicEvent => ({ voice: 'bass', notes: [m], dur, vel });
  if (style === 'sparse') {
    if (k === 0 || k === 8) return [bassNote(root, 3, 0.9)];
    if (k === 6 || k === 14) return [bassNote(root, 2, 0.7)];
    return [];
  }
  if (k % 2 !== 0) return [];
  return [bassNote(k === 6 || k === 14 ? root + 12 : root, 1.6, k % 8 === 0 ? 1 : 0.8)];
}

function buildEvents(step: number): MusicEvent[] {
  const bar = Math.floor(step / STEPS_PER_BAR);
  const k = step % STEPS_PER_BAR;
  let first = 0;
  let section = SECTIONS[0] as SectionDef;
  for (const s of SECTIONS) {
    if (bar < first + s.chords.length) {
      section = s;
      break;
    }
    first += s.chords.length;
  }
  const b = bar - first;
  const c = chord(section.chords[b] as ChordName);
  const out = drumEvents(section.drums(b), k);
  if (section.bass) out.push(...bassEvents(section.bass, c.bass, k));
  if (k === 0) out.push({ voice: 'pad', notes: c.triad, dur: STEPS_PER_BAR, vel: 0.8 });
  if (section.stabs) {
    for (const [at, vel] of STAB_STEPS) if (k === at) out.push({ voice: 'stab', notes: c.triad.map((n) => n + 12), dur: 1.5, vel });
  }
  if (section.arp) {
    const pool = [c.triad[0], c.triad[1], c.triad[2], c.triad[0] + 12];
    out.push({ voice: 'arp', notes: [pool[ARP_PATTERN[k] as number] as number], dur: 1, vel: 0.5 });
  }
  const phrase = section.lead?.[b % section.lead.length];
  if (phrase) {
    for (const [at, name, dur] of phrase) {
      if (at === k) out.push({ voice: 'lead', notes: [note(name)], dur: Math.min(dur, STEPS_PER_BAR - k), vel: section.leadVel });
    }
  }
  return out;
}

const EVENTS: readonly (readonly MusicEvent[])[] = Array.from({ length: TOTAL_STEPS }, (_, step) => buildEvents(step));

/** Events starting on `step` (any integer; the score loops every TOTAL_STEPS). */
export function eventsAtStep(step: number): readonly MusicEvent[] {
  const s = ((Math.floor(step) % TOTAL_STEPS) + TOTAL_STEPS) % TOTAL_STEPS;
  return EVENTS[s] as readonly MusicEvent[];
}

/**
 * Look-ahead sequencer: `advance(now, lookahead, emit)` emits every step that starts in [now, now + lookahead)
 * exactly once, in order, with its start time. Falling behind (throttled timers) skips ahead instead of bursting.
 */
export class MusicSequencer {
  private step = 0;
  private nextTime = 0;

  /** Begin (or resume) at the next bar line at or after the stored position, first step at `time`. */
  start(time: number): void {
    this.step = (Math.ceil(this.step / STEPS_PER_BAR) * STEPS_PER_BAR) % TOTAL_STEPS;
    this.nextTime = time;
  }

  get position(): number {
    return this.step;
  }

  advance(now: number, lookahead: number, emit: (event: MusicEvent, time: number) => void): void {
    if (this.nextTime < now) this.nextTime = now;
    while (this.nextTime < now + lookahead) {
      for (const e of eventsAtStep(this.step)) emit(e, this.nextTime);
      this.step = (this.step + 1) % TOTAL_STEPS;
      this.nextTime += STEP_SECONDS;
    }
  }
}
