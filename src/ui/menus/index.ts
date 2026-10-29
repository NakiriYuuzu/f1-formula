/**
 * Front-end menus + results + meta progression (owner: menus agent). DOM/CSS only, zh-TW text.
 * Exported signatures are a CONTRACT used by the App: keep them (you may add members / optional params).
 *
 * MenuSystem is a small screen framework: a stack of screens with enter/exit transitions, focus management,
 * keyboard navigation (arrows / Enter / Space / Esc / Backspace, F = fullscreen) and mouse support. It drives the
 * 3D showroom / podium behind car-focused screens through MenuCallbacks.
 */
import '../tokens.css';
import './menus.css';
import type { SessionConfig, SessionResult, Settings, WorldState } from '../../core/types';
import { GAME_TITLE, GAME_TITLE_ZH } from '../../core/defaults';
import { getLayout } from '../../data/tracks';
import { extractGhost, simulateLapTimes } from '../../race';
import type { MenuHome, SessionContext } from '../../meta/context';
import { applyProgress, type ProgressOutcome } from '../../meta/progression';
import { loadCareer, loadMyTeam, loadProfile, saveSettings, cloneSettings } from '../../meta/save';
import { careerRoster } from '../../meta/career';
import { myTeamDef } from '../../meta/myTeam';
import { classifyQualifying, type QualifyingEntry } from '../../meta/sessionBuilder';
import { achievementDef } from '../../meta/achievements';
import { pickTip } from '../../meta/tips';
import type { PadMenuInput } from '../../input/index';
import { h, setText } from './dom';
import { cancelMinimapQueue } from './minimap';
import { findNext, focusables, focusElement, getAdjuster, isTextField, scrollStep, type NavDirection } from './nav';
import type { Host, Screen, SoundKind, StageRequest } from './screen';
import { showroomCar, showroomCarFor } from './showroom';
import { setWidgetSound } from './widgets';
import { hubScreens } from './hubs';
import { MainMenuScreen } from './screens/mainMenu';
import { TitleScreen } from './screens/title';
import { ResultsScreen } from './screens/results';
import { SettingsScreen } from './screens/settings';
import { markPadEvent } from './keyCapture';
import { ConfirmScreen } from './screens/confirm';
import type { MenuCallbacks, ShowroomCar } from './types';

export type { MenuHome, SessionContext } from '../../meta/context';
export type { MenuCallbacks, ShowroomCar } from './types';

const TRANSITION_MS = 260;
const TOAST_MS = 3600;
const SETTINGS_SAVE_DELAY = 300;

const PAD_KEYS: Record<PadMenuInput, { key: string; code: string }> = {
  up: { key: 'ArrowUp', code: 'ArrowUp' },
  down: { key: 'ArrowDown', code: 'ArrowDown' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  right: { key: 'ArrowRight', code: 'ArrowRight' },
  confirm: { key: 'Enter', code: 'Enter' },
  back: { key: 'Escape', code: 'Escape' },
};

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[menus]', err);
  }
}

export class MenuSystem implements Host {
  settings: Settings;
  private readonly cb: MenuCallbacks;
  private readonly container: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly crumbEl: HTMLElement;
  private readonly hintsEl: HTMLElement;
  private readonly toastsEl: HTMLElement;
  private readonly loadingEl: HTMLElement;
  private readonly loadingText: HTMLElement;
  private readonly loadingTip: HTMLElement;
  private stack: Screen[] = [];
  private visible = false;
  private titleShown = false;
  private overlayClose: (() => void) | null = null;
  private stageKey = '';
  private readonly timers = new Set<number>();
  private settingsTimer = 0;
  private settingsDirty = false;
  private lastResult: { key: string; outcome: ProgressOutcome; qualifying: QualifyingEntry[] | null } | null = null;

