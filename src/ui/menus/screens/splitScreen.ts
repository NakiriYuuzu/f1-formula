/**
 * Local two-player split-screen setup: P1 / P2 seats and assists, AI field size (0–20), layout, distance,
 * weather, regulation and AI difficulty, with each player's key layout.
 */
import type { KeyAction, Regulation, SessionRules } from '../../../core/types';
import { DEFAULT_RULES } from '../../../core/defaults';
import { filterLayouts, TRACK_FILTERS, TRACK_FILTER_LABEL, type TrackFilter } from '../../../meta/circuits';
import { findLayout, LAPS_CHOICES, listLayouts, resolveLaps, WEATHER_CHOICES, type LapsChoice, type WeatherChoice } from '../../../meta/options';
import type { ProfileSave, SeatChoice } from '../../../meta/prefs';
import { driverName, standardRoster } from '../../../meta/roster';
import { loadProfile, loadSetup, saveProfile } from '../../../meta/save';
import { MAX_SPLIT_AI, type SessionRequest } from '../../../meta/sessionBuilder';
import { aeroWakeRow, assistPresetCycler, raceControlRows, REGULATION_OPTIONS } from '../components/editors';
import { h } from '../dom';
import { launchWeekend } from '../flow';
import { difficultyLabel, keyLabel, lapsLabel, WEATHER_LABEL } from '../labels';
import { minimapCanvas } from '../minimap';
import { Screen, type Host } from '../screen';
import { button, cycler, heading, panel, slider, type CyclerControl } from '../widgets';
import { TeamSelectScreen } from './teamSelect';

const KEY_SUMMARY: [KeyAction, string][] = [
  ['throttle', '油門'],
  ['brake', '煞車'],
  ['steerLeft', '左'],
  ['steerRight', '右'],
  ['shiftUp', '升檔'],
  ['shiftDown', '降檔'],
  ['drs', 'DRS'],
];

