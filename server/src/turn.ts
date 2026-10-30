/**
 * TURN relay credentials (coturn's REST API scheme, `use-auth-secret`): the username is "<expiry unix s>:<tag>", the
 * password base64(HMAC-SHA1(secret, username)). The relay server checks them with the same shared secret, so only
 * this Worker hands out working credentials, each valid TURN_TTL_S. Anyone who can call GET /turn gets one (the
 * Origin check keeps other web pages out, not scripts), so the relay itself is locked down
 * (server/turn/install-coturn.sh: UDP only, public peers only, a bandwidth cap per session, allocation quotas), and
 * every credential gets its own random tag: coturn counts a user's allocations by the tag, so one credential holds at
 * most its user-quota (many credentials can still fill the relay for a while; direct links are not affected).
 * Pure apart from Web Crypto (Workers, browsers and bun all have it).
 */

/** How long handed-out credentials work (s): a race weekend in one room. */
export const TURN_TTL_S = 24 * 60 * 60;

/** A TURN URL browsers accept (RFC 7065: turn[s]:host[:port][?transport=udp|tcp]); the game checks the same. */
const TURN_URL = /^turns?:(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(?:udp|tcp))?$/;

function isTurnUrl(url: string): boolean {
  const m = TURN_URL.exec(url);
  return m !== null && (m[1] === undefined || (Number(m[1]) >= 1 && Number(m[1]) <= 65535));
}

export interface TurnServers {
  /** RTCIceServer entries for the game (empty: no relay configured) */
  iceServers: { urls: string[]; username: string; credential: string }[];
  ttl: number;
}

/** "turn:host:3478?transport=udp, turn:host:3478?transport=tcp" → the well-formed turn: / turns: URLs in it. */
export function parseTurnUrls(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(isTurnUrl);
}

/** base64(HMAC-SHA1(secret, message)). */
export async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A fresh tag for one credential (12 hex digits). */
export function randomTag(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Credentials for `tag`, valid from `nowMs` for TURN_TTL_S on every URL of `urls`; no relay without a secret or a URL. */
export async function turnServers(secret: string | undefined, urls: string | undefined, nowMs: number, tag: string): Promise<TurnServers> {
  const list = parseTurnUrls(urls ?? '');
  if (!secret || list.length === 0) return { iceServers: [], ttl: 0 };
  const username = `${Math.floor(nowMs / 1000) + TURN_TTL_S}:${tag}`;
  return { iceServers: [{ urls: list, username, credential: await hmacSha1Base64(secret, username) }], ttl: TURN_TTL_S };
}
