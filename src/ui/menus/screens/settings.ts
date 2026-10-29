/**
 * Settings: graphics, audio, controls, P1 / P2 key rebinding (with conflict detection), HUD elements and units, and
 * the roster pack (名單, menus only).
 * Every change is applied immediately (cb.applySettings) and persisted. Also used as an overlay above a
 * paused session.
 */
import type { CameraMode, KeyAction, QualityLevel, Settings, SpeedUnit } from '../../../core/types';
import { bundledPlaylist, bundledPlaylistNow } from '../../../audio/bundledMusic';
import { clearMusicFile, getMusicError, MAX_MUSIC_BYTES, readMusicInfo, saveMusicFile, subscribeMusic } from '../../../audio/musicStore';
import { cloneSettings, defaultSettings, KEY_ACTIONS } from '../../../meta/save';
import { h, setChildren } from '../dom';
import { captureStep, clashesWithP1Pause, isPadEvent } from '../keyCapture';
import { focusElement } from '../nav';
import { CAMERA_LABEL, KEY_ACTION_LABEL, keyLabel, QUALITY_LABEL } from '../labels';
import { Screen, type Host } from '../screen';
import { button, cycler, heading, panel, slider, tabs, textField, toggle } from '../widgets';
import { ExperienceScreen } from './onboarding';
import { rosterTab } from './rosterSettings';

type TabId = 'graphics' | 'audio' | 'controls' | 'keysP1' | 'keysP2' | 'hud' | 'roster';
type Player = 'p1' | 'p2';

const TABS: { id: TabId; label: string }[] = [
  { id: 'graphics', label: '畫面' },
  { id: 'audio', label: '音效' },
  { id: 'controls', label: '操控' },
  { id: 'keysP1', label: '按鍵（P1）' },
  { id: 'keysP2', label: '按鍵（P2）' },
  { id: 'hud', label: 'HUD' },
];
/** Not offered above a paused session: the running session keeps the roster it was built with. */
const ROSTER_TAB: { id: TabId; label: string } = { id: 'roster', label: '名單' };

/** Actions P2 can bind (global actions such as pause / fullscreen stay with P1). */
const P2_ACTIONS: readonly KeyAction[] = [
  'throttle',
  'brake',
  'steerLeft',
  'steerRight',
  'shiftUp',
  'shiftDown',
  'drs',
  'overtake',
  'ersCycle',
  'limiter',
  'camera',
  'lookBack',
  'pitRequest',
  'mfd',
];

