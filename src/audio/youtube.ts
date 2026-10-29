/**
 * YouTube music source (musicSource 'youtube'): plays the video or playlist the player pasted (Settings.musicYoutube)
 * with YouTube's IFrame Player API. The API script is loaded from youtube.com only once this source is chosen, and
 * the player is the privacy-enhanced youtube-nocookie.com one.
 *
 * YouTube's API policies require a visible player of at least 200×200 px that nothing covers, no background play and
 * no autoplay while hidden. So a mini player sits above every other layer while the music sounds — bottom-left in the
 * menus, a 200×200 square at the right edge between the timing box and the telemetry during sessions — and the video
 * pauses and the player hides whenever the music would be silent (silent scene, hidden tab, volume 0). The audio does
 * not pass through WebAudio: the level is the player's own volume (0..100).
 */

export interface YouTubeTarget {
  /** 11-character video id */
  videoId: string | null;
  /** playlist id */
  listId: string | null;
}

const VIDEO_ID = /^[\w-]{11}$/;
const LIST_ID = /^[\w-]{2,64}$/;
const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'];

/** A YouTube watch / share / embed / shorts / playlist link (or a bare video id) → what to play; null if it is none. */
export function parseYouTubeUrl(text: string): YouTubeTarget | null {
  const raw = text.trim();
  if (VIDEO_ID.test(raw)) return { videoId: raw, listId: null };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  let videoId: string | null = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') videoId = path[0] ?? null;
  else if (!HOSTS.includes(host)) return null;
  else if (path[0] === 'watch') videoId = url.searchParams.get('v');
  else if (path[0] === 'embed' || path[0] === 'shorts' || path[0] === 'live' || path[0] === 'v') videoId = path[1] ?? null;
  const list = url.searchParams.get('list');
  const target: YouTubeTarget = {
    videoId: videoId !== null && VIDEO_ID.test(videoId) ? videoId : null,
    listId: list !== null && LIST_ID.test(list) ? list : null,
  };
  return target.videoId || target.listId ? target : null;
}

// ───────────────────────────── IFrame API (minimal typing) ─────────────────────────────

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  setVolume(volume: number): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  destroy(): void;
}

interface YTPlayerOptions {
  width: number;
  height: number;
  host: string;
  videoId?: string;
  playerVars: Record<string, string | number>;
  events: {
    onReady: () => void;
    onStateChange: (e: { data: number }) => void;
    onError: (e: { data: number }) => void;
  };
}

interface YTNamespace {
  Player: new (el: HTMLElement, options: YTPlayerOptions) => YTPlayer;
}

type YTWindow = Window & { YT?: Partial<YTNamespace>; onYouTubeIframeAPIReady?: () => void };

const API_URL = 'https://www.youtube.com/iframe_api';
const API_TIMEOUT_MS = 15000;
const STATE_ENDED = 0;
/** 16:9 player in the menus (the CSS sizes the box per placement, never below the API policy's 200×200 px) */
const PLAYER_W = 356;
const PLAYER_H = 200;

/** where the mini player sits: the menus' corner, or out of the race HUD's way */
export type YouTubePlacement = 'menu' | 'race';

let api: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  const w = window as YTWindow;
  if (w.YT?.Player) return Promise.resolve(w.YT as YTNamespace);
  if (!api) {
    api = new Promise<YTNamespace>((resolve, reject) => {
      const fail = (): void => {
        api = null;
        reject(new Error('無法連線到 YouTube，請確認網路連線'));
      };
      const timer = setTimeout(fail, API_TIMEOUT_MS);
      const previous = w.onYouTubeIframeAPIReady;
      w.onYouTubeIframeAPIReady = () => {
        previous?.();
        clearTimeout(timer);
        if (w.YT?.Player) resolve(w.YT as YTNamespace);
        else fail();
      };
      const script = document.createElement('script');
      script.src = API_URL;
      script.async = true;
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        fail();
      };
      document.head.append(script);
    });
  }
  return api;
}

function errorMessage(code: number): string {
  if (code === 2) return '這個 YouTube 連結的影片 ID 不正確';
  if (code === 5) return '這部影片無法在網頁播放器播放';
  if (code === 100) return '找不到這部影片（可能已刪除或設為私人）';
  if (code === 101 || code === 150) return '這部影片的上傳者不允許嵌入播放，請換一部影片';
  return `YouTube 播放失敗（錯誤 ${code}）`;
}

/**
 * The mini player. `update()` states what should happen (link, whether music sounds, level 0..1); problems go to
 * `onStatus(message)` and a working link reports `onStatus(null)`, so the AudioEngine can fall back to the original
 * music while a link fails.
 */
