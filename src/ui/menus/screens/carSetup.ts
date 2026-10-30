/**
 * Car setup screen: every SETUP_RANGES slider with its description, start compound, reset to defaults.
 * Edits the given PlayerChoice in place and remembers the setup per layout (split-screen P2 separately; online rooms
 * in their own book, see loadOnlineSetup).
 */
import type { CarSetup, SessionKind, TireCompound, WeatherKind } from '../../../core/types';
import { COMPOUND_INFO, COMPOUNDS, DEFAULT_SETUP, SETUP_RANGES } from '../../../core/defaults';
import { saveOnlineSetup, saveSetup } from '../../../meta/save';
import { autoCompound, type PlayerChoice } from '../../../meta/sessionBuilder';
import { h } from '../dom';
import { Screen, type Host } from '../screen';
import { button, cycler, heading, panel, slider, type Control } from '../widgets';

function formatSetup(key: keyof CarSetup, v: number): string {
  if (key === 'brakeBias' || key === 'diffOnThrottle') return `${v}%`;
  return String(v);
}

export interface CarSetupOptions {
  /** an online room's setup (saved in the online book only, at every change: a session the host starts meanwhile keeps it) */
  online?: boolean;
  /** after each save (an online guest sends its car to the host) */
  onSave?: () => void;
  /** show the start compound (default true; an online guest's compound is not sent to the host) */
  startCompound?: boolean;
}

export class CarSetupScreen extends Screen {
  readonly title: string;
  private readonly sliders = new Map<keyof CarSetup, Control<number>>();
  private readonly online: boolean;
  private readonly onSave: (() => void) | undefined;

  constructor(
    host: Host,
    private readonly player: PlayerChoice,
    private readonly layoutId: string,
    kind: SessionKind,
    weather: WeatherKind,
    who: string,
    opts: CarSetupOptions = {},
  ) {
    super(host, { layout: 'panel', className: 'nvm-setup' });
    this.online = opts.online === true;
    this.onSave = opts.onSave;
    this.title = `賽車設定${who ? `・${who}` : ''}`;
    const rows = SETUP_RANGES.map((range) => {
      const control = slider({
        label: range.label,
        min: range.min,
        max: range.max,
        step: range.step,
        value: player.setup[range.key],
        format: (v) => formatSetup(range.key, v),
        description: range.description,
        onChange: (v) => {
          this.player.setup = { ...this.player.setup, [range.key]: v };
          if (this.online) this.save();
        },
      });
      this.sliders.set(range.key, control);
      return control.el;
    });
    const auto = autoCompound(weather, kind);
    const compound = cycler<TireCompound | 'auto'>({
      label: '起步輪胎',
      options: [
        { value: 'auto', label: `自動（${COMPOUND_INFO[auto].label}）`, swatch: COMPOUND_INFO[auto].color },
        ...COMPOUNDS.map((c) => ({ value: c, label: `${COMPOUND_INFO[c].label}（${COMPOUND_INFO[c].letter}）`, swatch: COMPOUND_INFO[c].color })),
      ],
      value: player.startCompound ?? 'auto',
      onChange: (v) => {
        this.player.startCompound = v === 'auto' ? null : v;
      },
      description: '軟胎最快但磨耗快；硬胎耐用；雨天請使用半雨胎或全雨胎',
    });
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading(this.title, '調校'),
        h(
          'div',
          { class: 'nvm-stack nvm-narrow' },
          panel('空力與機械', rows),
          ...(opts.startCompound === false ? [] : [panel('輪胎', compound.el)]),
          h('p', {
            class: 'nvm-note',
            text: this.online
              ? '線上多人的設定依賽道另外保存，只用在線上，不會改到單機模式的設定（還沒在線上調過的賽道先沿用單機設定）。'
              : '設定會依賽道分別保存，下次在同一佈局出賽時自動套用。',
          }),
          h(
            'div',
            { class: 'nvm-actions nvm-actions--bar' },
            button({ label: '重設為預設值', variant: 'ghost', onClick: () => this.resetDefaults() }),
            button({ label: '完成', variant: 'primary', back: true, onClick: () => this.finish() }),
          ),
        ),
      ),
    );
  }

  override onBack(): boolean {
    this.save();
    return false;
  }

  private save(): void {
    if (this.online) saveOnlineSetup(this.layoutId, this.player.setup);
    else saveSetup(this.layoutId, this.player.setup, this.player.playerIndex);
    this.onSave?.();
  }

  private resetDefaults(): void {
    this.player.setup = { ...DEFAULT_SETUP };
    for (const [key, control] of this.sliders) control.set(DEFAULT_SETUP[key]);
    if (this.online) this.save();
    this.host.toast('已還原預設設定');
  }

  private finish(): void {
    this.save();
    this.host.pop();
  }
}
