/**
 * Title screen: game logo over the showroom car, "press any key" to enter the main menu.
 */
import { GAME_TITLE_ZH } from '../../../core/defaults';
import { needsOnboarding } from '../../../meta/prefs';
import { loadProfile } from '../../../meta/save';
import { h } from '../dom';
import { Screen, type Host, type StageRequest } from '../screen';
import { MainMenuScreen } from './mainMenu';
import { ExperienceScreen } from './onboarding';

const IGNORED = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'F5', 'F11', 'F12']);

export class TitleScreen extends Screen {
  readonly title = '';
  private done = false;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-title' });
    const press = h('button', {
      class: 'nvm-title__press',
      attrs: { type: 'button', 'data-sound': 'confirm' },
      text: '按任意鍵開始',
      on: { click: () => this.advance() },
    });
    this.el.append(
      h(
        'div',
        { class: 'nvm-title__block' },
        h('div', { class: 'nvm-title__kicker', text: 'ORIGINAL OPEN-WHEEL RACING' }),
        h('h1', { class: 'nvm-title__logo' }, h('span', { text: 'FORMULA' }), h('span', { class: 'nvm-title__nova', text: 'NOVA' }), h('span', { class: 'nvm-title__year', text: '25' })),
        h('div', { class: 'nvm-title__zh', text: GAME_TITLE_ZH }),
        press,
        h('p', { class: 'nvm-title__note', text: '原創同人作品・與任何真實賽事、車隊或發行商無關' }),
      ),
    );
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && e.target === this.el) this.advance();
    });
  }

  override stage(): StageRequest {
    return { kind: 'car', car: this.host.featuredCar() };
  }

  override hints(): string[] {
    return ['任意鍵 開始', 'F 全螢幕'];
  }

  override onKey(e: KeyboardEvent): boolean {
    if (IGNORED.has(e.key) || e.repeat) return false;
    if (e.code === 'KeyF') return false;
    this.host.sound('confirm');
    this.advance();
    return true;
  }

  override onBack(): boolean {
    return true;
  }

  private advance(): void {
    if (this.done) return;
    this.done = true;
    this.host.replace(needsOnboarding(loadProfile()) ? new ExperienceScreen(this.host, true) : new MainMenuScreen(this.host));
  }
}
