/**
 * Online multiplayer menus (docs/plans/phase3-online.md §4):
 * - OnlineScreen: player name, matchmaking (local test = tabs of this browser, or a Cloudflare matchmaking server),
 *   create / join a room by code, with clear zh-TW errors (room full, wrong code, unreachable server, NAT);
 * - LobbyScreen: room code (copy), players (name, driver, ready, ping), the host's race settings, each player's driver
 *   (unique) and assists, ready / start / leave. The host starts the weekend through the usual briefing flow; the App
 *   hands every session to the guests.
 */
import type { Assists, Regulation } from '../../../core/types';
import { DEFAULT_RULES } from '../../../core/defaults';
import { FORMAT_LABEL, WEATHER_LABEL, difficultyLabel, lapsLabel } from '../labels';
import { LAPS_CHOICES, WEATHER_CHOICES, findLayout, listLayouts, resolveLaps, weekendSessions, type LapsChoice, type WeatherChoice, type WeekendFormat } from '../../../meta/options';
import { loadProfile, loadSetup, saveProfile } from '../../../meta/save';
import { standardRoster } from '../../../meta/roster';
import { MAX_SPLIT_AI, type PlayerChoice, type SessionRequest } from '../../../meta/sessionBuilder';
import type { LobbySettings } from '../../../net/protocol';
import type { OnlineRoom } from '../../../net/room';
import { assistPresetCycler, REGULATION_OPTIONS } from '../components/editors';
import { h } from '../dom';
import { launchWeekend } from '../flow';
import { minimapCanvas } from '../minimap';
import { onlineHooks, type OnlinePrefs } from '../onlineHooks';
import { Screen, type Host } from '../screen';
import { button, cycler, heading, panel, slider, teamChip, textField } from '../widgets';

const FORMATS: readonly WeekendFormat[] = ['raceOnly', 'qualiRace', 'full'];

export class OnlineScreen extends Screen {
  readonly title = '線上多人';
  private readonly prefs: OnlinePrefs;
  private readonly statusEl: HTMLElement;
  private readonly createBtn: HTMLButtonElement;
  private busy = false;
  private code = '';

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-online' });
    const hooks = onlineHooks();
    this.prefs = hooks ? hooks.prefs() : { name: '玩家', mode: 'local', serverUrl: '' };
    const save = (): void => hooks?.savePrefs(this.prefs);
    const name = textField({ label: '玩家名稱', value: this.prefs.name, maxLength: 16, onInput: (v) => {
      this.prefs.name = v.trim();
      save();
    } });
    const server = textField({
      label: '配對伺服器網址',
      value: this.prefs.serverUrl,
      maxLength: 200,
      placeholder: 'https://formula-nova-signal.<帳號>.workers.dev',
      onInput: (v) => {
        this.prefs.serverUrl = v.trim().replace(/\/+$/, '');
        save();
      },
    });
    const mode = cycler<OnlinePrefs['mode']>({
      label: '配對方式',
      options: [
        { value: 'local', label: '本機測試（同一台電腦的分頁）' },
        { value: 'server', label: '配對伺服器（網際網路）' },
      ],
      value: this.prefs.mode,
      onChange: (v) => {
        this.prefs.mode = v;
        server.setDisabled(v !== 'server');
        save();
      },
    });
    server.setDisabled(this.prefs.mode !== 'server');
    const code = textField({
      label: '房間代碼',
      value: '',
      maxLength: 6,
      placeholder: '6 碼，例如 K7MPQ2',
      transform: (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      onInput: (v) => {
        this.code = v;
      },
    });
    this.statusEl = h('p', { class: 'nvm-note', attrs: { role: 'status' } });
    this.createBtn = button({ label: '建立房間', variant: 'primary', onClick: () => void this.create() });
    const joinBtn = button({ label: '加入房間', onClick: () => void this.join() });
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('線上多人', '2–4 名玩家・點對點連線'),
        h(
          'div',
          { class: 'nvm-columns nvm-columns--side' },
          h(
            'div',
            { class: 'nvm-stack' },
            panel('玩家', name.el),
            panel('配對', mode.el, server.el, h('p', { class: 'nvm-note', text: this.serverHelp() })),
            panel('房間', this.createBtn, code.el, joinBtn, this.statusEl),
          ),
          h(
            'div',
            { class: 'nvm-stack' },
            panel(
              '說明',
              h('p', { class: 'nvm-note', text: '房主的電腦會模擬整場比賽（含 AI），其他玩家的賽車由自己的鍵盤或手把操控、以點對點方式連到房主。' }),
              h('p', { class: 'nvm-note', text: '本機測試：在同一個瀏覽器開兩個分頁、同一個網址，一個建立房間，另一個輸入代碼加入，不需要伺服器。' }),
              h('p', { class: 'nvm-note', text: '限制：沒有中繼伺服器（TURN），部分嚴格 NAT 網路可能連不上；沒有反作弊；斷線後無法重新加入；房主的分頁切到背景時比賽會變慢或暫停。' }),
            ),
          ),
        ),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
    if (!hooks) this.status('線上多人無法在這個環境使用', true);
  }