export class SplitScreenSetupScreen extends Screen {
  readonly title = '雙人分割畫面';
  private readonly profile: ProfileSave;
  private readonly mapBox: HTMLElement;
  private readonly lapsCtl: CyclerControl<LapsChoice>;
  private readonly p1Btn: HTMLButtonElement;
  private readonly p2Btn: HTMLButtonElement;
  private readonly keysEl: HTMLElement;
  private readonly startBtn: HTMLButtonElement;

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-split' });
    this.profile = loadProfile();
    const sp = this.profile.split;
    const layouts = listLayouts();
    if (!layouts.some((l) => l.id === sp.layoutId) && layouts[0]) sp.layoutId = layouts[0].id;
    const persist = (): void => saveProfile(this.profile);
    this.mapBox = h('div', { class: 'nvm-split__map' });
    const layoutOptions = (filter: TrackFilter): { value: string; label: string }[] =>
      filterLayouts(layouts, filter).map((l) => ({ value: l.id, label: l.displayName }));
    const layoutCtl = cycler<string>({
      label: '賽道',
      options: layoutOptions('all'),
      value: sp.layoutId,
      onChange: (id) => {
        sp.layoutId = id;
        persist();
        this.renderMap();
        this.lapsCtl.setOptions(this.lapsOptions());
      },
    });
    const filterCtl = cycler<TrackFilter>({
      label: '賽道類型',
      options: TRACK_FILTERS.map((f) => ({ value: f, label: TRACK_FILTER_LABEL[f] })),
      value: 'all',
      onChange: (f) => {
        layoutCtl.setOptions(layoutOptions(f));
        // the current layout fell out of the filter: the control moved to the first remaining one
        const id = layoutCtl.get();
        if (id && id !== sp.layoutId) {
          sp.layoutId = id;
          persist();
          this.renderMap();
          this.lapsCtl.setOptions(this.lapsOptions());
        }
      },
    });
    this.lapsCtl = cycler<LapsChoice>({
      label: '比賽長度',
      options: this.lapsOptions(),
      value: sp.laps,
      onChange: (v) => {
        sp.laps = v;
        persist();
      },
    });
    const weather = cycler<WeatherChoice>({
      label: '天氣',
      options: WEATHER_CHOICES.map((w) => ({ value: w, label: WEATHER_LABEL[w] })),
      value: sp.weather,
      onChange: (v) => {
        sp.weather = v;
        persist();
      },
    });
    const reg = cycler<Regulation>({
      label: '規則年份',
      options: REGULATION_OPTIONS,
      value: sp.regulation,
      onChange: (v) => {
        sp.regulation = v;
        persist();
      },
    });
    const aiCount = slider({
      label: 'AI 車輛數',
      min: 0,
      max: MAX_SPLIT_AI,
      step: 1,
      value: sp.aiCount,
      format: (v) => (v === 0 ? '無（僅雙人）' : `${v} 台`),
      onChange: (v) => {
        sp.aiCount = v;
        persist();
      },
    });
    const diff = slider({
      label: 'AI 難度',
      min: 0,
      max: 110,
      step: 1,
      value: sp.aiDifficulty,
      format: (v) => `${v}（${difficultyLabel(v)}）`,
      onChange: (v) => {
        sp.aiDifficulty = v;
        persist();
      },
    });
    const setRule = <K extends keyof SessionRules>(key: K) => (v: SessionRules[K]): void => {
      sp.rules = { ...sp.rules, [key]: v };
      persist();
    };
    const raceControl = panel('規則', aeroWakeRow(sp.rules, setRule), ...raceControlRows(sp.rules, setRule));
    this.p1Btn = button({ label: '', sub: 'P1 車手', onClick: () => this.pickSeat(0) });
    this.p2Btn = button({ label: '', sub: 'P2 車手', onClick: () => this.pickSeat(1) });
    const p1Assists = assistPresetCycler('P1 駕駛輔助', this.profile.assists, (a) => {
      this.profile.assists = a;
      persist();
    });
    const p2Assists = assistPresetCycler('P2 駕駛輔助', sp.p2Assists, (a) => {
      sp.p2Assists = a;
      persist();
    });
    this.keysEl = h('div', { class: 'nvm-keys' });
    this.startBtn = button({ label: '開始比賽', variant: 'primary', onClick: () => this.start() });
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('雙人分割畫面', '本機雙人'),
        h(
          'div',
          { class: 'nvm-columns nvm-columns--side' },
          h(
            'div',
            { class: 'nvm-stack' },
            panel('車手', this.p1Btn, p1Assists.el, this.p2Btn, p2Assists.el),
            panel('賽事', filterCtl.el, layoutCtl.el, this.lapsCtl.el, weather.el, reg.el, aiCount.el, diff.el),
            raceControl,
          ),
          h(
            'div',
            { class: 'nvm-stack' },
            panel('賽道預覽', this.mapBox),
            panel('操控', this.keysEl, h('p', { class: 'nvm-note', text: '分割畫面中，P2 綁定的按鍵只會控制 P2。可在「設定 → 按鍵」調整。' })),
          ),
        ),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() }), this.startBtn),
      ),
    );
  }

  override initialFocus(): HTMLElement {
    return this.startBtn;
  }

  override onEnter(): void {
    this.renderMap();
    this.renderSeats();
    this.renderKeys();
  }

  private lapsOptions(): { value: LapsChoice; label: string }[] {
    const layout = findLayout(this.profile.split.layoutId);
    return LAPS_CHOICES.map((c) => ({ value: c, label: lapsLabel(c, layout ? layout.fullLaps : null) }));
  }

  private renderMap(): void {
    this.mapBox.replaceChildren(minimapCanvas(this.profile.split.layoutId, 300, 170, { lineWidth: 3 }));
  }

  private seatLabel(seat: SeatChoice): string {
    const roster = standardRoster();
    const d = roster.drivers.find((x) => x.id === seat.driverId);
    const t = roster.teams.find((x) => x.id === seat.teamId);
    return d && t ? `${driverName(d)}・${t.shortName}` : '選擇車手';
  }

  private renderSeats(): void {
    const set = (btn: HTMLButtonElement, text: string): void => {
      const label = btn.querySelector('.nvm-btn__label');
      if (label) label.textContent = text;
    };
    set(this.p1Btn, this.seatLabel(this.profile.split.p1));
    set(this.p2Btn, this.seatLabel(this.profile.split.p2));
  }

  private renderKeys(): void {
    const s = this.host.settings;
    const row = (player: string, get: (a: KeyAction) => string[] | undefined): HTMLElement =>
      h(
        'div',
        { class: 'nvm-keys__col' },
        h('b', { text: player }),
        KEY_SUMMARY.map(([action, label]) =>
          h('span', null, h('small', { text: label }), h('kbd', { text: (get(action) ?? []).map(keyLabel).join(' / ') || '未設定' })),
        ),
      );
    // in split-screen every key bound for P2 is routed to P2 only
    const p2Codes = new Set<string>();
    for (const list of Object.values(s.keyBindingsP2)) for (const code of list ?? []) p2Codes.add(code);
    this.keysEl.replaceChildren(
      row('P1', (a) => s.keyBindings[a].filter((code) => !p2Codes.has(code))),
      row('P2', (a) => s.keyBindingsP2[a]),
    );
  }

  private pickSeat(index: 0 | 1): void {
    const sp = this.profile.split;
    const mine = index === 0 ? sp.p1 : sp.p2;
    const other = index === 0 ? sp.p2 : sp.p1;
    this.host.push(
      new TeamSelectScreen(this.host, {
        title: '雙人分割畫面',
        kicker: `P${index + 1} 選擇車手`,
        roster: standardRoster(),
        initial: mine,
        pickDriver: true,
        excludeDriverId: other.driverId,
        onChosen: (seat) => {
          if (index === 0) sp.p1 = seat;
          else sp.p2 = seat;
          saveProfile(this.profile);
          this.host.pop();
        },
      }),
    );
  }

  private start(): void {
    const sp = this.profile.split;
    const layout = findLayout(sp.layoutId) ?? listLayouts()[0];
    if (!layout) {
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入', 'bad');
      return;
    }
    if (sp.p1.driverId === sp.p2.driverId) {
      this.host.sound('error');
      this.host.toast('P1 與 P2 不能選擇同一位車手', 'bad');
      return;
    }
    const setup = loadSetup(layout.id);
    const setupP2 = loadSetup(layout.id, 1);
    const base: SessionRequest = {
      mode: 'splitScreen',
      kind: 'race',
      layoutId: layout.id,
      raceLaps: resolveLaps(sp.laps, layout.fullLaps),
      weather: sp.weather,
      timeOfDay: 'auto',
      regulation: sp.regulation,
      aiDifficulty: sp.aiDifficulty,
      qualifying: 'oneShot',
      rules: { ...DEFAULT_RULES, ...sp.rules },
      seed: Date.now() >>> 0,
      players: [
        { playerIndex: 0, driverId: sp.p1.driverId, teamId: sp.p1.teamId, setup: { ...setup }, assists: { ...this.profile.assists }, startCompound: null },
        { playerIndex: 1, driverId: sp.p2.driverId, teamId: sp.p2.teamId, setup: setupP2, assists: { ...sp.p2Assists }, startCompound: null },
      ],
      roster: standardRoster(),
      aiCount: sp.aiCount,
      gridOrder: null,
      playerStartPosition: null,
      ghost: null,
      objective: null,
    };
    launchWeekend(this.host, base, ['race'], { returnTo: 'splitScreen', round: null, storyId: null });
  }
}
