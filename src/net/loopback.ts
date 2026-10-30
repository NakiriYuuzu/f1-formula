/**
 * In-memory NetTransport pairs on a manual clock (tests): every message is delivered after `delayMs` (+ up to
 * `jitterMs`, which reorders the 'state' channel). The 'state' channel also drops (`loss`) and duplicates
 * (`duplicate`) messages; the 'reliable' channel is delayed but in order and complete. `stall(ms)` holds everything
 * sent for a while and lets it through in a burst (a lag spike). With a `bandwidth` each direction is a serial link
 * of that many bytes per second: messages queue behind each other (both channels, like one SCTP association) and
 * `buffered()` reports what has not left yet; `setBandwidth` changes it for what is sent from then on (a congested
 * link), both ways or one end's upload only. Deterministic (seeded).
 */
import type { NetChannel, NetPayload, NetTransport } from './transport';

export interface LoopbackOptions {
  delayMs?: number;
  jitterMs?: number;
  /** 'state' channel: share of messages dropped / delivered twice */
  loss?: number;
  duplicate?: number;
  seed?: number;
  /** bytes per second each way (0 / absent: unlimited) */
  bandwidth?: number;
}

interface Pending {
  at: number;
  order: number;
  to: LoopbackEnd;
  channel: NetChannel;
  data: NetPayload;
}

class LoopbackEnd implements NetTransport {
  onMessage: ((channel: NetChannel, data: NetPayload) => void) | null = null;
  onClose: (() => void) | null = null;
  other: LoopbackEnd | null = null;
  private closed = false;
  /** last reliable delivery time on this end (keeps the reliable channel in order under jitter) */
  lastReliable = 0;
  /** outgoing link: busy until (ms), and what is still leaving (time it has left, bytes, channel) */
  linkFreeAt = 0;
  /** bytes per second of this end's outgoing link (null: the network's) */
  bandwidth: number | null = null;
  outgoing: { leftAt: number; bytes: number; channel: NetChannel }[] = [];

  constructor(private readonly net: LoopbackNetwork) {}

  get open(): boolean {
    return !this.closed;
  }

  send(channel: NetChannel, data: NetPayload): void {
    if (this.closed || !this.other || this.other.closed) return;
    // copy binary payloads: the sender may reuse its buffer
    const copy = typeof data === 'string' ? data : data.slice(0);
    this.net.enqueue(this, this.other, channel, copy);
  }

  buffered(channel: NetChannel): number {
    const now = this.net.now;
    this.outgoing = this.outgoing.filter((o) => o.leftAt > now);
    let n = 0;
    for (const o of this.outgoing) if (o.channel === channel) n += o.bytes;
    return n;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const o = this.other;
    if (o && !o.closed) this.net.enqueueClose(o);
  }

  deliver(channel: NetChannel, data: NetPayload): void {
    if (!this.closed) this.onMessage?.(channel, data);
  }

  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

export class LoopbackNetwork {
  now = 0;
  private queue: Pending[] = [];
  private order = 0;
  private rng: number;
  private delay: number;
  private readonly jitter: number;
  private bandwidth: number;
  private readonly loss: number;
  private readonly duplicate: number;
  /** messages sent / dropped on the 'state' channel (statistics) */
  sentState = 0;
  droppedState = 0;
  /** until then (ms) messages leave only at that time */
  private stallUntil = 0;

  constructor(opts: LoopbackOptions = {}) {
    this.delay = Math.max(0, opts.delayMs ?? 0);
    this.jitter = Math.max(0, opts.jitterMs ?? 0);
    this.loss = Math.min(1, Math.max(0, opts.loss ?? 0));
    this.duplicate = Math.min(1, Math.max(0, opts.duplicate ?? 0));
    this.rng = (opts.seed ?? 1) >>> 0 || 1;
    this.bandwidth = Math.max(0, opts.bandwidth ?? 0);
  }

  /** One-way delay (ms) for what is sent from now on (a route that got slower / faster; reliable stays in order). */
  setDelay(ms: number): void {
    this.delay = Math.max(0, ms);
  }

  /** Bytes per second each way for what is sent from now on (0: unlimited); with `from`: only what that end sends. */
  setBandwidth(bytesPerSecond: number, from?: NetTransport): void {
    if (from instanceof LoopbackEnd) from.bandwidth = Math.max(0, bytesPerSecond);
    else this.bandwidth = Math.max(0, bytesPerSecond);
  }

  /** A connected pair of transports (a ↔ b). */
  pair(): [NetTransport, NetTransport] {
    const a = new LoopbackEnd(this);
    const b = new LoopbackEnd(this);
    a.other = b;
    b.other = a;
    return [a, b];
  }

  /** Advance the clock by `ms` and deliver everything due (in time order). */
  advance(ms: number): void {
    const until = this.now + Math.max(0, ms);
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i] as Pending;
        if (q.at > until) continue;
        const b = best >= 0 ? (this.queue[best] as Pending) : null;
        if (!b || q.at < b.at || (q.at === b.at && q.order < b.order)) best = i;
      }
      if (best < 0) break;
      const [p] = this.queue.splice(best, 1);
      if (!p) break;
      this.now = Math.max(this.now, p.at);
      if (p.channel === 'reliable' && p.data === CLOSE) p.to.remoteClosed();
      else p.to.deliver(p.channel, p.data);
    }
    this.now = until;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** A lag spike: what is sent in the next `ms` (both ways, both channels) leaves only when it ends. */
  stall(ms: number): void {
    this.stallUntil = Math.max(this.stallUntil, this.now + Math.max(0, ms));
  }

  enqueue(sender: LoopbackEnd, to: LoopbackEnd, channel: NetChannel, data: NetPayload): void {
    let from = Math.max(this.now, this.stallUntil);
    const bandwidth = sender.bandwidth ?? this.bandwidth;
    if (bandwidth > 0) {
      // the sender's link: behind what it is still sending (a lost message used the link all the same)
      const bytes = typeof data === 'string' ? utf8Length(data) : data.byteLength;
      from = Math.max(from, sender.linkFreeAt) + (bytes * 1000) / bandwidth;
      sender.linkFreeAt = from;
      sender.outgoing = sender.outgoing.filter((o) => o.leftAt > this.now);
      sender.outgoing.push({ leftAt: from, bytes, channel });
    }
    if (channel === 'state') {
      this.sentState++;
      if (this.random() < this.loss) {
        this.droppedState++;
        return;
      }
      this.push(to, channel, data, from + this.delay + this.random() * this.jitter);
      if (this.random() < this.duplicate) this.push(to, channel, data, from + this.delay + this.random() * this.jitter);
      return;
    }
    const at = Math.max(from + this.delay + this.random() * this.jitter, to.lastReliable);
    to.lastReliable = at;
    this.push(to, channel, data, at);
  }

  enqueueClose(to: LoopbackEnd): void {
    const at = Math.max(this.now + this.delay, to.lastReliable);
    to.lastReliable = at;
    this.push(to, 'reliable', CLOSE, at);
  }

  private push(to: LoopbackEnd, channel: NetChannel, data: NetPayload, at: number): void {
    this.queue.push({ at, order: this.order++, to, channel, data });
  }

  private random(): number {
    // xorshift32
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // a surrogate pair: one 4-byte character
      n += 4;
      i++;
    } else n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

/** Internal close marker on the reliable queue. */
const CLOSE = '\u0000__loopback_close__';
