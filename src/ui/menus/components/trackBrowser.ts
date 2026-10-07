/**
 * Track grid: one card per circuit with a minimap preview, plus a forward / reverse direction toggle.
 * By default focusing a card selects (previews) it; with `selectOnFocus: false` only Enter / click selects, so
 * hovering other cards on the way to a separate start button never changes the selection. Enter / click chooses.
 * A filter (all / real / original circuits) keeps 17 circuits easy to browse.
 */
import { filterLayouts, formatKm, TRACK_FILTERS, TRACK_FILTER_LABEL, type TrackFilter } from '../../../meta/circuits';
import { listLayouts, type LayoutMeta } from '../../../meta/options';
import { h, setText } from '../dom';
import { minimapCanvas } from '../minimap';
import { BIOME_LABEL } from '../labels';
import { cycler } from '../widgets';

export interface TrackBrowserOptions {
  initial: string;
  /** the selected layout changed */
  onFocus(layout: LayoutMeta): void;
  onChoose(layout: LayoutMeta): void;
  /** optional badge per layout (e.g. personal best) */
  badge?(layout: LayoutMeta): string | null;
  /** select on focus (keyboard / hover); default true. False = only Enter / click selects. */
  selectOnFocus?: boolean;
}

export class TrackBrowser {
  readonly el: HTMLElement;
  private readonly all: LayoutMeta[];
  private readonly grid: HTMLElement;
  private readonly badges = new Map<string, HTMLElement>();
  private reverse: boolean;
  private filter: TrackFilter = 'all';
  private currentId: string;

  constructor(private readonly o: TrackBrowserOptions) {
    this.all = listLayouts();
    const initial = this.all.find((l) => l.id === o.initial) ?? this.all[0];
    this.reverse = initial ? initial.reverse : false;
    this.currentId = initial ? initial.id : '';
    this.grid = h('div', { class: 'nvm-trackgrid' });
    const dir = cycler<boolean>({
      label: '賽道方向',
      options: [
        { value: false, label: '正向' },
        { value: true, label: '反向' },
      ],
      value: this.reverse,
      onChange: (rev) => this.setReverse(rev),
    });
    const filter = cycler<TrackFilter>({
      label: '賽道類型',
      options: TRACK_FILTERS.map((f) => ({ value: f, label: TRACK_FILTER_LABEL[f] })),
      value: this.filter,
      onChange: (f) => this.setFilter(f),
    });
    this.el = h('div', { class: `nvm-trackbrowser${o.selectOnFocus === false ? ' nvm-trackbrowser--explicit' : ''}` }, h('div', { class: 'nvm-trackbrowser__bar' }, filter.el, dir.el), this.grid);
    if (this.all.length === 0) {
      this.grid.append(h('p', { class: 'nvm-empty', text: '賽道資料尚未載入，請重新整理頁面。' }));
    } else {
      this.renderCards();
    }
  }

  current(): LayoutMeta | null {
    return this.all.find((l) => l.id === this.currentId) ?? null;
  }

  /** The card element of the current layout (for initial focus). */
  currentCard(): HTMLElement | null {
    return this.grid.querySelector<HTMLElement>(`[data-layout="${CSS.escape(this.currentId)}"]`);
  }

  refreshBadges(): void {
    if (!this.o.badge) return;
    for (const [id, el] of this.badges) {
      const layout = this.all.find((l) => l.id === id);
      setText(el, layout ? (this.o.badge(layout) ?? '') : '');
    }
  }

  private visible(): LayoutMeta[] {
    return filterLayouts(this.all, this.filter).filter((l) => l.reverse === this.reverse);
  }

  private setFilter(f: TrackFilter): void {
    this.filter = f;
    this.reselect();
  }

  private setReverse(rev: boolean): void {
    this.reverse = rev;
    this.reselect();
  }

  /** Keep the current circuit when it is still listed (same circuit in the new direction), else the first card. */
  private reselect(): void {
    const cur = this.current();
    const match = this.visible().find((l) => cur !== null && l.defId === cur.defId) ?? this.visible()[0];
    if (match && match.id !== this.currentId) {
      this.currentId = match.id;
      this.o.onFocus(match);
    }
    this.renderCards();
  }

  private renderCards(): void {
    this.badges.clear();
    if (this.visible().length === 0) {
      this.grid.replaceChildren(h('p', { class: 'nvm-empty', text: '沒有符合條件的賽道。' }));
      return;
    }
    const cards = this.visible().map((layout) => {
      const badge = h('span', { class: 'nvm-track__badge', text: this.o.badge ? (this.o.badge(layout) ?? '') : '' });
      this.badges.set(layout.id, badge);
      const card = h(
        'button',
        {
          class: `nvm-track${layout.id === this.currentId ? ' is-selected' : ''}`,
          attrs: { type: 'button', 'data-layout': layout.id, 'data-sound': 'confirm' },
          on: {
            focus: () => {
              if (this.o.selectOnFocus !== false) this.select(layout);
            },
            click: () => {
              this.select(layout);
              this.o.onChoose(layout);
            },
          },
        },
        h('span', { class: 'nvm-track__map' }, minimapCanvas(layout.id, 180, 112)),
        h('span', { class: 'nvm-track__name' }, layout.circuitName, layout.real ? h('span', { class: 'nvm-real-tag', text: '真實賽道' }) : null),
        h('span', { class: 'nvm-track__meta', text: layout.real ? `${layout.location}・${layout.country}` : `${layout.location}・${BIOME_LABEL[layout.biome]}` }),
        layout.real ? h('span', { class: 'nvm-track__meta', text: `${formatKm(layout.real.length)}・${layout.real.turns} 彎` }) : null,
        layout.reverse ? h('span', { class: 'nvm-track__rev', text: '反向' }) : null,
        badge,
      );
      return card;
    });
    this.grid.replaceChildren(...cards);
  }

  private select(layout: LayoutMeta): void {
    if (layout.id === this.currentId) return;
    this.currentId = layout.id;
    for (const card of Array.from(this.grid.children)) {
      if (card instanceof HTMLElement) card.classList.toggle('is-selected', card.dataset.layout === layout.id);
    }
    this.o.onFocus(layout);
  }
}
