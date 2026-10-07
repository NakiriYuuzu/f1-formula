/**
 * Real-circuit pack "asia" (Suzuka, Singapore, Las Vegas, Shanghai): defs recreated from real layouts (place-name naming).
 * Each circuit lives in its own module next to this file; only validated defs are listed here.
 */
import type { TrackDef } from '../../../core/types';
import { LAS_VEGAS } from './las-vegas';
import { SEPANG } from './sepang';
import { SHANGHAI } from './shanghai';
import { SINGAPORE } from './singapore';
import { SUZUKA } from './suzuka';

export const ASIA_CIRCUITS: TrackDef[] = [SUZUKA, SINGAPORE, LAS_VEGAS, SHANGHAI, SEPANG];
