/**
 * Global error overlay: uncaught errors and unhandled promise rejections (and errors reported by the App loop)
 * are shown in a visible panel with message + stack. Identical messages are collapsed with a counter; a fatal
 * notice (e.g. WebGL unsupported) replaces the panel content and offers a reload.
 */

const MAX_ENTRIES = 6;
const MAX_STACK_CHARS = 4000;
/** Benign browser noise that must not alarm the player. */
const IGNORED = [/ResizeObserver loop/i];

interface Entry {
  key: string;
  count: number;
  countEl: HTMLElement;
}

let panel: HTMLElement | null = null;
let list: HTMLElement | null = null;
const entries: Entry[] = [];
let installed = false;

function describe(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) {
    const stack = typeof err.stack === 'string' ? err.stack : '';
    return { message: `${err.name}: ${err.message}`, stack };
  }
  if (typeof err === 'string') return { message: err, stack: '' };
  try {
    return { message: JSON.stringify(err) ?? String(err), stack: '' };
  } catch {
    return { message: String(err), stack: '' };
  }
}

function ensurePanel(): { panel: HTMLElement; list: HTMLElement } | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (panel && list && panel.isConnected) return { panel, list };
  const root = document.createElement('section');
  root.className = 'nv-error';
  root.setAttribute('role', 'alert');
  const head = document.createElement('header');
  head.className = 'nv-error__head';
  const title = document.createElement('h2');
  title.className = 'nv-error__title';
  title.textContent = '發生未預期的錯誤';
  const actions = document.createElement('div');
  actions.className = 'nv-error__actions';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'nv-error__btn';
  reload.textContent = '重新載入';
  reload.addEventListener('click', () => window.location.reload());
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'nv-error__btn';
  close.textContent = '關閉';
  close.addEventListener('click', () => {
    root.hidden = true;
  });
  actions.append(reload, close);
  head.append(title, actions);
  const hint = document.createElement('p');
  hint.className = 'nv-error__hint';
  hint.textContent = '遊戲仍會嘗試繼續執行；若畫面異常，請重新載入頁面。';
  const body = document.createElement('div');
  body.className = 'nv-error__list';
  root.append(head, hint, body);
  document.body.append(root);
  panel = root;
  list = body;
  return { panel: root, list: body };
}

/** Show an error in the overlay (deduplicated by message). */
export function reportError(err: unknown, context = ''): void {
  const { message, stack } = describe(err);
  if (IGNORED.some((re) => re.test(message))) return;
  console.error(context ? `[${context}]` : '[app]', err);
  const ui = ensurePanel();
  if (!ui) return;
  ui.panel.hidden = false;
  const key = `${context}|${message}`;
  const existing = entries.find((e) => e.key === key);
  if (existing) {
    existing.count++;
    existing.countEl.textContent = `×${existing.count}`;
    return;
  }
  const item = document.createElement('article');
  item.className = 'nv-error__item';
  const msg = document.createElement('p');
  msg.className = 'nv-error__msg';
  msg.textContent = context ? `［${context}］${message}` : message;
  const count = document.createElement('span');
  count.className = 'nv-error__count';
  msg.append(' ', count);
  item.append(msg);
  if (stack) {
    const pre = document.createElement('pre');
    pre.className = 'nv-error__stack';
    pre.textContent = stack.length > MAX_STACK_CHARS ? `${stack.slice(0, MAX_STACK_CHARS)}…` : stack;
    item.append(pre);
  }
  ui.list.append(item);
  entries.push({ key, count: 1, countEl: count });
  while (entries.length > MAX_ENTRIES) {
    entries.shift();
    ui.list.firstElementChild?.remove();
  }
}

/** Replace everything with a blocking notice (startup failures such as missing WebGL 2). */
export function showFatal(title: string, detail: string): void {
  const ui = ensurePanel();
  if (!ui) return;
  ui.panel.hidden = false;
  ui.panel.classList.add('nv-error--fatal');
  const heading = ui.panel.querySelector('.nv-error__title');
  if (heading) heading.textContent = title;
  const hint = ui.panel.querySelector('.nv-error__hint');
  if (hint) hint.textContent = detail;
  ui.panel.querySelector('.nv-error__btn:last-child')?.remove();
}

/** Listen for uncaught errors and unhandled rejections (idempotent). */
export function installErrorOverlay(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e: ErrorEvent) => {
    // resource load errors (no error object, no message) are not script failures
    if (!e.error && !e.message) return;
    reportError(e.error ?? e.message, '未捕捉的錯誤');
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    reportError(e.reason, '未處理的 Promise');
  });
}
