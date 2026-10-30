/**
 * The hidden YouTube player (src/audio/youtube.ts) against a fake page and a fake IFrame API: the invisible box, the
 * rotation through several links (videos, the last video of a playlist, wrapping, a single link looping), list edits
 * keeping the playing link, skipping links that cannot play, the fallback when none can, 「下一首」 and the link marked in
 * the settings screen, and the silent / disposed paths.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { skipYouTube, subscribeYouTube, YouTubeMusic, youtubeNowPlaying } from '../src/audio/youtube';

class FakeEl {
  className = '';
  inert = false;
  children: unknown[] = [];
  attrs: Record<string, string> = {};
  removed = false;
  onerror: (() => void) | null = null;
  src = '';
  async = false;
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  replaceChildren(...c: unknown[]): void {
    this.children = c;
  }
  append(...c: unknown[]): void {
    this.children.push(...c);
  }
  remove(): void {
    this.removed = true;
  }
}

interface Options {
  width: number;
  height: number;
  videoId?: string;
  playerVars: Record<string, string | number>;
  events: { onReady: () => void; onStateChange: (e: { data: number }) => void; onError: (e: { data: number }) => void };
}

class FakePlayer {
  static all: FakePlayer[] = [];
  playing = false;
  volume = -1;
  destroyed = false;
  seeks = 0;
  nexts = 0;
  playAt: number[] = [];
  playlist: string[] | null = null;
  playlistIndex = 0;
  constructor(
    readonly el: unknown,
    readonly opts: Options,
  ) {
    FakePlayer.all.push(this);
  }
  playVideo(): void {
    this.playing = true;
  }
  pauseVideo(): void {
    this.playing = false;
  }
  setVolume(v: number): void {
    this.volume = v;
  }
  seekTo(): void {
    this.seeks += 1;
  }
  playVideoAt(i: number): void {
    this.playAt.push(i);
    this.playlistIndex = i;
  }
  nextVideo(): void {
    this.nexts += 1;
    this.playlistIndex += 1;
    this.playing = true;
  }
  getPlaylist(): string[] | null {
    return this.playlist;
  }
  getPlaylistIndex(): number {
    return this.playlistIndex;
  }
  destroy(): void {
    this.destroyed = true;
  }
  ready(): void {
    this.opts.events.onReady();
  }
  ended(): void {
    this.opts.events.onStateChange({ data: 0 });
  }
  error(code: number): void {
    this.opts.events.onError({ data: code });
  }
}

const g = globalThis as unknown as { window?: unknown; document?: unknown };
let saved: { window: unknown; document: unknown };
let body: FakeEl;
let head: FakeEl;

function page(withApi = true): void {
  body = new FakeEl('body');
  head = new FakeEl('head');
  g.window = { location: { origin: 'http://localhost:5173' }, ...(withApi ? { YT: { Player: FakePlayer } } : {}) };
  g.document = { createElement: (tag: string) => new FakeEl(tag), body, head };
}

beforeEach(() => {
  saved = { window: g.window, document: g.document };
  FakePlayer.all = [];
  page();
});

afterEach(() => {
  g.window = saved.window;
  g.document = saved.document;
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const lastPlayer = (): FakePlayer => FakePlayer.all[FakePlayer.all.length - 1]!;

const A = 'https://youtu.be/AAAAAAAAAAA';
const B = 'https://www.youtube.com/playlist?list=PLbbbbbb';
const C = 'https://www.youtube.com/watch?v=CCCCCCCCCCC';
const D = 'https://youtu.be/DDDDDDDDDDD';

function music(): { yt: YouTubeMusic; status: (string | null)[] } {
  const status: (string | null)[] = [];
  return { yt: new YouTubeMusic((m) => status.push(m)), status };
}

describe('hidden YouTube player', () => {
  test('the box is invisible to the pointer, the focus and assistive tech; the player is 200×200', async () => {
    const { yt } = music();
    yt.update([A], true, 0.5);
    await flush();
    const box = body.children[0] as FakeEl;
    expect(box.className).toBe('nv-yt');
    expect(box.inert).toBe(true);
    expect(box.attrs['aria-hidden']).toBe('true');
    expect(lastPlayer().opts).toMatchObject({ width: 200, height: 200, videoId: 'AAAAAAAAAAA' });
    lastPlayer().ready();
    expect(lastPlayer()).toMatchObject({ playing: true, volume: 50 });
    yt.dispose();
    expect(lastPlayer().destroyed).toBe(true);
    expect(box.removed).toBe(true);
  });

  test('links play in turn: a video ends, a playlist after its last video, and the list wraps around', async () => {
    const { yt, status } = music();
    yt.update([A, B, C], true, 1);
    await flush();
    const a = lastPlayer();
    a.ready();
    a.ended();
    expect(a.destroyed).toBe(true);
    await flush();
    const b = lastPlayer();
    expect(b.opts.videoId).toBeUndefined();
    expect(b.opts.playerVars).toMatchObject({ listType: 'playlist', list: 'PLbbbbbb' });
    // the playlist does not loop by itself: the rotation decides what follows its last video
    expect(b.opts.playerVars.loop).toBeUndefined();
    b.ready();
    expect(b.playing).toBe(true);
    b.playlist = ['x1', 'x2'];
    b.ended(); // first video of the playlist: YouTube moves on by itself
    expect(FakePlayer.all.length).toBe(2);
    b.playlistIndex = 1;
    b.ended();
    await flush();
    const c = lastPlayer();
    expect(c.opts.videoId).toBe('CCCCCCCCCCC');
    c.ready();
    c.ended();
    await flush();
    expect(lastPlayer().opts.videoId).toBe('AAAAAAAAAAA');
    expect(FakePlayer.all.length).toBe(4);
    expect(status.every((m) => m === null)).toBe(true);
  });

  test('a single link loops in place', async () => {
    const { yt } = music();
    yt.update([A], true, 1);
    await flush();
    const a = lastPlayer();
    a.ready();
    a.ended();
    expect(FakePlayer.all.length).toBe(1);
    expect(a).toMatchObject({ seeks: 1, playing: true, destroyed: false });

    yt.update([B], true, 1);
    await flush();
    const b = lastPlayer();
    b.ready();
    b.playlist = ['x1', 'x2'];
    b.playlistIndex = 1;
    b.ended();
    expect(FakePlayer.all.length).toBe(2);
    expect(b.playAt).toEqual([0]);
    expect(b.playing).toBe(true);
  });

  test('editing the list keeps the link playing now; a removed one hands over to the link in its place', async () => {
    const { yt } = music();
    yt.update([A, B], true, 1);
    await flush();
    const a = lastPlayer();
    a.ready();
    yt.update([C, A, B, D], true, 1);
    await flush();
    expect(FakePlayer.all.length).toBe(1);
    expect(a.destroyed).toBe(false);
    yt.update([C, B, D], true, 1);
    expect(a.destroyed).toBe(true);
    await flush();
    expect(lastPlayer().opts.playerVars.list).toBe('PLbbbbbb');
    // the rotation goes on from there
    lastPlayer().ready();
    lastPlayer().ended();
    await flush();
    expect(lastPlayer().opts.videoId).toBe('DDDDDDDDDDD');
  });

  test('a link that cannot play is skipped; when none can, the reason is reported and the list change retries', async () => {
    const { yt, status } = music();
    yt.update(['hello', A, C], true, 1);
    expect(status).toEqual([null]);
    await flush();
    expect(lastPlayer().opts.videoId).toBe('AAAAAAAAAAA');
    lastPlayer().error(150);
    await flush();
    expect(lastPlayer().opts.videoId).toBe('CCCCCCCCCCC');
    expect(status).toEqual([null]);
    lastPlayer().error(100);
    expect(status[status.length - 1]).toBe('清單中的 YouTube 連結都無法播放（找不到這部影片（可能已刪除或設為私人）），已改播原創音樂');
    expect(youtubeNowPlaying()).toBeNull();
    expect(skipYouTube()).toBe(false);
    await flush();
    expect(FakePlayer.all.length).toBe(2);

    yt.update(['hello', A, C, D], true, 1);
    expect(status[status.length - 1]).toBeNull();
    await flush();
    expect(FakePlayer.all.length).toBe(3);
  });

  test('a single link keeps its old messages', async () => {
    const { yt, status } = music();
    yt.update([], true, 1);
    expect(status).toEqual(['尚未設定 YouTube 連結，已改播原創音樂']);
    yt.update(['hello'], true, 1);
    expect(status[1]).toBe('這不是 YouTube 影片或播放清單的連結，已改播原創音樂');
    yt.update(['hello', 'world'], true, 1);
    expect(status[2]).toBe('清單中沒有 YouTube 影片或播放清單的連結，已改播原創音樂');
    await flush();
    expect(FakePlayer.all.length).toBe(0);
    yt.update([A], true, 1);
    await flush();
    lastPlayer().error(101);
    expect(status[status.length - 1]).toBe('這部影片的上傳者不允許嵌入播放，請換一部影片，已改播原創音樂');
  });

  test('YouTube unreachable: every link fails at once', async () => {
    page(false);
    const { yt, status } = music();
    yt.update([A, C, D], true, 1);
    const script = head.children[0] as FakeEl;
    expect(script.src).toBe('https://www.youtube.com/iframe_api');
    script.onerror?.();
    await flush();
    expect(status[status.length - 1]).toBe('無法連線到 YouTube，請確認網路連線，已改播原創音樂');
    expect(head.children.length).toBe(1);
    yt.dispose();
  });

  test('「下一首」: the next link, a playlist\'s next video, a single video again; the settings screen sees the link', async () => {
    const { yt } = music();
    let notes = 0;
    const off = subscribeYouTube(() => void notes++);
    expect(youtubeNowPlaying()).toBeNull(); // no list yet
    yt.update([A, B], true, 1);
    expect(youtubeNowPlaying()).toBe(A);
    await flush();
    const a = lastPlayer();
    a.ready();
    const seen = notes;
    expect(skipYouTube()).toBe(true);
    expect(a.destroyed).toBe(true);
    expect(youtubeNowPlaying()).toBe(B);
    expect(notes).toBeGreaterThan(seen);
    await flush();
    const b = lastPlayer();
    b.ready();
    b.playlist = ['x1', 'x2'];
    expect(skipYouTube()).toBe(true);
    expect(b).toMatchObject({ nexts: 1, playing: true, destroyed: false });
    expect(youtubeNowPlaying()).toBe(B);
    // past the playlist's last video: the next link (wrapping to the first)
    skipYouTube();
    expect(b.destroyed).toBe(true);
    await flush();
    expect(lastPlayer().opts.videoId).toBe('AAAAAAAAAAA');
    // silent music: the link moves on, its player waits for the music to sound
    yt.update([A, B], false, 1);
    skipYouTube();
    expect(youtubeNowPlaying()).toBe(B);
    await flush();
    expect(FakePlayer.all.length).toBe(3);

    yt.update([C], true, 1);
    await flush();
    const c = lastPlayer();
    c.ready();
    skipYouTube();
    expect(c).toMatchObject({ seeks: 1, playing: true, destroyed: false });

    yt.dispose();
    expect(youtubeNowPlaying()).toBeNull();
    expect(skipYouTube()).toBe(false);
    off();
  });

  test('silent music: no player is made, and a playing one pauses', async () => {
    const { yt } = music();
    yt.update([A, C], false, 1);
    yt.update([A, C], true, 0);
    await flush();
    expect(FakePlayer.all.length).toBe(0);
    yt.update([A, C], true, 0.3);
    await flush();
    const a = lastPlayer();
    a.ready();
    expect(a).toMatchObject({ playing: true, volume: 30 });
    yt.update([A, C], false, 0.3);
    expect(a.playing).toBe(false);
    // the next link waits for the music to sound again
    a.ended();
    await flush();
    expect(FakePlayer.all.length).toBe(1);
    yt.update([A, C], true, 0.3);
    await flush();
    expect(lastPlayer().opts.videoId).toBe('CCCCCCCCCCC');
    yt.dispose();
    yt.update([A], true, 1);
    await flush();
    expect(FakePlayer.all.length).toBe(2);
  });
});
