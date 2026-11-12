/**
 * Livery parts and finish (roster packs): part swatch colours with their defaults, the per-zone body paint
 * (recorded fillRect calls of a fake 2D canvas), the finish on the car material, clones and pack validation; the
 * 2026 layouts (bare-carbon zones, ≥ 55 % painted, per-layout surface maps, editor / sanitiser coverage).
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { Livery } from '../src/core/types';
import { cloneLivery, identColor } from '../src/meta/roster';
import { parseRosterPack, ROSTER_PACK_FORMAT } from '../src/meta/rosterPack';
import { REAL_GRID } from '../src/data/realGrid';
import { TEAMS } from '../src/data/teams';
import { LIVERY_PATTERNS, sanitizeLivery } from '../src/meta/guards';
import { BODY_V0, carbonZones, FIN_U0, paintLiveryCanvas, swatchColors } from '../src/render/car/atlas';
import { buildCarGeometry } from '../src/render/car/carGeometry';
import { CarSharedResources } from '../src/render/car/carMaterials';
import { createCarModel } from '../src/render/car/carModel';
import { designForTeam } from '../src/render/car/designs';
import { PATTERN_LABEL } from '../src/ui/menus/components/forms';
import { CAR_FINISH, CAR_PAINT, CAR_WET } from '../src/render/car/carQuality';
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
    paintLiveryCanvas(size, carDims(), { livery, helmet: BASE, number: 7, teamShort: 'TST' });
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
  const d = carDims();
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

  test('a wet car is darker and glossier (rain or spray off a wet track), dry again after', () => {
    const model = createCarModel({ ...base, livery: { ...BASE, finish: 'satin' }, quality: 'low' });
    const st = { carId: 1, x: 0, y: 0, z: 0, yaw: 0, visible: true, damage: { frontWing: 0, rearWing: 0 } } as never;
    model.apply(st, 0.016, { time: 0, rain: 0, wetness: 1 });
    expect(mat(model).roughness).toBeCloseTo(CAR_FINISH.satin.roughness * (1 - CAR_WET.gloss), 6);
    expect(mat(model).color.r).toBeCloseTo(1 - CAR_WET.darken, 6);
    model.apply(st, 0.016, { time: 0, rain: 0, wetness: 0 });
    expect(mat(model).roughness).toBe(CAR_FINISH.satin.roughness);
    expect(mat(model).color.r).toBe(1);
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

  test('the ident colour is kept (lower-cased), survives cloneLivery and colours the HUD; without it the primary does', () => {
    const r = pack({ ...colours, ident: '#E10600' });
    if (!r.ok) throw new Error(r.errors.join('; '));
    const livery = r.pack.teams[0]!.livery;
    expect(livery.ident).toBe('#e10600');
    expect(cloneLivery(livery)).toEqual(livery);
    expect(identColor(livery)).toBe('#e10600');
    expect(identColor({ ...colours })).toBe(colours.primary);
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
      { ...colours, ident: 'white' },
    ]) {
      const r = pack(livery);
      expect(r.ok).toBe(false);
    }
  });
});

describe('2026 layouts', () => {
  /** point in a left-side UV polygon or its right-side mirror */
  const inside = (poly: [number, number][], u: number, v: number): boolean => {
    let hit = false;
    for (const vv of [v, 1 - v]) {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ui, vi] = poly[i]!;
        const [uj, vj] = poly[j]!;
        if (vi > vv !== vj > vv && u < ((uj - ui) * (vv - vi)) / (vj - vi) + ui) c = !c;
      }
      hit ||= c;
    }
    return hit;
  };

  test('every team of both rosters runs a 2026 layout with bare carbon, and at least 55 % of the bodywork stays painted', () => {
    for (const team of [...TEAMS, ...REAL_GRID.teams]) {
      const pattern = team.livery.pattern ?? 'classic';
      const zones = carbonZones(carDims(), pattern);
      expect(zones.length).toBeGreaterThan(0);
      // area-weighted over the wrapped bodywork of the team's own car
      const g = buildCarGeometry(designForTeam(team.id)).body;
      const pos = g.getAttribute('position');
      const uv = g.getAttribute('uv');
      const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      let total = 0;
      let carbon = 0;
      for (let t = 0; t + 2 < pos.count; t += 3) {
        const u = (uv.getX(t) + uv.getX(t + 1) + uv.getX(t + 2)) / 3;
        const v = (uv.getY(t) + uv.getY(t + 1) + uv.getY(t + 2)) / 3;
        if (v <= BODY_V0) continue;
        P.forEach((p, k) => p.fromBufferAttribute(pos, t + k));
        const area = P[1]!.clone().sub(P[0]!).cross(P[2]!.clone().sub(P[0]!)).length() / 2;
        const V = (v - BODY_V0) / (1 - BODY_V0);
        total += area;
        if (V < 0.06 || V > 0.94 || zones.some((z) => inside(z, u, V))) carbon += area;
      }
      expect(carbon / total).toBeGreaterThan(0.12);
      expect(1 - carbon / total).toBeGreaterThanOrEqual(0.55);
    }
  });

  test('bare carbon is painted carbon and baked into one surface map per layout', () => {
    const shared = new CarSharedResources('low');
    expect(shared.surfaceMapFor('classic')).toBe(shared.surfaceMap);
    expect(shared.surfaceMapFor(undefined)).toBe(shared.surfaceMap);
    const arrow = shared.surfaceMapFor('arrow');
    expect(arrow).not.toBe(shared.surfaceMap);
    expect(shared.surfaceMapFor('arrow')).toBe(arrow);
    expect(shared.surfaceMapFor('duo')).not.toBe(arrow);
    const model = createCarModel({ number: 7, teamShort: 'TST', helmet: BASE, regulation: '2026', livery: { ...BASE, pattern: 'arrow' }, shared, quality: 'low' });
    const m = model.nodes.body.material as THREE.MeshStandardMaterial;
    expect(m.roughnessMap).toBe(arrow);
    model.setLivery(BASE, 7, 'TST', BASE);
    expect(m.roughnessMap).toBe(shared.surfaceMap);
    model.dispose();
    shared.dispose();
  });

  test('the new layouts are offered in the editor and survive sanitising', () => {
    for (const p of LIVERY_PATTERNS) {
      expect(PATTERN_LABEL[p]).toBeTruthy();
      expect(sanitizeLivery({ ...BASE, pattern: p }, BASE).pattern).toBe(p);
    }
    expect(LIVERY_PATTERNS).toContain('arrow');
  });
});

describe('team identity colours', () => {
  /** OKLab of a #rrggbb colour (perceptual: a distance of 0.1 is a clearly different colour) */
  const oklab = (hex: string): number[] => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => (x / 255 <= 0.04045 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4));
    const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
    const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
    const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const distance = (a: string, b: string): number => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]!));

  test('the white / silver real teams share a primary, but every team of each roster has its own HUD colour', () => {
    // why the real grid needs `ident`: Haas, Cadillac and Racing Bulls run the same white
    const real = (id: string): Livery => REAL_GRID.teams.find((t) => t.id === id)!.livery;
    expect(distance(real('haas').primary, real('cadillac').primary)).toBeLessThan(0.02);
    for (const teams of [TEAMS, REAL_GRID.teams]) {
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const a = teams[i]!;
          const b = teams[j]!;
          expect({ pair: `${a.id} / ${b.id}`, far: distance(identColor(a.livery), identColor(b.livery)) >= 0.1 }).toEqual({ pair: `${a.id} / ${b.id}`, far: true });
        }
      }
    }
  });
});
