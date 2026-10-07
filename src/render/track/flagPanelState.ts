/**
 * Marshal light panel state machine (pure, allocation-free per update). Per sector it turns the race-control
 * state (mode + sector flags) into one atlas cell: dark, steady / flashing yellow, 'VSC' / 'SC' lettering, red, or
 * green for GREEN_HOLD_S after a sector (or the whole track) stops being under caution.
 */
import type { RaceControlMode } from '../../core/types';

/** Atlas cells of the panel texture (left → right). */
export const PANEL_CELL = { dark: 0, yellow: 1, vsc: 2, sc: 3, red: 4, green: 5 } as const;
export const PANEL_CELL_COUNT = 6;
/** Seconds the panels show green after the caution ends. */
export const GREEN_HOLD_S = 4;
/** Flash rate (Hz) of double-yellow and of VSC / SC lettering (on for half of each cycle). */
export const PANEL_FLASH_HZ = 1.5;
/** Time jump (s) backwards that counts as a replay seek / flashback (state restarts without a green phase). */
const SEEK_BACK = 0.05;

export interface RaceControlInput {
  mode: RaceControlMode;
  sectorFlags: number[];
}

/** Sector (0-based) containing distance s, from BuiltTrack.sectorStarts. */
export function sectorOfS(s: number, starts: readonly number[]): number {
  let k = 0;
  for (let i = 1; i < starts.length; i++) if (s >= starts[i]) k = i;
  return k;
}

/** True during the "on" half of the flash cycle. */
export function flashOn(time: number, hz = PANEL_FLASH_HZ): boolean {
  return (((time * hz) % 1) + 1) % 1 < 0.5;
}

/** Caution kind of a sector: 0 none, 1 steady yellow, 2 flashing yellow, 3 VSC, 4 SC, 5 red. */
function cautionOf(rc: RaceControlInput | undefined, sector: number): number {
  if (!rc) return 0;
  switch (rc.mode) {
    case 'vsc':
    case 'vscEnding':
      return 3;
    case 'sc':
    case 'scEnding':
      return 4;
    case 'red':
      return 5;
    default: {
      const f = rc.sectorFlags?.[sector];
      return f === 1 ? 1 : f === 2 ? 2 : 0;
    }
  }
}

export class FlagPanelState {
  /** current cell per sector (read after update()) */
  readonly cells: Int8Array;
  private readonly active: Uint8Array;
  private readonly greenUntil: Float64Array;
  private lastTime = Number.NaN;
  private primed = false;

  constructor(readonly sectors = 3) {
    this.cells = new Int8Array(sectors);
    this.active = new Uint8Array(sectors);
    this.greenUntil = new Float64Array(sectors).fill(Number.NEGATIVE_INFINITY);
  }

  /** Advance to `time`; returns true when any cell changed since the previous call. */
  update(rc: RaceControlInput | undefined, time: number): boolean {
    const t = Number.isFinite(time) ? time : 0;
    if (this.primed && t < this.lastTime - SEEK_BACK) this.primed = false; // seek: no green phase for the jump
    this.lastTime = t;
    const flash = flashOn(t);
    let changed = false;
    for (let i = 0; i < this.sectors; i++) {
      const c = cautionOf(rc, i);
      const wasActive = this.active[i] === 1;
      if (!this.primed) this.greenUntil[i] = Number.NEGATIVE_INFINITY;
      else if (wasActive && c === 0) this.greenUntil[i] = t + GREEN_HOLD_S;
      else if (c !== 0) this.greenUntil[i] = Number.NEGATIVE_INFINITY;
      this.active[i] = c !== 0 ? 1 : 0;
      let cell: number = PANEL_CELL.dark;
      switch (c) {
        case 1:
          cell = PANEL_CELL.yellow;
          break;
        case 2:
          cell = flash ? PANEL_CELL.yellow : PANEL_CELL.dark;
          break;
        case 3:
          cell = flash ? PANEL_CELL.vsc : PANEL_CELL.dark;
          break;
        case 4:
          cell = flash ? PANEL_CELL.sc : PANEL_CELL.dark;
          break;
        case 5:
          cell = PANEL_CELL.red;
          break;
        default:
          cell = t < this.greenUntil[i] ? PANEL_CELL.green : PANEL_CELL.dark;
      }
      if (cell !== this.cells[i]) {
        this.cells[i] = cell;
        changed = true;
      }
    }
    this.primed = true;
    return changed;
  }
}
