/**
 * Real-circuit pack "meam" (Bahrain, Yas Marina, Interlagos, COTA): defs recreated from real layouts (place-name naming).
 * Each circuit lives in its own module next to this file; only validated defs are listed here.
 */
import type { TrackDef } from '../../../core/types';
import { BAHRAIN } from './bahrain';
import { COTA } from './cota';
import { INTERLAGOS } from './interlagos';
import { YAS_MARINA } from './yas-marina';

export const MEAM_CIRCUITS: TrackDef[] = [BAHRAIN, YAS_MARINA, INTERLAGOS, COTA];
