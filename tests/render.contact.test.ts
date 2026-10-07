/**
 * Contact-shadow footprint: dark under the car body and the tyres, fading out just beyond the car outline.
 */
import { describe, expect, test } from 'bun:test';
import { carDims } from '../src/render/car/dims';
import { footprintAlpha, raceFootprint } from '../src/render/fx/contactShadows';

describe('contact shadow footprint', () => {
  for (const reg of ['2025', '2026'] as const) {
    const d = carDims(reg);
    const f = raceFootprint(d);

    test(`${reg}: dark under the floor and the tyres, clear well outside the car`, () => {
      expect(footprintAlpha(f, 0, 0)).toBeGreaterThan(0.6);
      // under the diffuser / just behind the rear axle the road must stay shaded (this read as "floating" before)
      expect(footprintAlpha(f, 0, d.rearAxleZ - 0.5)).toBeGreaterThan(0.3);
      for (const z of [d.frontAxleZ, d.rearAxleZ]) {
        const track = z > 0 ? d.frontHalfTrack : d.rearHalfTrack;
        expect(footprintAlpha(f, track, z)).toBeGreaterThan(0.9);
        expect(footprintAlpha(f, -track, z)).toBeGreaterThan(0.9);
      }
      expect(footprintAlpha(f, d.width / 2 + 1.2, 0)).toBe(0);
      expect(footprintAlpha(f, 0, d.length / 2 + 1.2)).toBe(0);
    });

    test(`${reg}: symmetric left / right and fading monotonically outward`, () => {
      for (const z of [-2, 0, 1.5]) {
        expect(footprintAlpha(f, 0.4, z)).toBeCloseTo(footprintAlpha(f, -0.4, z), 9);
      }
      let prev = Infinity;
      for (let x = d.width / 2; x <= d.width / 2 + 0.8; x += 0.1) {
        const a = footprintAlpha(f, x, 0);
        expect(a).toBeLessThanOrEqual(prev + 1e-9);
        prev = a;
      }
    });
  }
});
