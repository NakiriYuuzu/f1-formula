/**
 * OnlineRoom: the browser side of an online room — matchmaking (Cloudflare Worker or the local BroadcastChannel test
 * channel), one WebRTC link per guest (peer.ts) and the lobby (lobby.ts). The host keeps the matchmaking connection
 * open for late joiners; a guest uses it only to reach the host. Session numbers count up per room.
 */
import type { Assists, CarSetup, SessionConfig, SessionResult } from '../core/types';
import type { Roster } from '../meta/roster';
import { GuestLobby, HostLobby } from './lobby';
import { connectPeer, webRtcAvailable, type PeerOptions } from './peer';
import type { LobbySettings } from './protocol';
import { BroadcastSignal, broadcastAvailable, createLocalRoomCode } from './signal/broadcast';
import { CloudflareSignal, createRemoteRoom, fetchIceServers } from './signal/cloudflare';
import { signalReasonText, type SignalClient } from './signal/types';

export type SignalMode = 'local' | 'server';

export interface RoomEvents {
  /** lobby changed (players, picks, settings) */
  changed?(): void;
  /** guest: the host starts a session */
  start?(session: number, config: SessionConfig, final: boolean): void;
  /** guest: a session's result arrived outside a session */
  result?(session: number, result: SessionResult, final: boolean): void;
  /** the room is gone (zh-TW reason) */
  closed?(reason: string): void;
}

export interface RoomOptions {
  mode: SignalMode;
  /** matchmaking server base URL (mode 'server') */
  serverUrl: string;
  name: string;
  /** every packet of this side through the matchmaking server's TURN relay (mode 'server'; else direct first) */
  relay?: boolean;
}

function makeSignal(opts: RoomOptions, code: string, host: boolean): SignalClient {
  return opts.mode === 'local' ? new BroadcastSignal(code, host) : new CloudflareSignal(opts.serverUrl, code);
}

/**
 * The matchmaking server's TURN relay for this side's links: a fallback behind direct paths, or the only path with
 * `relay` (refused when the server has no relay).
 */
async function peerOptions(opts: RoomOptions): Promise<PeerOptions> {
  if (opts.mode !== 'server') return {};
  // direct first: no relay (or no answer about one) is no reason to stop; making the room reports a server that is down
  if (!opts.relay) return { iceServers: await fetchIceServers(opts.serverUrl).catch(() => []) };
  const iceServers = await fetchIceServers(opts.serverUrl);
  if (iceServers.length === 0) throw new Error('配對伺服器沒有設定中繼伺服器（TURN）：請把「連線路徑」改回「自動（直連優先）」');
  return { iceServers, relayOnly: true };
}

function checkSupport(opts: RoomOptions): void {
  if (!webRtcAvailable()) throw new Error('這個瀏覽器不支援 WebRTC，無法線上連線');
  if (opts.mode === 'local' && !broadcastAvailable()) throw new Error('這個瀏覽器不支援本機測試連線');
  if (opts.mode === 'server' && !/^https?:\/\//.test(opts.serverUrl)) throw new Error('請先設定配對伺服器網址（https://…）');
}

export class OnlineRoom {
  readonly role: 'host' | 'guest';
  readonly code: string;
  hostLobby: HostLobby | null = null;
  guestLobby: GuestLobby | null = null;
  events: RoomEvents = {};
  private session = 0;
  private closedFlag = false;
  private readonly peers = new Map<string, { routeSignal(p: unknown): void; abort(): void }>();

  private constructor(
    role: 'host' | 'guest',
    code: string,
    private readonly signal: SignalClient,
  ) {
    this.role = role;
    this.code = code;
  }

  /** Create a room and host it. */
  static async host(opts: RoomOptions, roster: Roster, settings: LobbySettings): Promise<OnlineRoom> {
    checkSupport(opts);
    const peerOpts = await peerOptions(opts);
    const code = opts.mode === 'local' ? createLocalRoomCode() : await createRemoteRoom(opts.serverUrl);
    const signal = makeSignal(opts, code, true);
    const welcome = await signal.connect();
    if (!welcome.host) {
      signal.close();
      throw new Error('房間代碼衝突，請再試一次');
    }
    const room = new OnlineRoom('host', code, signal);
    const lobby = new HostLobby({ code, name: opts.name, roster, settings });
    room.hostLobby = lobby;
    lobby.onChange = () => room.events.changed?.();
    signal.onSignal = (from, payload) => {
      let peer = room.peers.get(from);
      if (!peer) {
        const link = connectPeer(signal, from, false, peerOpts);
        peer = link;
        room.peers.set(from, link);
        link.transport.then(
          (t) => {
            if (room.closedFlag) t.close();
            else lobby.addGuest(t);
          },
          () => room.peers.delete(from),
        );
      }
      peer.routeSignal(payload);
    };
    signal.onPeerLeft = (id) => {
      room.peers.get(id)?.abort();
      room.peers.delete(id);
    };
    signal.onClosed = (reason) => room.shut(signalReasonText(reason));
    return room;
  }

  /** Join a room by code. */
  static async join(opts: RoomOptions, code: string, setup: CarSetup, assists: Assists): Promise<OnlineRoom> {
    checkSupport(opts);
    const peerOpts = await peerOptions(opts);
    const clean = code.trim().toUpperCase();
    const signal = makeSignal(opts, clean, false);
    const welcome = await signal.connect();
    if (welcome.host || !welcome.hostId) {
      signal.close();
      throw new Error(signalReasonText('not-found'));
    }
    const room = new OnlineRoom('guest', clean, signal);
    const hostId = welcome.hostId;
    const link = connectPeer(signal, hostId, true, peerOpts);
    room.peers.set(hostId, link);
    signal.onSignal = (from, payload) => {
      if (from === hostId) link.routeSignal(payload);
    };
    signal.onClosed = (reason) => room.shut(signalReasonText(reason));
    let transport;
    try {
      transport = await link.transport;
    } catch (err) {
      signal.close();
      throw err;
    }
    room.guestLobby = new GuestLobby(transport, opts.name, {
      changed: () => {
        // first lobby state with our seat: tell the host our car setup and assists
        const lobby = room.guestLobby;
        const me = lobby?.me;
        if (lobby && me && !room.sentCar) {
          room.sentCar = true;
          lobby.pick(me.teamId, me.driverId, setup, assists);
        }
        room.events.changed?.();
      },
      start: (session, config, final) => room.events.start?.(session, config, final),
      result: (session, result, final) => room.events.result?.(session, result, final),
      closed: (reason) => room.shut(reason),
    });
    return room;
  }

  private sentCar = false;

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Host: the next session number. */
  nextSession(): number {
    return ++this.session;
  }

  /** Lobby housekeeping (pings); call every frame. */
  tick(): void {
    this.hostLobby?.tick();
  }

  /** Leave (host: closes the room for everyone). */
  leave(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.hostLobby?.close();
    this.guestLobby?.leave();
    for (const p of this.peers.values()) p.abort();
    this.peers.clear();
    this.signal.close();
  }

  private shut(reason: string): void {
    if (this.closedFlag) return;
    // a guest no longer needs the matchmaking link once connected; only the host link matters
    if (this.role === 'guest' && this.guestLobby && this.guestLobby.link.open && reason !== '與房主的連線中斷' && !/房主/.test(reason)) return;    this.closedFlag = true;
    this.hostLobby?.close('房間已關閉');
    this.guestLobby?.leave();
    for (const p of this.peers.values()) p.abort();
    this.peers.clear();
    this.signal.close();
    this.events.closed?.(reason);
  }
}
