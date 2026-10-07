/**
 * Credits: project statement (fan-made work, not affiliated with any racing series or publisher), real circuit
 * data attributions and technology used.
 */
import { GAME_TITLE, GAME_TITLE_ZH } from '../../../core/defaults';
import { TRACK_DEFS } from '../../../data/tracks';
import { circuitCredits } from '../../../meta/circuits';
import { h } from '../dom';
import { Screen, type Host } from '../screen';
import { button, heading, panel } from '../widgets';

/** Real circuit attributions (dynamic from the registry) and the non-affiliation note. */
function trackDataNotes(): HTMLElement[] {
  const credits = circuitCredits(TRACK_DEFS);
  const p = (text: string): HTMLElement => h('p', { class: 'nvm-credits__p', text });
  const notes: HTMLElement[] = [
    p('真實賽道依真實佈局重現，僅作為非商業的同人專案使用；與任何賽道、賽事系列或權利人均無關聯，也未獲得其授權或背書。'),
  ];
  if (credits.length > 0) {
    notes.push(h('ul', { class: 'nvm-credits__list nvm-credits__list--sources' }, credits.map((c) => h('li', { text: `${c.name}（${c.location}）：${c.source}` }))));
  }
  return notes;
}

export class CreditsScreen extends Screen {
  readonly title = '製作名單';

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-credits' });
    const p = (text: string): HTMLElement => h('p', { class: 'nvm-credits__p', text });
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide nvm-credits__wrap' },
        heading(`${GAME_TITLE}｜${GAME_TITLE_ZH}`, '製作名單'),
        h(
          'div',
          { class: 'nvm-columns' },
          panel(
            '關於本作',
            p('本作是一款原創的同人開輪賽車遊戲，所有車隊、車手、塗裝、劇情、介面、模型與音效皆為原創或以程式即時生成；賽道包含 5 條原創賽道，以及依真實世界佈局重現的賽道。'),
            p('本作與任何真實賽車系列、賽事主辦單位、車隊、車手、贊助商或遊戲發行商均無任何關聯，也未獲得其授權或背書。'),
            p('文中出現的 DRS、ERS 等詞彙為一般賽車術語；輪胎配方顏色、積分制度等皆屬通用知識。'),
          ),
          h(
            'div',
            { class: 'nvm-stack' },
            panel(
              '技術',
              h(
                'ul',
                { class: 'nvm-credits__list' },
                h('li', { text: 'three.js：即時 3D 繪圖與程式化建模' }),
                h('li', { text: 'Vite：開發與建置工具' }),
                h('li', { text: 'TypeScript：型別安全的遊戲邏輯' }),
                h('li', { text: 'Web Audio API：引擎與音效即時合成' }),
                h('li', { text: '背景音樂為原創作品，以 Web Audio 即時合成；使用者自選的音樂檔不屬於遊戲內容' }),
                h('li', { text: 'Gamepad API：控制器支援' }),
              ),
            ),
            panel('賽道資料', ...trackDataNotes()),
            panel(
              '未實作的功能',
              p('線上多人、區域網路、跨平台連線、VR、雲端存檔與反作弊需要伺服器或專用硬體，本作不提供。所有進度皆保存在本機瀏覽器中。'),
            ),
          ),
        ),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
  }
}
