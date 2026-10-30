/**
 * Realism upgrade: quality fields (shadow softness, AO, surface detail, scene probe), post look (AO / lens),
 * rubbered racing line, pit crew choreography + instanced crews on a built track, car damage presentation,
 * crash debris and the replay round trip of floor / suspension damage.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { CarRenderState } from '../src/core/types';
import { buildTrack } from '../src/track/track';
import { decodeFrame, encodeFrame } from '../src/app/replay';
import { qualityProfile } from '../src/render/core/quality';
import { AO_BY_TIME, aoAmount, createPostLook, showroomLook } from '../src/render/core/post';
import { RUBBER_BASE, rubberIntensity } from '../src/render/track/road';
import {
  CREW_LIFT,
  CREW_SERVICE,
  CREW_SLOTS,
  CREW_SPEED,
  crewLift,
  crewTarget,
  nextBoxPhase,
  walkToward,
  type BoxPhase,
  type CrewCarShape,
} from '../src/render/track/pitCrewMath';
import { PitCrew } from '../src/render/track/pitCrew';
import { carDims } from '../src/render/car/dims';
import {
  FRONT_WING_BREAK,
  SCUFF_IMPACT_CAP,
  SUSPENSION_BEND,
  SUSPENSION_BROKEN,
  damageLook,
  scuffAfterImpact,
} from '../src/render/car/carDamage';
import { createCarModel } from '../src/render/car/carModel';
import { DebrisFx } from '../src/render/fx/debris';
import { installFakeDom, makeContext } from './renderHarness';
import { longDef } from './trackFixtures';

installFakeDom();

function carState(over: Partial<CarRenderState> = {}): CarRenderState {
  return {
    carId: 3, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, wheelSpin: 0, throttle: 0, brake: 0, rpm: 0, gear: 1,
    drsOpen: false, compound: 'medium', rainLight: false, limiter: false, damage: { frontWing: 0, rearWing: 0 }, slip: 0, lockup: 0, impact: 0,
    surface: 'asphalt', boost: false, visible: true, ghost: false,
    ...over,
  };
}

describe('quality fields', () => {
  test('AO only from high up, surface detail and the scene probe from medium up, softer shadows with quality', () => {
    expect(qualityProfile('low').aoScale).toBe(0);
    expect(qualityProfile('medium').aoScale).toBe(0);
    expect(qualityProfile('high').aoScale).toBeGreaterThan(0);
    expect(qualityProfile('ultra').aoScale).toBeGreaterThanOrEqual(qualityProfile('high').aoScale);
    expect(qualityProfile('low').surfaceDetail).toBe(false);
    expect(qualityProfile('low').sceneProbe).toBe(false);
    for (const l of ['medium', 'high', 'ultra'] as const) {
      expect(qualityProfile(l).surfaceDetail).toBe(true);
      expect(qualityProfile(l).sceneProbe).toBe(true);
    }
    expect(qualityProfile('ultra').shadowRadius).toBeGreaterThan(qualityProfile('medium').shadowRadius);
    expect(qualityProfile('high').asphaltTexSize).toBeGreaterThan(qualityProfile('low').asphaltTexSize);
  });
});

describe('post look: AO and lens', () => {
  test('AO off without an AO pass, lighter at night, a little stronger under cloud, clamped', () => {
    expect(aoAmount('day', 0, 0)).toBe(0);
    expect(aoAmount('day', 0.5, 0)).toBeCloseTo(AO_BY_TIME.day, 6);
    expect(aoAmount('night', 0.5, 0)).toBeLessThan(aoAmount('day', 0.5, 0));
    expect(aoAmount('day', 0.5, 1)).toBeGreaterThan(aoAmount('day', 0.5, 0));
    expect(aoAmount('day', 0.5, Number.NaN)).toBeCloseTo(AO_BY_TIME.day, 6);
    expect(aoAmount('dusk', 1, 99)).toBeLessThanOrEqual(1);
  });

  test('neutral look has no AO / lens; showroom AO follows the flag', () => {
    const n = createPostLook();
    expect([n.ao, n.chroma, n.grain]).toEqual([0, 0, 0]);
    expect(showroomLook('high', true, createPostLook(), true).ao).toBeGreaterThan(0);
    expect(showroomLook('high', true, createPostLook(), false).ao).toBe(0);
    expect(showroomLook('low', false).grain).toBe(0);
  });
});

describe('rubbered racing line', () => {
  test('intensity stays in [base × 0.85, 1] and is higher in braking zones than on the straights', () => {
    const t = buildTrack(longDef());
    let brake = 0;
    let brakeN = 0;
    let straight = 0;
    let straightN = 0;
    const la = Math.round(40 / t.spacing);
    for (let k = 0; k < t.count; k++) {
      const v = rubberIntensity(t, k);
      expect(v).toBeGreaterThanOrEqual(RUBBER_BASE * 0.85 - 1e-9);
      expect(v).toBeLessThanOrEqual(1);
      const drop = t.speedProfile[k] - t.speedProfile[(k + la) % t.count];
      if (drop > 15) {
        brake += v;
        brakeN++;
      } else if (drop < 0.5 && Math.abs(t.curvature[k]) < 1e-3) {
        straight += v;
        straightN++;
      }
    }
    expect(brakeN).toBeGreaterThan(0);
    expect(straightN).toBeGreaterThan(0);
    expect(brake / brakeN).toBeGreaterThan(straight / straightN + 0.2);
  });
});

const SHAPE: CrewCarShape = { frontAxle: 1.8, rearAxle: -1.8, frontTrack: 0.95, rearTrack: 0.9, nose: 2.8, tail: -2.8, halfWidth: 0.76 };

describe('pit crew choreography', () => {
  test('box phases: called out by an approaching car, service while it stands, release while it leaves, then home', () => {
    let p: BoxPhase = 'idle';
    p = nextBoxPhase(p, { stopped: false, approaching: true, departing: false });
    expect(p).toBe('ready');
    p = nextBoxPhase(p, { stopped: true, approaching: true, departing: false });
    expect(p).toBe('service');
    p = nextBoxPhase(p, { stopped: false, approaching: false, departing: true });
    expect(p).toBe('release');
    p = nextBoxPhase(p, { stopped: false, approaching: false, departing: true });
    expect(p).toBe('release');
    p = nextBoxPhase(p, { stopped: false, approaching: false, departing: false });
    expect(p).toBe('idle');
    // departing alone never calls an idle crew out
    expect(nextBoxPhase('idle', { stopped: false, approaching: false, departing: true })).toBe('idle');
  });

  test('16 slots: 3 per wheel, 2 jacks, 2 stabilisers', () => {
    expect(CREW_SLOTS.length).toBe(16);
    for (let w = 0; w < 4; w++) expect(CREW_SLOTS.filter((s) => s.wheel === w).length).toBe(3);
    expect(CREW_SLOTS.filter((s) => s.role === 'frontJack' || s.role === 'rearJack').length).toBe(2);
  });

  test('nobody stands in the arriving or departing car path; wheel guns kneel at the wheels in service', () => {
    const lane = SHAPE.frontTrack + 0.3;
    for (let i = 0; i < CREW_SLOTS.length; i++) {
      const ready = crewTarget(i, 'ready', 0, SHAPE, 6, 1);
      // the car comes from behind and stops with its nose at SHAPE.nose
      if (Math.abs(ready.r) < lane) expect(ready.f).toBeGreaterThan(SHAPE.nose + 1);
      const release = crewTarget(i, 'release', 0, SHAPE, 6, 1);
      // it leaves forwards
      if (Math.abs(release.r) < lane) expect(release.f).toBeLessThan(SHAPE.tail);
      const service = crewTarget(i, 'service', 1, SHAPE, 6, 1);
      const inBody = Math.abs(service.r) < SHAPE.halfWidth && service.f > SHAPE.tail && service.f < SHAPE.nose;
      expect(inBody).toBe(false);
      if (CREW_SLOTS[i].role === 'gun') {
        expect(service.pose).toBe('kneel');
        expect(service.item).toBe('gun');
      }
    }
  });

  test('service spots are at least 0.45 m apart; idle crew lines up in front of the garage', () => {
    for (const t of [0.2, 1, 2.5]) {
      const pts = CREW_SLOTS.map((_, i) => crewTarget(i, 'service', t, SHAPE, 6, 1));
      for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) expect(Math.hypot(pts[a].f - pts[b].f, pts[a].r - pts[b].r)).toBeGreaterThan(0.45);
    }
    for (let i = 0; i < CREW_SLOTS.length; i++) {
      const idle = crewTarget(i, 'idle', 0, SHAPE, 6, 1);
      expect(idle.r).toBeGreaterThan(3.5);
      expect(idle.r).toBeLessThan(6);
    }
  });

  test('tyres change hands: new tyre carried until it is fitted, old tyre carried once it is off', () => {
    const on = CREW_SLOTS.findIndex((s) => s.role === 'on');
    const off = CREW_SLOTS.findIndex((s) => s.role === 'off');
    expect(crewTarget(on, 'service', CREW_SERVICE.tyreOff - 0.1, SHAPE, 6, 1).item).toBe('tyre');
    expect(crewTarget(on, 'service', CREW_SERVICE.tyreOn + 0.1, SHAPE, 6, 1).item).toBe('none');
    expect(crewTarget(off, 'service', CREW_SERVICE.tyreOff - 0.1, SHAPE, 6, 1).item).toBe('none');
    expect(crewTarget(off, 'service', CREW_SERVICE.tyreOff + 0.1, SHAPE, 6, 1).item).toBe('tyre');
  });

  test('jack lift: none outside the service, full while the tyres change, down after the jacks drop', () => {
    expect(crewLift('ready', 1)).toBe(0);
    expect(crewLift('service', 0)).toBe(0);
    expect(crewLift('service', 1)).toBeCloseTo(CREW_LIFT, 6);
    expect(crewLift('service', CREW_SERVICE.jackDown + 0.5)).toBe(0);
    expect(crewLift('service', Number.NaN)).toBe(0);
  });

  test('walking never exceeds the crew speed and arrives', () => {
    const cur = { f: 0, r: 0, yaw: 0 };
    const target = crewTarget(0, 'service', 1, SHAPE, 6, 1);
    const d0 = Math.hypot(target.f, target.r);
    walkToward(cur, target, 0.1);
    expect(Math.hypot(cur.f, cur.r)).toBeLessThanOrEqual(CREW_SPEED * 0.1 + 1e-9);
    expect(Math.hypot(target.f - cur.f, target.r - cur.r)).toBeCloseTo(d0 - CREW_SPEED * 0.1, 6);
    let moving = true;
    for (let i = 0; i < 100 && moving; i++) moving = walkToward(cur, target, 0.05);
    expect(moving).toBe(false);
  });
});

describe('pit crews on a built track', () => {
  test('one crew of 16 per team box; a team car standing in its box is serviced and lifted, then released', () => {
    const track = buildTrack(longDef());
    const { ctx, disposer } = makeContext(track);
    const crew = new PitCrew(ctx, carDims('2025'), new Map([[7, 2]]));
    expect(crew.boxCount).toBe(Math.min(12, ctx.teamColors.length));
    const people = (): number => {
      let n = 0;
      crew.group.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh && o.name.startsWith('crewSuit')) n += (o as THREE.InstancedMesh).count;
      });
      return n;
    };
    expect(people()).toBe(crew.boxCount * 16);
    const box = crew.boxInfo(2);
    expect(box).not.toBeNull();
    if (!box) return;
    const fx = Math.sin(box.yaw);
    const fz = Math.cos(box.yaw);
    // standing in the box: service starts, jacks lift after ~0.25 s
    let time = 10;
    crew.update([carState({ carId: 7, x: box.x, y: box.y, z: box.z, yaw: box.yaw })], time, []);
    for (let i = 0; i < 12; i++) {
      time += 1 / 12;
      crew.update([carState({ carId: 7, x: box.x, y: box.y, z: box.z, yaw: box.yaw })], time, []);
    }
    expect(crew.boxInfo(2)?.phase).toBe('service');
    expect(crew.liftFor(7)).toBeGreaterThan(CREW_LIFT * 0.9);
    expect(crew.liftFor(8)).toBe(0);
    // another team's car standing in box 2 is not this crew's business
    const other = new PitCrew(ctx, carDims('2025'), new Map([[9, 5]]));
    other.update([carState({ carId: 9, x: box.x, y: box.y, z: box.z, yaw: box.yaw })], 1, []);
    expect(other.boxInfo(2)?.phase).toBe('idle');
    // pulling away: release, then idle once it has gone
    time += 0.1;
    crew.update([carState({ carId: 7, x: box.x + fx * 4, y: box.y, z: box.z + fz * 4, yaw: box.yaw, speed: 8 })], time, []);
    expect(crew.boxInfo(2)?.phase).toBe('release');
    expect(crew.liftFor(7)).toBe(0);
    time += 0.1;
    crew.update([carState({ carId: 7, x: box.x + fx * 40, y: box.y, z: box.z + fz * 40, yaw: box.yaw, speed: 20 })], time, []);
    expect(crew.boxInfo(2)?.phase).toBe('idle');
    disposer.dispose();
  });
});

describe('car damage presentation', () => {
  test('intact car: no deformation, no scuffs', () => {
    const l = damageLook({ frontWing: 0, rearWing: 0 }, 1, 0);
    for (const v of [l.frontWingRoll, l.frontWingDrop, l.rearFlapDroop, l.camber, l.toe, l.sagRoll, l.sagPitch, l.scuff]) expect(Math.abs(v)).toBe(0);
    expect(l.frontWingBroken).toBe(false);
  });

  test('front wing bends on the hit side, then breaks off', () => {
    const bent = damageLook({ frontWing: 0.4, rearWing: 0 }, 0, 0);
    expect(bent.frontWingBroken).toBe(false);
    expect(Math.abs(bent.frontWingRoll)).toBeGreaterThan(0.03);
    const broken = damageLook({ frontWing: FRONT_WING_BREAK + 0.1, rearWing: 0 }, 0, 0);
    expect(broken.frontWingBroken).toBe(true);
    expect(Math.abs(broken.frontWingRoll)).toBe(0);
    // the other side bends the other way
    expect(Math.sign(damageLook({ frontWing: 0.4, rearWing: 0 }, 1, 0).frontWingRoll)).toBe(-Math.sign(bent.frontWingRoll));
  });

  test('broken suspension splays the wheel and sags that corner; floor / rear wing scuff the paint', () => {
    const l = damageLook({ frontWing: 0, rearWing: 0, suspension: 1 }, 3, 0);
    expect(l.camber).toBeCloseTo(SUSPENSION_BROKEN.camber, 6);
    expect(l.wheelOut).toBeCloseTo(SUSPENSION_BROKEN.out, 6);
    // corner 3 = rear right: right side down (+roll), tail down (+pitch = nose up)
    expect(l.sagRoll).toBeGreaterThan(0);
    expect(l.sagPitch).toBeGreaterThan(0);
    expect(l.scuff).toBe(1);
    expect(damageLook({ frontWing: 0, rearWing: 0.8 }, 0, 0).rearFlapDroop).toBeGreaterThan(0.3);
    expect(damageLook({ frontWing: 0, rearWing: 0, floor: 0.5 }, 0, 0).scuff).toBeGreaterThan(0.3);
    const garbage = damageLook({ frontWing: Number.NaN, rearWing: Number.POSITIVE_INFINITY, suspension: -1 }, Number.NaN, Number.NaN);
    expect(Number.isFinite(garbage.scuff)).toBe(true);
    expect(garbage.camber).toBe(0);
  });

  test('impacts add scuffs only on a hard rising edge, capped', () => {
    expect(scuffAfterImpact(0, 300, 0)).toBe(0);
    expect(scuffAfterImpact(0, 2000, 1900)).toBe(0);
    const once = scuffAfterImpact(0, 2000, 0);
    expect(once).toBeGreaterThan(0);
    let s = 0;
    for (let i = 0; i < 50; i++) s = scuffAfterImpact(s, 5000, 0);
    expect(s).toBeCloseTo(SCUFF_IMPACT_CAP, 6);
  });

  test('a bent suspension splays the wheel in proportion to the bend (as its grip loss), the broken pose only at 1', () => {
    const at = (s: number) => damageLook({ frontWing: 0, rearWing: 0, suspension: s }, 0, 0);
    expect(at(0.05).camber).toBeCloseTo(SUSPENSION_BEND.camber * 0.05, 9);
    expect(at(0.5).camber).toBeCloseTo(SUSPENSION_BEND.camber * 0.5, 9);
    expect(at(0.5).toe).toBeCloseTo(SUSPENSION_BEND.toe * 0.5, 9);
    expect(at(0.5).wheelOut).toBeCloseTo(SUSPENSION_BEND.out * 0.5, 9);
    expect(at(0.99).camber).toBeLessThan(SUSPENSION_BEND.camber);
    expect(at(1).camber).toBeCloseTo(SUSPENSION_BROKEN.camber, 9);
  });

  test('car model: a broken suspension splays exactly the wheel at its corner, a bent front wing rolls, repairs restore', () => {
    const model = createCarModel({ livery: { primary: '#d22', secondary: '#fff', accent: '#000' }, number: 7, teamShort: 'TST', helmet: { primary: '#ff0', secondary: '#000', accent: '#fff' }, regulation: '2025', textureSize: 64 });
    for (const corner of [0, 1, 2, 3]) {
      model.apply(carState({ carId: 5, damage: { frontWing: 0, rearWing: 0, suspension: 1, corner } }), 0.016);
      const splayed = model.nodes.wheelPivots.map((p, i) => (Math.abs(p.rotation.z) > 0.2 ? i : -1)).filter((i) => i >= 0);
      expect(splayed).toEqual([corner]);
    }
    model.apply(carState({ carId: 5, damage: { frontWing: 0.4, rearWing: 0, suspension: 1 } }), 0.016);
    const splayed = model.nodes.wheelPivots.filter((p) => Math.abs(p.rotation.z) > 0.2);
    expect(splayed.length).toBe(1);
    expect(Math.abs(model.nodes.frontWing.rotation.z)).toBeGreaterThan(0.03);
    model.apply(carState({ carId: 5, damage: { frontWing: 0, rearWing: 0, suspension: 0 } }), 0.016);
    expect(model.nodes.wheelPivots.every((p) => Math.abs(p.rotation.z) === 0)).toBe(true);
    expect(Math.abs(model.nodes.frontWing.rotation.z)).toBe(0);
    model.dispose();
  });
});

describe('crash debris', () => {
  test('a hard impact throws shards that land and rest; damage already present at first sight throws none; reset clears', () => {
    const fx = new DebrisFx(64, carDims('2025'), new Map([[1, '#ff0000']]));
    fx.update([carState({ carId: 1, impact: 0, damage: { frontWing: 0.9, rearWing: 0 } })], 0.016);
    expect(fx.mesh.count).toBe(0);
    fx.update([carState({ carId: 1, impact: 3000, speed: 40, damage: { frontWing: 0.9, rearWing: 0 } })], 0.016);
    expect(fx.mesh.count).toBeGreaterThan(3);
    for (let i = 0; i < 300; i++) fx.update([carState({ carId: 1, impact: 0 })], 0.02);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < fx.mesh.count; i++) {
      fx.mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(0.2);
    }
    fx.reset();
    expect(fx.mesh.count).toBe(0);
    fx.dispose();
  });

  test('a wing breaking off throws a livery-coloured piece', () => {
    const fx = new DebrisFx(64, carDims('2025'), new Map([[1, '#ff0000']]));
    fx.update([carState({ carId: 1 })], 0.016);
    fx.update([carState({ carId: 1, damage: { frontWing: 0.7, rearWing: 0 } })], 0.016);
    expect(fx.mesh.count).toBeGreaterThan(2);
    const c = new THREE.Color();
    let red = false;
    for (let i = 0; i < fx.mesh.count; i++) {
      fx.mesh.getColorAt(i, c);
      if (c.r > 0.5 && c.g < 0.1) red = true;
    }
    expect(red).toBe(true);
    fx.dispose();
  });
});

describe('replay keeps floor / suspension damage', () => {
  test('encode → decode round trip', () => {
    const frame = { time: 3, cars: [carState({ carId: 2, damage: { frontWing: 0.2, rearWing: 0.1, floor: 0.4, suspension: 0.9 } })], startLights: { lit: 0, out: true }, weather: { kind: 'clear' as const, rain: 0, wetness: 0 } };
    const back = decodeFrame(3, encodeFrame(frame), null, 0);
    expect(back.cars[0].damage.floor).toBeCloseTo(0.4, 5);
    expect(back.cars[0].damage.suspension).toBeCloseTo(0.9, 5);
    expect(back.cars[0].damage.frontWing).toBeCloseTo(0.2, 5);
  });
});
