/**
 * Race-control visuals (pure parts): marshal panel state machine (cautions, flashing, VSC / SC lettering, red,
 * 4 s green hold, replay seek), sector lookup, safety car wheel roll direction + light bar phases, and the
 * safety car geometry budget / dimensions.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { RaceControlMode } from '../src/core/types';
import { FlagPanelState, GREEN_HOLD_S, PANEL_CELL, PANEL_FLASH_HZ, flashOn, sectorOfS } from '../src/render/track/flagPanelState';
import { SC_FLASH_HZ, lightBarPhase, wheelSpinAngle } from '../src/render/car/safetyCarMath';
import {
  SC_HEIGHT,
  SC_LENGTH,
  SC_WHEEL_RADIUS,
  SC_WIDTH,
  bodySideX,
  buildSafetyCarGeometry,
  triangleCount,
} from '../src/render/car/safetyCarGeometry';

const rc = (mode: RaceControlMode, flags: number[] = [0, 0, 0]) => ({ mode, sectorFlags: flags });
/** time where the flash is in its "on" half */
const ON = 0.1;
const OFF = 0.5 / PANEL_FLASH_HZ + 0.1;

describe('sectorOfS', () => {
  test('maps distance to sector by sectorStarts', () => {
    const starts = [0, 1000, 2500] as const;
    expect(sectorOfS(0, starts)).toBe(0);
    expect(sectorOfS(999, starts)).toBe(0);
    expect(sectorOfS(1000, starts)).toBe(1);
    expect(sectorOfS(2499, starts)).toBe(1);
    expect(sectorOfS(4000, starts)).toBe(2);
  });
});

describe('flag panel state machine', () => {
  test('dark without race control', () => {
    const p = new FlagPanelState(3);
    p.update(undefined, 1);
    expect([...p.cells]).toEqual([0, 0, 0]);
  });

  test('sector flags: 1 steady yellow, 2 flashing yellow', () => {
    const p = new FlagPanelState(3);
    p.update(rc('green', [1, 2, 0]), ON);
    expect([...p.cells]).toEqual([PANEL_CELL.yellow, PANEL_CELL.yellow, PANEL_CELL.dark]);
    p.update(rc('green', [1, 2, 0]), OFF);
    expect([...p.cells]).toEqual([PANEL_CELL.yellow, PANEL_CELL.dark, PANEL_CELL.dark]);
  });

  test('flash timing follows the rate', () => {
    expect(flashOn(0.0)).toBe(true);
    expect(flashOn(0.5 / PANEL_FLASH_HZ + 0.01)).toBe(false);
    expect(flashOn(1 / PANEL_FLASH_HZ + 0.01)).toBe(true);
  });

  test('VSC / SC flash with lettering on every sector, red is steady', () => {
    const p = new FlagPanelState(3);
    for (const mode of ['vsc', 'vscEnding'] as const) {
      p.update(rc(mode), ON);
      expect([...p.cells]).toEqual([2, 2, 2]);
      p.update(rc(mode), OFF);
      expect([...p.cells]).toEqual([0, 0, 0]);
    }
    for (const mode of ['sc', 'scEnding'] as const) {
      p.update(rc(mode), ON);
      expect([...p.cells]).toEqual([3, 3, 3]);
    }
    p.update(rc('red'), OFF);
    expect([...p.cells]).toEqual([4, 4, 4]);
  });

  test('green for GREEN_HOLD_S after the caution ends, then dark', () => {
    const p = new FlagPanelState(3);
    p.update(rc('sc'), 10);
    p.update(rc('green'), 20);
    expect([...p.cells]).toEqual([5, 5, 5]);
    p.update(rc('green'), 20 + GREEN_HOLD_S - 0.1);
    expect(p.cells[0]).toBe(PANEL_CELL.green);
    p.update(rc('green'), 20 + GREEN_HOLD_S + 0.1);
    expect([...p.cells]).toEqual([0, 0, 0]);
  });

  test('a single sector clearing goes green while the others stay yellow', () => {
    const p = new FlagPanelState(3);
    p.update(rc('green', [1, 1, 0]), 5);
    p.update(rc('green', [0, 1, 0]), 6);
    expect([...p.cells]).toEqual([PANEL_CELL.green, PANEL_CELL.yellow, PANEL_CELL.dark]);
  });

  test('a new caution cancels the green phase', () => {
    const p = new FlagPanelState(3);
    p.update(rc('green', [1, 0, 0]), 5);
    p.update(rc('green', [0, 0, 0]), 6);
    p.update(rc('green', [1, 0, 0]), 7);
    expect(p.cells[0]).toBe(PANEL_CELL.yellow);
    p.update(rc('green', [0, 0, 0]), 8);
    expect(p.cells[0]).toBe(PANEL_CELL.green);
  });

  test('update reports whether a cell changed', () => {
    const p = new FlagPanelState(3);
    expect(p.update(rc('green', [1, 0, 0]), 1)).toBe(true);
    expect(p.update(rc('green', [1, 0, 0]), 1.01)).toBe(false);
  });

  test('a backwards seek restarts without a green phase', () => {
    const p = new FlagPanelState(3);
    p.update(rc('sc'), 100);
    p.update(undefined, 50); // seek to before the safety car
    expect([...p.cells]).toEqual([0, 0, 0]);
  });
});

