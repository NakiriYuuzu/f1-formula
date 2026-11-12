/** On-screen panel of the benchmark: start button, progress, per-cell summary, the raw rows and a copy button. */
import { baseQualityProfile } from '../../render/core/quality';
import { QUALITY_LABEL } from '../../ui/menus/labels';
import { summarize, type BenchParams, type BenchResult, type BenchRow } from './benchSpec';

const STYLE = `
.nvb{position:fixed;top:8px;right:8px;z-index:99999;width:min(560px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;
  background:rgba(8,10,16,.94);color:#e6ebf2;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;border:1px solid #2c3446;border-radius:8px;padding:10px 12px;box-sizing:border-box}
.nvb h2{margin:0 0 4px;font-size:14px}
.nvb p{margin:2px 0}
.nvb button{font:inherit;color:#fff;background:#d64a1a;border:0;border-radius:5px;padding:5px 12px;margin:6px 6px 6px 0;cursor:pointer}
.nvb button:disabled{background:#4a5163;cursor:default}
.nvb pre{margin:6px 0 0;max-height:7em;overflow:auto;font-size:10px;color:#9fb0c8;white-space:pre}
.nvb pre#bench-summary{max-height:none;font-size:11px;color:#e6ebf2}
.nvb .warn{color:#ffb454}
.nvb.hold{opacity:.0;pointer-events:none}
`;

const COLUMNS = [
  'run', 'variant', 'quality', 'dpr', 'pixelRatio', 'scenario', 'frames',
  'medianMs', 'p95Ms', 'p99Ms', 'meanMs', 'cpuMedianMs', 'gpuWaitMedianMs',
  'drawCalls', 'triangles', 'programs', 'canvasPixels', 'canvasSamples', 'sceneSamples',
  'fullscreenPasses', 'postFillMpx', 'shadowRenders', 'lights', 'shadowLights', 'ibl', 'phaseEnd', 'errors',
];

function rowCells(r: BenchRow): (string | number)[] {
  const c = r.counters;
  return [
    r.run, r.variant, r.quality, r.dpr ?? 'device', r.pixelRatio, r.scenario, r.frames,
    r.frameMs.median, r.frameMs.p95, r.frameMs.p99, r.frameMs.mean, r.cpuMs.median, r.gpuWaitMs.median,
    c.drawCalls, c.triangles, c.programs, c.canvasPixels, c.canvasSamples, c.sceneSamples,
    c.fullscreenPasses, c.postFillMpx, c.shadowRenders, c.lights, c.shadowLights, c.ibl ? 1 : 0, r.phaseEnd, r.errors,
  ];
}

export function rowsToText(result: BenchResult): string {
  return [COLUMNS.join('\t'), ...result.rows.map((r) => rowCells(r).join('\t'))].join('\n');
}

const fmt = (v: number, d = 1): string => v.toFixed(d);

/**
 * The window title carries the timings (quality.scenario.dpr=median/p95/p99 ms) so a driver that cannot read the page
 * can still read them from the window list: the software-rendered proxy runs are collected this way.
 */
export function titleLine(result: BenchResult, done: boolean): string {
  const cells = result.rows.map((r) => `${r.quality}.${r.scenario}.${r.dpr ?? 'd'}${r.variant === 'tuned' ? 't' : ''}.r${r.run}=${r.frameMs.median}/${r.frameMs.p95}/${r.frameMs.p99}`);
  return `NB ${done ? 'DONE' : 'RUN'} ${cells.join(' ')}`;
}

export class BenchPanel {
  readonly root = document.createElement('section');
  private readonly status = document.createElement('p');
  private readonly info = document.createElement('div');
  private readonly start = document.createElement('button');
  private readonly copy = document.createElement('button');
  private readonly table = document.createElement('pre');
  private readonly text = document.createElement('pre');

