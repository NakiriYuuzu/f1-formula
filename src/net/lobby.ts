/**
 * Online lobby logic (pure, over NetTransport): the host keeps the seats (player 0 = host, guests 1–3), each player's
 * team / driver (unique; a My Team entry takes its whole team), what each player races as (meta/onlineEntry.ts), ready
 * flags, the race settings and every guest's car setup and assists (the host simulates their cars with them); the
 * guest side mirrors the lobby and sends its choices. Between sessions the lobby owns the
 * transports' message handlers; during a session HostSession / ClientSession do (attach / detach).
 */
import type { Assists, CarSetup, PlayerIndex, SessionConfig, SessionResult } from '../core/types';
import { DEFAULT_ASSISTS, DEFAULT_SETUP } from '../core/defaults';
import { sanitizeAssists, sanitizeSetup } from '../meta/guards';
import { ROSTER_ENTRY, sanitizeOnlineEntry, type OnlineEntry } from '../meta/onlineEntry';
import { driverName, type Roster } from '../meta/roster';
import {
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type LobbyEntry,
  type LobbyPlayer,
  type LobbyRoster,
  type LobbySettings,
  type LobbyState,
  type NetMessage,
} from './protocol';
import type { NetTransport } from './transport';

export const MAX_PLAYERS = 4;
const PING_MS = 2000;

export function lobbyRoster(roster: Roster): LobbyRoster {
  return {
    teams: roster.teams.map((t) => ({ id: t.id, name: t.shortName || t.name, color: t.livery?.primary ?? '#888888' })),
    drivers: roster.drivers.filter((d) => d.teamId !== '').map((d) => ({ id: d.id, name: driverName(d), teamId: d.teamId })),
  };
}

/**
 * Whether a seat is free for `playerIndex`: a whole team (a team entry) needs no other player in it; a driver needs
 * its seat free and its team not taken over by another player's team entry.
 */
export function seatFree(players: readonly LobbyPlayer[], playerIndex: PlayerIndex, teamId: string, driverId: string, wholeTeam: boolean): boolean {
  return players.every(
    (p) => p.playerIndex === playerIndex || (wholeTeam ? p.teamId !== teamId : p.driverId !== driverId && !(p.entry?.kind === 'team' && p.teamId === teamId)),
  );
}

/** How the lobby lists an entry the host has checked (undefined: the roster driver). */
export function lobbyEntry(entry: OnlineEntry): LobbyEntry | undefined {
  if (entry.kind === 'driver') return { kind: 'driver', source: entry.source, driver: driverName(entry.driver) };
  if (entry.kind === 'team') return { kind: 'team', driver: driverName(entry.driver), team: entry.team.name, color: entry.team.livery.primary };
  return undefined;
}

/** How the lobby will list a player who sent `entry` (the host checks every entry, its own too). */
export function listedEntry(entry: OnlineEntry): LobbyEntry | undefined {
  return lobbyEntry(sanitizeOnlineEntry(entry));
}

/** Whether two lobby listings are the same entry. */
export function sameListing(a: LobbyEntry | undefined, b: LobbyEntry | undefined): boolean {
  return a?.kind === b?.kind && a?.source === b?.source && a?.driver === b?.driver && a?.team === b?.team && a?.color === b?.color;
}

interface Guest {
  playerIndex: PlayerIndex;
  transport: NetTransport;
  joined: boolean;
  setup: CarSetup;
  assists: Assists;
  entry: OnlineEntry;
  pingSent: number;
}

export interface HostLobbyOptions {
  code: string;
  name: string;
  roster: Roster;
  settings: LobbySettings;
  /** wall clock (ms) for pings; injectable for tests */
  now?: () => number;
}

export class HostLobby {
  readonly state: LobbyState;
  /** lobby changed (players / settings): redraw */
  onChange: (() => void) | null = null;
  private readonly guests = new Map<PlayerIndex, Guest>();
  private hostEntry: OnlineEntry = ROSTER_ENTRY;
  private attached = true;
  private started = false;
  private readonly now: () => number;
  private lastPing = 0;

