/**
 * Modal confirmation dialog (floats above the current screen).
 */
import { h } from '../dom';
import { Screen, type Host } from '../screen';
import { button } from '../widgets';

export class ConfirmScreen extends Screen {
  readonly title: string;
  private readonly noBtn: HTMLButtonElement;

  constructor(host: Host, title: string, text: string, onYes: () => void, yesLabel: string) {
    super(host, { layout: 'panel', modal: true, className: 'nvm-confirm' });
    this.title = title;
    const yes = button({
      label: yesLabel,
      variant: 'danger',
      onClick: () => {
        this.host.pop();
        onYes();
      },
    });
    this.noBtn = button({ label: '取消', variant: 'ghost', back: true, onClick: () => this.host.pop() });
    this.el.append(
      h(
        'div',
        { class: 'nvm-confirm__box', attrs: { role: 'alertdialog', 'aria-label': title } },
        h('h3', { class: 'nvm-confirm__title', text: title }),
        h('p', { class: 'nvm-confirm__text', text }),
        h('div', { class: 'nvm-confirm__actions' }, this.noBtn, yes),
      ),
    );
  }

  override initialFocus(): HTMLElement {
    return this.noBtn;
  }

  override hints(): string[] {
    return ['←→ 選擇', 'Enter 確認', 'Esc 取消'];
  }
}