  constructor(
    host: HTMLElement,
    private readonly params: BenchParams,
    onStart: () => void,
    private readonly getResult: () => BenchResult | null,
  ) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);
    this.root.className = 'nvb';
    this.root.setAttribute('data-bench-panel', '');
    const title = document.createElement('h2');
    title.textContent = '效能測試（FORMULA NOVA 25）';
    this.start.textContent = '開始測試';
    this.start.addEventListener('click', () => {
      this.start.disabled = true;
      onStart();
    });
    this.copy.textContent = '複製結果（JSON）';
    this.copy.disabled = true;
    this.copy.addEventListener('click', () => void this.copyJson());
    this.text.id = 'bench-text';
    this.table.id = 'bench-summary';
    this.status.id = 'bench-status';
    this.root.append(title, this.status, this.info, this.start, this.copy, this.text, this.table);
    host.append(this.root);
    this.status.textContent = this.params.autorun ? '準備中…' : '按「開始測試」。測試期間請勿切換分頁或最小化視窗。';
    this.renderInfo(null);
  }

  hide(): void {
    this.root.classList.add('hold');
  }

  setStatus(message: string): void {
    this.status.textContent = message;
  }

  update(result: BenchResult, done: boolean): void {
    this.renderInfo(result);
    this.renderTable(result);
    this.text.replaceChildren(...rowsToText(result).split('\n').map((line) => Object.assign(document.createElement('div'), { textContent: line })));
    document.title = titleLine(result, done);
    this.copy.disabled = false;
    if (done) {
      this.status.textContent = `完成：${result.rows.length} 筆。可按「複製結果」貼給開發者。`;
      this.start.disabled = false;
      this.start.textContent = '再測一次';
    }
  }

  private renderInfo(result: BenchResult | null): void {
    const p = this.params;
    const dpr = p.dprs.map((d) => d ?? '顯示器預設').join(' / ');
    const lines = [`畫布 ${p.width}×${p.height} CSS · 像素比 ${dpr} · 解析度比例 ${p.scale} · 畫面反鋸齒 ${p.antialias === null ? '依畫質' : p.antialias ? '開' : '關'} · 自適應解析度 鎖定`];
    const first = p.qualities[0];
    if (p.antialias === null && first !== undefined && p.qualities.some((q) => baseQualityProfile(q).canvasMsaa !== baseQualityProfile(first).canvasMsaa)) {
      lines.push(`偵測：畫面反鋸齒在建立畫面時就固定，同頁多個畫質以第一個（${first}）為準；要比較其他畫質請分頁測試。`);
    }
    if (Object.keys(p.tune).length > 0) lines.push(`調整欄位：${JSON.stringify(p.tune)}${p.ab ? '（與預設交替比較）' : ''}`);
    if (result) {
      lines.push(`GPU：${result.env.gpu}`);
      lines.push(`自動畫質依顯卡名稱的首選：${QUALITY_LABEL[result.env.autoPick]}`);
      if (result.env.software) lines.push('偵測到軟體繪圖（無獨立或內建 GPU 加速）。');
    }
    this.info.replaceChildren(...lines.map((l) => Object.assign(document.createElement('p'), { textContent: l, className: l.startsWith('偵測') ? 'warn' : '' })));
  }

  private renderTable(result: BenchResult): void {
    const cells = new Map<string, BenchRow[]>();
    for (const r of result.rows) {
      const key = `${r.quality}|${r.scenario}|${r.dpr ?? 'device'}|${r.variant}`;
      const list = cells.get(key);
      if (list) list.push(r);
      else cells.set(key, [r]);
    }
    const pad = (v: string, n: number): string => v.padStart(n);
    const lines = [`${'畫質'.padEnd(8)}${'情境'.padEnd(17)}${pad('DPR', 4)}${pad('中位ms', 8)}${pad('p95', 7)}${pad('p99', 7)}${pad('FPS', 6)}${pad('呼叫', 6)}${pad('三角形k', 8)}`];
    for (const rows of cells.values()) {
      const first = rows[0];
      if (!first) continue;
      const med = summarize(rows.map((r) => r.frameMs.median)).median;
      const p95 = summarize(rows.map((r) => r.frameMs.p95)).median;
      const p99 = summarize(rows.map((r) => r.frameMs.p99)).median;
      const calls = summarize(rows.map((r) => r.counters.drawCalls)).median;
      const tris = summarize(rows.map((r) => r.counters.triangles)).median;
      const label = first.variant === 'tuned' ? `${first.quality}*` : first.quality;
      lines.push(`${label.padEnd(8)}${first.scenario.padEnd(17)}${pad(String(first.dpr ?? '顯示器'), 4)}${pad(fmt(med), 8)}${pad(fmt(p95), 7)}${pad(fmt(p99), 7)}${pad(fmt(1000 / Math.max(med, 0.001), 0), 6)}${pad(String(calls), 6)}${pad(fmt(tris / 1000, 0), 8)}`);
    }
    this.table.textContent = lines.join('\n');
  }

  private async copyJson(): Promise<void> {
    const result = this.getResult();
    if (!result) return;
    const json = JSON.stringify(result, null, 1);
    try {
      await navigator.clipboard.writeText(json);
      this.copy.textContent = '已複製';
    } catch {
      const area = document.createElement('textarea');
      area.value = json;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      this.copy.textContent = '已複製';
    }
    window.setTimeout(() => {
      this.copy.textContent = '複製結果（JSON）';
    }, 1500);
  }
}
