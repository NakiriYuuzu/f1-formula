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
            p('本作是一款非商業、純娛樂的同人開輪賽車遊戲。劇情、介面、模型、音效與背景音樂皆為原創或以程式即時生成；賽道包含 5 條原創賽道，以及依真實世界佈局重現的賽道。'),
            p('預設名單收錄 2026 年 F1 賽季的真實車隊與車手名稱，僅作為事實資訊使用：車隊評分與車手能力為主觀估計，塗裝只以顏色近似，不含任何標誌、贊助商或肖像。「新星之路」與「原創名單」使用原創的虛構車隊與車手。'),
            p('本作與 Formula 1、FIA、任何車隊、車手、贊助商或遊戲發行商均無任何關聯，也未獲得其授權或背書；相關名稱與商標屬於其各自的所有者。'),
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
                h('li', { text: '背景音樂為原創作品（選單〈Lights Out〉、比賽〈Pole Position Anthem〉、頒獎台〈Champagne〉），以 Web Audio 即時合成' }),
                h('li', { text: '本機播放清單、自選音樂檔與 YouTube 影片是玩家自己選的內容，不屬於遊戲；YouTube 影片由 YouTube 播放器播放，適用 YouTube 服務條款' }),
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
