/**
 * YouTube music source (musicSource 'youtube'): plays the videos and playlists the player added (Settings.musicYoutube
 * + musicYoutubeExtra, see youtubeLinks) in turn with YouTube's IFrame Player API. The API script is loaded from
 * youtube.com only once this source is chosen, and the player is the privacy-enhanced youtube-nocookie.com one.
 *
 * The player is not shown (2026-10-30 user decision, against the YouTube API policy's visible-player rule): its iframe
 * stays in the page at 200×200 px so it keeps playing, but fully transparent, inert and ignoring the pointer. The video
 * still pauses whenever the music would be silent (silent scene, hidden tab, volume 0).
 *
 * Rotation: when a video ends, or the last video of a playlist, the next link plays; after the last link the first one
 * plays again, and a single link loops. A link that cannot play (not a YouTube link, embedding disabled, removed) is
 * skipped; only when none of them can play does the AudioEngine fall back to the original music. The audio does not
 * pass through WebAudio: the level is the player's own volume (0..100).
 */
import type { Settings } from '../core/types';

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

/** The YouTube links to play, in order. */
export function youtubeLinks(s: Pick<Settings, 'musicYoutube' | 'musicYoutubeExtra'>): string[] {
  return [s.musicYoutube, ...s.musicYoutubeExtra].map((l) => l.trim()).filter((l) => l !== '');
}

/** The settings fields that store `links` (the first one in `musicYoutube`, the rest in `musicYoutubeExtra`). */
export function youtubeLinksPatch(links: readonly string[]): Pick<Settings, 'musicYoutube' | 'musicYoutubeExtra'> {
  return { musicYoutube: links[0] ?? '', musicYoutubeExtra: links.slice(1) };
}

// ───────────────────────────── IFrame API (minimal typing) ─────────────────────────────

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  setVolume(volume: number): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideoAt(index: number): void;
  nextVideo(): void;
  getPlaylist(): string[] | null;
  getPlaylistIndex(): number;
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
/** the hidden player's size (YouTube's minimum player size) */
const PLAYER_SIZE = 200;
/** stands in for the player until the API answers, so apply() does not create a second one meanwhile */
const LOADING: YTPlayer = {
  playVideo() {},
  pauseVideo() {},
  setVolume() {},
  seekTo() {},
  playVideoAt() {},
  nextVideo() {},
  getPlaylist: () => null,
  getPlaylistIndex: () => -1,
  destroy() {},
};

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

// ───────────────────────────── the settings screen's view ─────────────────────────────

/** the player in use (one AudioEngine per page): the settings screen marks its link and skips through it */
let live: YouTubeMusic | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of listeners) fn();
}

/** The link playing now (paused in a silent scene too); null when YouTube music is not in use or no link can play. */
export function youtubeNowPlaying(): string | null {
  return live?.current() ?? null;
}

/** 「下一首」: the next video of a playlist (after its last one: the next link), else the next link. False when there is nothing to skip. */
export function skipYouTube(): boolean {
  return live?.skip() ?? false;
}

