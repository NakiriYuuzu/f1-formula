/**
 * Settings → 名單 tab: shows the active roster (imported pack, default pack or built-in) and imports a pack, switches
 * back to the default pack or restores the built-in roster (meta/rosterPack.ts). Hidden while a session is paused
 * (the running session keeps the roster it was built with).
 */
import {
  activeRosterPack,
  defaultRosterPack,
  parseRosterPackText,
  rosterSource,
  setRosterPack,
  useDefaultRosterPack,
} from '../../../meta/rosterPack';
import { rosterDrivers, rosterTeams } from '../../../meta/roster';
import { h } from '../dom';
import type { Host } from '../screen';
import { button, infoLine, panel } from '../widgets';

/** A roster pack is a few KB; anything this large is not one. */
const MAX_PACK_BYTES = 1024 * 1024;

const SOURCE_LABEL = { imported: '匯入的名單', default: '預設名單（public/rosters/default.json）', builtin: '內建原創名單' } as const;

export function rosterTab(host: Host, rerender: () => void): HTMLElement {
  const pack = activeRosterPack();
  const source = rosterSource();
  const fallback = defaultRosterPack();
  const teams = rosterTeams();
  const drivers = rosterDrivers();
  const reserves = drivers.filter((d) => d.teamId === '').length;
  const errEl = h('div', { class: 'nvm-banner is-bad' });
  errEl.hidden = true;
  const showErrors = (lines: string[]): void => {
    errEl.hidden = lines.length === 0;
    errEl.replaceChildren(...lines.map((line) => h('div', { text: line })));
  };

  const input = h('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: true, tabindex: -1, 'aria-hidden': 'true' } });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_PACK_BYTES) {
      host.sound('error');
      showErrors(['檔案太大，不像是名單檔（上限 1 MB）']);
      return;
    }
    file.text().then(
      (text) => {
        const result = parseRosterPackText(text);
        if (!result.ok) {
          host.sound('error');
          showErrors(['無法套用這個名單檔：', ...result.errors]);
          return;
        }
        const saved = setRosterPack(result.pack);
        host.toast(saved ? `已套用名單：${result.pack.name}` : `已套用名單：${result.pack.name}（無法存到瀏覽器，重新整理後會還原）`, saved ? 'good' : 'bad');
        rerender();
      },
      () => {
        host.sound('error');
        showErrors(['無法讀取檔案']);
      },
    );
  });

  return h(
    'div',
    { class: 'nvm-stack nvm-narrow' },
    panel(
      '目前名單',
      infoLine('名單', pack ? pack.name : '內建原創名單'),
      infoLine('來源', SOURCE_LABEL[source]),
      infoLine('車隊', `${teams.length} 支`),
      infoLine('車手', `${drivers.length - reserves} 位正選・${reserves} 位候補`),
      h('p', { class: 'nvm-note', text: teams.map((t) => t.shortName).join('・') }),
    ),
    panel(
      '名單檔',
      h('p', {
        class: 'nvm-note',
        text: '匯入你自備的名單檔（.json），取代大獎賽、計時賽、生涯、我的車隊與雙人分割畫面的車隊和車手。名單只存在這台電腦的瀏覽器；「新星之路」固定使用內建名單。',
      }),
      h('p', { class: 'nvm-note', text: '生涯與我的車隊會依名單分開存檔，切換名單不會刪除另一邊的進度。' }),
      errEl,
      input,
      h(
        'div',
        { class: 'nvm-actions' },
        button({ label: '匯入名單檔…', onClick: () => input.click() }),
        fallback && source !== 'default'
          ? button({
              label: '改用預設名單',
              onClick: () => {
                useDefaultRosterPack();
                host.toast(`已改用預設名單：${fallback.name}`, 'good');
                rerender();
              },
            })
          : null,
        pack
          ? button({
              label: '還原內建名單',
              variant: 'danger',
              onClick: () =>
                host.confirm('還原內建名單？', `會停用「${pack.name}」並回到內建原創名單。用這份名單的生涯與我的車隊存檔會保留，之後切回即可繼續。`, () => {
                  setRosterPack(null);
                  host.toast('已還原內建名單');
                  rerender();
                }, '還原'),
            })
          : null,
      ),
    ),
  );
}
