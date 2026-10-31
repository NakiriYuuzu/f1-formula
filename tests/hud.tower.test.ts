/**
 * Timing tower position-number column: the fixed per-slot numbers must follow the state (retired dimming, player
 * highlight) of the row that is visually at that slot, i.e. only switch once the row's glide has finished.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CarEntry, WorldState } from '../src/core/types';
import { GLIDE_SEC, TOWER_ROW_EM, TimingTower, pickTowerRows } from '../src/ui/hud/tower';

class FakeEl {
  className = '';
  textContent = '';
  title = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  /** classes switched through classList (className itself stays as created) */
  classes = new Set<string>();
  classList = {
    toggle: (c: string, on?: boolean): void => {
      if (on ?? !this.classes.has(c)) this.classes.add(c);
      else this.classes.delete(c);
    },
  };
  /** layout box for the windowing tests */
  top = 0;
  /** display: none (the HUD hidden with H): no layout box */
  hidden = false;
  getBoundingClientRect(): { top: number } {
    return { top: this.hidden ? 0 : this.top };
  }
  getClientRects(): unknown[] {
    return this.hidden ? [] : [{}];
  }
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

const g = globalThis as unknown as { document?: unknown; getComputedStyle?: unknown };
let saved: unknown;
let savedStyle: unknown;
beforeAll(() => {
  saved = g.document;
  savedStyle = g.getComputedStyle;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.getComputedStyle = () => ({ fontSize: '12px' });
});
afterAll(() => {
  g.document = saved;
  g.getComputedStyle = savedStyle;
});

