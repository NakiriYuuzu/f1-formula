/**
 * Real-circuit pack "eu" (Monaco, Silverstone, Monza, Spa): defs recreated from real layouts (place-name naming).
 * Each circuit lives in its own module next to this file; only validated defs are listed here.
 */
import type { TrackDef } from '../../../core/types';
import { MONACO } from './monaco';
import { MONZA } from './monza';
import { SILVERSTONE } from './silverstone';
import { SPA } from './spa';

export const EU_CIRCUITS: TrackDef[] = [MONACO, SILVERSTONE, SPA, MONZA];