describe('safety car helpers', () => {
  test('wheel spin rolls forward: the tyre top moves towards +Z for +wheelSpin', () => {
    const top = new THREE.Vector3(0, SC_WHEEL_RADIUS, 0);
    top.applyAxisAngle(new THREE.Vector3(1, 0, 0), wheelSpinAngle(0.1));
    expect(top.z).toBeGreaterThan(0);
    // the contact patch moves backwards relative to the hub (forward rolling)
    const bottom = new THREE.Vector3(0, -SC_WHEEL_RADIUS, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.1);
    expect(bottom.z).toBeLessThan(0);
  });

  test('wheel spin wraps and ignores non-finite input', () => {
    expect(Math.abs(wheelSpinAngle(Math.PI * 6 + 0.5) - 0.5)).toBeLessThan(1e-9);
    expect(wheelSpinAngle(Number.NaN)).toBe(0);
  });

  test('light bar alternates at SC_FLASH_HZ and is dark when off', () => {
    expect(lightBarPhase(0.05, true)).toBe(0);
    expect(lightBarPhase(0.5 / SC_FLASH_HZ + 0.05, true)).toBe(1);
    expect(lightBarPhase(1 / SC_FLASH_HZ + 0.05, true)).toBe(0);
    expect(lightBarPhase(0.05, false)).toBeNull();
    expect(lightBarPhase(-0.05, true)).toBe(1);
  });
});

describe('safety car geometry', () => {
  const geo = buildSafetyCarGeometry();
  const wheelTris = triangleCount(geo.wheel) * 4;
  const total = Object.entries(geo).reduce((n, [k, g]) => n + (k === 'wheel' ? wheelTris : triangleCount(g)), 0);

  test('triangle budget ≤ 6k', () => {
    expect(total).toBeLessThanOrEqual(6000);
  });

  test('body fits ≈ 4.6 × 1.95 × 1.25 m on the ground', () => {
    const box = new THREE.Box3();
    for (const k of ['body', 'glass', 'bar'] as const) box.union(geo[k].boundingBox as THREE.Box3);
    expect(box.max.z - box.min.z).toBeGreaterThan(SC_LENGTH - 0.15);
    expect(box.max.z - box.min.z).toBeLessThan(SC_LENGTH + 0.1);
    expect(box.max.x - box.min.x).toBeLessThan(SC_WIDTH + 0.1);
    expect(box.min.y).toBeGreaterThanOrEqual(0);
    expect(box.max.y).toBeGreaterThan(SC_HEIGHT - 0.1);
    expect(box.max.y).toBeLessThan(SC_HEIGHT + 0.1);
  });

  test('wheel radius and decal projection', () => {
    const wb = geo.wheel.boundingBox as THREE.Box3;
    expect(wb.max.y).toBeCloseTo(SC_WHEEL_RADIUS, 2);
    expect(bodySideX(0, 0.6)).toBeGreaterThan(0.9);
    expect(bodySideX(0, 0.6)).toBeLessThanOrEqual(0.97);
  });
});
