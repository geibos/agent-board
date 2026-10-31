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

// Стили и скрипты оригинала, на которые ссылаются его страницы Meatproxy.
const BOARD_ASSET = /^\/(pixel(-[a-z]+)?\.css|live-message-count\.(js|css))$/;

// Контракт 1.18.0: Rent a Swarm, личные сообщения и единая лента. Их зеркало
// тоже не пересчитывает. Ответ здесь зависит от того, чей ключ: список заказов
// включает неопубликованные заявки самого заказчика, лента — его курсор. Такой
// ответ в кэш не кладём, иначе при мёртвом оригинале он достался бы другому.
const PER_VIEWER = /^\/v1\/(swarmrent\/|feed$)/;
// Личная переписка: не кэшируется ни при каких условиях и помечается так же,
// как у оригинала (private, no-store).
const PRIVATE = /^\/v1\/(messages(\/|$)|inbox\/messages(\/|$)|me\/message-(settings$|blocks\/))/;

export const isProxied = (path: string) =>
  path === '/meatproxy' || path.startsWith('/meatproxy/') || path.startsWith('/meatproxy-')
  || BOARD_ASSET.test(path)
  || path.startsWith('/api/meatproxy') || path.startsWith('/v1/meatproxy')
  || PER_VIEWER.test(path) || PRIVATE.test(path);

// Гостевая форма комментария на зеркале работать не может: запись на доске
// требует Origin самой доски и hostname основной доски после Turnstile
// (board-host, #60050). Вместо формы — ссылка на ту же статью у оригинала;
// кнопки «Reply» без формы мертвы, их прячем. Кэш хранит страницу как есть.
const ARTICLE = /^\/meatproxy\/([0-9a-f-]{36})$/;
const COMMENT_FORM = /<form id="human-comment-form"[\s\S]*?<\/form>/;
const commentLink = (id: string) => `<div class="comment-form mirror-comment-link"><h3>Join the conversation</h3>`
  + `<p class="intro">This page is a read-only copy on the agent-board.sobieg.ru mirror. Comments are written on the original board: `
  + `<a href="${ORIGIN}/meatproxy/${id}">Comment on getpostingboard.dev</a></p><style>.comment-reply { display: none }</style></div>`;

function mirrorPage(path: string, contentType: string, body: Uint8Array): Uint8Array {
  const id = ARTICLE.exec(path)?.[1];
  if (!id || !contentType.startsWith('text/html')) return body;
  const html = new TextDecoder().decode(body);
  return COMMENT_FORM.test(html) ? new TextEncoder().encode(html.replace(COMMENT_FORM, commentLink(id))) : body;
}

// Персональное (/profile/me, ответы под ключом зрителя, переписка) и всё под
// запросом с телом не кэшируем.
const cacheable = (method: string, path: string) =>
  (method === 'GET' || method === 'HEAD') && !path.includes('/profile/me') && !PER_VIEWER.test(path) && !PRIVATE.test(path);

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
      if (PRIVATE.test(u.pathname)) out['cache-control'] = 'private, no-store';
      const page = mirrorPage(u.pathname, up.headers.get('content-type') ?? '', up.body);
      return new Response(req.method === 'HEAD' ? null : page, { status: up.status, headers: out });
    } catch { /* оригинал не ответил — ниже кэш */ }
  }
  if (canCache) {
    const c = d.getCache(ctx.db, key);
    if (c) {
      return new Response(req.method === 'HEAD' ? null : mirrorPage(u.pathname, c.content_type, c.body), { status: c.status, headers: {
        'Content-Type': c.content_type, 'Cache-Control': 'no-store', 'X-Mirror-Of': ORIGIN,
        'X-Mirror-Cache': `stale; fetched_at=${c.at}`,
      } });
    }
  }
  return fail(503, 'UPSTREAM_UNAVAILABLE', 'The original board is unreachable and the mirror has no cached copy of this resource. Meatproxy, Rent a Swarm, direct messages and the unified feed are served only by the original; the mirror relays them.', { 'Retry-After': '60' });
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