/** Called whenever youtubeNowPlaying() may have changed; returns the unsubscribe function. */
export function subscribeYouTube(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The hidden player. `update()` states what should happen (links, whether music sounds, level 0..1); when no link can
 * play, the reason goes to `onStatus(message)`, and a playing link reports `onStatus(null)`, so the AudioEngine can fall
 * back to the original music meanwhile.
 */
export class YouTubeMusic {
  /** null until the first update(), so an empty first list is reported too */
  private links: string[] | null = null;
  private targets: (YouTubeTarget | null)[] = [];
  /** the link playing now */
  private index = 0;
  /** links that failed to play: skipped until the list changes */
  private readonly failed = new Set<number>();
  private active = false;
  private volume = 0;
  private box: HTMLElement | null = null;
  private player: YTPlayer | null = null;
  private ready = false;
  /** bumps on every new player / dispose: late API callbacks of an older player are ignored */
  private generation = 0;
  private disposed = false;

  constructor(private readonly onStatus: (message: string | null) => void) {
    live = this;
    changed();
  }

  update(links: readonly string[], active: boolean, volume: number): void {
    if (this.disposed) return;
    if (!this.links || links.length !== this.links.length || links.some((l, i) => l !== this.links?.[i])) this.setLinks(links);
    this.active = active;
    this.volume = Math.max(0, Math.min(1, volume));
    this.apply();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.box?.remove();
    this.box = null;
    if (live === this) {
      live = null;
      changed();
    }
  }

  /** The link playing now; null when none can play. */
  current(): string | null {
    return this.links && this.playable(this.index) ? (this.links[this.index] ?? null) : null;
  }

  /** 「下一首」: the playlist's next video, else the next link (a single video link starts again). */
  skip(): boolean {
    if (this.disposed || this.current() === null) return false;
    if (this.playlistGoesOn()) {
      this.player?.nextVideo();
      this.apply();
    } else this.advance();
    return true;
  }

  /** A new list: the link playing now keeps playing if it is still in it, failed links get another try. */
  private setLinks(links: readonly string[]): void {
    const playing = this.links?.[this.index];
    this.links = [...links];
    this.targets = this.links.map(parseYouTubeUrl);
    this.failed.clear();
    const kept = playing === undefined ? -1 : this.links.indexOf(playing);
    if (kept >= 0) {
      this.index = kept;
    } else {
      this.teardown();
      // a removed link hands over to the one now in its place
      this.index = this.nextPlayable((this.index < this.links.length ? this.index : 0) - 1) ?? 0;
    }
    if (this.links.length === 0) this.onStatus('尚未設定 YouTube 連結，已改播原創音樂');
    else if (!this.targets.some(Boolean)) {
      this.onStatus(this.links.length === 1 ? '這不是 YouTube 影片或播放清單的連結，已改播原創音樂' : '清單中沒有 YouTube 影片或播放清單的連結，已改播原創音樂');
    } else this.onStatus(null);
    changed();
  }

  private playable(i: number): boolean {
    return this.targets[i] != null && !this.failed.has(i);
  }

  /** The first playable link after `from` (wrapping around, `from` itself last); null when none can play. */
  private nextPlayable(from: number): number | null {
    const n = this.targets.length;
    for (let step = 1; step <= n; step++) {
      const i = (((from + step) % n) + n) % n;
      if (this.playable(i)) return i;
    }
    return null;
  }

  private teardown(): void {
    this.generation += 1;
    this.player?.destroy();
    this.player = null;
    this.ready = false;
  }

  /** The link playing now cannot play (`all`: no link can, e.g. YouTube is unreachable): the next one takes over. */
  private fail(message: string, all = false): void {
    if (all) this.targets.forEach((_, i) => this.failed.add(i));
    else this.failed.add(this.index);
    this.teardown();
    const next = this.nextPlayable(this.index);
    if (next !== null) this.index = next;
    changed();
    if (next !== null) {
      this.apply();
      return;
    }
    this.onStatus(
      all || (this.links?.length ?? 0) <= 1 ? `${message}，已改播原創音樂` : `清單中的 YouTube 連結都無法播放（${message}），已改播原創音樂`,
    );
  }

  /** The link playing now finished: the next one, or the same one again when it is the only one that plays. */
  private advance(): void {
    const next = this.nextPlayable(this.index);
    if (next === null) return;
    if (next !== this.index) {
      this.index = next;
      this.teardown();
      changed();
    } else if (this.targets[this.index]?.listId) this.player?.playVideoAt(0);
    else this.player?.seekTo(0, true);
    this.apply();
  }

  /** The link playing now is a playlist with videos left after this one. */
  private playlistGoesOn(): boolean {
    const player = this.ready ? this.player : null;
    const list = player && this.targets[this.index]?.listId ? player.getPlaylist() : null;
    return player !== null && list !== null && player.getPlaylistIndex() < list.length - 1;
  }

  private apply(): void {
    const sounding = this.active && this.volume > 0 && this.playable(this.index);
    if (!sounding) {
      if (this.ready) this.player?.pauseVideo();
      return;
    }
    if (!this.player) {
      this.create();
      return;
    }
    if (!this.ready) return;
    this.player.setVolume(Math.round(this.volume * 100));
    this.player.playVideo();
  }

  private mountBox(): HTMLElement {
    if (!this.box) {
      const box = document.createElement('div');
      box.className = 'nv-yt';
      box.setAttribute('aria-hidden', 'true');
      // never takes the focus or a click: the menus' keyboard / pad navigation skips it
      box.inert = true;
      document.body.append(box);
      this.box = box;
    }
    return this.box;
  }

  private create(): void {
    const target = this.targets[this.index];
    if (!target) return;
    const box = this.mountBox();
    const generation = this.generation;
    // a stand-in element the API replaces with its iframe
    const slot = document.createElement('div');
    box.replaceChildren(slot);
    // no autoplay: apply() starts the video once it is ready and still meant to sound; playlists do not loop by
    // themselves (advance() decides what comes after their last video)
    const vars: Record<string, string | number> = { autoplay: 0, controls: 1, playsinline: 1, rel: 0, origin: window.location.origin };
    if (target.listId) {
      vars.listType = 'playlist';
      vars.list = target.listId;
    }
    this.player = LOADING;
    loadApi().then(
      (YT) => {
        if (generation !== this.generation || this.disposed) return;
        this.player = new YT.Player(slot, {
          width: PLAYER_SIZE,
          height: PLAYER_SIZE,
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
              // a playlist moves on to its next video by itself
              if (generation !== this.generation || e.data !== STATE_ENDED || this.playlistGoesOn()) return;
              this.advance();
            },
            onError: (e) => {
              if (generation === this.generation) this.fail(errorMessage(e.data));
            },
          },
        });
      },
      (err: unknown) => {
        if (generation === this.generation && !this.disposed) this.fail(err instanceof Error ? err.message : '無法連線到 YouTube', true);
      },
    );
  }
}
