/**
 * Keyboard binding resolution (pure, DOM-free).
 * Builds code → action routes for single-player and split-screen. In split-screen every code listed in
 * keyBindingsP2 is routed exclusively to player 1; all other codes follow player 0's keyBindings.
 */
import type { KeyAction, Settings } from '../core/types';

export interface InputAction {
  action: KeyAction;
  playerIndex: 0 | 1;
}

export const ALL_KEY_ACTIONS: readonly KeyAction[] = [
  'throttle',
  'brake',
  'steerLeft',
  'steerRight',
  'shiftUp',
  'shiftDown',
  'drs',
  'overtake',
  'ersCycle',
  'limiter',
  'camera',
  'lookBack',
  'pause',
  'flashback',
  'mfd',
  'pitRequest',
  'fullscreen',
  'hud',
];

/** Pre-resolved routes: code → actions, for both routing modes. */
export interface BindingTable {
  single: ReadonlyMap<string, readonly InputAction[]>;
  split: ReadonlyMap<string, readonly InputAction[]>;
}

const NO_ROUTES: readonly InputAction[] = [];

/** code → actions for one player's binding record; tolerates missing/malformed entries (old saves). */
function invertBindings(bindings: Partial<Record<KeyAction, string[]>> | null | undefined): Map<string, KeyAction[]> {
  const byCode = new Map<string, KeyAction[]>();
  if (!bindings || typeof bindings !== 'object') return byCode;
  for (const action of ALL_KEY_ACTIONS) {
    const codes: unknown = bindings[action];
    if (!Array.isArray(codes)) continue;
    for (const code of codes) {
      if (typeof code !== 'string' || code.length === 0) continue;
      const list = byCode.get(code);
      if (!list) byCode.set(code, [action]);
      else if (!list.includes(action)) list.push(action);
    }
  }
  return byCode;
}

function toRoutes(byCode: Map<string, KeyAction[]>, playerIndex: 0 | 1): Map<string, InputAction[]> {
  const routes = new Map<string, InputAction[]>();
  for (const [code, actions] of byCode) routes.set(code, actions.map((action) => ({ action, playerIndex })));
  return routes;
}

export function buildBindingTable(settings: Pick<Settings, 'keyBindings' | 'keyBindingsP2'>): BindingTable {
  const p1 = invertBindings(settings.keyBindings);
  const p2 = invertBindings(settings.keyBindingsP2);
  const single = toRoutes(p1, 0);
  const split = toRoutes(p1, 0);
  for (const [code, routes] of toRoutes(p2, 1)) split.set(code, routes);
  return { single, split };
}

/** Actions (with player) triggered by a KeyboardEvent.code; empty when unbound. */
export function resolveKey(table: BindingTable, code: string, splitScreen: boolean): readonly InputAction[] {
  return (splitScreen ? table.split : table.single).get(code) ?? NO_ROUTES;
}
