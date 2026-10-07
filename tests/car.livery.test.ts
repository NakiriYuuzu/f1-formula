/**
 * Livery parts and finish (roster packs): part swatch colours with their defaults, the per-zone body paint
 * (recorded fillRect calls of a fake 2D canvas), the finish on the car material, clones and pack validation.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { Livery } from '../src/core/types';
import { cloneLivery } from '../src/meta/roster';
import { parseRosterPack, ROSTER_PACK_FORMAT } from '../src/meta/rosterPack';
import { FIN_U0, paintLiveryCanvas, swatchColors } from '../src/render/car/atlas';
import { createCarModel } from '../src/render/car/carModel';
import { CAR_FINISH, CAR_PAINT } from '../src/render/car/carQuality';
import { carDims } from '../src/render/car/dims';
import { installFakeDom } from './renderHarness';

installFakeDom();

const BASE: Livery = { primary: '#112233', secondary: '#445566', accent: '#778899', pattern: 'classic' };
const PARTS = {
  nose: '#aa0001',
  engineCover: '#aa0002',
  sidepods: '#aa0003',
  lower: '#aa0004',
  halo: '#aa0005',
  frontWing: '#aa0006',
  rearWing: '#aa0007',
  rearFlap: '#aa0008',
};

interface Rect {
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** paintLiveryCanvas with a 2D context that records every fillRect and the fill style it used. */
function paintRecorded(size: number, livery: Livery): Rect[] {
  const rects: Rect[] = [];
  let fillStyle = '';
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'fillStyle') return fillStyle;
        if (prop === 'fillRect') return (x: number, y: number, w: number, h: number) => rects.push({ style: fillStyle, x, y, w, h });
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
        return () => undefined;
      },
      set: (_t, prop, value) => {
        if (prop === 'fillStyle') fillStyle = typeof value === 'string' ? value : '<gradient>';
        return true;
      },
    },
  );
  const doc = (globalThis as unknown as { document: { createElement: unknown } }).document;
  const original = doc.createElement;
  doc.createElement = () => ({ width: 1, height: 1, getContext: () => ctx });
  try {
    paintLiveryCanvas(size, carDims('2026'), { livery, helmet: BASE, number: 7, teamShort: 'TST' });
  } finally {
    doc.createElement = original;
  }
  return rects;
}

describe('part swatches', () => {
  test('without parts the halo / wings keep the primary colour and the rear flap the secondary', () => {
    const c = swatchColors(BASE);
    expect([c.halo, c.frontWing, c.rearWing]).toEqual([BASE.primary, BASE.primary, BASE.primary]);
    expect(c.rearFlap).toBe(BASE.secondary);
  });

  test('parts override their swatch; an invalid colour keeps the default', () => {
    const c = swatchColors({ ...BASE, parts: { ...PARTS, rearWing: 'red' } });
    expect([c.halo, c.frontWing, c.rearFlap]).toEqual([PARTS.halo, PARTS.frontWing, PARTS.rearFlap]);
    expect(c.rearWing).toBe(BASE.primary);
    expect(c.primary).toBe(BASE.primary);
  });
});

describe('body zones', () => {
  const size = 512;
  const d = carDims('2026');
  const uOf = (z: number): number => ((z - d.wrapZMin) / (d.wrapZMax - d.wrapZMin)) * size;

  test('no parts: none of the part colours is painted', () => {
    const styles = new Set(paintRecorded(size, BASE).map((r) => r.style));
    for (const c of Object.values(PARTS)) expect(styles.has(c)).toBe(false);
  });

  test('nose, engine cover, sidepods and lower sides are painted in their z / V ranges', () => {
    const rects = paintRecorded(size, { ...BASE, parts: PARTS });
    const of = (style: string): Rect[] => rects.filter((r) => r.style === style);
    const nose = of(PARTS.nose);
    expect(nose.length).toBe(1);
    expect(nose[0]!.x).toBeCloseTo(uOf(d.cockpitZ1), 3);
    expect(nose[0]!.x + nose[0]!.w).toBeCloseTo(size, 3);
    // engine cover: body top behind the cockpit + the fin panel background
    const cover = of(PARTS.engineCover);
    expect(cover.length).toBe(2);
    expect(cover[0]!.x).toBeCloseTo(0, 3);
    expect(cover[0]!.x + cover[0]!.w).toBeCloseTo(uOf(d.cockpitZ0), 3);
    expect(cover[1]!.x).toBeCloseTo(FIN_U0 * size, 3);
    // sidepods and lower sides: one band per side
    expect(of(PARTS.sidepods).length).toBe(2);
    for (const r of of(PARTS.sidepods)) expect(r.x + r.w).toBeCloseTo(uOf(d.cockpitZ1), 3);
    expect(of(PARTS.lower).length).toBe(2);
    // part swatches
    for (const k of ['halo', 'frontWing', 'rearWing', 'rearFlap'] as const) expect(of(PARTS[k]).length).toBe(1);
  });
});

