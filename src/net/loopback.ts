/**
 * In-memory NetTransport pairs on a manual clock (tests): every message is delivered after `delayMs` (+ up to
 * `jitterMs`, which reorders the 'state' channel). The 'state' channel also drops (`loss`) and duplicates
 * (`duplicate`) messages; the 'reliable' channel is delayed but in order and complete. Deterministic (seeded).
 */
import type { NetChannel, NetPayload, NetTransport } from './transport';

export interface LoopbackOptions {
  delayMs?: number;
  jitterMs?: number;
  /** 'state' channel: share of messages dropped / delivered twice */
  loss?: number;
  duplicate?: number;
  seed?: number;
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

  constructor(private readonly net: LoopbackNetwork) {}

  get open(): boolean {
    return !this.closed;
  }

  send(channel: NetChannel, data: NetPayload): void {
    if (this.closed || !this.other || this.other.closed) return;
    // copy binary payloads: the sender may reuse its buffer
    const copy = typeof data === 'string' ? data : data.slice(0);
    this.net.enqueue(this.other, channel, copy);
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
  private readonly delay: number;
  private readonly jitter: number;
  private readonly loss: number;
  private readonly duplicate: number;
  /** messages sent / dropped on the 'state' channel (statistics) */
  sentState = 0;
  droppedState = 0;

  constructor(opts: LoopbackOptions = {}) {
    this.delay = Math.max(0, opts.delayMs ?? 0);
    this.jitter = Math.max(0, opts.jitterMs ?? 0);
    this.loss = Math.min(1, Math.max(0, opts.loss ?? 0));
    this.duplicate = Math.min(1, Math.max(0, opts.duplicate ?? 0));
    this.rng = (opts.seed ?? 1) >>> 0 || 1;
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

  enqueue(to: LoopbackEnd, channel: NetChannel, data: NetPayload): void {
    if (channel === 'state') {
      this.sentState++;
      if (this.random() < this.loss) {
        this.droppedState++;
        return;
      }
      this.push(to, channel, data, this.now + this.delay + this.random() * this.jitter);
      if (this.random() < this.duplicate) this.push(to, channel, data, this.now + this.delay + this.random() * this.jitter);
      return;
    }
    const at = Math.max(this.now + this.delay + this.random() * this.jitter, to.lastReliable);
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

/** Internal close marker on the reliable queue. */
const CLOSE = '\u0000__loopback_close__';
