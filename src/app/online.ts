/**
 * The App's online-room controller (menus see it through ui/menus/onlineHooks): saved player name / matchmaking
 * choice / what the player races as, hosting / joining a room and leaving it. Room events (a guest's next session, the
 * room closing) go to the App through `events`.
 */
import type { SessionConfig } from '../core/types';
import { ONLINE_ENTRY_SOURCES } from '../meta/onlineEntry';
import { loadOnlineSetup, loadProfile } from '../meta/save';
import { standardRoster } from '../meta/roster';
import { readRecord, writeRecord } from '../meta/storage';
import { OnlineRoom } from '../net/room';
import { defaultSignalUrl } from '../net/signal/cloudflare';
import type { OnlineHooks, OnlinePrefs } from '../ui/menus/onlineHooks';
import { defaultLobbySettings } from '../ui/menus/screens/online';

export interface OnlineAppEvents {
  /** guest: the host started a session */
  start(session: number, config: SessionConfig, final: boolean): void;
  /** the room is gone (zh-TW reason) */
  closed(reason: string): void;
}

const PREFS_KEY = 'onlinePrefs';

export class OnlineController implements OnlineHooks {
  private current: OnlineRoom | null = null;

  constructor(private readonly events: OnlineAppEvents) {}

  room(): OnlineRoom | null {
    return this.current && !this.current.closed ? this.current : null;
  }

  prefs(): OnlinePrefs {
    const raw = readRecord(PREFS_KEY);
    const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const env = defaultSignalUrl();
    return {
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 16) : '玩家',
      mode: r.mode === 'server' ? 'server' : env && r.mode !== 'local' ? 'server' : 'local',
      serverUrl: typeof r.serverUrl === 'string' && r.serverUrl ? r.serverUrl : env,
      relay: r.relay === true,
      entry: ONLINE_ENTRY_SOURCES.find((s) => s === r.entry) ?? 'roster',
    };
  }

  savePrefs(p: OnlinePrefs): void {
    writeRecord(PREFS_KEY, { name: p.name.slice(0, 16), mode: p.mode, serverUrl: p.serverUrl.slice(0, 200), relay: p.relay, entry: p.entry });
  }

  async host(): Promise<OnlineRoom> {
    this.leave();
    const p = this.prefs();
    const room = await OnlineRoom.host({ mode: p.mode, serverUrl: p.serverUrl, name: p.name, relay: p.relay }, standardRoster(), defaultLobbySettings());
    this.adopt(room);
    return room;
  }

  async join(code: string): Promise<OnlineRoom> {
    this.leave();
    const p = this.prefs();
    const settings = defaultLobbySettings();
    const room = await OnlineRoom.join({ mode: p.mode, serverUrl: p.serverUrl, name: p.name, relay: p.relay }, code, loadOnlineSetup(settings.layoutId), { ...loadProfile().assists });
    // the host always has my online setup for its track and my assists, whatever screen is showing
    const lobby = room.guestLobby;
    if (lobby) {
      lobby.carFor = (layoutId) => ({ setup: loadOnlineSetup(layoutId), assists: { ...loadProfile().assists } });
      lobby.syncCar();
    }
    this.adopt(room);
    return room;
  }

  leave(): void {
    const r = this.current;
    this.current = null;
    r?.leave();
  }

  private adopt(room: OnlineRoom): void {
    this.current = room;
    const prevChanged = room.events.changed;
    room.events = {
      changed: prevChanged,
      start: (session, config, final) => this.events.start(session, config, final),
      closed: (reason) => {
        if (this.current === room) this.current = null;
        this.events.closed(reason);
      },
    };
  }
}
