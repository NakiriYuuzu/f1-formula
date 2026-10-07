/**
 * Track selection: circuit grid with minimap previews, forward / reverse toggle and a detail card.
 */
import { TrackBrowser } from '../components/trackBrowser';
import { TrackDetails } from '../components/trackDetails';
import { h } from '../dom';
import { Screen, type Host } from '../screen';
import { heading } from '../widgets';

export interface TrackSelectOptions {
  title: string;
  kicker: string;
  initial: string;
  onChosen(layoutId: string): void;
}

export class TrackSelectScreen extends Screen {
  readonly title: string;
  private readonly browser: TrackBrowser;
  private readonly details = new TrackDetails();

  constructor(host: Host, o: TrackSelectOptions) {
    super(host, { layout: 'panel', className: 'nvm-trackselect' });
    this.title = o.title;
    this.browser = new TrackBrowser({
      initial: o.initial,
      onFocus: (layout) => this.details.show(layout),
      onChoose: (layout) => o.onChosen(layout.id),
    });
    this.el.append(
      h('div', { class: 'nvm-wide' }, heading('選擇賽道', o.kicker), h('div', { class: 'nvm-columns nvm-columns--track' }, this.browser.el, this.details.el)),
    );
  }

  override initialFocus(): HTMLElement | null {
    return this.browser.currentCard();
  }

  override onEnter(): void {
    this.details.show(this.browser.current());
  }

  override onLeave(): void {
    this.details.cancel();
  }

  override destroy(): void {
    this.details.cancel();
  }
}
