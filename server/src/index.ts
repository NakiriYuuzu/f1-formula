/**
 * FORMULA NOVA 25 matchmaking Worker: POST /rooms → { code } (a new room Durable Object), GET /rooms/:code/ws →
 * WebSocket into that room (404 for an unknown code). Signalling only: the game itself runs peer to peer (WebRTC).
 */
import { isRoomCode, makeRoomCode } from './roomLogic';
import { Room, type Env } from './room';

export { Room };

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } : {};
}

const random = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname === '/rooms' && request.method === 'POST') {
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
      if (!isRoomCode(code)) return new Response('room not found', { status: 404, headers });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(new Request('https://room/ws', request));
    }
    if (url.pathname === '/' || url.pathname === '/health') return new Response('formula-nova signalling ok', { headers });
    return new Response('not found', { status: 404, headers });
  },
};
