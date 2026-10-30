/**
 * FORMULA NOVA 25 matchmaking Worker: POST /rooms → { code } (a new room Durable Object), GET /rooms/:code/ws →
 * WebSocket into that room (404 for an unknown code), GET /turn → TURN relay credentials ({ iceServers, ttl }; empty
 * without TURN_SECRET / TURN_URLS). Signalling only: the game itself runs peer to peer (WebRTC), through the relay
 * when a player asks for it. With ALLOWED_ORIGINS set, all three refuse (403, before any room is made) a request
 * whose Origin is not listed.
 */
import { isOriginAllowed, isRoomCode, makeRoomCode } from './roomLogic';
import { Room, type Env } from './room';
import { randomTag, turnServers } from './turn';

export { Room };

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  return isOriginAllowed(origin, env.ALLOWED_ORIGINS ?? '')
    ? { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
    : {};
}

const random = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const allowed = isOriginAllowed(request.headers.get('Origin'), env.ALLOWED_ORIGINS ?? '');
    if (url.pathname === '/rooms' && request.method === 'POST') {
      if (!allowed) return new Response('origin not allowed', { status: 403, headers });
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = makeRoomCode(random);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch('https://room/init', { method: 'POST' });
        if (res.status === 200) return Response.json({ code }, { headers });
      }
      return new Response('no free room code', { status: 503, headers });
    }
    const m = /^\/rooms\/([A-Z0-9]+)\/ws$/.exec(url.pathname);
    if (m && request.method === 'GET') {
      const code = m[1] ?? '';
      if (!allowed) return new Response('origin not allowed', { status: 403, headers });
      if (!isRoomCode(code)) return new Response('room not found', { status: 404, headers });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(new Request('https://room/ws', request));
    }
    if (url.pathname === '/turn' && request.method === 'GET') {
      if (!allowed) return new Response('origin not allowed', { status: 403, headers });
      const body = await turnServers(env.TURN_SECRET, env.TURN_URLS, Date.now(), randomTag());
      return Response.json(body, { headers: { ...headers, 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/' || url.pathname === '/health') return new Response('formula-nova signalling ok', { headers });
    return new Response('not found', { status: 404, headers });
  },
};
