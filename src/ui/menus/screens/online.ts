/**
 * Online multiplayer menus (docs/plans/phase3-online.md §4):
 * - OnlineScreen: player name, matchmaking (local test = tabs of this browser, or a Cloudflare matchmaking server),
 *   create / join a room by code, with clear zh-TW errors (room full, wrong code, unreachable server, NAT);
 * - LobbyScreen: room code (copy), players (name, driver, ready, ping), the host's race settings, each player's driver
 *   (unique), what they race as (a roster driver, their career / My Team driver in a roster seat, or their whole My Team
 *   in a roster team's place: meta/onlineEntry.ts) and assists, ready / start / leave. The host starts the weekend
 *   through the usual briefing flow; the App hands every session to the guests.
 */
import type { Assists, Regulation, SessionRules } from '../../../core/types';
import { DEFAULT_RULES } from '../../../core/defaults';
import { FORMAT_LABEL, SAFETY_CAR_LABEL, WEATHER_LABEL, difficultyLabel, lapsLabel } from '../labels';
import { LAPS_CHOICES, WEATHER_CHOICES, findLayout, listLayouts, resolveLaps, weekendSessions, type LapsChoice, type WeatherChoice, type WeekendFormat } from '../../../meta/options';
import { loadCareer, loadMyTeam, loadOnlineSetup, loadProfile, saveProfile } from '../../../meta/save';
import { standardRoster } from '../../../meta/roster';
import { applyOnlineEntries, onlineEntryOptions, type OnlineEntryOption, type OnlineEntrySource } from '../../../meta/onlineEntry';
import { MAX_SPLIT_AI, type PlayerChoice, type SessionRequest } from '../../../meta/sessionBuilder';
import { listedEntry, sameListing, seatFree } from '../../../net/lobby';
import type { LobbyPlayer, LobbyRules, LobbySettings, LobbyState } from '../../../net/protocol';
import type { OnlineRoom } from '../../../net/room';
import { aeroWakeRow, assistPresetCycler, raceControlRows, REGULATION_OPTIONS } from '../components/editors';
import { h } from '../dom';
import { launchWeekend } from '../flow';
import { minimapCanvas } from '../minimap';
import { onlineHooks, type OnlinePrefs } from '../onlineHooks';
import { Screen, type Host } from '../screen';
import { button, cycler, heading, panel, slider, teamChip, textField } from '../widgets';
import { CarSetupScreen } from './carSetup';

