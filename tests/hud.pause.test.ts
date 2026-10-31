/**
 * Pause menu on a minimal fake DOM: every item is a button that holds focus when selected, destructive actions open a
 * confirm dialog (取消 first) instead of arming a second press, and Backspace / the pause key / B step back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PauseMenu, type PauseItem } from '../src/ui/hud/pauseMenu';
import { pauseKeyOutcome } from '../src/ui/hud/labels';

type Listener = (e: { detail: number; target: unknown; preventDefault(): void; stopPropagation(): void }) => void;

let focused: FakeEl | null = null;

class FakeEl {
  className = '';
  textContent = '';
  type = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  classes = new Set<string>();
  listeners = new Map<string, Listener[]>();
  classList = {
    toggle: (c: string, on?: boolean): void => {
      if (on ?? !this.classes.has(c)) this.classes.add(c);
      else this.classes.delete(c);
    },
    add: (c: string): void => void this.classes.add(c),
    remove: (c: string): void => void this.classes.delete(c),
  };
  constructor(readonly tag: string) {}
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  replaceChildren(): void {
    this.children = [];
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  focus(): void {
    focused = this;
  }
  fire(type: string, detail = 1): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ detail, target: this, preventDefault: () => undefined, stopPropagation: () => undefined });
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.find(pred))];
  }
}

const g = globalThis as unknown as { document?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.document;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
});
afterAll(() => {
  g.document = saved;
});

const key = (code: string, repeat = false): KeyboardEvent => ({ code, repeat }) as unknown as KeyboardEvent;

function make() {
  const log: string[] = [];
  let camera = 'chase';
  const items: PauseItem[] = [
    { kind: 'action', id: 'resume', label: '繼續', run: () => log.push('resume') },
    {
      kind: 'action',
      id: 'restart',
      label: '重新開始',
      confirm: { title: '重新開始？', text: '本節進度會清除。', ok: '重新開始' },
      run: () => log.push('restart'),
    },
    {
      kind: 'cycle',
      id: 'camera',
      label: '鏡頭',
      options: [
        { value: 'chase', label: '追焦' },
        { value: 'cockpit', label: '座艙' },
      ],
      get: () => camera,
      set: (v) => (camera = v),
    },
    { kind: 'action', id: 'quit', label: '離開至選單', confirm: { title: '離開至選單？', text: '進度不會保留。', ok: '離開至選單' }, run: () => log.push('quit') },
  ];
  const root = new FakeEl('div');
  const menu = new PauseMenu(root as unknown as Element, () => log.push('back'));
  menu.open(items, '正賽');
  const buttons = root.find((e) => e.className === 'nvh-pi');
  const dialog = root.find((e) => e.className.split(' ')[0] === 'nvh-confirm')[0];
  const dialogButtons = root.find((e) => e.className === 'nvh-cbtn');
  const selected = (): number => buttons.findIndex((b) => b.attrs.get('data-selected') === '1');
  return { menu, log, root, buttons, dialog, dialogButtons, selected, camera: () => camera };
}

describe('pause menu items', () => {
  test('every item is a button, the first is selected and holds focus', () => {
    const { buttons, selected } = make();
    expect(buttons.length).toBe(4);
    expect(buttons.every((b) => b.tag === 'button' && b.type === 'button')).toBe(true);
    expect(selected()).toBe(0);
    expect(focused).toBe(buttons[0]);
  });

  test('up / down move the selection and the focus, and wrap', () => {
    const { menu, buttons, selected } = make();
    menu.handleKey(key('ArrowDown'));
    expect(selected()).toBe(1);
    expect(focused).toBe(buttons[1]);
    menu.handleKey(key('ArrowUp'));
    menu.handleKey(key('ArrowUp'));
    expect(selected()).toBe(3);
    expect(focused).toBe(buttons[3]);
    menu.navigate('down');
    expect(selected()).toBe(0);
  });

  test('Enter and Space activate a plain action; the pad does the same through activate()', () => {
    const { menu, log } = make();
    expect(menu.handleKey(key('Enter'))).toBe(true);
    expect(menu.handleKey(key('Space'))).toBe(true);
    menu.activate();
    expect(log).toEqual(['resume', 'resume', 'resume']);
  });

  test('a held key activates once', () => {
    const { menu, log } = make();
    menu.handleKey(key('Enter'));
    menu.handleKey(key('Enter', true));
    expect(log).toEqual(['resume']);
  });

  test('left / right change a cycle value, Enter steps it, and neither runs anything', () => {
    const { menu, log, camera } = make();
    menu.navigate('down');
    menu.navigate('down');
    menu.handleKey(key('ArrowRight'));
    expect(camera()).toBe('cockpit');
    menu.handleKey(key('ArrowLeft'));
    expect(camera()).toBe('chase');
    menu.handleKey(key('Enter'));
    expect(camera()).toBe('cockpit');
    expect(log).toEqual([]);
  });

  test('clicking an item activates it; the arrows inside a cycle item only change the value', () => {
    const { menu, buttons, log, camera } = make();
    buttons[0].fire('click');
    expect(log).toEqual(['resume']);
    buttons[2].find((e) => e.textContent === '›')[0].fire('click');
    expect(camera()).toBe('cockpit');
    expect(menu.isOpen()).toBe(true);
  });

  test('hovering an item selects it', () => {
    const { buttons, selected } = make();
    buttons[3].fire('mouseenter');
    expect(selected()).toBe(3);
    expect(focused).toBe(buttons[3]);
  });

  test('destructive items are marked, plain ones are not', () => {
    const { buttons } = make();
    expect(buttons.map((b) => b.dataset.danger)).toEqual([undefined, '1', undefined, '1']);
  });

  test('the hint names Backspace and B as resume keys', () => {
    const { root } = make();
    const hint = root.find((e) => e.className === 'nvh-pause-hint')[0].textContent;
    expect(hint).toContain('Backspace');
    expect(hint).toContain('B');
  });
});

describe('pause menu confirm dialog', () => {
  function openRestart() {
    const m = make();
    m.menu.navigate('down');
    m.menu.handleKey(key('Enter'));
    return m;
  }

  test('a destructive action opens the dialog instead of running, with 取消 focused', () => {
    const { menu, log, dialog, dialogButtons, root } = openRestart();
    expect(log).toEqual([]);
    expect(menu.isConfirming()).toBe(true);
    expect(dialog.classes.has('nvh-hidden')).toBe(false);
    expect(root.find((e) => e.className === 'nvh-confirm-title')[0].textContent).toBe('重新開始？');
    expect(root.find((e) => e.className === 'nvh-confirm-text')[0].textContent).toBe('本節進度會清除。');
    expect(dialogButtons.map((b) => b.textContent)).toEqual(['取消', '重新開始']);
    expect(focused).toBe(dialogButtons[0]);
    expect(dialogButtons[1].dataset.danger).toBe('1');
  });

  test('the pause list is out of reach while the dialog is up', () => {
    const { root } = openRestart();
    expect(root.find((e) => e.className === 'nvh-pause-list')[0].attrs.has('inert')).toBe(true);
  });

  test('Enter on the default 取消 closes the dialog and runs nothing', () => {
    const { menu, log, dialog, buttons } = openRestart();
    menu.handleKey(key('Enter'));
    expect(log).toEqual([]);
    expect(menu.isConfirming()).toBe(false);
    expect(dialog.classes.has('nvh-hidden')).toBe(true);
    expect(focused).toBe(buttons[1]);
  });

  test('right then Enter confirms: the action runs and the dialog closes', () => {
    const { menu, log, dialogButtons } = openRestart();
    menu.handleKey(key('ArrowRight'));
    expect(focused).toBe(dialogButtons[1]);
    menu.handleKey(key('Enter'));
    expect(log).toEqual(['restart']);
    expect(menu.isConfirming()).toBe(false);
  });

  test('focus moved by Tab decides what Enter does, never a stale selection', () => {
    const toCancel = openRestart();
    toCancel.menu.handleKey(key('ArrowRight'));
    toCancel.dialogButtons[0].focus();
    toCancel.dialogButtons[0].fire('focus');
    toCancel.menu.handleKey(key('Enter'));
    expect(toCancel.log).toEqual([]);
    expect(toCancel.menu.isConfirming()).toBe(false);

    const toOk = openRestart();
    toOk.dialogButtons[1].focus();
    toOk.dialogButtons[1].fire('focus');
    toOk.menu.handleKey(key('Enter'));
    expect(toOk.log).toEqual(['restart']);
  });

  test('pad: D-pad moves between the buttons and A activates', () => {
    const { menu, log, dialogButtons } = openRestart();
    menu.navigate('right');
    expect(focused).toBe(dialogButtons[1]);
    menu.navigate('left');
    expect(focused).toBe(dialogButtons[0]);
    menu.navigate('down');
    menu.activate();
    expect(log).toEqual(['restart']);
  });

  test('Backspace cancels the dialog without resuming; with no dialog it resumes', () => {
    const { menu, log } = openRestart();
    expect(menu.handleKey(key('Backspace'))).toBe(true);
    expect(menu.isConfirming()).toBe(false);
    expect(log).toEqual([]);
    menu.handleKey(key('Backspace'));
    expect(log).toEqual(['back']);
  });

  test('closeConfirm() (pause key / B) cancels an open dialog and reports whether there was one', () => {
    const { menu } = openRestart();
    expect(pauseKeyOutcome(true, () => menu.closeConfirm())).toBe('stay');
    expect(pauseKeyOutcome(true, () => menu.closeConfirm())).toBe('resume');
  });

  test('mouse: clicking a dialog button acts; the dimmed backdrop cancels', () => {
    const a = openRestart();
    a.dialogButtons[1].fire('click');
    expect(a.log).toEqual(['restart']);
    const b = openRestart();
    b.dialog.fire('click');
    expect(b.menu.isConfirming()).toBe(false);
    expect(b.log).toEqual([]);
  });

  test('the click a Space key-up echoes onto the freshly focused 取消 is ignored; a real click is not', () => {
    const { menu, dialogButtons } = make();
    menu.navigate('down');
    menu.handleKey(key('Space'));
    dialogButtons[0].fire('click', 0);
    expect(menu.isConfirming()).toBe(true);
    dialogButtons[0].fire('click', 1);
    expect(menu.isConfirming()).toBe(false);
  });

  test('every destructive item gets its own dialog', () => {
    const { menu, log, root, dialogButtons } = make();
    menu.navigate('up');
    menu.handleKey(key('Enter'));
    expect(root.find((e) => e.className === 'nvh-confirm-title')[0].textContent).toBe('離開至選單？');
    expect(dialogButtons[1].textContent).toBe('離開至選單');
    menu.navigate('right');
    menu.activate();
    expect(log).toEqual(['quit']);
  });

  test('suspending (settings overlay) or closing drops the dialog', () => {
    const a = openRestart();
    a.menu.suspend(true);
    expect(a.menu.isConfirming()).toBe(false);
    expect(a.menu.isOpen()).toBe(false);
    a.menu.suspend(false);
    expect(a.menu.isOpen()).toBe(true);
    const b = openRestart();
    b.menu.close();
    expect(b.menu.isConfirming()).toBe(false);
    expect(b.menu.handleKey(key('Enter'))).toBe(false);
  });
});
