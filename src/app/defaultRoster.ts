/**
 * Optional default roster pack: `public/rosters/default.json`, the player's own file (git-ignored, not part of the
 * game). Read once at boot before the menus start; it applies while no pack was imported and the built-in roster
 * was not chosen (meta/rosterPack.ts). Missing or invalid → the built-in roster, the game starts anyway.
 */
import { parseRosterPackText, setDefaultRosterPack } from '../meta/rosterPack';

const URL_DEFAULT = './rosters/default.json';

export async function loadDefaultRoster(timeoutMs = 2000): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(URL_DEFAULT, { cache: 'no-cache', signal: abort.signal });
    if (!res.ok) return;
    const text = await res.text();
    // a dev server answers a missing file with index.html
    if (text.trimStart().startsWith('<')) return;
    const result = parseRosterPackText(text);
    if (result.ok) setDefaultRosterPack(result.pack);
    else console.warn('[formula-nova] public/rosters/default.json 無法使用：', result.errors.join('；'));
  } catch {
    // no default pack (offline file, timeout): the built-in roster
  } finally {
    clearTimeout(timer);
  }
}
