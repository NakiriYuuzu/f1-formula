/**
 * A frame timer that keeps going while the page is hidden. Browsers stop requestAnimationFrame in a hidden tab (a
 * minimised or covered window too) and let main-thread timers fire about once a second there, so the online host's
 * world — everyone's race — would freeze for every guest. A dedicated worker's interval is not slowed down that way:
 * its ticks drive the host's frames (simulate + send, no drawing) until the page is shown again. Falls back to a
 * main-thread interval where a worker cannot be made.
 */

/** Ticks per second while the page is hidden. */
export const BACKGROUND_HZ = 60;

const WORKER_SOURCE = 'let id=null;onmessage=(e)=>{clearInterval(id);id=e.data>0?setInterval(()=>postMessage(0),e.data):null;};';

export class BackgroundTicker {
  private worker: Worker | null = null;
  private url: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onTick: () => void,
    private readonly intervalMs = 1000 / BACKGROUND_HZ,
  ) {}

  get running(): boolean {
    return this.worker !== null || this.timer !== null;
  }

  start(): void {
    if (this.running) return;
    try {
      this.url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      const worker = new Worker(this.url);
      worker.onmessage = () => this.onTick();
      worker.onerror = () => this.fallBack();
      worker.postMessage(this.intervalMs);
      this.worker = worker;
    } catch {
      this.fallBack();
    }
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** No worker (blocked / failed): a main-thread interval, slowed down while hidden but better than nothing. */
  private fallBack(): void {
    this.stop();
    this.timer = setInterval(() => this.onTick(), this.intervalMs);
  }
}