  constructor(opts: HostLobbyOptions) {
    this.now = opts.now ?? (() => Date.now());
    const roster = lobbyRoster(opts.roster);
    const first = roster.drivers[0];
    this.state = {
      code: opts.code,
      players: [{ playerIndex: 0, name: opts.name || '房主', teamId: first?.teamId ?? '', driverId: first?.id ?? '', ready: true, ping: 0, connected: true }],
      settings: { ...opts.settings },
      roster,
    };
  }

  get host(): LobbyPlayer {
    return this.state.players[0] as LobbyPlayer;
  }

  /** A new peer link: it joins once its 'join' arrives (full lobby / wrong version / session running: refused). */
  addGuest(transport: NetTransport): void {
    const free = ([1, 2, 3] as const).find((pi) => !this.guests.has(pi));
    if (free === undefined || this.started) {
      send(transport, { t: 'reject', reason: free === undefined ? '房間已滿（最多 4 名玩家）' : '比賽已經開始，請等下一場' });
      transport.close();
      return;
    }
    const g: Guest = { playerIndex: free, transport, joined: false, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, entry: ROSTER_ENTRY, pingSent: 0 };
    this.guests.set(free, g);
    this.listen(g);
    transport.onClose = () => this.removeGuest(g);
  }

  /** The host's seat and what it races as (entry omitted: unchanged; checked like a guest's); false when the seat is not free. */
  setHostPick(teamId: string, driverId: string, picked: OnlineEntry = this.hostEntry): boolean {
    const entry = sanitizeOnlineEntry(picked);
    if (!this.pickOk(0, teamId, driverId, entry)) return false;
    this.hostEntry = entry;
    this.seat(this.host, teamId, driverId, entry);
    this.changed();
    return true;
  }

  setSettings(settings: Partial<LobbySettings>): void {
    Object.assign(this.state.settings, settings);
    this.changed();
  }

  setName(name: string): void {
    this.host.name = name || '房主';
    this.changed();
  }

  /** Every joined guest is ready (the host is always ready). */
  canStart(): boolean {
    return this.state.players.every((p) => p.ready || !p.connected);
  }

  /** Setup and assists of a guest (defaults for the host: it uses its own local ones). */
  guestCar(playerIndex: PlayerIndex): { setup: CarSetup; assists: Assists } | null {
    const g = this.guests.get(playerIndex);
    return g ? { setup: { ...g.setup }, assists: { ...g.assists } } : null;
  }

  /** What a player races as (the roster driver for an unknown seat). */
  entryOf(playerIndex: PlayerIndex): OnlineEntry {
    return playerIndex === 0 ? this.hostEntry : (this.guests.get(playerIndex)?.entry ?? ROSTER_ENTRY);
  }

  /** Joined guests and their links (for HostSession). */
  sessionPlayers(): { playerIndex: PlayerIndex; name: string; transport: NetTransport }[] {
    return [...this.guests.values()]
      .filter((g) => g.joined && g.transport.open)
      .map((g) => ({ playerIndex: g.playerIndex, name: this.playerOf(g.playerIndex)?.name ?? `P${g.playerIndex + 1}`, transport: g.transport }));
  }

  /** A session starts: everyone gets the config; the session layer takes the links over. */
  startSession(session: number, config: SessionConfig, final: boolean): void {
    this.started = true;
    for (const g of this.guests.values()) if (g.joined) send(g.transport, { t: 'start', session, config, final });
    this.attached = false;
  }

  /** Back in the lobby (between sessions / after the weekend): the lobby handles the links again. */
  attach(weekendOver: boolean): void {
    this.attached = true;
    if (weekendOver) {
      this.started = false;
      for (const p of this.state.players) if (p.playerIndex !== 0) p.ready = false;
    }
    for (const g of this.guests.values()) {
      this.listen(g);
      g.transport.onClose = () => this.removeGuest(g);
      if (!g.transport.open) this.removeGuest(g);
    }
    this.changed();
  }

