/**
 * Bootstrap: global styles, the error overlay (uncaught errors / unhandled rejections), a WebGL 2 capability
 * check, the optional default roster pack, then the App (menus, sessions, replays) on the #game canvas with #ui-root
 * for DOM layers.
 */
import './ui/tokens.css';
import './ui/app.css';
import { App } from './app/App';
import { loadDefaultRoster } from './app/defaultRoster';
import { installErrorOverlay, reportError, showFatal } from './app/errorOverlay';

/** True when this browser can create a WebGL 2 context (probe canvas, released right away). */
function supportsWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  installErrorOverlay();
  const canvas = document.getElementById('game');
  const uiRoot = document.getElementById('ui-root');
  if (!(canvas instanceof HTMLCanvasElement) || !(uiRoot instanceof HTMLElement)) {
    showFatal('無法啟動遊戲', '頁面缺少必要的元素（#game 畫布或 #ui-root），請重新載入。');
    return;
  }
  if (!supportsWebGL2()) {
    showFatal('您的瀏覽器不支援 WebGL 2', '新星方程式 25 需要 WebGL 2 才能顯示 3D 畫面。請改用最新版的 Chrome、Edge、Firefox 或 Safari，並確認已啟用硬體加速。');
    return;
  }
  await loadDefaultRoster();
  try {
    new App(canvas, uiRoot).start();
  } catch (err) {
    reportError(err, '啟動');
    showFatal('遊戲啟動失敗', '初始化 3D 繪圖或介面時發生錯誤；請確認瀏覽器支援 WebGL 2 並已啟用硬體加速，然後重新載入頁面。');
  }
}

void boot();