  override initialFocus(): HTMLElement {
    return this.createBtn;
  }

  private serverHelp(): string {
    return this.prefs.serverUrl
      ? '使用配對伺服器時，房間代碼可分享給任何地方的玩家。'
      : '尚未設定配對伺服器：部署 server/ 的 Cloudflare Worker（見 server/README.md）後，把網址填在上方，或在建置時設定 VITE_SIGNAL_URL。';
  }

  private status(text: string, bad = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('is-bad', bad);
  }

  private async create(): Promise<void> {
    const hooks = onlineHooks();
    if (!hooks || this.busy) return;
    this.busy = true;
    this.status('建立房間中…');
    try {
      await hooks.host();
      this.host.sound('confirm');
      this.host.replace(new LobbyScreen(this.host));
    } catch (err) {
      this.host.sound('error');
      this.status(err instanceof Error ? err.message : '無法建立房間', true);
    } finally {
      this.busy = false;
    }
  }

  private async join(): Promise<void> {
    const hooks = onlineHooks();
    if (!hooks || this.busy) return;
    if (this.code.length !== 6) {
      this.host.sound('error');
      this.status('請輸入 6 碼房間代碼', true);
      return;
    }
    this.busy = true;
    this.status('連線到房主中…（最多約 15 秒）');
    try {
      await hooks.join(this.code);
      this.host.sound('confirm');
      this.host.replace(new LobbyScreen(this.host));
    } catch (err) {
      this.host.sound('error');
      this.status(err instanceof Error ? err.message : '無法加入房間', true);
    } finally {
      this.busy = false;
    }
  }
}

