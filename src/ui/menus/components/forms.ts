/**
 * Driver identity form (name, abbreviation, number, nationality, helmet colours) and livery editor fields
 * (three colours + pattern), shared by the Driver Career and My Team wizards.
 */
import type { Livery, LiveryPattern } from '../../../core/types';
import { identityProblems } from '../../../meta/career';
import type { PlayerIdentity } from '../../../meta/roster';
import { h, setText } from '../dom';
import { NATIONALITIES } from '../labels';
import { colorPicker, cycler, panel, slider, textField } from '../widgets';

export interface IdentityForm {
  el: HTMLElement;
  first: HTMLElement;
  problems(): string[];
}

/** Uppercase A–Z only. */
export const lettersOnly = (v: string): string => v.toUpperCase().replace(/[^A-Z]/g, '');

export function suggestAbbr(lastName: string): string {
  const letters = lettersOnly(lastName);
  return letters.length >= 3 ? letters.slice(0, 3) : '';
}

export function identityForm(
  initial: PlayerIdentity,
  takenNumbers: () => ReadonlySet<number>,
  onChange: (id: PlayerIdentity) => void,
  opts: { number: boolean } = { number: true },
): IdentityForm {
  let value: PlayerIdentity = { ...initial, helmet: { ...initial.helmet } };
  let abbrTouched = initial.abbr.length === 3;
  const errors = h('div', { class: 'nvm-form__errors', attrs: { role: 'alert' } });
  const problems = (): string[] => identityProblems(value, opts.number ? takenNumbers() : new Set<number>());
  const update = (patch: Partial<PlayerIdentity>): void => {
    value = { ...value, ...patch };
    const list = problems();
    setText(errors, list.join('・'));
    errors.classList.toggle('is-visible', list.length > 0);
    onChange({ ...value, helmet: { ...value.helmet } });
  };
  const abbr = textField({
    label: '縮寫（3 個英文字母）',
    value: value.abbr,
    maxLength: 3,
    transform: lettersOnly,
    onInput: (v) => {
      abbrTouched = true;
      update({ abbr: v });
    },
  });
  const first = textField({ label: '名字', value: value.firstName, maxLength: 16, placeholder: '例：Kai', onInput: (v) => update({ firstName: v.trim() }) });
  const last = textField({
    label: '姓氏',
    value: value.lastName,
    maxLength: 16,
    placeholder: '例：Lin',
    onInput: (v) => {
      const patch: Partial<PlayerIdentity> = { lastName: v.trim() };
      if (!abbrTouched) {
        const s = suggestAbbr(v);
        if (s) {
          abbr.set(s);
          patch.abbr = s;
        }
      }
      update(patch);
    },
  });
  const number = opts.number
    ? slider({
        label: '車號',
        min: 1,
        max: 99,
        step: 1,
        value: value.number,
        format: (n) => (takenNumbers().has(n) ? `#${n}（已被使用）` : `#${n}`),
        onChange: (n) => update({ number: n }),
      }).el
    : null;
  const nationality = cycler<string>({
    label: '國籍',
    options: NATIONALITIES.map((n) => ({ value: n.code, label: `${n.label}（${n.code}）` })),
    value: value.nationality,
    onChange: (code) => update({ nationality: code }),
  });
  const helmet = (key: keyof Pick<Livery, 'primary' | 'secondary' | 'accent'>, label: string): HTMLElement =>
    colorPicker(label, value.helmet[key], (c) => update({ helmet: { ...value.helmet, [key]: c } })).el;
  const el = panel(
    '車手資料',
    first.el,
    last.el,
    abbr.el,
    number,
    nationality.el,
    helmet('primary', '頭盔主色'),
    helmet('secondary', '頭盔副色'),
    helmet('accent', '頭盔點綴色'),
    errors,
  );
  const initialProblems = problems();
  if (initialProblems.length > 0 && (value.firstName || value.lastName)) {
    setText(errors, initialProblems.join('・'));
    errors.classList.add('is-visible');
  }
  return { el, first: first.input, problems };
}

export const PATTERN_LABEL: Record<LiveryPattern, string> = {
  classic: '經典',
  stripe: '中央條紋',
  chevron: '箭羽',
  split: '前後分色',
  fade: '漸層',
};

/** Livery colours + pattern. */
export function liveryFields(initial: Livery, onChange: (l: Livery) => void): { el: HTMLElement; first: HTMLElement } {
  let value: Livery = { ...initial, pattern: initial.pattern ?? 'classic' };
  const set = (patch: Partial<Livery>): void => {
    value = { ...value, ...patch };
    onChange({ ...value });
  };
  const primary = colorPicker('主色', value.primary, (c) => set({ primary: c }));
  const el = panel(
    '塗裝',
    primary.el,
    colorPicker('副色', value.secondary, (c) => set({ secondary: c })).el,
    colorPicker('點綴色', value.accent, (c) => set({ accent: c })).el,
    cycler<LiveryPattern>({
      label: '圖樣',
      options: (Object.keys(PATTERN_LABEL) as LiveryPattern[]).map((p) => ({ value: p, label: PATTERN_LABEL[p] })),
      value: value.pattern ?? 'classic',
      onChange: (p) => set({ pattern: p }),
    }).el,
    h('p', { class: 'nvm-note', text: '←→ 切換調色盤顏色，滑鼠點擊色塊可自選任意顏色。' }),
  );
  return { el, first: primary.focus };
}
