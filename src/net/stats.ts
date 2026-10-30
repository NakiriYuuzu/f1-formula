/**
 * Online link statistics for the connection diagnostics panel (race HUD, F3): what each side measures of its link over
 * the last STATS_WINDOW_MS, plus what WebRTC itself reports (round trip, route; peer.ts). Pure logic.
 */

/** Rates and worst values are taken over this much wall-clock time (ms). */
export const STATS_WINDOW_MS = 2000;
/** Recent seqs a SeqTracker remembers to recognise duplicates (well over a window of 30 Hz snapshots). */
const SEEN = 128;

/**
 * Timed samples of the last STATS_WINDOW_MS: their sum per second and their largest value. `since`: when watching
 * began (default: the first sample) — a rate of rare events (the first one minutes in) is taken over the whole window.
 */
export class StatWindow {
  private items: { at: number; v: number }[] = [];

  constructor(private since: number | null = null) {}

  add(at: number, v = 1): void {
    this.since ??= at;
    this.items.push({ at, v });
    this.trim(at);
  }

  /** Sum per second over the window (over the time since `since` while that is shorter). */
  perSecond(now: number): number {
    this.trim(now);
    if (this.since === null) return 0;
    const span = Math.min(STATS_WINDOW_MS, Math.max(250, now - this.since)) / 1000;
    let sum = 0;
    for (const i of this.items) sum += i.v;
    return sum / span;
  }

  sum(now: number): number {
    this.trim(now);
    let sum = 0;
    for (const i of this.items) sum += i.v;
    return sum;
  }

  max(now: number): number {
    this.trim(now);
    let max = 0;
    for (const i of this.items) max = Math.max(max, i.v);
    return max;
  }

  private trim(now: number): void {
    while (this.items.length > 0 && (this.items[0] as { at: number }).at < now - STATS_WINDOW_MS) this.items.shift();
  }
}

/**
 * Datagrams of one numbered stream (snapshot seqs, uint16): how many of the last STATS_WINDOW_MS never arrived (a
 * gap in the seqs; one that turns up late after all is taken back; a duplicate counts once) and the longest wait
 * between two arrivals.
 */
export class SeqTracker {
  private last: number | null = null;
  private lastAt: number | null = null;
  /** the last SEEN seqs (duplicates of them are not counted again) */
  private readonly seen: number[] = [];
  private readonly got = new StatWindow();
  private readonly lost = new StatWindow();
  private readonly gaps = new StatWindow();

  /** A datagram with `seq` arrived at `at` (ms). */
  arrived(seq: number, at: number): void {
    if (this.seen.includes(seq)) return;
    this.seen.push(seq);
    if (this.seen.length > SEEN) this.seen.shift();
    this.got.add(at);
    if (this.lastAt !== null) this.gaps.add(at, at - this.lastAt);
    this.lastAt = at;
    if (this.last === null) {
      this.last = seq;
      return;
    }
    const ahead = (seq - this.last + 0x10000) % 0x10000;
    if (ahead < 0x8000) {
      // the seqs skipped were lost (so far)
      if (ahead > 1) this.lost.add(at, ahead - 1);
      this.last = seq;
    } else this.lost.add(at, -1);
  }

  /** Arrivals per second. */
  rate(now: number): number {
    return this.got.perSecond(now);
  }

  /** Share of the datagrams sent that never arrived (0..1). */
  loss(now: number): number {
    const got = this.got.sum(now);
    const lost = Math.max(0, this.lost.sum(now));
    return got + lost > 0 ? lost / (got + lost) : 0;
  }

  /** Longest wait (ms) between two arrivals, also counting the one still going on. */
  maxGap(now: number): number {
    return Math.max(this.gaps.max(now), this.lastAt !== null ? now - this.lastAt : 0);
  }
}

/** What WebRTC reports of a peer link (RTCPeerConnection.getStats, the selected candidate pair). */
export interface PeerLinkStats {
  /** WebRTC's own round trip (ms, STUN on the selected pair): the network alone, no game frame in it */
  rttMs: number | null;
  /** 'relay': through a TURN server; 'direct': peer to peer */
  route: 'direct' | 'relay' | null;
}

/** The guest's view of its link to the host. */
export interface GuestLinkStats {
  /** round trip of the game's own ping (ms; through both frame loops) */
  pingMs: number | null;
  peer: PeerLinkStats | null;
  /** frame snapshots per second */
  snapshotHz: number;
  /** share of frame snapshots / own-car states lost on the way (0..1) */
  snapshotLoss: number;
  ownLoss: number;
  /** longest wait between two frame snapshots (ms) */
  maxGapMs: number;
  /** largest correction of the predicted own car (m) */
  correctionM: number;
  /** received / sent bytes per second */
  downBps: number;
  upBps: number;
}

/** The host's view of its link to one guest. */
export interface HostLinkStats {
  name: string;
  pingMs: number | null;
  peer: PeerLinkStats | null;
  /** snapshots sent per second, and the ones a congested link made wait (newest wins) per second */
  snapshotHz: number;
  deferredHz: number;
  /** sent / received bytes per second */
  upBps: number;
  downBps: number;
  /** bytes waiting on the link now */
  backlogBytes: number;
  /** the guest's inputs are played this long after they were made (ms) */
  inputDelayMs: number;
  /** steps per second the guest's car ran on a guessed input (the record came too late) */
  guessHz: number;
}

const utf8 = new TextEncoder();

/** Bytes a message takes on the wire (a string goes as UTF-8). */
export function byteSize(data: ArrayBuffer | string): number {
  return typeof data === 'string' ? utf8.encode(data).length : data.byteLength;
}
