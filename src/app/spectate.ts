/**
 * Spectating (pure): in a multiplayer session (online, split-screen) a player whose car is out of it — retired,
 * crashed out or disqualified — watches the rest. Once the 退賽 banner has had its time (or at the player's first
 * switch press) their view follows another car: the best placed other human player still racing, else the leader.
 * The switch presses step through the running order; a watched car that drops out hands over to a fresh pick. The
 * view goes back to the player's own car whenever it is in the session again (a flashback in split-screen).
 */
import type { CarEntry, WorldState } from '../core/types';

/** Still on track: racing, or (race) on the cool-down lap after the flag. A retired car is parked out of sight. */
export function canWatch(world: WorldState, carId: number): boolean {
  const car = world.cars[carId];
  if (!car) return false;
  if (car.status === 'finished') return world.config.kind === 'race';
  return car.status === 'running' || car.status === 'pitting' || car.status === 'grid';
}

const positionKey = (c: CarEntry): number => (Number.isFinite(c.timing.position) && c.timing.position > 0 ? c.timing.position : 1e6);

/** Cars that can be watched, in running order. */
export function watchOrder(world: WorldState): CarEntry[] {
  return world.cars.filter((c) => canWatch(world, c.id)).sort((a, b) => positionKey(a) - positionKey(b) || a.id - b.id);
}

/** First car to watch for the player of `ownCarId`: the best placed other human still racing, else the best placed car still racing, else any. */
export function firstWatch(world: WorldState, ownCarId: number): number | null {
  const order = watchOrder(world);
  const racing = order.filter((c) => c.status !== 'finished');
  const human = racing.find((c) => c.playerIndex >= 0 && c.id !== ownCarId);
  return (human ?? racing[0] ?? order[0])?.id ?? null;
}

/** The car `dir` places from `current` in running order (wrapping); a fresh pick when `current` cannot be watched. */
export function stepWatch(world: WorldState, current: number, dir: -1 | 1, ownCarId: number): number | null {
  const order = watchOrder(world);
  const i = order.findIndex((c) => c.id === current);
  if (i < 0) return firstWatch(world, ownCarId);
  return (order[(i + dir + order.length) % order.length] as CarEntry).id;
}

/** One view's spectating state: which car it watches instead of the player's own, and the switch presses. */
export class Spectator {
  /** car watched (null = the player's own car is shown) */
  watching: number | null = null;
  private left = false;
  private right = false;
  private press: -1 | 0 | 1 = 0;

  constructor(readonly ownCarId: number) {}

  /** The player's own car is out of the session (retired / disqualified). */
  isOut(world: WorldState): boolean {
    return world.cars[this.ownCarId]?.status === 'retired';
  }

  /** The switch keys held this frame: a key going down counts as a press (left = previous car, right = next). */
  keys(left: boolean, right: boolean): void {
    if (left && !this.left) this.press = -1;
    else if (right && !this.right) this.press = 1;
    this.left = left;
    this.right = right;
  }

  /** A switch press from elsewhere (gamepad D-pad). */
  step(dir: -1 | 1): void {
    this.press = dir;
  }

  /**
   * Per frame: picks the car to show. `delay` = seconds after the retirement before the view switches over on its
   * own. Presses made while the own car still races are dropped. True when `watching` changed.
   */
  update(world: WorldState, delay: number): boolean {
    const press = this.press;
    this.press = 0;
    const before = this.watching;
    const car = world.cars[this.ownCarId];
    if (!car || car.status !== 'retired') this.watching = null;
    else if (this.watching === null) {
      // the first press only ends the wait (it picks the same car the wait would)
      const since = world.time - (car.race.retiredAt ?? world.time);
      if (press !== 0 || !(since < delay)) this.watching = firstWatch(world, this.ownCarId);
    } else if (press !== 0) this.watching = stepWatch(world, this.watching, press, this.ownCarId);
    else if (!canWatch(world, this.watching)) this.watching = firstWatch(world, this.ownCarId);
    return this.watching !== before;
  }

  /** Back to the own car (restart). */
  reset(): void {
    this.watching = null;
    this.press = 0;
  }
}