  /** Back in the lobby screen: a weekend left early is over (new players may join, ready flags reset). */
  endWeekend(): void {
    if (!this.started) return;
    this.started = false;
    for (const p of this.state.players) if (p.playerIndex !== 0) p.ready = false;
    this.changed();
  }

  /** Results of a session for everyone (also handled by ClientSession while it runs). */
  sendResult(session: number, result: SessionResult, final: boolean): void {
    for (const g of this.guests.values()) if (g.joined) send(g.transport, { t: 'result', session, result, final });
  }

  /** Lobby pings (call every frame; sends at most every PING_MS). */
  tick(): void {
    if (!this.attached) return;
    const t = this.now();
    if (t - this.lastPing < PING_MS) return;
    this.lastPing = t;
    for (const g of this.guests.values()) {
      if (!g.joined) continue;
      g.pingSent = t;
      send(g.transport, { t: 'ping', at: t });
    }
  }

  close(reason = '房主已關閉房間'): void {
    for (const g of this.guests.values()) {
      g.transport.onClose = null;
      send(g.transport, { t: 'bye', reason });
      g.transport.close();
    }
    this.guests.clear();
    this.state.players.splice(1);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private listen(g: Guest): void {
    g.transport.onMessage = (channel, data) => {
      if (channel !== 'reliable') return;
      const m = decodeMessage(data);
      if (m) this.receive(g, m);
    };
  }

  private receive(g: Guest, m: NetMessage): void {
    if (!this.attached && m.t !== 'pong') return;
    switch (m.t) {
      case 'join': {
        if (g.joined) return;
        if (m.version !== PROTOCOL_VERSION) {
          send(g.transport, { t: 'reject', reason: '遊戲版本不同，請重新整理頁面後再試' });
          g.transport.close();
          this.guests.delete(g.playerIndex);
          return;
        }
        g.joined = true;
        const free = this.state.roster.drivers.find((d) => seatFree(this.state.players, g.playerIndex, d.teamId, d.id, false));
        this.state.players.push({
          playerIndex: g.playerIndex,
          name: m.name.slice(0, 24) || `玩家 ${g.playerIndex + 1}`,
          teamId: free?.teamId ?? '',
          driverId: free?.id ?? '',
          ready: false,
          ping: 0,
          connected: true,
        });
        this.state.players.sort((a, b) => a.playerIndex - b.playerIndex);
        send(g.transport, { t: 'welcome', playerIndex: g.playerIndex });
        this.changed();
        return;
      }
      case 'pick': {
        if (!g.joined) return;
        if (m.setup !== undefined) g.setup = sanitizeSetup(m.setup);
        if (m.assists !== undefined) g.assists = sanitizeAssists(m.assists);
        const entry = m.entry !== undefined ? sanitizeOnlineEntry(m.entry) : g.entry;
        const p = this.playerOf(g.playerIndex);
        if (p && this.pickOk(g.playerIndex, m.teamId, m.driverId, entry)) {
          g.entry = entry;
          this.seat(p, m.teamId, m.driverId, entry);
        }
        if (p && m.seq !== undefined) p.pickSeq = m.seq;
        this.changed();
        return;
      }
      case 'ready': {
        const p = this.playerOf(g.playerIndex);
        if (!p) return;
        p.ready = m.ready;
        this.changed();
        return;
      }
      case 'pong': {
        const p = this.playerOf(g.playerIndex);
        if (p && g.pingSent === m.at) {
          p.ping = Math.max(0, Math.round(this.now() - m.at));
          if (this.attached) this.changed();
        }
        return;
      }
      default:
        return;
    }
  }

  private pickOk(playerIndex: PlayerIndex, teamId: string, driverId: string, entry: OnlineEntry): boolean {
    const d = this.state.roster.drivers.find((x) => x.id === driverId);
    if (!d || d.teamId !== teamId) return false;
    return seatFree(this.state.players, playerIndex, teamId, driverId, entry.kind === 'team');
  }

  private seat(p: LobbyPlayer, teamId: string, driverId: string, entry: OnlineEntry): void {
    p.teamId = teamId;
    p.driverId = driverId;
    const shown = lobbyEntry(entry);
    if (shown) p.entry = shown;
    else delete p.entry;
  }

  private playerOf(pi: PlayerIndex): LobbyPlayer | undefined {
    return this.state.players.find((p) => p.playerIndex === pi);
  }

  private removeGuest(g: Guest): void {
    if (this.guests.get(g.playerIndex) !== g) return;
    this.guests.delete(g.playerIndex);
    const i = this.state.players.findIndex((p) => p.playerIndex === g.playerIndex);
    if (i >= 0) this.state.players.splice(i, 1);
    this.changed();
  }

  private changed(): void {
    if (this.attached) for (const g of this.guests.values()) if (g.joined) send(g.transport, { t: 'lobby', lobby: this.state });
    this.onChange?.();
  }
}

export interface GuestLobbyCallbacks {
  changed?(): void;
  /** the host starts a session */
  start?(session: number, config: SessionConfig, final: boolean): void;
  result?(session: number, result: SessionResult, final: boolean): void;
  /** refused / the host left / link lost (zh-TW reason) */
  closed?(reason: string): void;
}

export class GuestLobby {
  state: LobbyState | null = null;
  playerIndex: PlayerIndex | null = null;
  /** `seq` of the last pick sent (the host echoes the ones it handled in LobbyPlayer.pickSeq) */
  pickSeq = 0;
  private closedFlag = false;

