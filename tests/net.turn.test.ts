/**
 * TURN relay credentials (server/src/turn.ts, the Worker's GET /turn) and the game reading them
 * (src/net/signal/cloudflare.ts fetchIceServers): coturn's REST scheme (HMAC-SHA1 of "<expiry>:<tag>", a fresh tag per
 * credential: coturn's quotas count by it), well-formed URLs only, no relay without a secret or a URL, the route's
 * origin check and no caching, malformed answers dropped, a server that is down or refuses reported.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import worker from '../server/src/index';
import type { Env } from '../server/src/room';
import { TURN_TTL_S, hmacSha1Base64, parseTurnUrls, randomTag, turnServers } from '../server/src/turn';
import { fetchIceServers } from '../src/net/signal/cloudflare';

const URLS = 'turn:203.0.113.7:3478?transport=udp, turn:203.0.113.7:3478?transport=tcp';

function env(over: Partial<Env> = {}): Env {
  return { ROOMS: null as never, ALLOWED_ORIGINS: 'https://github.yuuzu.net', TURN_SECRET: 's3cret', TURN_URLS: URLS, ...over };
}

describe('credentials', () => {
  test('HMAC-SHA1 in base64, as coturn computes it', async () => {
    for (const [secret, message] of [
      ['s3cret', '1767225600:nova'],
      ['Jefe', 'what do ya want for nothing?'],
      ['x'.repeat(100), ''],
    ] as const) {
      expect(await hmacSha1Base64(secret, message)).toBe(createHmac('sha1', secret).update(message).digest('base64'));
    }
  });

  test('the URL list: well-formed turn: and turns: URLs, trimmed; anything else (a browser would refuse it) dropped', () => {
    expect(parseTurnUrls(URLS)).toEqual(['turn:203.0.113.7:3478?transport=udp', 'turn:203.0.113.7:3478?transport=tcp']);
    expect(parseTurnUrls('turns:relay.example:5349, turn:[2001:db8::7]:3478, turn:relay-1.example')).toEqual([
      'turns:relay.example:5349',
      'turn:[2001:db8::7]:3478',
      'turn:relay-1.example',
    ]);
    const bad = ['stun:stun.example:3478', '', 'https://x', 'turn:a b', 'turn:1.2.3.4:3478?transport=udpp', 'turn:1.2.3.4:347800', 'turn:1.2.3.4:65536', 'turn:1.2.3.4:0', 'turn:', 'turn:1.2.3.4:3478?x=1', 'turn://1.2.3.4'];
    expect(parseTurnUrls(bad.join(','))).toEqual([]);
  });

  test('valid for a day from now on every URL, under its own tag; none without a secret or a URL', async () => {
    const now = 1_767_225_600_000;
    const t = await turnServers('s3cret', URLS, now + 999, 'a1b2c3d4e5f6');
    expect(t.ttl).toBe(TURN_TTL_S);
    expect(t.iceServers).toHaveLength(1);
    const s = t.iceServers[0]!;
    expect(s.urls).toHaveLength(2);
    expect(s.username).toBe(`${now / 1000 + TURN_TTL_S}:a1b2c3d4e5f6`);
    expect(s.credential).toBe(createHmac('sha1', 's3cret').update(s.username).digest('base64'));
    for (const [secret, urls] of [
      [undefined, URLS],
      ['', URLS],
      ['s3cret', undefined],
      ['s3cret', ' , stun:x:3478'],
    ] as const) {
      expect(await turnServers(secret, urls, now, 'a1b2c3d4e5f6')).toEqual({ iceServers: [], ttl: 0 });
    }
    // tags: 12 hex digits, a new one each time
    const tags = new Set(Array.from({ length: 50 }, () => randomTag()));
    expect(tags.size).toBe(50);
    for (const tag of tags) expect(tag).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('GET /turn', () => {
  const get = (origin: string | null, e: Env = env(), method = 'GET'): Promise<Response> =>
    worker.fetch(new Request('https://signal.example/turn', { method, headers: origin ? { Origin: origin } : {} }), e);

  test("the game's own origin gets credentials, never cached", async () => {
    const res = await get('https://github.yuuzu.net');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://github.yuuzu.net');
    const body = (await res.json()) as { iceServers: { urls: string[]; username: string; credential: string }[]; ttl: number };
    expect(body.ttl).toBe(TURN_TTL_S);
    expect(body.iceServers[0]!.urls).toEqual(parseTurnUrls(URLS));
    expect(body.iceServers[0]!.credential).toBe(createHmac('sha1', 's3cret').update(body.iceServers[0]!.username).digest('base64'));
    // each caller its own tag (coturn's per-user allocation quota)
    const again = (await (await get('https://github.yuuzu.net')).json()) as typeof body;
    const tag = (u: string): string => u.slice(u.indexOf(':') + 1);
    expect(tag(again.iceServers[0]!.username)).not.toBe(tag(body.iceServers[0]!.username));
    expect(tag(body.iceServers[0]!.username)).toMatch(/^[0-9a-f]{12}$/);
  });

  test('another origin, or none, is refused; without a relay the answer is empty', async () => {
    expect((await get('https://elsewhere.example')).status).toBe(403);
    expect((await get(null)).status).toBe(403);
    const none = await get('https://github.yuuzu.net', env({ TURN_SECRET: undefined }));
    expect(await none.json()).toEqual({ iceServers: [], ttl: 0 });
    expect((await get('https://github.yuuzu.net', env(), 'POST')).status).toBe(404);
  });
});

describe('fetchIceServers', () => {
  /** Run `f` with fetch answered by `answer` (the request's URL passed in). */
  async function withFetch<T>(answer: (url: string) => Promise<Response>, f: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => answer(String(input instanceof Request ? input.url : input))) as typeof fetch;
    try {
      return await f();
    } finally {
      globalThis.fetch = real;
    }
  }

  test("the Worker's relay as ICE servers (a trailing slash on the server URL is fine)", async () => {
    const seen: string[] = [];
    const servers = await withFetch(
      (url) => {
        seen.push(url);
        return worker.fetch(new Request(url, { headers: { Origin: 'https://github.yuuzu.net' } }), env());
      },
      () => fetchIceServers('https://signal.example/'),
    );
    expect(seen).toEqual(['https://signal.example/turn']);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.urls).toEqual(parseTurnUrls(URLS));
    expect(typeof servers[0]!.username).toBe('string');
    expect(typeof servers[0]!.credential).toBe('string');
  });

  test('no relay when the server has none, predates the route or answers nonsense', async () => {
    const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
    const cases: ((url: string) => Promise<Response>)[] = [
      json({ iceServers: [], ttl: 0 }),
      async () => new Response('not found', { status: 404 }),
      async () => new Response('<html>', { status: 200 }),
      json({ iceServers: 'turn:x' }),
      // a STUN URL, a malformed TURN URL, a missing credential, a numeric username: not a relay
      json({
        iceServers: [
          { urls: ['stun:x:3478'], username: 'u', credential: 'c' },
          { urls: ['turn:x:3478?transport=udpp'], username: 'u', credential: 'c' },
          { urls: ['turn:x:70000'], username: 'u', credential: 'c' },
          { urls: ['turn:x:3478'], username: 'u' },
          { urls: ['turn:x:3478'], username: 1, credential: 'c' },
        ],
      }),
    ];
    for (const answer of cases) expect(await withFetch(answer, () => fetchIceServers('https://signal.example'))).toEqual([]);
  });

  test('a server that is down or refuses is reported (not taken for one without a relay)', async () => {
    const down = async (): Promise<Response> => {
      throw new TypeError('network down');
    };
    await expect(withFetch(down, () => fetchIceServers('https://signal.example'))).rejects.toThrow('無法連線到配對伺服器');
    const refused = async (): Promise<Response> => new Response('origin not allowed', { status: 403 });
    await expect(withFetch(refused, () => fetchIceServers('https://signal.example'))).rejects.toThrow('（403）');
  });
});
