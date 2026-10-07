/**
 * Low-level persistence: localStorage when usable, otherwise an in-memory store (bun tests, private browsing,
 * disabled storage). Every key is `${STORAGE_PREFIX}v${SCHEMA_VERSION}:<name>` and every value is a JSON
 * envelope `{ schema, savedAt, data }`. Missing, unparsable or other-schema data reads as `undefined`.
 * Nothing in this module throws.
 */
import { STORAGE_PREFIX } from '../core/defaults';
import { isRecord } from './guards';

export const SCHEMA_VERSION = 1;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Map-backed store used when localStorage is unavailable. */
export class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let store: KeyValueStore | null = null;
/** Values whose write failed (quota, disabled storage): kept for this page session so reads stay consistent. */
const overlay = new Map<string, string>();

function detectStore(): KeyValueStore {
  try {
    const candidate = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    if (candidate) {
      const probe = `${STORAGE_PREFIX}__probe`;
      candidate.setItem(probe, '1');
      candidate.removeItem(probe);
      return candidate;
    }
  } catch {
    // storage blocked (sandboxed iframe, privacy mode) → memory fallback
  }
  return new MemoryStore();
}

export function getStore(): KeyValueStore {
  if (!store) store = detectStore();
  return store;
}

/** Replace the backing store (tests / fixtures). `null` re-detects on next access. */
export function setStore(next: KeyValueStore | null): void {
  store = next;
  overlay.clear();
}

export function storageKey(name: string): string {
  return `${STORAGE_PREFIX}v${SCHEMA_VERSION}:${name}`;
}

function readRaw(key: string): string | null {
  const pending = overlay.get(key);
  if (pending !== undefined) return pending;
  try {
    return getStore().getItem(key);
  } catch {
    return null;
  }
}

/** Data stored under `name`, or undefined when missing / corrupt / written by another schema version. */
export function readRecord(name: string): unknown {
  const raw = readRaw(storageKey(name));
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.schema !== SCHEMA_VERSION || !('data' in parsed)) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

/** Persist `data` (must be JSON-serialisable). Returns false if it could only be kept in memory. */
export function writeRecord(name: string, data: unknown): boolean {
  const key = storageKey(name);
  let json: string;
  try {
    json = JSON.stringify({ schema: SCHEMA_VERSION, savedAt: new Date().toISOString(), data });
  } catch {
    return false;
  }
  try {
    getStore().setItem(key, json);
    overlay.delete(key);
    return true;
  } catch {
    overlay.set(key, json);
    return false;
  }
}

export function removeRecord(name: string): void {
  const key = storageKey(name);
  overlay.delete(key);
  try {
    getStore().removeItem(key);
  } catch {
    // ignore
  }
}
