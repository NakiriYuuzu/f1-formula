/**
 * Storage for the user-selected background-music file (the game ships no audio). The file bytes, name and MIME type
 * live in IndexedDB (never uploaded); this module also carries the small change / error notifications shared by the
 * settings screen and the music player. Every failure is an Error whose message is shown to the player as is.
 */

const DB_NAME = 'formula-nova-music';
const STORE = 'files';
const META_KEY = 'custom-meta';
const DATA_KEY = 'custom-data';

export const MAX_MUSIC_BYTES = 50 * 1024 * 1024;

export interface MusicFileInfo {
  name: string;
  type: string;
  size: number;
}

export interface StoredMusic extends MusicFileInfo {
  data: ArrayBuffer;
}

const UNAVAILABLE = '此瀏覽器無法儲存音樂檔（IndexedDB 不可用）';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(UNAVAILABLE));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(UNAVAILABLE));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      reject(new Error(UNAVAILABLE));
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(UNAVAILABLE));
    req.onblocked = () => reject(new Error(UNAVAILABLE));
  });
}

/** Run `fn` in one transaction and close the database afterwards. */
async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(UNAVAILABLE));
      tx.onabort = () => reject(tx.error ?? new Error('儲存空間不足，無法保存音樂檔'));
    });
    const result = await fn(tx.objectStore(STORE));
    await done;
    return result;
  } finally {
    db.close();
  }
}

function isInfo(v: unknown): v is MusicFileInfo {
  const r = v as Partial<MusicFileInfo> | null;
  return !!r && typeof r.name === 'string' && typeof r.type === 'string' && typeof r.size === 'number';
}

/** Name / type / size of the stored file, or null when none is stored. */
export async function readMusicInfo(): Promise<MusicFileInfo | null> {
  const meta = await withStore('readonly', (s) => request(s.get(META_KEY)));
  return isInfo(meta) ? meta : null;
}

/** The stored file with its bytes, or null when none is stored. */
export async function loadMusicFile(): Promise<StoredMusic | null> {
  return withStore('readonly', async (s) => {
    const [meta, data] = await Promise.all([request(s.get(META_KEY)), request(s.get(DATA_KEY))]);
    return isInfo(meta) && data instanceof ArrayBuffer ? { ...meta, data } : null;
  });
}

/** Validates and stores a picked file (replacing any previous one), then notifies listeners. */
export async function saveMusicFile(file: File): Promise<MusicFileInfo> {
  if (file.size > MAX_MUSIC_BYTES) throw new Error('檔案超過 50 MB，請選擇較小的音樂檔');
  if (file.size === 0) throw new Error('這個檔案是空的，請選擇其他音樂檔');
  const data = await file.arrayBuffer();
  const info: MusicFileInfo = { name: file.name, type: file.type, size: file.size };
  await withStore('readwrite', async (s) => {
    s.put(info, META_KEY);
    s.put(data, DATA_KEY);
  });
  reportMusicError(null);
  notifyMusic('file');
  return info;
}

export async function clearMusicFile(): Promise<void> {
  await withStore('readwrite', async (s) => {
    s.delete(META_KEY);
    s.delete(DATA_KEY);
  });
  reportMusicError(null);
  notifyMusic('file');
}

// ───────────────────────────── notifications ─────────────────────────────

let lastError: string | null = null;
const listeners = new Set<(kind: 'file' | 'error') => void>();

function notifyMusic(kind: 'file' | 'error'): void {
  for (const fn of [...listeners]) fn(kind);
}

/** Called whenever the stored file changes ('file') or the playback error changes ('error'). Returns the unsubscribe function. */
export function subscribeMusic(fn: (kind: 'file' | 'error') => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Last problem loading / decoding the stored file (null = none); shown in the settings screen. */
export function getMusicError(): string | null {
  return lastError;
}

export function reportMusicError(message: string | null): void {
  if (lastError === message) return;
  lastError = message;
  notifyMusic('error');
}
