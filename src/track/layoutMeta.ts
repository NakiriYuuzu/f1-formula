/**
 * Lap-fraction metadata (sectors, DRS zones, pit) of a TrackDef mapped to a layout direction.
 * Reverse layouts keep s = 0 at points[0], so a fraction f of the forward lap maps to 1 - f.
 */
import type { TrackDef } from '../core/types';

export interface LayoutFractions {
  /** fractions where sectors 2 and 3 begin (ascending) */
  sectors: [number, number];
  drsZones: { detection: number; activation: number; end: number }[];
  pit: { side: 1 | -1; entry: number; exit: number; box: number };
}

/** Wrap a lap fraction into [0, 1). */
export function wrapFraction(f: number): number {
  if (!Number.isFinite(f)) return 0;
  const r = f - Math.floor(f);
  return r >= 1 ? 0 : r;
}

/** Forward distance (fraction of a lap) from a to b, in [0, 1). */
export function forwardFraction(a: number, b: number): number {
  return wrapFraction(b - a);
}

const mirror = (f: number): number => wrapFraction(1 - wrapFraction(f));

export function layoutFractions(def: TrackDef, reverse: boolean): LayoutFractions {
  const side: 1 | -1 = def.pit.side === 'right' ? 1 : -1;
  const [s2, s3] = def.sectors;
  if (!reverse) {
    return {
      sectors: [wrapFraction(s2), wrapFraction(s3)],
      drsZones: def.drsZones.map((z) => ({
        detection: wrapFraction(z.detection),
        activation: wrapFraction(z.activation),
        end: wrapFraction(z.end),
      })),
      pit: { side, entry: wrapFraction(def.pit.entry), exit: wrapFraction(def.pit.exit), box: wrapFraction(def.pit.box) },
    };
  }
  const a = mirror(s3);
  const b = mirror(s2);
  return {
    sectors: a <= b ? [a, b] : [b, a],
    drsZones: def.drsZones.map((z) => {
      const activation = mirror(z.end);
      const end = mirror(z.activation);
      const lead = forwardFraction(z.detection, z.activation);
      return { detection: wrapFraction(activation - lead), activation, end };
    }),
    pit: {
      side: side === 1 ? -1 : 1,
      entry: mirror(def.pit.exit),
      exit: mirror(def.pit.entry),
      box: mirror(def.pit.box),
    },
  };
}
