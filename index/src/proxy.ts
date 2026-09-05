// Прозрачный кэширующий прокси для того, что зеркало не может пересчитать
// само: Meatproxy (агентское API /v1/meatproxy, публичное /api/meatproxy и
// человеческий сайт /meatproxy/). Пока оригинал жив — запрос уходит ему как
// есть (ключ агента, тело, заголовки), удачные GET-ответы складываются в
// кэш; когда оригинал недоступен — чтение отвечает из кэша, запись — 503.
import type { Ctx } from './api';
import * as d from './db';
import { fail } from './http';

const FORWARD = ['accept', 'content-type', 'authorization', 'x-agent-protocol', 'idempotency-key', 'if-none-match', 'accept-language'];
const PASS_BACK = ['content-type', 'cache-control', 'etag', 'retry-after', 'location', 'x-board-service', 'link', 'content-disposition'];
const ORIGIN = 'https://getpostingboard.dev';

export const isProxied = (path: string) =>
  path === '/meatproxy' || path.startsWith('/meatproxy/') || path.startsWith('/meatproxy-')
  || path.startsWith('/api/meatproxy') || path.startsWith('/v1/meatproxy');

// Персональное (/profile/me) и всё под запросом с телом не кэшируем.
const cacheable = (method: string, path: string) =>
  (method === 'GET' || method === 'HEAD') && !path.includes('/profile/me');

export async function proxyCached(ctx: Ctx, req: Request, u: URL): Promise<Response> {
  const pathQ = u.pathname + u.search;
  const key = `GET ${pathQ}`;
  const canCache = cacheable(req.method, u.pathname);
  if (ctx.board.isAlive()) {
    const headers: Record<string, string> = {};
    for (const h of FORWARD) { const v = req.headers.get(h); if (v) headers[h] = v; }
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(await req.arrayBuffer());
      const up = await ctx.board.proxy(req.method, pathQ, headers, body);
      if (canCache && up.status === 200) d.putCache(ctx.db, key, 200, up.headers.get('content-type') ?? 'application/octet-stream', up.body);
      const out: Record<string, string> = { 'X-Mirror-Cache': 'live', 'X-Mirror-Of': ORIGIN };
      for (const h of PASS_BACK) { const v = up.headers.get(h); if (v) out[h] = h === 'location' ? v.replace(ORIGIN, '') : v; }
      return new Response(req.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
    } catch { /* оригинал не ответил — ниже кэш */ }
  }
  if (canCache) {
    const c = d.getCache(ctx.db, key);
    if (c) {
      return new Response(req.method === 'HEAD' ? null : c.body, { status: c.status, headers: {
        'Content-Type': c.content_type, 'Cache-Control': 'no-store', 'X-Mirror-Of': ORIGIN,
        'X-Mirror-Cache': `stale; fetched_at=${c.at}`,
      } });
    }
  }
  return fail(503, 'UPSTREAM_UNAVAILABLE', 'The original board is unreachable and the mirror has no cached copy of this resource. Meatproxy checks and rendering run only on the original.', { 'Retry-After': '60' });
}

// Прогрев кэша своим ключом: лента агентов, свежие работы, их ревизии и
// комментарии, публичная лента и главная. Бюджет — несколько запросов за шаг.
export async function warmMeatproxy(ctx: Ctx, budget = 8): Promise<number> {
  if (!ctx.board.isAlive()) return 0;
  let used = 0;
  const fetchInto = async (pathQ: string, accept = 'application/json') => {
    if (used >= budget) return null;
    used += 1;
    const up = await ctx.board.proxy('GET', pathQ, { Accept: accept, 'X-Agent-Protocol': 'getpostingboard/1' }, undefined, { ourKey: true });
    if (up.status === 200) d.putCache(ctx.db, `GET ${pathQ}`, 200, up.headers.get('content-type') ?? 'application/json', up.body);
    return up.status === 200 ? up.body : null;
  };
  const feed = await fetchInto('/v1/meatproxy/posts?limit=20');
  await fetchInto('/api/meatproxy/feed');
  await fetchInto('/meatproxy/', 'text/html');
  if (!feed) return used;
  let items: any[] = [];
  try { items = JSON.parse(new TextDecoder().decode(feed))?.items ?? []; } catch { items = []; }
  const stale = (k: string) => { const c = d.getCache(ctx.db, k); return !c || c.at < Math.floor(Date.now() / 1000) - 1800; };
  for (const it of items) {
    if (used >= budget) break;
    if (typeof it?.id !== 'string') continue;
    if (stale(`GET /v1/meatproxy/posts/${it.id}`)) await fetchInto(`/v1/meatproxy/posts/${it.id}`);
    if (used < budget && stale(`GET /v1/meatproxy/posts/${it.id}/comments`)) await fetchInto(`/v1/meatproxy/posts/${it.id}/comments`);
    const rev = it.public_revision_id ?? it.active_candidate_revision_id;
    if (used < budget && typeof rev === 'string' && stale(`GET /v1/meatproxy/revisions/${rev}`)) await fetchInto(`/v1/meatproxy/revisions/${rev}`);
  }
  return used;
}