export class YouTubeMusic {
  /** null until the first update(), so an empty first link is reported too */
  private link: string | null = null;
  private target: YouTubeTarget | null = null;
  private active = false;
  private volume = 0;
  private placement: YouTubePlacement = 'menu';
  private box: HTMLElement | null = null;
  private player: YTPlayer | null = null;
  private ready = false;
  private failed = false;
  /** bumps on every new link / dispose: late API callbacks of an older player are ignored */
  private generation = 0;
  private disposed = false;

  constructor(private readonly onStatus: (message: string | null) => void) {}

  update(link: string, active: boolean, volume: number, placement: YouTubePlacement = 'menu'): void {
    if (this.disposed) return;
    if (link !== this.link) this.setLink(link);
    this.active = active;
    this.volume = Math.max(0, Math.min(1, volume));
    this.placement = placement;
    if (this.box) this.box.dataset.place = placement;
    this.apply();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.show(false);
    this.box?.remove();
    this.box = null;
  }

  private setLink(link: string): void {
    this.link = link;
    this.teardown();
    this.target = parseYouTubeUrl(link);
    this.failed = this.target === null;
    this.onStatus(
      this.target ? null : link.trim() === '' ? '尚未設定 YouTube 連結，已改播原創音樂' : '這不是 YouTube 影片或播放清單的連結，已改播原創音樂',
    );
  }

  private teardown(): void {
    this.generation += 1;
    this.player?.destroy();
    this.player = null;
    this.ready = false;
  }

  private fail(message: string): void {
    this.failed = true;
    this.teardown();
    this.apply();
    this.onStatus(`${message}，已改播原創音樂`);
  }

  private apply(): void {
    const sounding = this.active && this.volume > 0 && !this.failed && this.target !== null;
    if (!sounding) {
      if (this.ready) this.player?.pauseVideo();
      this.show(false);
      return;
    }
    // shown before playing: the API policy allows playback only in a visible player
    this.show(true);
    if (!this.player) {
      this.create();
      return;
    }
    if (!this.ready) return;
    this.player.setVolume(Math.round(this.volume * 100));
    this.player.playVideo();
  }

  private show(visible: boolean): void {
    if (visible) this.mountBox().hidden = false;
    else if (this.box) this.box.hidden = true;
  }

  private mountBox(): HTMLElement {
    if (!this.box) {
      const box = document.createElement('div');
      box.className = 'nv-yt';
      box.setAttribute('aria-label', 'YouTube 背景音樂播放器');
      box.dataset.place = this.placement;
      box.hidden = true;
      document.body.append(box);
      this.box = box;
    }
    return this.box;
  }

  private create(): void {
    const target = this.target;
    const box = this.box;
    if (!target || !box) return;
    const generation = this.generation;
    // a stand-in element the API replaces with its iframe
    const slot = document.createElement('div');
    box.replaceChildren(slot);
    // no autoplay: apply() starts the video once it is ready and still meant to sound (never while hidden)
    const vars: Record<string, string | number> = { autoplay: 0, controls: 1, playsinline: 1, rel: 0, origin: window.location.origin };
    if (target.listId) {
      vars.listType = 'playlist';
      vars.list = target.listId;
      vars.loop = 1;
    }
    // a placeholder object until the API answers, so apply() does not create a second player meanwhile
    this.player = { playVideo() {}, pauseVideo() {}, setVolume() {}, seekTo() {}, destroy() {} };
    loadApi().then(
      (YT) => {
        if (generation !== this.generation || this.disposed) return;
        this.player = new YT.Player(slot, {
          width: PLAYER_W,
          height: PLAYER_H,
          host: 'https://www.youtube-nocookie.com',
          ...(target.videoId ? { videoId: target.videoId } : {}),
          playerVars: vars,
          events: {
            onReady: () => {
              if (generation !== this.generation) return;
              this.ready = true;
              this.onStatus(null);
              this.apply();
            },
            onStateChange: (e) => {
              // a single video loops; a playlist loops by itself (loop=1)
              if (generation !== this.generation || e.data !== STATE_ENDED || target.listId) return;
              this.player?.seekTo(0, true);
              this.player?.playVideo();
            },
            onError: (e) => {
              if (generation === this.generation) this.fail(errorMessage(e.data));
            },
          },
        });
      },
      (err: unknown) => {
        if (generation === this.generation && !this.disposed) this.fail(err instanceof Error ? err.message : '無法連線到 YouTube');
      },
    );
  }
}
