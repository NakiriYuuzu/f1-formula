/**
 * WebRTC link to one other player as a NetTransport: an RTCPeerConnection (public STUN, plus the matchmaking server's
 * TURN relay when it has one: a fallback for a strict NAT, or the only path when the player asks for the relay) with
 * two data channels: 'state' (unordered, no retransmits) and 'reliable' (ordered). The guest makes the offer;
 * signalling payloads go through a SignalClient. Browser only (bun has no RTCPeerConnection, so this thin layer is
 * not unit-tested; everything above it runs on the loopback transport in tests).
 */
import type { SignalClient } from './signal/types';
import type { PeerLinkStats } from './stats';
import type { NetChannel, NetPayload, NetTransport } from './transport';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
/** Give up connecting after this long (ms): most likely a NAT that needs a relay. */
export const CONNECT_TIMEOUT_MS = 15000;

type Signal = { kind: 'offer' | 'answer'; sdp: string } | { kind: 'ice'; candidate: RTCIceCandidateInit };

function isSignal(v: unknown): v is Signal {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { kind?: unknown; sdp?: unknown; candidate?: unknown };
  if (o.kind === 'offer' || o.kind === 'answer') return typeof o.sdp === 'string';
  return o.kind === 'ice' && typeof o.candidate === 'object' && o.candidate !== null;
}

export function webRtcAvailable(): boolean {
  return typeof RTCPeerConnection === 'function';
}

class PeerTransport implements NetTransport {
  onClose: (() => void) | null = null;
  private closed = false;
  private handler: ((channel: NetChannel, data: NetPayload) => void) | null = null;
  /** messages that arrived before anyone listened (the other side may talk as soon as the channels open) */
  private early: [NetChannel, NetPayload][] = [];

  get onMessage(): ((channel: NetChannel, data: NetPayload) => void) | null {
    return this.handler;
  }

  set onMessage(fn: ((channel: NetChannel, data: NetPayload) => void) | null) {
    this.handler = fn;
    if (!fn || this.early.length === 0) return;
    const queued = this.early;
    this.early = [];
    for (const [c, d] of queued) fn(c, d);
  }

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly state: RTCDataChannel,
    private readonly reliable: RTCDataChannel,
  ) {
    for (const [name, ch] of [
      ['state', state],
      ['reliable', reliable],
    ] as const) {
      ch.binaryType = 'arraybuffer';
      ch.onmessage = (e: MessageEvent) => {
        const d: unknown = e.data;
        if (typeof d !== 'string' && !(d instanceof ArrayBuffer)) return;
        if (this.handler) this.handler(name, d);
        else if (name === 'reliable' && this.early.length < 256) this.early.push([name, d]);
      };
      ch.onclose = () => this.shut();
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') this.shut();
    };
  }

  get open(): boolean {
    return !this.closed && this.reliable.readyState === 'open';
  }

  buffered(channel: NetChannel): number {
    if (this.closed) return 0;
    return (channel === 'state' ? this.state : this.reliable).bufferedAmount;
  }

  /** The selected candidate pair: WebRTC's own round trip (STUN, the network alone) and whether it goes via TURN. */
  async stats(): Promise<PeerLinkStats | null> {
    if (this.closed) return null;
    const report = await this.pc.getStats();
    // (RTCStatsReport entries by type; the DOM typings give them as plain records)
    type Entry = Record<string, unknown>;
    let pair: Entry | undefined;
    report.forEach((s: Entry) => {
      if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = report.get(s.selectedCandidatePairId) as Entry | undefined;
    });
    // (Firefox marks the pair instead)
    if (!pair) report.forEach((s: Entry) => {
      if (s.type === 'candidate-pair' && s.selected === true) pair = s;
    });
    if (!pair) return { rttMs: null, route: null };
    const local = report.get(String(pair.localCandidateId)) as Entry | undefined;
    const remote = report.get(String(pair.remoteCandidateId)) as Entry | undefined;
    const rtt = pair.currentRoundTripTime;
    return {
      rttMs: typeof rtt === 'number' && Number.isFinite(rtt) ? rtt * 1000 : null,
      route: local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct',
    };
  }

  send(channel: NetChannel, data: NetPayload): void {
    const ch = channel === 'state' ? this.state : this.reliable;
    if (this.closed || ch.readyState !== 'open') return;
    // a congested unreliable channel: drop rather than queue stale state
    if (channel === 'state' && ch.bufferedAmount > 256 * 1024) return;
    try {
      if (typeof data === 'string') ch.send(data);
      else ch.send(data);
    } catch {
      // closing
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.state.close();
      this.reliable.close();
      this.pc.close();
    } catch {
      // already closed
    }
  }

  private shut(): void {
    if (this.closed) return;
    this.close();
    this.onClose?.();
  }
}