const SLOTS = 2;

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export class SettingsScreen extends Screen {
  readonly title = '設定';
  private s: Settings;
  private tab: TabId = 'graphics';
  private readonly body: HTMLElement;
  private capture: { player: Player; action: KeyAction; slot: number; el: HTMLButtonElement } | null = null;

  constructor(
    host: Host,
    private readonly onClose: (() => void) | null,
  ) {
    super(host, { layout: 'panel', className: 'nvm-settings' });
    this.s = cloneSettings(host.settings);
    this.body = h('div', { class: 'nvm-settings__body' });
    const bar = tabs(onClose ? TABS : [...TABS, ROSTER_TAB], this.tab, (id) => {
      this.cancelCapture();
      this.tab = id as TabId;
      this.render();
    });
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('設定', onClose ? '暫停中' : '選項'),
        bar.el,
        this.body,
        h(
          'div',
          { class: 'nvm-actions nvm-actions--bar' },
          button({
            label: '還原預設值',
            variant: 'danger',
            onClick: () =>
              this.host.confirm('還原所有設定？', '畫面、音效、操控、按鍵與 HUD 設定都會回到預設值。', () => {
                this.s = defaultSettings();
                this.commit();
                this.render();
              }, '還原'),
          }),
          button({ label: '返回', back: true, onClick: () => this.close() }),
        ),
      ),
    );
    this.render();
  }

  override hints(): string[] {
    return ['↑↓ 選擇', '←→ 調整', 'Enter 重新綁定', 'Esc 返回'];
  }

  override onBack(): boolean {
    if (this.capture) {
      this.cancelCapture();
      return true;
    }
    if (this.onClose) {
      this.host.sound('back');
      this.onClose();
      return true;
    }
    return false;
  }

  override onLeave(): void {
    this.cancelCapture();
  }

  override onKey(e: KeyboardEvent): boolean {
    if (!this.capture) return false;
    const { player, action, slot } = this.capture;
    const step = captureStep(e, action, isPadEvent(e));
    if (step.kind === 'cancel') {
      this.cancelCapture();
      this.host.sound('back');
    } else if (step.kind === 'clear') this.setKey(player, action, slot, null);
    else if (step.kind === 'bind') this.setKey(player, action, slot, step.code);
    return true;
  }

  private close(): void {
    this.cancelCapture();
    if (this.onClose) this.onClose();
    else this.host.pop();
  }

  private commit(): void {
    this.host.updateSettings(cloneSettings(this.s));
  }

  private patch(p: Partial<Settings>): void {
    this.s = { ...this.s, ...p };
    this.commit();
  }

  private render(): void {
    const focusTab = this.tab;
    switch (focusTab) {
      case 'graphics':
        setChildren(this.body, this.graphics());
        break;
      case 'audio':
        setChildren(this.body, this.audio());
        break;
      case 'controls':
        setChildren(this.body, this.controls());
        break;
      case 'keysP1':
        setChildren(this.body, this.keys('p1'));
        break;
      case 'keysP2':
        setChildren(this.body, this.keys('p2'));
        break;
      case 'hud':
        setChildren(this.body, this.hud());
        break;
      case 'roster':
        setChildren(this.body, rosterTab(this.host, () => this.render()));
        break;
    }
  }

  private graphics(): HTMLElement {
    const s = this.s;
    return h(
      'div',
      { class: 'nvm-stack nvm-narrow' },
      panel(
        '畫質',
        cycler<QualityLevel>({
          label: '畫質等級',
          options: (['low', 'medium', 'high', 'ultra'] as const).map((q) => ({ value: q, label: QUALITY_LABEL[q] })),
          value: s.quality,
          onChange: (v) => this.patch({ quality: v }),
          description: '影響陰影解析度、物件密度與特效數量',
        }).el,
        slider({ label: '解析度比例', min: 0.5, max: 1, step: 0.05, value: s.resolutionScale, format: pct, onChange: (v) => this.patch({ resolutionScale: v }), description: '降低可提升效能' }).el,
        toggle('陰影', s.shadows, (v) => this.patch({ shadows: v })).el,
        toggle('反鋸齒', s.antialias, (v) => this.patch({ antialias: v }), '重新整理頁面後生效').el,
        toggle('顯示 FPS', s.showFps, (v) => this.patch({ showFps: v })).el,
      ),
      panel(
        '鏡頭',
        slider({ label: '視野（FOV）', min: 50, max: 90, step: 1, value: s.fov, format: (v) => `${v}°`, onChange: (v) => this.patch({ fov: v }) }).el,
        cycler<CameraMode>({
          label: '預設鏡頭',
          options: (['chase', 'chaseFar', 'tcam', 'cockpit', 'nose', 'tv'] as const).map((c) => ({ value: c, label: CAMERA_LABEL[c] })),
          value: s.defaultCamera,
          onChange: (v) => this.patch({ defaultCamera: v }),
        }).el,
        toggle('鏡頭震動', s.cameraShake, (v) => this.patch({ cameraShake: v })).el,
        slider({
          label: '速度模糊',
          min: 0,
          max: 1,
          step: 0.05,
          value: s.speedBlur,
          format: (v) => (v > 0 ? pct(v) : '關閉'),
          onChange: (v) => this.patch({ speedBlur: v }),
          description: '速度越快，畫面周圍越模糊；0% 為關閉（需「中」以上畫質；分割畫面不套用）',
        }).el,
      ),
    );
  }

  private audio(): HTMLElement {
    const s = this.s;
    const vol = (label: string, key: 'masterVolume' | 'engineVolume' | 'sfxVolume' | 'uiVolume' | 'musicVolume'): HTMLElement =>
      slider({ label, min: 0, max: 1, step: 0.05, value: s[key], format: pct, onChange: (v) => this.patch({ [key]: v }) }).el;
    // the local playlist's manifest is read once; redraw the tab when it arrives
    const tracks = bundledPlaylistNow();
    if (tracks === undefined) {
      void bundledPlaylist().then(() => {
        if (this.tab === 'audio' && this.el.isConnected) this.render();
      });
    }
    const bundledLabel =
      tracks === undefined ? '本機播放清單' : tracks === null ? '本機播放清單（找不到檔案）' : tracks.length === 1 ? (tracks[0]?.title ?? '') : `本機播放清單（${tracks.length} 首）`;
    const source = cycler<Settings['musicSource']>({
      label: '音樂來源',
      options: [
        { value: 'original', label: '原創' },
        ...(tracks || s.musicSource === 'bundled' ? [{ value: 'bundled' as const, label: bundledLabel }] : []),
        { value: 'custom', label: '自選檔案' },
        { value: 'youtube', label: 'YouTube' },
        { value: 'off', label: '關閉' },
      ],
      value: s.musicSource,
      onChange: (v) => this.patch({ musicSource: v }),
      description: '「原創」是遊戲即時合成的配樂（選單、比賽、頒獎台各一首），不含任何音訊檔',
    });
    return h(
      'div',
      { class: 'nvm-stack nvm-narrow' },
      panel('音量', vol('主音量', 'masterVolume'), vol('引擎', 'engineVolume'), vol('音效', 'sfxVolume'), vol('介面', 'uiVolume'), vol('音樂音量', 'musicVolume')),
      panel(
        '背景音樂',
        source.el,
        cycler<boolean>({
          label: '比賽中播放',
          options: [
            { value: true, label: '開' },
            { value: false, label: '關' },
          ],
          value: s.musicInRace,
          onChange: (v) => this.patch({ musicInRace: v }),
          description: '開啟後，賽事與重播中仍會以較小音量播放',
        }).el,
        ...this.musicFile(source),
      ),
      this.youtubeLink(source),
    );
  }

  /** YouTube link field: 「套用連結」 stores the link and switches the source to YouTube (Enter in the field moves to it). */
  private youtubeLink(source: { set(v: Settings['musicSource']): void }): HTMLElement {
    const apply = (): void => {
      const link = field.get().trim();
      field.set(link);
      this.patch({ musicYoutube: link, musicSource: 'youtube' });
      source.set('youtube');
      this.host.toast(link ? '已改用 YouTube 音樂' : '已清除 YouTube 連結', link ? 'good' : undefined);
    };
    const field = textField({
      label: '影片或播放清單連結',
      value: this.s.musicYoutube,
      maxLength: 300,
      placeholder: 'https://www.youtube.com/watch?v=…',
      onInput: () => undefined,
    });
    return panel(
      'YouTube 音樂',
      field.el,
      h('div', { class: 'nvm-actions' }, button({ label: '套用連結', onClick: apply })),
      h('p', {
        class: 'nvm-note',
        text: '貼上 YouTube 影片或播放清單的連結，音樂來源會改為「YouTube」。需要網路連線；有些影片的上傳者不允許嵌入播放，這時會改播原創音樂。',
      }),
      h('p', {
        class: 'nvm-note',
        text: '依 YouTube 的使用規範，播放時會顯示小播放器（選單在左下角，賽事中在畫面右側中段），不能隱藏；音樂靜音的場景（例如關閉「比賽中播放」時的賽事）與背景分頁會自動暫停並收起播放器。',
      }),
    );
  }

  /** 「選擇音樂檔…」 / 「清除音樂檔」 with the stored file's name and any load / decode error. */
  private musicFile(source: { set(v: Settings['musicSource']): void }): HTMLElement[] {
    const nameEl = h('p', { class: 'nvm-note', text: '目前的音樂檔：讀取中…' });
    const errEl = h('div', { class: 'nvm-banner is-bad' });
    errEl.hidden = true;
    const showError = (message: string | null): void => {
      errEl.hidden = !message;
      errEl.textContent = message ?? '';
    };
    const showName = async (): Promise<void> => {
      try {
        const info = await readMusicInfo();
        nameEl.textContent = `目前的音樂檔：${info ? info.name : '（尚未選擇）'}`;
      } catch (err) {
        nameEl.textContent = '目前的音樂檔：（無法讀取）';
        showError(err instanceof Error ? err.message : '無法讀取音樂檔');
      }
    };
    const off = subscribeMusic(() => {
      if (!nameEl.isConnected) {
        off();
        return;
      }
      showError(getMusicError());
      void showName();
    });
    showError(getMusicError());
    void showName();

    const input = h('input', { attrs: { type: 'file', accept: 'audio/*', hidden: true, tabindex: -1, 'aria-hidden': 'true' } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      saveMusicFile(file).then(
        () => {
          this.patch({ musicSource: 'custom' });
          source.set('custom');
          this.host.toast(`已選擇音樂檔：${file.name}`, 'good');
        },
        (err: unknown) => {
          this.host.sound('error');
          showError(err instanceof Error ? err.message : '無法儲存音樂檔');
        },
      );
    });
    return [
      h(
        'div',
        { class: 'nvm-actions' },
        button({ label: '選擇音樂檔…', onClick: () => input.click() }),
        button({
          label: '清除音樂檔',
          variant: 'danger',
          onClick: () => {
            clearMusicFile().then(
              () => {
                if (this.s.musicSource === 'custom') {
                  this.patch({ musicSource: 'original' });
                  source.set('original');
                }
                this.host.toast('已清除音樂檔');
              },
              (err: unknown) => showError(err instanceof Error ? err.message : '無法清除音樂檔'),
            );
          },
        }),
        input,
      ),
      nameEl,
      errEl,
      h('p', { class: 'nvm-note', text: `支援瀏覽器可播放的音訊格式（如 MP3、AAC、OGG、WAV），上限 ${Math.round(MAX_MUSIC_BYTES / 1024 / 1024)} MB。檔案只保存在這個瀏覽器中，不會上傳，也不屬於遊戲內容。` }),
    ];
  }

  private controls(): HTMLElement {
    const s = this.s;
    return h(
      'div',
      { class: 'nvm-narrow' },
      panel(
      '操控',
      slider({ label: '轉向靈敏度', min: 0.5, max: 1.5, step: 0.05, value: s.steeringSensitivity, format: (v) => `${v.toFixed(2)}×`, onChange: (v) => this.patch({ steeringSensitivity: v }) }).el,
      slider({ label: '搖桿死區', min: 0, max: 0.3, step: 0.01, value: s.deadzone, format: pct, onChange: (v) => this.patch({ deadzone: v }), description: '控制器類比搖桿的無反應範圍' }).el,
      toggle('控制器震動', s.vibration, (v) => this.patch({ vibration: v })).el,
      this.onClose ? null : button({ label: '重新選擇駕駛經驗', sub: '重設各模式的預設駕駛輔助（不會清除存檔）', onClick: () => this.host.push(new ExperienceScreen(this.host, false)) }),
      ),
    );
  }

  private hud(): HTMLElement {
    const s = this.s;
    const hudToggle = (label: string, key: keyof Settings['hud']): HTMLElement =>
      toggle(label, s.hud[key], (v) => this.patch({ hud: { ...this.s.hud, [key]: v } })).el;
    return h(
      'div',
      { class: 'nvm-stack nvm-narrow' },
      panel('HUD 元件', hudToggle('小地圖', 'minimap'), hudToggle('計時塔', 'tower'), hudToggle('遙測（速度／檔位／輪胎）', 'telemetry'), hudToggle('車隊無線電', 'radio')),
      panel(
        '單位',
        cycler<SpeedUnit>({
          label: '速度單位',
          options: [
            { value: 'kmh', label: '公里／小時（km/h）' },
            { value: 'mph', label: '英里／小時（mph）' },
          ],
          value: s.units,
          onChange: (v) => this.patch({ units: v }),
        }).el,
      ),
    );
  }

  // ───────────────────────────── key bindings ─────────────────────────────

  private bindings(player: Player): Partial<Record<KeyAction, string[]>> {
    return player === 'p1' ? this.s.keyBindings : this.s.keyBindingsP2;
  }

  private keys(player: Player): HTMLElement {
    const actions = player === 'p1' ? KEY_ACTIONS : P2_ACTIONS;
    const other = this.bindings(player === 'p1' ? 'p2' : 'p1');
    const otherCodes = new Map<string, KeyAction>();
    for (const a of KEY_ACTIONS) for (const code of other[a] ?? []) otherCodes.set(code, a);
    const rows = actions.map((action) => {
      const keys = this.bindings(player)[action] ?? [];
      const shared = keys.filter((c) => otherCodes.has(c));
      const slots = Array.from({ length: SLOTS }, (_, slot) => {
        const code = keys[slot];
        const btn = h('button', {
          class: `nvm-keyslot${code ? '' : ' is-empty'}${code && otherCodes.has(code) ? ' is-shared' : ''}`,
          attrs: { type: 'button', 'data-sound': 'confirm' },
          text: code ? keyLabel(code) : '—',
        });
        btn.addEventListener('click', () => this.beginCapture(player, action, slot, btn));
        return btn;
      });
      const note =
        shared.length > 0
          ? player === 'p1'
            ? `與 P2「${KEY_ACTION_LABEL[otherCodes.get(shared[0] as string) as KeyAction]}」共用：分割畫面時歸 P2`
            : `與 P1「${KEY_ACTION_LABEL[otherCodes.get(shared[0] as string) as KeyAction]}」共用：分割畫面時此鍵只控制 P2`
          : '';
      return h(
        'div',
        { class: 'nvm-keyrow' },
        h('span', { class: 'nvm-keyrow__label', text: KEY_ACTION_LABEL[action] }),
        h('span', { class: 'nvm-keyrow__slots' }, slots),
        note ? h('small', { class: 'nvm-keyrow__note', text: note }) : null,
      );
    });
    const keysPanel = panel(
      player === 'p1' ? '玩家 1 按鍵' : '玩家 2 按鍵（分割畫面）',
      h('p', { class: 'nvm-note', text: '選擇欄位後按下新按鍵；Backspace／Delete 清除，Esc 取消（「暫停」欄位則會綁定 Esc）。同一玩家重複的按鍵會自動從原動作移除。' }),
      h('div', { class: 'nvm-keyrows' }, rows),
    );
    return h('div', { class: 'nvm-narrow' }, keysPanel);
  }

  private beginCapture(player: Player, action: KeyAction, slot: number, el: HTMLButtonElement): void {
    this.cancelCapture();
    this.capture = { player, action, slot, el };
    el.classList.add('is-capturing');
    el.textContent = '按下按鍵…';
  }

  private cancelCapture(): void {
    if (!this.capture) return;
    const { el } = this.capture;
    this.capture = null;
    if (el.isConnected) this.renderKeepingFocus();
  }

  private renderKeepingFocus(): void {
    const slots = Array.from(this.body.querySelectorAll<HTMLElement>('.nvm-keyslot'));
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? slots.indexOf(active) : -1;
    this.render();
    if (index >= 0) {
      const next = this.body.querySelectorAll<HTMLElement>('.nvm-keyslot')[index];
      if (next) focusElement(next);
    }
  }

  private setKey(player: Player, action: KeyAction, slot: number, code: string | null): void {
    if (code && clashesWithP1Pause(player, this.s.keyBindings.pause, code)) {
      this.cancelCapture();
      this.host.sound('error');
      this.host.toast(`「${keyLabel(code)}」是 P1 的「暫停」鍵，P2 不能綁定（否則分割畫面時無法用鍵盤暫停）`, 'bad');
      return;
    }
    const map = this.bindings(player);
    const next: Partial<Record<KeyAction, string[]>> = {};
    for (const a of KEY_ACTIONS) {
      const list = map[a];
      if (list) next[a] = [...list];
    }
    const removedFrom: KeyAction[] = [];
    if (code) {
      for (const a of KEY_ACTIONS) {
        if (a === action) continue;
        const list = next[a];
        if (list && list.includes(code)) {
          next[a] = list.filter((c) => c !== code);
          removedFrom.push(a);
        }
      }
    }
    const current = (next[action] ?? []).filter((c) => c !== code);
    if (code) {
      if (slot < current.length) current[slot] = code;
      else current.push(code);
    } else if (slot < current.length) {
      current.splice(slot, 1);
    }
    next[action] = current.slice(0, SLOTS);
    if (player === 'p1' && (next.pause ?? []).length === 0) {
      // pause is the keyboard's only way out of a session (time trials have no clock)
      this.cancelCapture();
      this.host.sound('error');
      this.host.toast('「暫停」至少需要保留一個按鍵', 'bad');
      return;
    }
    if (player === 'p1') {
      const full = { ...this.s.keyBindings };
      for (const a of KEY_ACTIONS) full[a] = next[a] ?? [];
      this.s = { ...this.s, keyBindings: full };
    } else {
      this.s = { ...this.s, keyBindingsP2: next };
    }
    this.commit();
    const captured = this.capture;
    this.capture = null;
    if (captured && captured.el.isConnected) this.renderKeepingFocus();
    if (code) {
      this.host.sound('confirm');
      if (removedFrom.length > 0) {
        this.host.toast(`「${keyLabel(code)}」已從${removedFrom.map((a) => `「${KEY_ACTION_LABEL[a]}」`).join('、')}移除`);
      }
      const other = this.bindings(player === 'p1' ? 'p2' : 'p1');
      const clash = KEY_ACTIONS.find((a) => (other[a] ?? []).includes(code));
      if (clash) this.host.toast(`注意：此按鍵也是 ${player === 'p1' ? 'P2' : 'P1'} 的「${KEY_ACTION_LABEL[clash]}」`, 'bad');
    } else {
      this.host.sound('back');
    }
  }
}