const FORMATS: readonly WeekendFormat[] = ['raceOnly', 'qualiRace', 'full'];
/** A guest's entry the host refused (its seat was taken meanwhile) is chosen again this many times before giving up. */
const ENTRY_RETRIES = 3;

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
    this.prefs = hooks ? hooks.prefs() : { name: '玩家', mode: 'local', serverUrl: '', relay: false, entry: 'roster' };
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
        relay.setDisabled(v !== 'server');
        save();
      },
    });
    const relay = cycler<boolean>({
      label: '連線路徑',
      options: [
        { value: false, label: '自動（直連優先）' },
        { value: true, label: '經由中繼伺服器' },
      ],
      value: this.prefs.relay,
      description: '直連延遲高或常掉封包時（比賽中按 F3 看「網路來回」「快照遺失」），由連線較差的一方改走配對伺服器設定的中繼伺服器（server/turn/README.md）；另一方維持自動（兩邊都選會連不上）。',
      onChange: (v) => {
        this.prefs.relay = v;
        save();
      },
    });
    server.setDisabled(this.prefs.mode !== 'server');
    relay.setDisabled(this.prefs.mode !== 'server');
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
            panel('配對', mode.el, server.el, relay.el, h('p', { class: 'nvm-note', text: this.serverHelp() })),
            panel('房間', this.createBtn, code.el, joinBtn, this.statusEl),
          ),
          h(
            'div',
            { class: 'nvm-stack' },
            panel(
              '說明',
              h('p', { class: 'nvm-note', text: '房主的電腦會模擬整場比賽（含 AI），其他玩家的賽車由自己的鍵盤或手把操控、以點對點方式連到房主。' }),
              h('p', { class: 'nvm-note', text: '本機測試：在同一個瀏覽器開兩個分頁、同一個網址，一個建立房間，另一個輸入代碼加入，不需要伺服器。' }),
              h('p', { class: 'nvm-note', text: '限制：配對伺服器沒有設定中繼伺服器（TURN）時，部分嚴格 NAT 網路可能連不上；沒有反作弊；斷線後無法重新加入；房主的分頁切到背景時比賽會變慢或暫停。' }),
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
  private readonly rulesEl: HTMLElement;
  private readonly mineEl: HTMLElement;
  private readonly mapBox: HTMLElement;
  private readonly actionBtn: HTMLButtonElement;
  private lapsChoice: LapsChoice = 'l5';
  private assists: Assists;
  private ready = false;
  private built = false;
  /** what the 我的車手 panel was built for (rebuilt only when it changes: keeps the keyboard focus) */
  private mineKey = '';
  /** what this player can race as (from their saves) and what they chose (remembered in the online prefs) */
  private readonly entries: OnlineEntryOption[];
  private source: OnlineEntrySource;
  /** the remembered entry was sent once this player had a seat */
  private entrySent = false;
  /** refused entry picks chosen again in a row */
  private retries = 0;
  /** the last entry the lobby showed me racing as (what a refused change falls back to) */
  private confirmed: OnlineEntrySource = 'roster';

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-lobby' });
    this.assists = { ...loadProfile().assists };
    this.entries = onlineEntryOptions(loadCareer(), loadMyTeam());
    const remembered = onlineHooks()?.prefs().entry ?? 'roster';
    this.source = this.entries.some((e) => e.source === remembered) ? remembered : 'roster';
    this.playersEl = h('div', { class: 'nvm-stack' });
    this.settingsEl = h('div', { class: 'nvm-stack' });
    this.rulesEl = h('div', { class: 'nvm-stack' });
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
          h('div', { class: 'nvm-stack' }, panel('賽事設定', this.settingsEl), panel('規則', this.rulesEl), panel('賽道預覽', this.mapBox)),
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
    const setRule = <K extends keyof LobbyRules>(key: K) => (v: SessionRules[K]): void => set({ rules: { ...s.rules, [key]: v } });
    const rules: SessionRules = { ...DEFAULT_RULES, ...s.rules };
    this.rulesEl.replaceChildren(aeroWakeRow(rules, setRule), ...raceControlRows(rules, setRule));
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
    const playerLabel = (p: LobbyPlayer): string => {
      const e = p.entry;
      if (!e) return driverLabel(p.driverId);
      const replaced = e.kind === 'team' ? (state.roster.teams.find((t) => t.id === p.teamId)?.name ?? '') : (state.roster.drivers.find((d) => d.id === p.driverId)?.name ?? '');
      const team = e.kind === 'team' ? (e.team ?? '') : (state.roster.teams.find((t) => t.id === p.teamId)?.name ?? '');
      return `${e.driver}・${team}（頂替 ${replaced}）`;
    };
    this.playersEl.replaceChildren(
      ...state.players.map((p) =>
        h(
          'div',
          { class: `nvm-lobby__player${me && p.playerIndex === me.playerIndex ? ' is-me' : ''}` },
          teamChip(p.entry?.color ?? teamColor(p.teamId)),
          h('b', { text: `P${p.playerIndex + 1} ${p.name}${p.playerIndex === 0 ? '（房主）' : ''}` }),
          h('span', { text: playerLabel(p) }),
          h('small', { text: p.playerIndex === 0 ? '房主' : `${p.ready ? '已準備' : '未準備'}・${p.ping} ms` }),
        ),
      ),
      h('p', { class: 'nvm-note', text: `${state.players.length}/4 名玩家・把房間代碼傳給朋友即可加入` }),
    );
    // the remembered entry, once this player has a seat
    if (me && !this.entrySent) {
      this.entrySent = true;
      if (this.source !== 'roster') this.chooseSource(this.source, state, me);
    }
    // a guest's picks all handled but its entry not taken (another player got the seat first): choose again from the
    // lobby as it is now; after a few refusals show what the host has
    const settled = room.role === 'host' || room.guestLobby?.picksSettled() === true;
    if (me && settled && this.listedAs(me, this.source)) {
      this.confirmed = this.source;
      this.retries = 0;
    } else if (me && settled && room.role === 'guest' && this.retries <= ENTRY_RETRIES) {
      if (this.retries < ENTRY_RETRIES) {
        this.retries++;
        this.chooseSource(this.source, state, me);
      } else {
        // given up: no more tries until the player chooses again
        this.retries++;
        this.host.toast('參賽身分沒有換成功：選的席位已被其他玩家佔用', 'bad');
        this.source = this.confirmedSource(me);
      }
    }
    // my driver: any not taken by another player (a whole team for a My Team entry)
    const others = state.players.filter((p) => p.playerIndex !== me?.playerIndex);
    const takenKey = me
      ? `${this.source}|${me.teamId}|${me.driverId}|${state.settings.layoutId}|${others.map((p) => `${p.driverId}:${p.entry?.kind === 'team' ? p.teamId : ''}`).sort().join(',')}`
      : '';
    if (me && takenKey !== this.mineKey) {
      this.mineKey = takenKey;
      const focused = Array.from(this.mineEl.querySelectorAll('button')).indexOf(document.activeElement as HTMLButtonElement);
      const option = this.entry();
      const rows: HTMLElement[] = [];
      if (this.entries.length > 1) {
        rows.push(
          cycler<OnlineEntrySource>({
            label: '參賽身分',
            options: this.entries.map((e) => ({ value: e.source, label: e.label })),
            value: this.source,
            onChange: (v) => {
              this.retries = 0;
              this.chooseSource(v);
            },
          }).el,
        );
      }
      if (option.entry.kind === 'team') {
        const teams = state.roster.teams.filter((t) => seatFree(state.players, me.playerIndex, t.id, '', true));
        rows.push(
          cycler<string>({
            label: '頂替車隊',
            options: teams.map((t) => ({ value: t.id, label: t.name, swatch: t.color })),
            value: me.teamId,
            onChange: (id) => this.pickTeam(id),
          }).el,
        );
      } else {
        const options = state.roster.drivers
          .filter((d) => seatFree(state.players, me.playerIndex, d.teamId, d.id, false))
          .map((d) => ({ value: d.id, label: driverLabel(d.id) }));
        rows.push(
          cycler<string>({
            label: option.entry.kind === 'driver' ? '頂替車手' : '車手',
            options,
            value: me.driverId,
            onChange: (id) => this.pick(id),
          }).el,
        );
      }
      const assists = assistPresetCycler('駕駛輔助', this.assists, (a) => {
        this.assists = a;
        const profile = loadProfile();
        profile.assists = { ...a };
        saveProfile(profile);
        // (the host reads its own when the weekend starts)
        this.room?.guestLobby?.syncCar(true);
      });
      const setup = button({ label: '賽車設定', sub: findLayout(state.settings.layoutId)?.displayName ?? '', onClick: () => this.openSetup() });
      const note =
        option.entry.kind === 'team'
          ? '你的車隊（隊名、塗裝、研發後的賽車性能）整支頂替所選車隊，用它的車庫與兩個席位；隊友由你簽下的車手（AI）駕駛。'
          : option.entry.kind === 'driver'
            ? `你的車手（姓名、車號、頭盔）頂替所選車手的席位，開那支車隊的賽車${option.source === 'career' ? '；你生涯車隊的研發會套用到這支車隊的兩台車' : ''}。`
            : '';
      this.mineEl.replaceChildren(
        ...rows,
        assists.el,
        setup,
        ...(note ? [h('p', { class: 'nvm-note', text: note })] : []),
        h('p', {
          class: 'nvm-note',
          text: `賽車設定是線上專用的（依賽道保存，不會改到單機模式；還沒在線上調過的賽道先沿用單機設定），和輔助一樣只影響你自己的賽車；${
            room.role === 'host' ? '週末的每一節開始前，簡報裡也能調整。' : '週末的節次之間回到大廳也能再調整，每一節開始時採用你最新的設定。'
          }`,
        }),
      );
      if (focused >= 0) this.mineEl.querySelectorAll('button')[focused]?.focus();
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
      const r = s.rules;
      this.rulesEl.replaceChildren(
        h('p', { class: 'nvm-note', text: `安全車：${SAFETY_CAR_LABEL[r.safetyCar] ?? r.safetyCar}・紅旗：${r.redFlags ? '開' : '關'}・暖胎圈：${r.formationLap ? '開' : '關'}` }),
        h('p', { class: 'nvm-note', text: `空氣動力尾流：${r.aeroWake ? '擬真' : '關閉'}` }),
      );
      const label = this.actionBtn.querySelector('.nvm-btn__label');
      if (label) label.textContent = this.ready ? '取消準備' : '準備';
    } else {
      this.actionBtn.disabled = !room.hostLobby?.canStart();
    }
    this.mapBox.replaceChildren(minimapCanvas(s.layoutId, 300, 170, { lineWidth: 3 }));
  }

  private lobbyState(): LobbyState | null {
    const room = this.room;
    return room?.hostLobby?.state ?? room?.guestLobby?.state ?? null;
  }

  private lobbyMe(): LobbyPlayer | null {
    const room = this.room;
    return room?.role === 'host' ? (room.hostLobby?.host ?? null) : (room?.guestLobby?.me ?? null);
  }

  private entry(): OnlineEntryOption {
    return this.entries.find((e) => e.source === this.source) ?? (this.entries[0] as OnlineEntryOption);
  }

  /** Whether the lobby lists me racing as this entry. */
  private listedAs(me: LobbyPlayer, source: OnlineEntrySource): boolean {
    const option = this.entries.find((e) => e.source === source);
    return option !== undefined && sameListing(listedEntry(option.entry), me.entry);
  }

  /** What the lobby has me racing as: my choice when it is listed, else the last one it showed, else any it matches. */
  private confirmedSource(me: LobbyPlayer): OnlineEntrySource {
    if (this.listedAs(me, this.source)) return this.source;
    if (this.listedAs(me, this.confirmed)) return this.confirmed;
    const kind = me.entry?.kind ?? 'roster';
    return (this.entries.find((e) => this.listedAs(me, e.source)) ?? this.entries.find((e) => e.entry.kind === kind))?.source ?? 'roster';
  }

  /** My seat and entry to the host (the host's own: straight into its lobby; a guest's car: GuestLobby.syncCar). */
  private send(teamId: string, driverId: string): void {
    const room = this.room;
    if (!room) return;
    const entry = this.entry().entry;
    if (room.hostLobby) room.hostLobby.setHostPick(teamId, driverId, entry);
    else room.guestLobby?.pick(teamId, driverId, undefined, undefined, entry);
  }

  /** The online setup of the room's track (a guest's goes to the host at every change). */
  private openSetup(): void {
    const room = this.room;
    const state = this.lobbyState();
    const me = this.lobbyMe();
    if (!room || !state || !me) return;
    const layoutId = state.settings.layoutId;
    const player: PlayerChoice = { playerIndex: me.playerIndex, driverId: me.driverId, teamId: me.teamId, setup: loadOnlineSetup(layoutId), assists: { ...this.assists }, startCompound: null };
    const guest = room.guestLobby;
    this.host.push(
      new CarSetupScreen(this.host, player, layoutId, 'race', 'clear', findLayout(layoutId)?.displayName ?? '', {
        online: true,
        startCompound: false,
        ...(guest ? { onSave: () => guest.syncCar(true) } : {}),
      }),
    );
  }

  private pick(driverId: string): void {
    const d = this.lobbyState()?.roster.drivers.find((x) => x.id === driverId);
    if (d) this.send(d.teamId, d.id);
  }

  /** My Team entry: take over a team (its first roster driver is the seat the lobby keeps). */
  private pickTeam(teamId: string): void {
    const d = this.lobbyState()?.roster.drivers.find((x) => x.teamId === teamId);
    if (d) this.send(d.teamId, d.id);
  }

  /** Race as another entry: in my seat when it fits the entry (a whole free team for My Team), else the first that does. */
  private chooseSource(source: OnlineEntrySource, state = this.lobbyState(), me = this.lobbyMe()): void {
    const option = this.entries.find((e) => e.source === source);
    if (!option || !state || !me) return;
    const wholeTeam = option.entry.kind === 'team';
    const fits = (teamId: string, driverId: string): boolean => seatFree(state.players, me.playerIndex, teamId, driverId, wholeTeam);
    const seat = fits(me.teamId, me.driverId) ? { teamId: me.teamId, id: me.driverId } : state.roster.drivers.find((d) => fits(d.teamId, d.id));
    if (!seat) {
      this.host.sound('error');
      this.host.toast('沒有可以整支頂替的車隊（每支車隊都有其他玩家）', 'bad');
      this.source = this.confirmedSource(me);
      this.mineKey = '';
      this.render();
      return;
    }
    this.source = source;
    const hooks = onlineHooks();
    hooks?.savePrefs({ ...hooks.prefs(), entry: source });
    this.send(seat.teamId, seat.id);
    // the host's pick is taken (or not) at once; a guest's shows in a later lobby state (see render)
    if (this.room?.hostLobby) {
      this.source = this.confirmedSource(me);
      this.confirmed = this.source;
    }
    this.mineKey = '';
    this.render();
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
    // every player's own driver / My Team takes its seat's place in the roster
    const field = applyOnlineEntries(
      standardRoster(),
      lobby.state.players
        .filter((p) => p.connected && p.driverId)
        .map((p) => ({ playerIndex: p.playerIndex, teamId: p.teamId, driverId: p.driverId, entry: lobby.entryOf(p.playerIndex) })),
    );
    const players: PlayerChoice[] = field.seats.map((seat) => {
      const car = seat.playerIndex === 0 ? { setup: loadOnlineSetup(layout.id), assists: { ...profile.assists } } : (lobby.guestCar(seat.playerIndex) ?? { setup: loadOnlineSetup(layout.id), assists: { ...profile.assists } });
      return { playerIndex: seat.playerIndex, driverId: seat.driverId, teamId: seat.teamId, setup: car.setup, assists: car.assists, startCompound: null };
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
      rules: { ...DEFAULT_RULES, ...s.rules },
      seed: Date.now() >>> 0,
      players,
      roster: field.roster,
      ...(Object.keys(field.development).length > 0 ? { development: field.development } : {}),
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
    rules: {
      safetyCar: DEFAULT_RULES.safetyCar ?? 'standard',
      redFlags: DEFAULT_RULES.redFlags ?? true,
      formationLap: DEFAULT_RULES.formationLap ?? false,
      aeroWake: DEFAULT_RULES.aeroWake ?? true,
    },
  };
}