describe('finish', () => {
  const base = { number: 7, teamShort: 'TST', helmet: BASE, regulation: '2026' as const };
  const mat = (m: ReturnType<typeof createCarModel>): THREE.MeshPhysicalMaterial => m.nodes.body.material as THREE.MeshPhysicalMaterial;

  test('gloss by default; matte / satin scale roughness and clear coat', () => {
    const gloss = createCarModel({ ...base, livery: BASE, quality: 'ultra' });
    expect(mat(gloss).roughness).toBe(1);
    expect(mat(gloss).clearcoat).toBe(CAR_PAINT.clearcoat);
    const matte = createCarModel({ ...base, livery: { ...BASE, finish: 'matte' }, quality: 'ultra' });
    expect(mat(matte).roughness).toBe(CAR_FINISH.matte.roughness);
    expect(mat(matte).clearcoat).toBe(0);
    const satin = createCarModel({ ...base, livery: { ...BASE, finish: 'satin' }, quality: 'low' });
    expect(mat(satin).roughness).toBe(CAR_FINISH.satin.roughness);
    for (const m of [gloss, matte, satin]) m.dispose();
  });

  test('setLivery applies the new finish', () => {
    const model = createCarModel({ ...base, livery: BASE, quality: 'ultra' });
    model.setLivery({ ...BASE, finish: 'matte' }, 7, 'TST', BASE);
    expect(mat(model).clearcoat).toBe(0);
    model.setLivery(BASE, 7, 'TST', BASE);
    expect(mat(model).clearcoat).toBe(CAR_PAINT.clearcoat);
    model.dispose();
  });
});

describe('roster pack liveries', () => {
  const pack = (livery: Record<string, unknown>): ReturnType<typeof parseRosterPack> =>
    parseRosterPack({
      format: ROSTER_PACK_FORMAT,
      teams: [
        {
          id: 'team-a',
          name: 'Team A',
          shortName: 'TMA',
          livery,
          powerUnit: 'PU',
          rating: { aero: 0.9, power: 0.9, chassis: 0.9, reliability: 0.9 },
          driverIds: ['a1', 'a2'],
        },
      ],
      drivers: ['a1', 'a2', 'r1'].map((id, i) => ({
        id,
        lastName: id,
        abbr: `AB${'CDE'[i]}`,
        number: i + 1,
        nationality: 'GBR',
        teamId: i < 2 ? 'team-a' : '',
        skill: { pace: 0.9, racecraft: 0.9, awareness: 0.9, wet: 0.9, consistency: 0.9 },
        helmet: { primary: '#ffffff', secondary: '#000000', accent: '#ff0000' },
      })),
    });
  const colours = { primary: '#112233', secondary: '#445566', accent: '#778899' };

  test('parts and finish are kept (colours lower-cased) and survive cloneLivery', () => {
    const r = pack({ ...colours, parts: { nose: '#AABBCC', halo: '#000000' }, finish: 'matte' });
    if (!r.ok) throw new Error(r.errors.join('; '));
    const livery = r.pack.teams[0]!.livery;
    expect(livery.parts).toEqual({ nose: '#aabbcc', halo: '#000000' });
    expect(livery.finish).toBe('matte');
    const copy = cloneLivery(livery);
    expect(copy).toEqual(livery);
    expect(copy.parts).not.toBe(livery.parts);
  });

  test('gloss and empty parts are omitted', () => {
    const r = pack({ ...colours, parts: {}, finish: 'gloss' });
    expect(r.ok && r.pack.teams[0]!.livery).toEqual({ ...colours, pattern: 'classic' });
  });

  test('bad part colours, unknown parts and unknown finishes are rejected', () => {
    for (const livery of [
      { ...colours, parts: { nose: 'red' } },
      { ...colours, parts: { spoiler: '#000000' } },
      { ...colours, finish: 'chrome' },
    ]) {
      const r = pack(livery);
      expect(r.ok).toBe(false);
    }
  });
});
