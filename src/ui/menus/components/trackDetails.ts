/**
 * Track detail card: large minimap, circuit facts and (lazily, after the focus settles) built-track statistics.
 */
import { getLayout } from '../../../data/tracks';
import type { LayoutMeta } from '../../../meta/options';
import { h, setChildren, setText } from '../dom';
import { realFacts } from '../../../meta/circuits';
import { BIOME_LABEL, timeLabel } from '../labels';
import { minimapCanvas } from '../minimap';
import { infoLine } from '../widgets';

const STATS_DELAY_MS = 280;

export class TrackDetails {
  readonly el: HTMLElement;
  private readonly mapEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly descEl: HTMLElement;
  private readonly factsEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private timer = 0;
  private shownId = '';

  constructor(private readonly mapW = 300, private readonly mapH = 200) {
    this.mapEl = h('div', { class: 'nvm-details__map' });
    this.nameEl = h('h3', { class: 'nvm-details__name' });
    this.descEl = h('p', { class: 'nvm-details__desc' });
    this.factsEl = h('div', { class: 'nvm-details__facts' });
    this.statsEl = h('div', { class: 'nvm-details__stats' });
    this.el = h('div', { class: 'nvm-panel nvm-details' }, this.mapEl, this.nameEl, this.descEl, this.factsEl, this.statsEl);
  }

  show(layout: LayoutMeta | null): void {
    if (!layout) {
      setText(this.nameEl, '沒有可用的賽道');
      this.mapEl.replaceChildren();
      this.factsEl.replaceChildren();
      this.statsEl.replaceChildren();
      setText(this.descEl, '');
      return;
    }
    if (layout.id === this.shownId) return;
    this.shownId = layout.id;
    this.mapEl.replaceChildren(minimapCanvas(layout.id, this.mapW, this.mapH, { lineWidth: 3.5 }));
    setChildren(this.nameEl, layout.displayName, layout.real ? h('span', { class: 'nvm-real-tag', text: '真實賽道' }) : null);
    setText(this.descEl, layout.description);
    setChildren(
      this.factsEl,
      infoLine('地點', `${layout.location}・${layout.country}`),
      infoLine('環境', `${BIOME_LABEL[layout.biome]}${layout.street ? '・街道賽' : ''}`),
      infoLine('預設時段', timeLabel(layout.timeOfDay)),
      infoLine('完整賽程', `${layout.fullLaps} 圈`),
      infoLine('佈局', layout.reverse ? '反向佈局' : '正向佈局'),
      ...(layout.real ? realFacts(layout.real, layout.reverse).map((f) => infoLine(f.label, f.value)) : []),
    );
    this.statsEl.replaceChildren(h('span', { class: 'nvm-details__pending', text: '計算賽道資料中…' }));
    if (this.timer) window.clearTimeout(this.timer);
    const id = layout.id;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (this.shownId !== id) return;
      try {
        const track = getLayout(id);
        setChildren(
          this.statsEl,
          infoLine(layout.real ? '實測全長' : '全長', `${(track.length / 1000).toFixed(3)} km`),
          infoLine('彎道', `${track.corners.length} 個`),
          infoLine('DRS 區', `${track.drsZones.length} 個`),
        );
      } catch {
        this.statsEl.replaceChildren();
      }
    }, STATS_DELAY_MS);
  }

  /** Stop the pending statistics computation (the next show() of that layout starts it again). */
  cancel(): void {
    if (!this.timer) return;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.shownId = '';
  }
}
