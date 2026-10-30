/**
 * The App's online-room controller as the menus see it (registered by the App; null in tests / without one).
 * Screens call it to host / join / leave and read the current room.
 */
import type { OnlineEntrySource } from '../../meta/onlineEntry';
import type { OnlineRoom, SignalMode } from '../../net/room';

export interface OnlinePrefs {
  name: string;
  mode: SignalMode;
  serverUrl: string;
  /** every packet through the matchmaking server's TURN relay (mode 'server'); false: direct first */
  relay: boolean;
  /** what the player races as in a room (falls back to the roster when that save is gone) */
  entry: OnlineEntrySource;
}

export interface OnlineHooks {
  room(): OnlineRoom | null;
  prefs(): OnlinePrefs;
  savePrefs(p: OnlinePrefs): void;
  /** create and host a room (rejects with a zh-TW message) */
  host(): Promise<OnlineRoom>;
  /** join a room by code (rejects with a zh-TW message) */
  join(code: string): Promise<OnlineRoom>;
  /** leave the room (the host closes it) */
  leave(): void;
}

let hooks: OnlineHooks | null = null;

export function setOnlineHooks(h: OnlineHooks | null): void {
  hooks = h;
}

export function onlineHooks(): OnlineHooks | null {
  return hooks;
}
