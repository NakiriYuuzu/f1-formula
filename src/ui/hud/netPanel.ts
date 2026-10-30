/**
 * Connection diagnostics panel (online races, toggled with NET_PANEL_KEY or the pause menu): what the link really does, to tell a slow
 * route, a lossy one, a congested upload and a slow computer apart. netPanelRows is the pure part (tests); NetPanel
 * draws its rows under the ping chip.
 */
import type { GuestLinkStats, HostLinkStats, PeerLinkStats } from '../../net/stats';
import { el } from './dom';
import { PING_BAD_MS, PING_WARN_MS } from './labels';

/** Key that shows / hides the panel (online only). */
export const NET_PANEL_KEY = 'F3';

/** What the session reports of its links: a guest's one link to the host, or the host's link to each guest. */
export type NetDiagnostics = { role: 'guest'; link: GuestLinkStats } | { role: 'host'; links: readonly HostLinkStats[] };

export type NetLevel = 'warn' | 'bad' | null;

export interface NetRow {
  /** null: a heading row (a guest's name on the host) */
  label: string | null;
  value: string;
  level: NetLevel;
}

const level = (v: number, warn: number, bad: number): NetLevel => (v >= bad ? 'bad' : v >= warn ? 'warn' : null);
const below = (v: number, warn: number, bad: number): NetLevel => (v < bad ? 'bad' : v < warn ? 'warn' : null);
const worst = (...ls: NetLevel[]): NetLevel => (ls.includes('bad') ? 'bad' : ls.includes('warn') ? 'warn' : null);
const ms = (v: number | null): string => (v !== null && Number.isFinite(v) ? `${Math.max(0, Math.round(v))} ms` : '—');
const pct = (share: number): string => `${(Math.max(0, share) * 100).toFixed(1)}%`;
const hz = (v: number): string => `${Math.round(Math.max(0, v))} Hz`;
const kbps = (bytesPerSecond: number): string => `${(Math.max(0, bytesPerSecond) / 1024).toFixed(1)} KB/s`;

function linkRows(peer: PeerLinkStats | null, pingMs: number | null): NetRow[] {
  const route = peer?.route === 'relay' ? '經由中繼伺服器' : peer?.route === 'direct' ? '點對點直連' : '—';
  return [
    { label: '路徑', value: route, level: null },
    { label: '網路來回', value: ms(peer?.rttMs ?? null), level: peer?.rttMs != null ? level(peer.rttMs, PING_WARN_MS, PING_BAD_MS) : null },
    { label: '遊戲延遲', value: ms(pingMs), level: pingMs !== null ? level(pingMs, PING_WARN_MS, PING_BAD_MS) : null },
  ];
}

/** The panel's rows, worst values marked: 'warn' worth a look, 'bad' what makes the race stutter. */
export function netPanelRows(d: NetDiagnostics, fps: number): NetRow[] {
  const rows: NetRow[] = [];
  if (d.role === 'guest') {
    const l = d.link;
    rows.push(...linkRows(l.peer, l.pingMs));
    rows.push({
      label: '快照',
      value: `${hz(l.snapshotHz)}・遺失 ${pct(l.snapshotLoss)}`,
      level: worst(below(l.snapshotHz, 25, 15), level(l.snapshotLoss, 0.02, 0.1)),
    });
    rows.push({ label: '最長間隔', value: ms(l.maxGapMs), level: level(l.maxGapMs, 100, 250) });
    rows.push({ label: '自車狀態', value: `遺失 ${pct(l.ownLoss)}・修正 ${Math.max(0, l.correctionM).toFixed(2)} m`, level: worst(level(l.ownLoss, 0.02, 0.1), level(l.correctionM, 0.5, 2)) });
    rows.push({ label: '流量', value: `↓ ${kbps(l.downBps)}・↑ ${kbps(l.upBps)}`, level: null });
  } else {
    if (d.links.length === 0) rows.push({ label: null, value: '沒有連線中的玩家', level: null });
    for (const l of d.links) {
      rows.push({ label: null, value: l.name, level: null });
      rows.push(...linkRows(l.peer, l.pingMs));
      rows.push({ label: '快照', value: `${hz(l.snapshotHz)}・延後 ${l.deferredHz.toFixed(1)}/s`, level: worst(below(l.snapshotHz, 25, 15), level(l.deferredHz, 1, 5)) });
      rows.push({ label: '上傳', value: `${kbps(l.upBps)}・佇列 ${Math.max(0, Math.round(l.backlogBytes))} B`, level: level(l.backlogBytes, 4096, 32768) });
      rows.push({ label: '輸入', value: `延遲 ${ms(l.inputDelayMs)}・猜測 ${l.guessHz.toFixed(1)}/s`, level: level(l.guessHz, 2, 10) });
    }
  }
  rows.push({ label: '畫面', value: `${Math.max(0, Math.round(fps))} FPS`, level: below(fps, 50, 30) });
  return rows;
}

export class NetPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-net nvh-hidden', parent);
    el('div', 'nvh-net-title', this.el, `連線診斷（${NET_PANEL_KEY} 或暫停選單關閉）`);
    this.body = el('div', 'nvh-net-rows', this.el);
  }

  render(rows: readonly NetRow[]): void {
    this.body.replaceChildren();
    for (const r of rows) {
      const row = el('div', r.label === null ? 'nvh-net-head' : 'nvh-net-row', this.body);
      if (r.label !== null) el('span', 'nvh-net-label', row, r.label);
      const value = el('span', 'nvh-net-value', row, r.value);
      if (r.level) value.setAttribute('data-level', r.level);
    }
  }
}