  constructor(root: HTMLElement, settings: Settings, cb: MenuCallbacks) {
    this.settings = cloneSettings(settings);
    this.cb = cb;
    setWidgetSound((kind) => this.sound(kind));
    this.crumbEl = h('span', { class: 'nvm-top__crumb' });
    this.hintsEl = h('div', { class: 'nvm-hints' });
    this.toastsEl = h('div', { class: 'nvm-toasts', attrs: { 'aria-live': 'polite' } });
    this.stageEl = h('main', { class: 'nvm-stage' });
    this.loadingText = h('p', { class: 'nvm-loading__text' });
    this.loadingTip = h('p', { class: 'nvm-loading__tip', attrs: { hidden: true } });
    this.loadingEl = h(
      'div',
      { class: 'nvm-loading', attrs: { hidden: true, role: 'status' } },
      h('div', { class: 'nvm-loading__card' }, h('div', { class: 'nvm-loading__bar' }, h('i')), h('span', { class: 'nvm-loading__brand', text: GAME_TITLE }), this.loadingText, this.loadingTip),
    );
    this.container = h(
      'div',
      { class: 'nvm-root', attrs: { hidden: true, 'data-layout': 'showroom' } },
      h('div', { class: 'nvm-bg' }),
      h(
        'header',
        { class: 'nvm-top' },
        h('span', { class: 'nvm-brand' }, h('b', { class: 'nvm-brand__mark', text: 'N' }), h('span', { class: 'nvm-brand__name', text: GAME_TITLE }), h('span', { class: 'nvm-brand__zh', text: GAME_TITLE_ZH })),
        this.crumbEl,
      ),
      this.stageEl,
      h('footer', { class: 'nvm-foot' }, this.hintsEl),
      this.toastsEl,
      this.loadingEl,
    );
    this.container.addEventListener('click', this.onClickSound, true);
    this.container.addEventListener('pointermove', this.onPointerMove);
    // a reload / tab close inside the debounce window must not lose the last settings change
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onPageHide);
    root.append(this.container);
  }

  // ───────────────────────────── public contract ─────────────────────────────

  /** Title / main menu. */
  showMain(): void {
    this.prepareShow();
    if (!this.titleShown) {
      this.titleShown = true;
      this.reset([new TitleScreen(this)]);
    } else {
      this.reset([new MainMenuScreen(this)]);
    }
  }

  /** Return to a hub screen (after quitting a session from the pause menu). */
  showHome(home: MenuHome): void {
    this.prepareShow();
    this.goHome(home);
  }

  hide(): void {
    this.close();
  }

  isOpen(): boolean {
    return this.visible;
  }

  /** Simple full-screen loading card; `tip` shows one random hint (kept while the card stays up). */
  showLoading(message: string, tip = true): void {
    this.open();
    setText(this.loadingText, message);
    if (!tip) this.loadingTip.hidden = true;
    else if (this.loadingEl.hidden || this.loadingTip.hidden) {
      setText(this.loadingTip, pickTip());
      this.loadingTip.hidden = false;
    }
    this.loadingEl.hidden = false;
    // nothing behind the card may be activated again (e.g. Enter on the briefing's start button)
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.container.contains(active)) active.blur();
    if (!this.overlayClose) this.applyStage({ kind: 'none' });
  }

  /**
   * Session finished: show classification, persist progress (career/My Team points & resources, story completion,
   * time-trial PB + ghost via race.extractGhost) and offer next steps (next weekend session / replay / continue).
   * `onReplay` is provided by the App when a replay is available.
   */
  showResults(result: SessionResult, world: WorldState, ctx: SessionContext, onReplay: (() => void) | null): void {
    this.prepareShow();
    this.titleShown = true;
    const key = `${result.mode}|${result.kind}|${result.layoutId}|${world.config.seed}|${world.tick}|${world.time}`;
    let entry = this.lastResult && this.lastResult.key === key ? this.lastResult : null;
    let fresh = false;
    if (!entry) {
      const qualifying = result.kind === 'qualifying' ? this.classifyQualifying(result, world, ctx) : null;
      entry = { key, outcome: this.applyProgress(result, world, ctx, qualifying), qualifying };
      this.lastResult = entry;
      fresh = true;
    }
    const replay = onReplay
      ? () => {
          this.close();
          safe(onReplay);
        }
      : null;
    this.reset([new ResultsScreen(this, { result, world, ctx, onReplay: replay, outcome: entry.outcome, qualifying: entry.qualifying })]);
    if (fresh) {
      for (const id of entry.outcome.newAchievements) this.toast(`成就解鎖：${achievementDef(id).title}`, 'good');
    }
  }

  /** Settings screen as an overlay above the paused race; `onClose` returns control to the pause menu. */
  openSettingsOverlay(onClose: () => void): void {
    this.loadingEl.hidden = true;
    this.overlayClose = onClose;
    this.container.classList.add('is-overlay');
    this.open();
    this.reset([new SettingsScreen(this, () => this.closeOverlay())]);
  }

  /**
   * Gamepad navigation while the menus are open: D-pad = arrow keys, A = Enter, B = Esc, routed through the same
   * key handler as the keyboard (so screens' onKey hooks and focus rules behave identically). Returns whether the
   * input was consumed; the loading card swallows nothing.
   */
  navigate(input: PadMenuInput): boolean {
    if (!this.visible || !this.loadingEl.hidden) return false;
    const key = PAD_KEYS[input];
    const e = new KeyboardEvent('keydown', { key: key.key, code: key.code, cancelable: true });
    markPadEvent(e);
    this.onKeyDown(e);
    return true;
  }

  /** Remove the menu DOM and every listener / timer. */
  destroy(): void {
    this.close();
    this.flushSettings();
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
    cancelMinimapQueue();
    for (const s of this.stack) safe(() => s.destroy());
    this.stack = [];
    this.container.removeEventListener('click', this.onClickSound, true);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onPageHide);
    this.container.remove();
  }

  // ───────────────────────────── Host services ─────────────────────────────

  push(screen: Screen): void {
    const prev = this.top();
    if (prev) {
      prev.lastFocus = this.focusedIn(prev);
      safe(() => prev.onLeave());
      if (screen.modal) prev.el.inert = true;
      else this.hideScreen(prev, 'fwd');
    }
    this.stack.push(screen);
    this.showScreen(screen, 'fwd');
  }

  pop(): void {
    if (this.stack.length <= 1) return;
    const cur = this.stack.pop() as Screen;
    safe(() => cur.onLeave());
    this.discardScreen(cur, 'back');
    const prev = this.top();
    if (!prev) return;
    if (cur.modal) {
      prev.el.inert = false;
      this.activate(prev);
    } else {
      this.showScreen(prev, 'back');
    }
  }

  replace(screen: Screen): void {
    const cur = this.stack.pop();
    if (cur) {
      safe(() => cur.onLeave());
      this.discardScreen(cur, 'fwd');
    }
    const below = this.top();
    if (below && !screen.modal && below.el.isConnected) this.hideScreen(below, 'fwd');
    this.stack.push(screen);
    this.showScreen(screen, 'fwd');
  }

  reset(screens: Screen[]): void {
    const old = this.stack;
    const top = old[old.length - 1];
    if (top) safe(() => top.onLeave());
    this.stack = [];
    for (const s of old) {
      if (s === top) this.discardScreen(s, 'fwd');
      else {
        s.el.remove();
        safe(() => s.destroy());
      }
    }
    this.stack = [...screens];
    const next = this.top();
    if (next) this.showScreen(next, 'fwd');
  }

  resultsClosed(): void {
    safe(() => this.cb.resultsClosed?.());
  }

  goHome(home: MenuHome): void {
    this.titleShown = true;
    this.reset([new MainMenuScreen(this), ...hubScreens(this, home)]);
  }

  refreshStage(): void {
    if (this.overlayClose || !this.visible) return;
    let i = this.stack.length - 1;
    while (i > 0 && this.stack[i]?.modal) i--;
    const screen = this.stack[i];
    if (screen) this.applyStage(screen.stage());
  }

  sound(kind: SoundKind): void {
    safe(() => this.cb.uiSound(kind));
  }

  toast(text: string, tone: 'info' | 'good' | 'bad' = 'info'): void {
    const el = h('div', { class: `nvm-toast nvm-toast--${tone}`, text });
    this.toastsEl.append(el);
    while (this.toastsEl.childElementCount > 4) this.toastsEl.firstElementChild?.remove();
    this.later(() => el.remove(), TOAST_MS);
  }

  confirm(title: string, text: string, onYes: () => void, yesLabel = '確定'): void {
    this.push(new ConfirmScreen(this, title, text, onYes, yesLabel));
  }

  startSession(config: SessionConfig, ctx: SessionContext): void {
    this.showLoading('載入賽道與賽車中…');
    this.later(() => {
      try {
        this.cb.startSession(config, ctx);
      } catch (err) {
        console.error('[menus] startSession failed', err);
        this.loadingEl.hidden = true;
        this.sound('error');
        this.toast('無法開始節次，請稍後再試', 'bad');
      }
    }, 60);
  }

  updateSettings(next: Settings): void {
    this.settings = cloneSettings(next);
    safe(() => this.cb.applySettings(cloneSettings(next)));
    this.settingsDirty = true;
    if (this.settingsTimer) window.clearTimeout(this.settingsTimer);
    this.settingsTimer = window.setTimeout(() => {
      this.settingsTimer = 0;
      this.flushSettings();
    }, SETTINGS_SAVE_DELAY);
  }

  toggleFullscreen(): void {
    safe(() => this.cb.toggleFullscreen());
  }

  featuredCar(): ShowroomCar {
    const team = loadMyTeam();
    if (team) return showroomCar(myTeamDef(team), team.driver);
    const career = loadCareer();
    if (career) {
      const { roster } = careerRoster(career);
      return showroomCarFor(roster, 'player', career.teamId);
    }
    const gp = loadProfile().gp;
    return showroomCarFor(null, gp.driverId, gp.teamId);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private top(): Screen | undefined {
    return this.stack[this.stack.length - 1];
  }

  private later(fn: () => void, ms: number): void {
    const t = window.setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private prepareShow(): void {
    this.loadingEl.hidden = true;
    if (this.overlayClose) {
      this.overlayClose = null;
      this.container.classList.remove('is-overlay');
    }
    this.open();
  }

  private open(): void {
    if (this.visible) return;
    this.visible = true;
    this.container.hidden = false;
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  private close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.container.hidden = true;
    this.loadingEl.hidden = true;
    this.stageKey = '';
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.flushSettings();
  }

  private closeOverlay(): void {
    const done = this.overlayClose;
    this.overlayClose = null;
    this.container.classList.remove('is-overlay');
    this.close();
    if (done) safe(done);
  }

  private flushSettings(): void {
    if (this.settingsTimer) {
      window.clearTimeout(this.settingsTimer);
      this.settingsTimer = 0;
    }
    if (!this.settingsDirty) return;
    this.settingsDirty = false;
    saveSettings(this.settings);
  }

  private applyStage(req: StageRequest): void {
    const key = JSON.stringify(req);
    if (key === this.stageKey) return;
    const wasPodium = this.stageKey.startsWith('{"kind":"podium"');
    this.stageKey = key;
    if (wasPodium && req.kind !== 'podium') safe(() => this.cb.podium(null));
    if (req.kind === 'car') safe(() => this.cb.showroom(req.car));
    else if (req.kind === 'podium') safe(() => this.cb.podium(req.cars));
    else safe(() => this.cb.showroom(null));
  }

  private showScreen(screen: Screen, dir: 'fwd' | 'back'): void {
    const el = screen.el;
    el.classList.remove('is-leave-fwd', 'is-leave-back', 'is-enter-fwd', 'is-enter-back');
    el.inert = false;
    if (!el.isConnected) this.stageEl.append(el);
    // restart the enter animation
    void el.offsetWidth;
    el.classList.add(dir === 'fwd' ? 'is-enter-fwd' : 'is-enter-back');
    this.later(() => el.classList.remove('is-enter-fwd', 'is-enter-back'), TRANSITION_MS);
    this.activate(screen);
  }

  private hideScreen(screen: Screen, dir: 'fwd' | 'back'): void {
    const el = screen.el;
    el.inert = true;
    el.classList.remove('is-enter-fwd', 'is-enter-back');
    el.classList.add(dir === 'fwd' ? 'is-leave-fwd' : 'is-leave-back');
    this.later(() => {
      el.classList.remove('is-leave-fwd', 'is-leave-back');
      if (this.top() !== screen) el.remove();
    }, TRANSITION_MS);
  }

  private discardScreen(screen: Screen, dir: 'fwd' | 'back'): void {
    safe(() => screen.destroy());
    const el = screen.el;
    el.inert = true;
    el.classList.remove('is-enter-fwd', 'is-enter-back');
    el.classList.add(dir === 'fwd' ? 'is-leave-fwd' : 'is-leave-back');
    this.later(() => el.remove(), TRANSITION_MS);
  }

  private activate(screen: Screen): void {
    let base = screen;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i];
      if (s && !s.modal) {
        base = s;
        break;
      }
    }
    this.container.dataset.layout = base.layout;
    setText(this.crumbEl, base.title);
    const hints = screen.hints() ?? ['↑↓←→ 選擇', 'Enter 確認', 'Esc 返回'];
    this.hintsEl.replaceChildren(...hints.map((t) => h('span', { class: 'nvm-hint', text: t })));
    this.refreshStage();
    safe(() => screen.onEnter());
    const target =
      (screen.lastFocus && screen.el.contains(screen.lastFocus) && focusables(screen.el).includes(screen.lastFocus) ? screen.lastFocus : null) ??
      screen.initialFocus() ??
      focusables(screen.el)[0] ??
      null;
    if (target) focusElement(target);
    else if (document.activeElement instanceof HTMLElement && !screen.el.contains(document.activeElement)) document.activeElement.blur();
  }

  private focusedIn(screen: Screen): HTMLElement | null {
    const a = document.activeElement;
    return a instanceof HTMLElement && screen.el.contains(a) ? a : null;
  }

  private move(dir: NavDirection): void {
    const screen = this.top();
    if (!screen) return;
    const next = findNext(screen.el, this.focusedIn(screen), dir);
    if (next && next !== document.activeElement) {
      focusElement(next);
      this.sound('move');
    }
  }

  private back(): void {
    const screen = this.top();
    if (!screen) return;
    let handled = false;
    try {
      handled = screen.onBack();
    } catch (err) {
      console.error('[menus]', err);
      handled = true;
    }
    if (handled) return;
    if (this.stack.length > 1) {
      this.sound('back');
      this.pop();
    } else if (this.overlayClose) {
      this.sound('back');
      this.closeOverlay();
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.visible) return;
    if (this.overlayClose) e.stopPropagation();
    if (e.isComposing) return;
    const consume = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    // loading card: no navigation (keys pass through untouched to whoever needs them next)
    if (!this.loadingEl.hidden) return;
    const screen = this.top();
    if (!screen) return;
    let handled = false;
    try {
      handled = screen.onKey(e);
    } catch (err) {
      console.error('[menus]', err);
    }
    if (handled) {
      consume();
      return;
    }
    const active = document.activeElement;
    const typing = isTextField(active);
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        consume();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        if (active instanceof HTMLElement && active.dataset.scroll !== undefined && scrollStep(active, dir)) return;
        this.move(dir < 0 ? 'up' : 'down');
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (typing) return;
        consume();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const adjust = active instanceof HTMLElement && screen.el.contains(active) ? getAdjuster(active) : undefined;
        if (adjust) adjust(dir, e.shiftKey);
        else this.move(dir < 0 ? 'left' : 'right');
        return;
      }
      case 'Enter':
      case ' ': {
        if (typing) {
          if (e.key === 'Enter') {
            consume();
            this.move('down');
          }
          return;
        }
        consume();
        if (e.repeat) return;
        if (active instanceof HTMLElement && screen.el.contains(active)) active.click();
        else {
          const first = focusables(screen.el)[0];
          if (first) focusElement(first);
        }
        return;
      }
      case 'Escape':
        consume();
        if (!e.repeat) this.back();
        return;
      case 'Backspace':
        if (typing) return;
        consume();
        if (!e.repeat) this.back();
        return;
      default:
        if (e.code === 'KeyF' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
          consume();
          this.toggleFullscreen();
        }
    }
  };

  private readonly onPageHide = (e: Event): void => {
    if (e.type === 'pagehide' || document.visibilityState === 'hidden') this.flushSettings();
  };

  private readonly onClickSound = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-sound]') : null;
    if (!target || (target instanceof HTMLButtonElement && target.disabled)) return;
    const kind = target.dataset.sound;
    if (kind === 'confirm' || kind === 'back' || kind === 'move' || kind === 'error') this.sound(kind);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    const screen = this.top();
    if (!screen || isTextField(document.activeElement)) return;
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('button:not([disabled]), [tabindex="0"]') : null;
    if (target && target !== document.activeElement && screen.el.contains(target)) target.focus({ preventScroll: true });
  };

  private classifyQualifying(result: SessionResult, world: WorldState, ctx: SessionContext): QualifyingEntry[] | null {
    try {
      const roster = ctx.plan?.request.roster ?? { teams: world.config.teams, drivers: world.config.drivers };
      let simulated: Record<string, number> = {};
      try {
        simulated = simulateLapTimes(world.config, getLayout(world.config.layoutId));
      } catch (err) {
        console.error('[menus] simulateLapTimes failed', err);
      }
      return classifyQualifying(result, simulated, roster);
    } catch (err) {
      console.error('[menus]', err);
      return null;
    }
  }

  private applyProgress(result: SessionResult, world: WorldState, ctx: SessionContext, qualifying: QualifyingEntry[] | null): ProgressOutcome {
    const player = world.cars.find((c) => c.playerIndex === 0);
    let ghost = null;
    if (result.kind === 'timeTrial' && result.mode === 'timeTrial' && player) {
      try {
        ghost = extractGhost(world, player.id);
      } catch (err) {
        console.error('[menus] extractGhost failed', err);
      }
    }
    try {
      return applyProgress({
        result,
        config: world.config,
        ctx,
        trackLimitWarnings: player ? player.penalties.trackLimitWarnings : 0,
        ghost,
        qualifyingOrder: qualifying ? qualifying.map((q) => q.driverId) : null,
        date: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[menus] progress failed', err);
      return { notes: [], newAchievements: [], personalBest: false, leaderboardRank: null, objectiveMet: result.objectiveMet, seasonSummary: null };
    }
  }
}