/** Extra ICE servers (TURN) and whether this side may only use them (every packet through the relay). */
export interface PeerOptions {
  iceServers?: readonly RTCIceServer[];
  relayOnly?: boolean;
}

/**
 * Connect to `remoteId` through `signal`. The guest (`initiator`) creates the channels and the offer; the host answers
 * (routeSignal delivers the remote's payloads). Resolves once both channels are open; rejects after
 * CONNECT_TIMEOUT_MS.
 */
export function connectPeer(
  signal: SignalClient,
  remoteId: string,
  initiator: boolean,
  opts: PeerOptions = {},
): { transport: Promise<NetTransport>; routeSignal(payload: unknown): void; abort(): void } {
  const relayOnly = opts.relayOnly === true;
  const pc = new RTCPeerConnection({ iceServers: [...ICE_SERVERS, ...(opts.iceServers ?? [])], iceTransportPolicy: relayOnly ? 'relay' : 'all' });
  const unreachable = relayOnly ? '無法經由中繼伺服器連線：請確認中繼伺服器開著，且防火牆開了 UDP 3478 與中繼埠' : null;
  let stateCh: RTCDataChannel | null = null;
  let reliableCh: RTCDataChannel | null = null;
  let finished = false;
  const pendingIce: RTCIceCandidateInit[] = [];
  let resolveT: (t: NetTransport) => void = () => undefined;
  let rejectT: (e: Error) => void = () => undefined;
  const transport = new Promise<NetTransport>((resolve, reject) => {
    resolveT = resolve;
    rejectT = reject;
  });
  const timer = setTimeout(() => fail(unreachable ?? '連線逾時：對方的網路可能需要中繼伺服器（嚴格 NAT）'), CONNECT_TIMEOUT_MS);
  const fail = (msg: string): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      pc.close();
    } catch {
      // ignore
    }
    rejectT(new Error(msg));
  };
  const maybeReady = (): void => {
    if (finished || !stateCh || !reliableCh || stateCh.readyState !== 'open' || reliableCh.readyState !== 'open') return;
    finished = true;
    clearTimeout(timer);
    resolveT(new PeerTransport(pc, stateCh, reliableCh));
  };
  const adopt = (ch: RTCDataChannel): void => {
    if (ch.label === 'state') stateCh = ch;
    else if (ch.label === 'reliable') reliableCh = ch;
    else return;
    ch.onopen = maybeReady;
    if (ch.readyState === 'open') maybeReady();
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) signal.send(remoteId, { kind: 'ice', candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') fail(unreachable ?? '無法建立點對點連線（可能是嚴格 NAT，需要中繼伺服器）');
  };
  if (initiator) {
    adopt(pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
    adopt(pc.createDataChannel('reliable', { ordered: true }));
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal.send(remoteId, { kind: 'offer', sdp: offer.sdp ?? '' });
      } catch {
        fail('無法建立連線邀請');
      }
    })();
  } else {
    pc.ondatachannel = (e) => adopt(e.channel);
  }
  const routeSignal = (payload: unknown): void => {
    if (finished && !pc.remoteDescription) return;
    if (!isSignal(payload)) return;
    void (async () => {
      try {
        if (payload.kind === 'offer' && !initiator) {
          await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
          for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          signal.send(remoteId, { kind: 'answer', sdp: answer.sdp ?? '' });
        } else if (payload.kind === 'answer' && initiator) {
          await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
          for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c);
        } else if (payload.kind === 'ice') {
          if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
          else pendingIce.push(payload.candidate);
        }
      } catch {
        // a stale / broken payload: the timeout reports a failed connection
      }
    })();
  };
  return { transport, routeSignal, abort: () => fail('已取消') };
}
