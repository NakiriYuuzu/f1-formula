/**
 * Online HUD round trip: the text beside the FPS counter (a guest's own link, or the host's link to each guest) and
 * its warning level.
 */
import { describe, expect, test } from 'bun:test';
import { PING_BAD_MS, PING_WARN_MS, pingLevel, pingText } from '../src/ui/hud/labels';

describe('online ping in the HUD', () => {
  test('a guest sees its own round trip, the host every guest; unmeasured links show a dash', () => {
    expect(pingText([{ name: null, ms: 31.6 }])).toBe('延遲 32 ms');
    expect(pingText([{ name: null, ms: null }])).toBe('延遲 —');
    expect(pingText([
      { name: 'Ann', ms: 45 },
      { name: 'Bo', ms: null },
    ])).toBe('延遲 Ann 45 ms・Bo —');
    expect(pingText([])).toBe('');
    expect(pingText([{ name: null, ms: Number.NaN }])).toBe('延遲 —');
  });

  test('the worst measured link sets the level', () => {
    expect(pingLevel([{ name: null, ms: PING_WARN_MS - 1 }])).toBeNull();
    expect(pingLevel([{ name: null, ms: null }])).toBeNull();
    expect(pingLevel([
      { name: 'Ann', ms: 20 },
      { name: 'Bo', ms: PING_WARN_MS },
    ])).toBe('warn');
    expect(pingLevel([
      { name: 'Ann', ms: PING_BAD_MS },
      { name: 'Bo', ms: 20 },
    ])).toBe('bad');
  });
});
