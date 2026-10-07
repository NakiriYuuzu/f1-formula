/**
 * Optional bundled track (musicSource 'bundled'): a music file the player put in `public/music/` for their own
 * builds — git-ignored, not part of the game. `public/music/bundled.json` = { "title": "...", "file": "<name>.mp3" }
 * names it; without that manifest the option does not exist. Served from the game's own origin.
 */
import type { StoredMusic } from './musicStore';

const MANIFEST_URL = './music/bundled.json';

export interface BundledTrack {
  title: string;
  url: string;
}

let snapshot: BundledTrack | null | undefined;
let pending: Promise<BundledTrack | null> | null = null;

async function readManifest(): Promise<BundledTrack | null> {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    // a dev server answers a missing file with index.html: json() then throws
    const r = (await res.json()) as { title?: unknown; file?: unknown };
    // a plain file name inside public/music/
    if (typeof r.file !== 'string' || r.file.length === 0 || /[\\/]/.test(r.file) || r.file.startsWith('.')) return null;
    const title = typeof r.title === 'string' && r.title.trim().length > 0 ? r.title.trim().slice(0, 60) : r.file;
    return { title, url: `./music/${encodeURIComponent(r.file)}` };
  } catch {
    return null;
  }
}

/** The bundled track, or null when none is installed (the manifest is read once). */
export function bundledTrack(): Promise<BundledTrack | null> {
  if (!pending) {
    pending = readManifest().then((track) => {
      snapshot = track;
      return track;
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
export function bundledTrackNow(): BundledTrack | null | undefined {
  return snapshot;
}

/** Loader for MusicPlayer: the bundled file's bytes, or null when no track is installed. */
export async function loadBundledMusic(): Promise<StoredMusic | null> {
  const track = await bundledTrack();
  if (!track) return null;
  const res = await fetch(track.url);
  if (!res.ok) throw new Error(`找不到內建曲目「${track.title}」的音樂檔`);
  const data = await res.arrayBuffer();
  return { name: track.title, type: res.headers.get('content-type') ?? '', size: data.byteLength, data };
}
