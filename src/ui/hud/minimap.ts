/**
 * Minimap (2D canvas): track outline from track px/pz + bounds (top view: +X right, +Z down), DRS zones and
 * start/finish line pre-rendered once per size; team-coloured car dots (players larger, ringed) and the
 * time-trial ghost redrawn at most 30 times per second.
 */
import type { BuiltTrack, CarEntry, GhostData, WorldState } from '../../core/types';
import { el } from './dom';
import { fin, safeColor } from './labels';
import { controlOf, sectorFlagLevels } from './raceControl';

const FRAME = 1 / 30;
const PLAYER_RING = ['#ff5a1f', '#19d3c5'];
const YELLOW_FLAG = '#ffd500';
const SC_COLOR = '#ff8a1f';
/** a car reported by an 'incident' event keeps its warning marker until it moves faster than this (m/s), after INCIDENT_GRACE seconds */
const INCIDENT_CLEAR_SPEED = 12;
const INCIDENT_GRACE = 6;

interface Fit {
  scale: number;
  offX: number;
  offY: number;
}

export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly bg: HTMLCanvasElement;
  private readonly bgCtx: CanvasRenderingContext2D | null;
  private readonly observer: ResizeObserver | null = null;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly spanX: number;
  private readonly spanZ: number;
  private fit: Fit = { scale: 0, offX: 0, offY: 0 };
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private accum = FRAME;
  private measured = false;
  /** car id -> world time of an 'incident' event, until the car drives off again */
  private readonly incidents = new Map<number, number>();

  constructor(
    parent: Element,
    private readonly track: BuiltTrack,
  ) {
    this.el = el('div', 'nvh-minimap nvh-panel', parent);
    this.canvas = el('canvas', 'nvh-minimap-canvas', this.el);
    this.canvas.setAttribute('aria-label', '賽道小地圖');
    this.ctx = this.canvas.getContext('2d');
    this.bg = document.createElement('canvas');
    this.bgCtx = this.bg.getContext('2d');

    const b = this.computeBounds();
    this.minX = b.minX;
    this.minZ = b.minZ;
    this.spanX = Math.max(1, b.maxX - b.minX);
    this.spanZ = Math.max(1, b.maxZ - b.minZ);
    // Size the box to the layout's aspect ratio (within limits); CSS var --nvh-mm is the long side.
    const aspect = this.spanX / this.spanZ;
    const w = aspect >= 1 ? 1 : Math.max(0.45, aspect);
    const h = aspect >= 1 ? Math.max(0.45, 1 / aspect) : 1;
    this.canvas.style.width = `calc(var(--nvh-mm) * ${w.toFixed(3)})`;
    this.canvas.style.height = `calc(var(--nvh-mm) * ${h.toFixed(3)})`;

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => {
        const rect = entries[entries.length - 1]?.contentRect;
        if (rect) this.resize(rect.width, rect.height);
      });
      this.observer.observe(this.canvas);
    }
  }

  update(world: WorldState, dt: number): void {
    this.accum += dt;
    if (this.accum < FRAME) return;
    this.accum = 0;
    if (!this.measured && !this.observer) {
      this.measured = true;
      const r = this.canvas.getBoundingClientRect();
      this.resize(r.width, r.height);
    }
    this.draw(world);
  }

  /** An 'incident' event: mark the car with a warning triangle while it is stopped. */
  addIncident(carId: number, time: number): void {
    this.incidents.set(carId, fin(time));
  }

  destroy(): void {
    this.incidents.clear();
    this.observer?.disconnect();
    this.el.remove();
  }

  private computeBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const b = this.track.bounds;
    if (b && [b.minX, b.maxX, b.minZ, b.maxZ].every(Number.isFinite) && b.maxX > b.minX && b.maxZ > b.minZ) {
      return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.track.count; i++) {
      const x = this.track.px[i];
      const z = this.track.pz[i];
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (!Number.isFinite(minX)) return { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
    return { minX, maxX, minZ, maxZ };
  }

  private resize(cssW: number, cssH: number): void {
    if (!(cssW > 0) || !(cssH > 0)) return;
    const dpr = Math.min(3, Math.max(1, fin(window.devicePixelRatio, 1)));
    if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    this.canvas.width = W;
    this.canvas.height = H;
    this.bg.width = W;
    this.bg.height = H;
    const pad = 9 * dpr;
    const scale = Math.max(1e-6, Math.min((W - 2 * pad) / this.spanX, (H - 2 * pad) / this.spanZ));
    this.fit = {
      scale,
      offX: (W - this.spanX * scale) / 2 - this.minX * scale,
      offY: (H - this.spanZ * scale) / 2 - this.minZ * scale,
    };
    this.drawBackground();
    this.accum = FRAME;
  }

  private drawBackground(): void {
    const ctx = this.bgCtx;
    const t = this.track;
    if (!ctx || t.count < 2) return;
    const { scale, offX, offY } = this.fit;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, this.bg.width, this.bg.height);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const step = Math.max(1, Math.floor(t.count / 900));

    const tracePath = (): void => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < t.count; i += step) {
        const x = t.px[i] * scale + offX;
        const y = t.pz[i] * scale + offY;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.closePath();
    };

    tracePath();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 7 * dpr;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(226, 232, 241, 0.92)';
    ctx.lineWidth = 2.6 * dpr;
    ctx.stroke();

    // DRS / active-aero zones.
    ctx.strokeStyle = 'rgba(47, 210, 122, 0.95)';
    ctx.lineWidth = 2.6 * dpr;
    for (const zone of t.drsZones ?? []) this.strokeRange(ctx, zone.activation, zone.end);

    // Start / finish line, perpendicular to the track at s = 0.
    const x0 = t.px[0] * scale + offX;
    const y0 = t.pz[0] * scale + offY;
    const rx = fin(t.rx[0]);
    const rz = fin(t.rz[0]);
    if (Number.isFinite(x0) && Number.isFinite(y0) && (rx !== 0 || rz !== 0)) {
      const half = 6 * dpr;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.2 * dpr;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(x0 - rx * half, y0 - rz * half);
      ctx.lineTo(x0 + rx * half, y0 + rz * half);
      ctx.stroke();
      ctx.lineCap = 'round';
    }
  }

  /** Stroke the centre line between two distances (wrap-aware). */
  private strokeRange(ctx: CanvasRenderingContext2D, from: number, to: number): void {
    const t = this.track;
    const len = t.length;
    if (!(len > 0) || !Number.isFinite(from) || !Number.isFinite(to)) return;
    const wrap = (s: number): number => ((s % len) + len) % len;
    const start = wrap(from);
    let span = wrap(to) - start;
    if (span <= 0) span += len;
    const spacing = len / t.count;
    const first = Math.min(t.count - 1, Math.max(0, Math.round(start / spacing)));
    const steps = Math.min(t.count, Math.ceil(span / spacing));
    const { scale, offX, offY } = this.fit;
    ctx.beginPath();
    for (let k = 0; k <= steps; k++) {
      const i = (first + k) % t.count;
      const x = t.px[i] * scale + offX;
      const y = t.pz[i] * scale + offY;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private draw(world: WorldState): void {
    const ctx = this.ctx;
    if (!ctx || this.cssW <= 0) return;
    const { scale, offX, offY } = this.fit;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.bg, 0, 0);
    const r = Math.max(2.4, Math.min(5, Math.min(this.cssW, this.cssH) * 0.024)) * dpr;

    this.drawGhost(ctx, world, r);
    this.drawSectorFlags(ctx, world);
    this.drawIncidents(ctx, world, r);

    const players: CarEntry[] = [];
    for (const car of world.cars) {
      if (car.status === 'retired') continue;
      if (car.playerIndex !== -1) {
        players.push(car);
        continue;
      }
      const x = car.phys.x * scale + offX;
      const y = car.phys.z * scale + offY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = safeColor(car.livery?.primary);
      ctx.fill();
      ctx.lineWidth = 1.1 * dpr;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.stroke();
    }
    this.drawSafetyCar(ctx, world, r);
    for (const car of players) {
      const x = car.phys.x * scale + offX;
      const y = car.phys.z * scale + offY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const pr = r * 1.55;
      ctx.beginPath();
      ctx.arc(x, y, pr + 2.2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_RING[car.playerIndex === 1 ? 1 : 0];
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, pr, 0, Math.PI * 2);
      ctx.fillStyle = safeColor(car.livery?.primary, '#ffffff');
      ctx.fill();
      ctx.lineWidth = 1.4 * dpr;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }

  /** Yellow tint over the flagged sectors (double yellow pulses). */
  private drawSectorFlags(ctx: CanvasRenderingContext2D, world: WorldState): void {
    const levels = sectorFlagLevels(controlOf(world));
    const starts = this.track.sectorStarts;
    if (!starts || !(this.track.length > 0)) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.6 * this.dpr;
    for (let i = 0; i < 3; i++) {
      if (levels[i] === 0) continue;
      const pulse = levels[i] === 2 ? 0.55 + 0.45 * Math.sin(fin(world.time) * 8) ** 2 : 1;
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = YELLOW_FLAG;
      this.strokeRange(ctx, starts[i], i < 2 ? starts[i + 1] : this.track.length);
    }
    ctx.restore();
  }

  /** Warning triangles at incident cars that are still stopped. */
  private drawIncidents(ctx: CanvasRenderingContext2D, world: WorldState, r: number): void {
    if (this.incidents.size === 0) return;
    const { scale, offX, offY } = this.fit;
    for (const [id, since] of this.incidents) {
      const car = world.cars[id];
      // the car may still be slowing down right after the event: only drive-offs after the grace period clear it
      if (!car || (Math.abs(fin(car.phys.speed)) > INCIDENT_CLEAR_SPEED && world.time - since > INCIDENT_GRACE)) {
        this.incidents.delete(id);
        continue;
      }
      const x = car.phys.x * scale + offX;
      const y = car.phys.z * scale + offY - r * 1.9;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const h = r * 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y + h * 0.7);
      ctx.lineTo(x - h, y + h * 0.7);
      ctx.closePath();
      ctx.fillStyle = YELLOW_FLAG;
      ctx.fill();
      ctx.lineWidth = 1.1 * this.dpr;
      ctx.strokeStyle = '#1a1300';
      ctx.stroke();
      ctx.fillStyle = '#1a1300';
      ctx.fillRect(x - 0.5 * this.dpr, y - h * 0.3, 1 * this.dpr, h * 0.6);
    }
  }

  /** Orange 「SC」 dot while the safety car is on track. */
  private drawSafetyCar(ctx: CanvasRenderingContext2D, world: WorldState, r: number): void {
    const sc = controlOf(world)?.safetyCar;
    if (!sc || !sc.onTrack) return;
    const { scale, offX, offY } = this.fit;
    const x = sc.x * scale + offX;
    const y = sc.z * scale + offY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const pr = r * 1.7;
    ctx.beginPath();
    ctx.arc(x, y, pr, 0, Math.PI * 2);
    ctx.fillStyle = SC_COLOR;
    ctx.fill();
    ctx.lineWidth = 1.4 * this.dpr;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#1a0a04';
    ctx.font = `800 ${Math.max(6, pr * 1.05)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SC', x, y + 0.5 * this.dpr);
  }

  /** Time-trial ghost position at the player's current lap time. */
  private drawGhost(ctx: CanvasRenderingContext2D, world: WorldState, r: number): void {
    const ghost: GhostData | null = world.config.ghost;
    if (!ghost || ghost.layoutId !== this.track.id || !(ghost.dt > 0)) return;
    const player = world.cars.find((c) => c.playerIndex === 0);
    if (!player || player.timing.lap < 1) return;
    const n = Math.floor(ghost.samples.length / 4);
    if (n < 1) return;
    const i = Math.min(n - 1, Math.max(0, Math.floor(fin(player.timing.currentLapTime) / ghost.dt)));
    const { scale, offX, offY } = this.fit;
    const x = ghost.samples[i * 4] * scale + offX;
    const y = ghost.samples[i * 4 + 2] * scale + offY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.2, 0, Math.PI * 2);
    ctx.lineWidth = 1.6 * this.dpr;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.setLineDash([2.5 * this.dpr, 2 * this.dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