function entry(id: number, patch: Partial<{ status: string; playerIndex: number; livery: Record<string, string> }> = {}): CarEntry {
  return {
    id,
    abbr: `C${id}`,
    status: patch.status ?? 'racing',
    playerIndex: patch.playerIndex ?? -1,
    livery: patch.livery ?? { primary: '#ff0000' },
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

describe('timing tower team strip', () => {
  test('shows the team identity colour, else the livery primary', () => {
    const root = new FakeEl('div');
    const tower = new TimingTower(root as unknown as Element);
    const cars = [entry(0, { livery: { primary: '#f2f1eb', ident: '#444444' } }), entry(1, { livery: { primary: '#f2f1eb' } })];
    tower.update(worldOf(cars), cars, 1);
    const strips = (n: FakeEl): FakeEl[] => (n.className === 'nvh-tw-team' ? [n] : n.children.flatMap(strips));
    expect(strips(root).map((s) => s.style.background)).toEqual(['#444444', '#f2f1eb']);
  });
});

describe('pickTowerRows', () => {
  test('everything when the rows fit (or the room is unknown)', () => {
    expect(pickTowerRows(5, 3, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(pickTowerRows(5, 3, 9)).toEqual([0, 1, 2, 3, 4]);
    expect(pickTowerRows(4, 2, Infinity)).toEqual([0, 1, 2, 3]);
    expect(pickTowerRows(0, 0, 5)).toEqual([]);
  });

  test('the player inside the top rows: simply the top rows', () => {
    expect(pickTowerRows(22, 4, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pickTowerRows(22, -1, 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('leaders plus a window centred on the player', () => {
    expect(pickTowerRows(22, 15, 8)).toEqual([0, 1, 2, 13, 14, 15, 16, 17]);
    expect(pickTowerRows(22, 8, 8)).toEqual([0, 1, 2, 6, 7, 8, 9, 10]);
  });

  test('the window stops at the end of the field and never overlaps the leaders', () => {
    expect(pickTowerRows(22, 21, 8)).toEqual([0, 1, 2, 17, 18, 19, 20, 21]);
    expect(pickTowerRows(22, 8, 8).slice(0, 3)).toEqual([0, 1, 2]);
  });

  test('little room: one leader from 3 rows, none below that, the player always shown', () => {
    expect(pickTowerRows(22, 15, 4)).toEqual([0, 14, 15, 16]);
    expect(pickTowerRows(22, 15, 2)).toEqual([14, 15]);
    expect(pickTowerRows(22, 15, 1)).toEqual([15]);
    expect(pickTowerRows(22, 15, 0)).toEqual([15]);
    expect(pickTowerRows(22, 15, -3)).toEqual([15]);
  });

  test('invariants for a 22-car field: ascending, in range, exactly the room, the player in view', () => {
    for (let fit = 1; fit <= 24; fit++) {
      for (let p = -1; p < 22; p++) {
        const rows = pickTowerRows(22, p, fit);
        expect(rows.length).toBe(Math.min(22, fit));
        expect(rows.every((r, i) => r >= 0 && r < 22 && (i === 0 || r > rows[i - 1]))).toBe(true);
        if (p >= 0) expect(rows).toContain(p);
        if (fit >= 3) expect(rows[0]).toBe(0);
      }
    }
  });
});

describe('timing tower window', () => {
  const field = (n: number, player: number): CarEntry[] => Array.from({ length: n }, (_, i) => entry(i, i === player ? { playerIndex: 0 } : {}));

  function setup(room: number, n = 22, player = 15) {
    const root = new FakeEl('div');
    const below = new FakeEl('div');
    const tower = new TimingTower(root as unknown as Element);
    tower.setLimit(below as unknown as Element);
    const container = root.children[0];
    const body = container.children[1];
    body.top = 100;
    // 12px font: 1em clearance + `room` rows of TOWER_ROW_EM
    below.top = 100 + 12 + room * TOWER_ROW_EM * 12;
    const cars = field(n, player);
    tower.update(worldOf(cars), cars, 1);
    return { container, body, cars, tower, below };
  }
  const rowsOf = (body: FakeEl): FakeEl[] => body.children.filter((c) => c.className === 'nvh-tw-row');

  test('a 22-car field with room for 8 rows shows the leaders and the rows around the player', () => {
    const { body } = setup(8);
    const visible = rowsOf(body).filter((r) => !r.classes.has('nvh-hidden'));
    expect(visible.length).toBe(8);
    expect(numbers(body.parent as FakeEl).filter((n) => !n.classes.has('nvh-hidden')).map((n) => n.children[0].textContent)).toEqual([
      '1', '2', '3', '14', '15', '16', '17', '18',
    ]);
    expect(body.style.height).toBe('calc(var(--nvh-tw-row) * 8)');
    // the player (position 16) is the sixth shown row
    const player = visible.find((r) => r.dataset.player === '0');
    expect(player?.style.transform).toBe('translateY(500%)');
    // the row after the skipped stretch is marked
    expect(visible[3].attrs.get('data-gap')).toBe('1');
    expect(visible[4].attrs.get('data-gap')).toBeUndefined();
  });

  test('plenty of room shows every car and no gap marker', () => {
    const { body } = setup(40);
    expect(rowsOf(body).every((r) => !r.classes.has('nvh-hidden') && r.attrs.get('data-gap') === undefined)).toBe(true);
    expect(body.style.height).toBe('calc(var(--nvh-tw-row) * 22)');
  });

  test('the window follows the player when the room shrinks later', () => {
    const { body, tower, cars, below } = setup(40);
    below.top = 100 + 12 + 6 * TOWER_ROW_EM * 12;
    tower.update(worldOf(cars), cars, 1);
    expect(rowsOf(body).filter((r) => !r.classes.has('nvh-hidden')).length).toBe(6);
    expect(body.style.height).toBe('calc(var(--nvh-tw-row) * 6)');
  });

  test('a hidden HUD (no layout box) keeps the last window instead of collapsing to one row', () => {
    const { body, tower, cars, below } = setup(8);
    below.hidden = true;
    body.hidden = true;
    tower.update(worldOf(cars), cars, 1);
    expect(rowsOf(body).filter((r) => !r.classes.has('nvh-hidden')).length).toBe(8);
    expect(body.style.height).toBe('calc(var(--nvh-tw-row) * 8)');
  });

  test('a watched car takes the place of the player as the window centre', () => {
    const { body, tower, cars } = setup(8);
    tower.setWatched([4 + 12]);
    tower.update(worldOf(cars), cars, 1);
    const shown = rowsOf(body).filter((r) => !r.classes.has('nvh-hidden'));
    expect(shown.some((r) => r.attrs.get('data-watched') === '1')).toBe(true);
  });
});
