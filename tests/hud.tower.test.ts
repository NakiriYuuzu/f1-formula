/**
 * Timing tower position-number column: the fixed per-slot numbers must follow the state (retired dimming, player
 * highlight) of the row that is visually at that slot, i.e. only switch once the row's glide has finished.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CarEntry, WorldState } from '../src/core/types';
import { GLIDE_SEC, TimingTower } from '../src/ui/hud/tower';

class FakeEl {
  className = '';
  textContent = '';
  title = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  classList = { toggle: (_c: string, _on?: boolean): void => undefined };
  constructor(readonly tag: string) {}
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  addEventListener(): void {}
}

const g = globalThis as unknown as { document?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.document;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
});
afterAll(() => {
  g.document = saved;
});

function entry(id: number, patch: Partial<{ status: string; playerIndex: number }> = {}): CarEntry {
  return {
    id,
    abbr: `C${id}`,
    status: patch.status ?? 'racing',
    playerIndex: patch.playerIndex ?? -1,
    livery: { primary: '#ff0000' },
    phys: { tire: { compound: 'soft' } },
    timing: { bestLap: null, lapsDown: 0, gapToLeader: 0, interval: 0 },
    pit: { phase: 'none' },
    penalties: { timeSec: 0 },
  } as unknown as CarEntry;
}

const worldOf = (cars: CarEntry[]): WorldState => ({ cars, session: { kind: 'race', fastestLap: null } }) as unknown as WorldState;

function numbers(root: FakeEl): FakeEl[] {
  const body = root.children[1];
  return body.children.filter((c) => c.className === 'nvh-tw-pos');
}

describe('timing tower position numbers', () => {
  test('retired status shows on the number of the slot the retired row sits in', () => {
    const root = new FakeEl('div');
    const tower = new TimingTower(root as unknown as Element);
    const cars = [entry(0), entry(1), entry(2)];
    tower.update(worldOf(cars), cars, 1);
    cars[2] = entry(2, { status: 'retired' });
    tower.update(worldOf(cars), cars, 1);
    const nums = numbers(root.children[0]);
    expect(nums[2].attrs.get('data-status')).toBe('retired');
    expect(nums[0].attrs.get('data-status')).toBeUndefined();
  });

  test('a swap moves the player highlight only after the row has glided there', () => {
    const root = new FakeEl('div');
    const tower = new TimingTower(root as unknown as Element);
    const a = entry(0);
    const p = entry(1, { playerIndex: 0 });
    tower.update(worldOf([a, p]), [a, p], 1);
    const nums = numbers(root.children[0]);
    expect(nums[1].attrs.get('data-player')).toBe('0');
    // player overtakes: order flips
    const world = worldOf([a, p]);
    tower.update(world, [p, a], 0.25);
    expect(nums[1].attrs.get('data-player')).toBe('0'); // row still gliding away from slot 2
    expect(nums[0].attrs.get('data-player')).toBeUndefined();
    tower.update(world, [p, a], GLIDE_SEC - 0.1); // 0.35 s after the swap
    expect(nums[0].attrs.get('data-player')).toBeUndefined();
    tower.update(world, [p, a], 0.2); // > GLIDE_SEC
    expect(nums[0].attrs.get('data-player')).toBe('0');
    expect(nums[1].attrs.get('data-player')).toBeUndefined();
  });

  test('a swap that reverts before the glide ends changes nothing', () => {
    const root = new FakeEl('div');
    const tower = new TimingTower(root as unknown as Element);
    const a = entry(0);
    const p = entry(1, { playerIndex: 0 });
    tower.update(worldOf([a, p]), [a, p], 1);
    const nums = numbers(root.children[0]);
    tower.update(worldOf([a, p]), [p, a], 0.25);
    tower.update(worldOf([a, p]), [a, p], 0.25);
    tower.update(worldOf([a, p]), [a, p], 1);
    expect(nums[1].attrs.get('data-player')).toBe('0');
    expect(nums[0].attrs.get('data-player')).toBeUndefined();
  });
});
