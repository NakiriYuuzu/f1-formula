/**
 * Screen framework: the Host services a screen can use (stack navigation, stage/showroom, sounds, toasts,
 * confirm dialogs, session start, settings) and the Screen base class with lifecycle hooks.
 */
import type { SessionConfig, Settings } from '../../core/types';
import type { MenuHome, SessionContext } from '../../meta/context';
import { h } from './dom';
import type { ShowroomCar } from './types';

/** What the 3D background should show while a screen is active. */
export type StageRequest = { kind: 'none' } | { kind: 'car'; car: ShowroomCar } | { kind: 'podium'; cars: ShowroomCar[] };

export type SoundKind = 'move' | 'confirm' | 'back' | 'error';

export interface Host {
  readonly settings: Settings;
  push(screen: Screen): void;
  pop(): void;
  replace(screen: Screen): void;
  /** Replace the whole stack (last = active). */
  reset(screens: Screen[]): void;
  /** Stack = main menu + the hub of a mode. */
  goHome(home: MenuHome): void;
  /** Re-read the active screen's stage() (call after its car changed). */
  refreshStage(): void;
  sound(kind: SoundKind): void;
  toast(text: string, tone?: 'info' | 'good' | 'bad'): void;
  confirm(title: string, text: string, onYes: () => void, yesLabel?: string): void;
  startSession(config: SessionConfig, ctx: SessionContext): void;
  /** Apply + persist new settings. */
  updateSettings(next: Settings): void;
  toggleFullscreen(): void;
  /** Results screen is being left for the menus (not for a replay or the next session). */
  resultsClosed(): void;
  /** The car shown on title / main menu. */
  featuredCar(): ShowroomCar;
}

export interface ScreenOptions {
  /** 'showroom': transparent background, menu column on the left; 'panel': opaque full-width layout */
  layout: 'showroom' | 'panel';
  /** modal screens float above the previous screen without hiding it */
  modal?: boolean;
  className?: string;
}

export abstract class Screen {
  readonly el: HTMLElement;
  readonly layout: 'showroom' | 'panel';
  readonly modal: boolean;
  /** focus to restore when the screen becomes active again */
  lastFocus: HTMLElement | null = null;
  abstract readonly title: string;

  protected constructor(
    protected readonly host: Host,
    opts: ScreenOptions,
  ) {
    this.layout = opts.layout;
    this.modal = opts.modal === true;
    this.el = h('section', { class: `nvm-screen nvm-screen--${opts.layout}${opts.modal ? ' nvm-screen--modal' : ''} ${opts.className ?? ''}` });
  }

  stage(): StageRequest {
    return { kind: 'none' };
  }

  /** Footer key hints (null = defaults). */
  hints(): string[] | null {
    return null;
  }

  /** Element focused when the screen is first shown (null = first focusable). */
  initialFocus(): HTMLElement | null {
    return null;
  }

  /** Became the active screen (pushed or uncovered). */
  onEnter(): void {}

  /** Covered by another screen or removed. */
  onLeave(): void {}

  /** Esc / Backspace. Return true when handled; otherwise the host pops the screen. */
  onBack(): boolean {
    return false;
  }

  /** Raw keydown before default navigation. Return true to consume the event. */
  onKey(_e: KeyboardEvent): boolean {
    return false;
  }

  /** Removed from the stack for good: release timers / listeners. */
  destroy(): void {}
}
