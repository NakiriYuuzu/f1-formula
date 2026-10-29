/**
 * Optional local playlist (musicSource 'bundled'): music files the player put in `public/music/` for their own builds
 * — git-ignored, not part of the game. `public/music/bundled.json` names them, either one track looped everywhere
 *
 *   { "title": "...", "file": "<name>.mp3" }
 *
 * or a playlist
 *
 *   { "tracks": [ { "title": "...", "file": "<name>.mp3", "scenes": ["menu", "race", "results"] }, ... ] }
 *
 * The tracks of the current scene play in list order and the list loops; a track without `scenes` plays in every
 * scene, and a scene with no track of its own uses the whole list. Without a manifest the option does not exist.
 * Served from the game's own origin.
 */
import type { MusicScene } from './musicScore';
import type { StoredMusic } from './musicStore';

const MANIFEST_URL = './music/bundled.json';
const MAX_TRACKS = 50;
const SCENES: readonly MusicScene[] = ['menu', 'race', 'results'];

export interface BundledTrack {
  title: string;
  url: string;
  /** scenes the track plays in; null = every scene */
  scenes: readonly MusicScene[] | null;
}

/** The track MusicPlayer should play next. */
export interface BundledChoice {
  title: string;
  url: string;
  /** the only track of its scene: loop it instead of moving on */
  loop: boolean;
}

let snapshot: BundledTrack[] | null | undefined;
let pending: Promise<BundledTrack[] | null> | null = null;

function parseTrack(v: unknown): BundledTrack | null {
  const r = (typeof v === 'object' && v !== null ? v : {}) as { title?: unknown; file?: unknown; scenes?: unknown };
  // a plain file name inside public/music/
  if (typeof r.file !== 'string' || r.file.length === 0 || /[\\/]/.test(r.file) || r.file.startsWith('.')) return null;
  const title = typeof r.title === 'string' && r.title.trim().length > 0 ? r.title.trim().slice(0, 60) : r.file;
  const scenes = Array.isArray(r.scenes) ? SCENES.filter((s) => (r.scenes as unknown[]).includes(s)) : [];
  return { title, url: `./music/${encodeURIComponent(r.file)}`, scenes: scenes.length > 0 ? scenes : null };
}

async function readManifest(): Promise<BundledTrack[] | null> {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    // a dev server answers a missing file with index.html: json() then throws
    const r = (await res.json()) as { tracks?: unknown };
    const raw = Array.isArray(r.tracks) ? r.tracks.slice(0, MAX_TRACKS) : [r];
    const tracks = raw.map(parseTrack).filter((t): t is BundledTrack => t !== null);
    return tracks.length > 0 ? tracks : null;
  } catch {
    return null;
  }
}

/** The installed playlist, or null when none is installed (the manifest is read once). */
export function bundledPlaylist(): Promise<BundledTrack[] | null> {
  if (!pending) {
    pending = readManifest().then((tracks) => {
      snapshot = tracks;
      return tracks;
    });
  }
  return pending;
}

/** Forget the manifest so the next read fetches it again (tests). */
export function resetBundledTrackCache(): void {
  snapshot = undefined;
  pending = null;
}

/** Synchronous view for the settings screen: undefined while the manifest is still being read. */
export function bundledPlaylistNow(): BundledTrack[] | null | undefined {
  return snapshot;
}

/** Tracks that play in `scene` (the whole list when none is marked for it). */
export function tracksForScene(tracks: readonly BundledTrack[], scene: MusicScene): BundledTrack[] {
  const own = tracks.filter((t) => t.scenes === null || t.scenes.includes(scene));
  return own.length > 0 ? own : [...tracks];
}

/**
 * The track to play in `scene`: `current` (a track url) again while it belongs to the scene and `advance` is false,
 * otherwise the scene's next track after it (wrapping; its first track when `current` is not one of them).
 */
export async function chooseBundled(scene: MusicScene, current: string | null, advance: boolean): Promise<BundledChoice | null> {
  const tracks = await bundledPlaylist();
  if (!tracks) return null;
  const list = tracksForScene(tracks, scene);
  const at = list.findIndex((t) => t.url === current);
  const pick = at < 0 ? list[0] : advance ? list[(at + 1) % list.length] : list[at];
  if (!pick) return null;
  return { title: pick.title, url: pick.url, loop: list.length === 1 };
}

/** A playlist track's bytes. */
export async function loadBundledMusic(track: Pick<BundledChoice, 'title' | 'url'>): Promise<StoredMusic> {
  const res = await fetch(track.url);
  if (!res.ok) throw new Error(`找不到本機曲目「${track.title}」的音樂檔`);
  const data = await res.arrayBuffer();
  return { name: track.title, type: res.headers.get('content-type') ?? '', size: data.byteLength, data };
}