export class LobbyScreen extends Screen {
  readonly title = '線上大廳';
  private readonly playersEl: HTMLElement;
  private readonly settingsEl: HTMLElement;
  private readonly mineEl: HTMLElement;
  private readonly mapBox: HTMLElement;
  private readonly actionBtn: HTMLButtonElement;
  private lapsChoice: LapsChoice = 'l5';
  private assists: Assists;
  private ready = false;
  private built = false;
  /** what the 我的車手 panel was built for (rebuilt only when it changes: keeps the keyboard focus) */
  private mineKey = '';

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-lobby' });
    this.assists = { ...loadProfile().assists };
    this.playersEl = h('div', { class: 'nvm-stack' });
    this.settingsEl = h('div', { class: 'nvm-stack' });
    this.mineEl = h('div', { class: 'nvm-stack' });
    this.mapBox = h('div', { class: 'nvm-split__map' });
    const room = this.room;
    this.actionBtn = button({
      label: room?.role === 'host' ? '開始比賽' : '準備',
      variant: 'primary',
      onClick: () => (this.room?.role === 'host' ? this.start() : this.toggleReady()),
    });
    const code = room?.code ?? '------';
    const copy = button({
      label: `房間代碼 ${code}`,
      sub: '點擊複製',
      onClick: () => {
        void navigator.clipboard?.writeText(code).then(
          () => this.host.toast('已複製房間代碼', 'good'),
          () => this.host.toast(`房間代碼：${code}`),
        );
      },
    });
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('線上大廳', room?.role === 'host' ? '你是房主' : '等待房主開始'),
        h(
          'div',
          { class: 'nvm-columns nvm-columns--side' },
          h('div', { class: 'nvm-stack' }, panel('房間', copy, this.playersEl), panel('我的車手', this.mineEl)),
          h('div', { class: 'nvm-stack' }, panel('賽事設定', this.settingsEl), panel('賽道預覽', this.mapBox)),
        ),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '離開房間', back: true, onClick: () => this.leave() }), this.actionBtn),
      ),
    );
  }

  private get room(): OnlineRoom | null {
    return onlineHooks()?.room() ?? null;
  }

  override initialFocus(): HTMLElement {
    return this.actionBtn;
  }

  override onEnter(): void {
    const room = this.room;
    if (!room || room.closed) {
      this.host.goHome('main');
      return;
    }
    room.events.changed = () => this.render();
    room.hostLobby?.endWeekend();
    if (!this.built) {
      this.built = true;
      if (room.role === 'host') this.buildHostSettings();
    }
    this.render();
  }

  override onLeave(): void {
    const room = this.room;
    if (room) room.events.changed = undefined;
  }

  override onBack(): boolean {
    this.leave();
    return true;
  }

  private leave(): void {
    const room = this.room;
    const go = (): void => {
      onlineHooks()?.leave();
      this.host.goHome('main');
    };
    if (room?.role === 'host') this.host.confirm('離開房間', '你是房主，離開後房間會關閉。', go, '離開');
    else go();
  }

  private buildHostSettings(): void {
    const lobby = this.room?.hostLobby;
    if (!lobby) return;
    const s = lobby.state.settings;
    const layouts = listLayouts();
    const set = (patch: Partial<LobbySettings>): void => lobby.setSettings(patch);
    const lapsOptions = (): { value: LapsChoice; label: string }[] => {
      const layout = findLayout(s.layoutId);
      return LAPS_CHOICES.map((c) => ({ value: c, label: lapsLabel(c, layout ? layout.fullLaps : null) }));
    };
    const laps = cycler<LapsChoice>({
      label: '比賽長度',
      options: lapsOptions(),
      value: this.lapsChoice,
      onChange: (v) => {
        this.lapsChoice = v;
        set({ laps: resolveLaps(v, findLayout(s.layoutId)?.fullLaps ?? 50) });
      },
    });
    const track = cycler<string>({
      label: '賽道',
      options: layouts.map((l) => ({ value: l.id, label: l.displayName })),
      value: s.layoutId,
      onChange: (id) => {
        laps.setOptions(lapsOptions());
        set({ layoutId: id, laps: resolveLaps(this.lapsChoice, findLayout(id)?.fullLaps ?? 50) });
      },
    });
    const weather = cycler<WeatherChoice>({
      label: '天氣',
      options: WEATHER_CHOICES.map((w) => ({ value: w, label: WEATHER_LABEL[w] })),
      value: (WEATHER_CHOICES as readonly string[]).includes(s.weather) ? (s.weather as WeatherChoice) : 'clear',
      onChange: (v) => set({ weather: v }),
    });
    const format = cycler<WeekendFormat>({
      label: '週末賽制',
      options: FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] })),
      value: (FORMATS as readonly string[]).includes(s.format) ? (s.format as WeekendFormat) : 'raceOnly',
      onChange: (v) => set({ format: v }),
    });
    const reg = cycler<Regulation>({
      label: '規則年份',
      options: REGULATION_OPTIONS,
      value: s.regulation === '2026' ? '2026' : '2025',
      onChange: (v) => set({ regulation: v }),
    });
    const ai = slider({
      label: 'AI 車輛數',
      min: 0,
      max: MAX_SPLIT_AI,
      step: 1,
      value: s.aiCount,
      format: (v) => (v === 0 ? '無（只有玩家）' : `${v} 台`),
      onChange: (v) => set({ aiCount: v }),
    });
    const diff = slider({
      label: 'AI 難度',
      min: 0,
      max: 110,
      step: 1,
      value: s.aiDifficulty,
      format: (v) => `${v}（${difficultyLabel(v)}）`,
      onChange: (v) => set({ aiDifficulty: v }),
    });
    this.settingsEl.replaceChildren(track.el, laps.el, weather.el, format.el, reg.el, ai.el, diff.el);
  }

  private render(): void {
    const room = this.room;
    if (!room || room.closed) return;
    const state = room.hostLobby?.state ?? room.guestLobby?.state ?? null;
    const me = room.role === 'host' ? (room.hostLobby?.host ?? null) : (room.guestLobby?.me ?? null);
    if (!state) {
      this.playersEl.replaceChildren(h('p', { class: 'nvm-note', text: '連線中…' }));
      return;
    }
    const teamColor = (id: string): string => state.roster.teams.find((t) => t.id === id)?.color ?? '#888';
    const driverLabel = (id: string): string => {
      const d = state.roster.drivers.find((x) => x.id === id);
      const t = d ? state.roster.teams.find((x) => x.id === d.teamId) : undefined;
      return d ? `${d.name}・${t?.name ?? ''}` : '未選擇';
    };
    this.playersEl.replaceChildren(
      ...state.players.map((p) =>
        h(
          'div',
          { class: `nvm-lobby__player${me && p.playerIndex === me.playerIndex ? ' is-me' : ''}` },
          teamChip(teamColor(p.teamId)),
          h('b', { text: `P${p.playerIndex + 1} ${p.name}${p.playerIndex === 0 ? '（房主）' : ''}` }),
          h('span', { text: driverLabel(p.driverId) }),
          h('small', { text: p.playerIndex === 0 ? '房主' : `${p.ready ? '已準備' : '未準備'}・${p.ping} ms` }),
        ),
      ),
      h('p', { class: 'nvm-note', text: `${state.players.length}/4 名玩家・把房間代碼傳給朋友即可加入` }),
    );
    // my driver: any not taken by another player
    const takenKey = me ? `${me.driverId}|${state.players.filter((p) => p.playerIndex !== me.playerIndex).map((p) => p.driverId).sort().join(',')}` : '';
    if (me && takenKey !== this.mineKey) {
      this.mineKey = takenKey;
      const taken = new Set(state.players.filter((p) => p.playerIndex !== me.playerIndex).map((p) => p.driverId));
      const options = state.roster.drivers.filter((d) => !taken.has(d.id)).map((d) => ({ value: d.id, label: driverLabel(d.id) }));
      const driver = cycler<string>({
        label: '車手',
        options,
        value: me.driverId,
        onChange: (id) => this.pick(id),
      });
      const assists = assistPresetCycler('駕駛輔助', this.assists, (a) => {
        this.assists = a;
        const profile = loadProfile();
        profile.assists = { ...a };
        saveProfile(profile);
        this.pick(me.driverId);
      });
      this.mineEl.replaceChildren(driver.el, assists.el, h('p', { class: 'nvm-note', text: '賽車設定沿用你在這條賽道上次的設定；輔助只影響你自己的賽車。' }));
    }
    // settings summary for guests
    const s = state.settings;
    if (room.role === 'guest') {
      const layout = findLayout(s.layoutId);
      this.settingsEl.replaceChildren(
        h('p', { class: 'nvm-note', text: `賽道：${layout?.displayName ?? s.layoutId}` }),
        h('p', { class: 'nvm-note', text: `圈數：${s.laps}・天氣：${WEATHER_LABEL[s.weather as WeatherChoice] ?? s.weather}` }),
        h('p', { class: 'nvm-note', text: `賽制：${FORMAT_LABEL[s.format as WeekendFormat] ?? s.format}・規則 ${s.regulation}` }),
        h('p', { class: 'nvm-note', text: `AI：${s.aiCount} 台・難度 ${s.aiDifficulty}` }),
      );
      const label = this.actionBtn.querySelector('.nvm-btn__label');
      if (label) label.textContent = this.ready ? '取消準備' : '準備';
    } else {
      this.actionBtn.disabled = !room.hostLobby?.canStart();
    }
    this.mapBox.replaceChildren(minimapCanvas(s.layoutId, 300, 170, { lineWidth: 3 }));
  }

  private pick(driverId: string): void {
    const room = this.room;
    const state = room?.hostLobby?.state ?? room?.guestLobby?.state;
    const d = state?.roster.drivers.find((x) => x.id === driverId);
    if (!room || !d) return;
    if (room.hostLobby) room.hostLobby.setHostPick(d.teamId, d.id);
    else room.guestLobby?.pick(d.teamId, d.id, loadSetup(state?.settings.layoutId ?? ''), this.assists);
  }

  private toggleReady(): void {
    this.ready = !this.ready;
    this.room?.guestLobby?.setReady(this.ready);
    this.render();
  }

  /** Host: the weekend through the briefing; the App hands every session to the guests. */
  private start(): void {
    const room = this.room;
    const lobby = room?.hostLobby;
    if (!room || !lobby) return;
    if (!lobby.canStart()) {
      this.host.sound('error');
      this.host.toast('還有玩家沒有準備', 'bad');
      return;
    }
    const s = lobby.state.settings;
    const layout = findLayout(s.layoutId) ?? listLayouts()[0];
    if (!layout) return;
    const profile = loadProfile();
    const players: PlayerChoice[] = lobby.state.players
      .filter((p) => p.connected && p.driverId)
      .map((p) => {
        const car = p.playerIndex === 0 ? { setup: loadSetup(layout.id), assists: { ...profile.assists } } : (lobby.guestCar(p.playerIndex) ?? { setup: loadSetup(layout.id), assists: { ...profile.assists } });
        return { playerIndex: p.playerIndex, driverId: p.driverId, teamId: p.teamId, setup: car.setup, assists: car.assists, startCompound: null };
      });
    const base: SessionRequest = {
      mode: 'splitScreen',
      kind: 'race',
      layoutId: layout.id,
      raceLaps: Math.max(1, Math.round(s.laps)),
      weather: (WEATHER_CHOICES as readonly string[]).includes(s.weather) ? (s.weather as WeatherChoice) : 'clear',
      timeOfDay: 'auto',
      regulation: s.regulation === '2026' ? '2026' : '2025',
      aiDifficulty: s.aiDifficulty,
      qualifying: 'oneShot',
      rules: { ...DEFAULT_RULES },
      seed: Date.now() >>> 0,
      players,
      roster: standardRoster(),
      aiCount: s.aiCount,
      gridOrder: null,
      playerStartPosition: null,
      ghost: null,
      objective: null,
    };
    const format = (FORMATS as readonly string[]).includes(s.format) ? (s.format as WeekendFormat) : 'raceOnly';
    launchWeekend(this.host, base, weekendSessions(format), { returnTo: 'online', round: null, storyId: null });
  }
}

/** Default lobby settings for a new room. */
export function defaultLobbySettings(): LobbySettings {
  const layout = listLayouts()[0];
  return {
    layoutId: layout?.id ?? 'monza',
    laps: resolveLaps('l5', layout?.fullLaps ?? 50),
    weather: 'clear',
    aiCount: 10,
    aiDifficulty: 80,
    regulation: '2025',
    format: 'raceOnly',
  };
}
