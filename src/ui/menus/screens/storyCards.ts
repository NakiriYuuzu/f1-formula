/**
 * 新星之路 narrative card player: one card at a time with speaker, Enter = next, Esc = skip (intro: cancel).
 */
import type { StoryCard } from '../../../meta/story';
import { h, setText } from '../dom';
import { Screen, type Host } from '../screen';
import { button } from '../widgets';

/** Narrative cards, one at a time. Enter = next, Esc = skip (intro: cancel). */
export class StoryCardsScreen extends Screen {
  readonly title = '新星之路';
  private index = 0;
  private readonly speakerEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly nextBtn: HTMLButtonElement;
  private finished = false;

  constructor(
    host: Host,
    heading: string,
    private readonly cards: readonly StoryCard[],
    private readonly kind: 'intro' | 'outro',
    private readonly onDone: () => void,
  ) {
    super(host, { layout: 'panel', className: 'nvm-cards' });
    this.speakerEl = h('div', { class: 'nvm-cards__speaker' });
    this.textEl = h('p', { class: 'nvm-cards__text' });
    this.countEl = h('span', { class: 'nvm-cards__count' });
    this.nextBtn = button({ label: '繼續', variant: 'primary', onClick: () => this.next() });
    this.el.append(
      h(
        'div',
        { class: 'nvm-cards__frame' },
        h('div', { class: 'nvm-cards__heading', text: heading }),
        h('div', { class: 'nvm-cards__card' }, this.speakerEl, this.textEl),
        h('div', { class: 'nvm-cards__foot' }, this.countEl, button({ label: kind === 'intro' ? '略過' : '跳過', onClick: () => this.finish() }), this.nextBtn),
      ),
    );
    this.paint();
  }

  override initialFocus(): HTMLElement {
    return this.nextBtn;
  }

  override hints(): string[] {
    return ['Enter 繼續', this.kind === 'intro' ? 'Esc 返回章節列表' : 'Esc 跳過'];
  }

  override onBack(): boolean {
    if (this.kind === 'intro') return false;
    this.finish();
    return true;
  }

  private paint(): void {
    const card = this.cards[this.index];
    if (!card) return;
    setText(this.speakerEl, card.speaker || '');
    this.speakerEl.hidden = card.speaker === '';
    this.textEl.classList.toggle('is-narration', card.speaker === '');
    setText(this.textEl, card.text);
    setText(this.countEl, `${this.index + 1} / ${this.cards.length}`);
    const label = this.nextBtn.querySelector('.nvm-btn__label');
    if (label) label.textContent = this.index >= this.cards.length - 1 ? (this.kind === 'intro' ? '前往簡報' : '完成') : '繼續';
    // replay the card animation
    this.textEl.classList.remove('is-in');
    void this.textEl.offsetWidth;
    this.textEl.classList.add('is-in');
  }

  private next(): void {
    if (this.index >= this.cards.length - 1) {
      this.finish();
      return;
    }
    this.index++;
    this.paint();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.onDone();
  }
}