  constructor(
    private readonly transport: NetTransport,
    name: string,
    private readonly cb: GuestLobbyCallbacks = {},
  ) {
    this.attach();
    send(transport, { t: 'join', version: PROTOCOL_VERSION, name });
  }

  get me(): LobbyPlayer | null {
    return this.state?.players.find((p) => p.playerIndex === this.playerIndex) ?? null;
  }

  get link(): NetTransport {
    return this.transport;
  }

  pick(teamId: string, driverId: string, setup?: CarSetup, assists?: Assists, entry?: OnlineEntry): void {
    const seq = ++this.pickSeq;
    send(this.transport, { t: 'pick', teamId, driverId, ...(setup ? { setup } : {}), ...(assists ? { assists } : {}), ...(entry ? { entry } : {}), seq });
  }

  /** Every pick sent so far has been handled by the host: the lobby state shows what was taken. */
  picksSettled(): boolean {
    const me = this.me;
    return me !== null && me.pickSeq === this.pickSeq;
  }

  setReady(ready: boolean): void {
    send(this.transport, { t: 'ready', ready });
  }

  /** Re-take the link's messages (after a session). */
  attach(): void {
    this.transport.onMessage = (channel, data) => {
      if (channel !== 'reliable') return;
      const m = decodeMessage(data);
      if (m) this.handle(m);
    };
    this.transport.onClose = () => this.closed('與房主的連線中斷');
    if (!this.transport.open) this.closed('與房主的連線中斷');
  }

  /** Messages outside a session (also those a ClientSession passes on). */
  handle(m: NetMessage): void {
    switch (m.t) {
      case 'welcome':
        this.playerIndex = m.playerIndex;
        this.cb.changed?.();
        return;
      case 'lobby':
        this.state = m.lobby;
        this.cb.changed?.();
        return;
      case 'reject':
        this.closed(m.reason);
        return;
      case 'bye':
        this.closed(m.reason || '房主已離開');
        return;
      case 'start':
        this.cb.start?.(m.session, m.config, m.final);
        return;
      case 'result':
        this.cb.result?.(m.session, m.result, m.final);
        return;
      case 'ping':
        send(this.transport, { t: 'pong', at: m.at });
        return;
      default:
        return;
    }
  }

  leave(): void {
    this.closedFlag = true;
    this.transport.onClose = null;
    this.transport.close();
  }

  private closed(reason: string): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.transport.onClose = null;
    this.transport.close();
    this.cb.closed?.(reason);
  }
}

function send(t: NetTransport, m: NetMessage): void {
  if (t.open) t.send('reliable', encodeMessage(m));
}
