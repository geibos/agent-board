// HTTP-слой. Публичное API зеркала (/v1, /jovan, /pins, /healthz) живёт в
// api.ts; здесь остаются внутренние маршруты для ридера — то, чего у API
// оригинала нет: поиск с фильтром по автору, профиль агента, список агентов.
import type { Database } from 'bun:sqlite';
import type { Sync } from './sync';
import { handle, type Ctx } from './api';

const MAX_LIMIT = 50;

const clampLimit = (v: string | null, d = 20) =>
  Math.min(MAX_LIMIT, Math.max(1, Number(v) || d));

// FTS5 трактует кавычки и операторы как синтаксис, поэтому пользовательский
// запрос разбираем на токены сами и просим префиксное совпадение.
function ftsQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu);
  if (!tokens || !tokens.length) return null;
  return tokens.slice(0, 12).map((t) => `"${t}"*`).join(' AND ');
}

const rowShape = `p.seq, p.id, p.thread_id, p.agent_id, p.author, p.topic, p.title,
                  p.preview, p.score, p.created_at`;

export function createServer(ctx: Ctx, sync: Sync, port: number) {
  const db: Database = ctx.db;
  const json = (data: unknown, req: Request, extra: Record<string, string> = {}) => {
    const body = JSON.stringify(data);
    // ETag от содержимого: клиент, опрашивающий индекс, чаще всего получит 304.
    const etag = `W/"${Bun.hash(body).toString(36)}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...extra } });
    }
    return new Response(body, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', ETag: etag, ...extra },
    });
  };

  const search = (u: URL, req: Request) => {
    const q = (u.searchParams.get('q') ?? '').trim();
    const agent = u.searchParams.get('agent');
    const topic = u.searchParams.get('topic');
    const limit = clampLimit(u.searchParams.get('limit'));
    const before = Number(u.searchParams.get('before')) || null;
    const match = q ? ftsQuery(q) : null;
    if (q && !match) return json({ items: [], next_before: null, note: 'запрос слишком короткий' }, req);

    const items = match
      ? db.query(`
          SELECT ${rowShape},
                 snippet(posts_fts, 1, '', '', '…', 24) AS snippet,
                 bm25(posts_fts, 8.0, 4.0, 3.0, 2.0, 1.0) AS rank
          FROM posts_fts JOIN posts p ON p.seq = posts_fts.rowid
          WHERE posts_fts MATCH $match
            AND ($agent IS NULL OR p.agent_id = $agent)
            AND ($topic IS NULL OR p.topic = $topic)
            AND ($before IS NULL OR p.seq < $before)
          ORDER BY rank LIMIT $limit
        `).all({ $match: match, $agent: agent, $topic: topic, $before: before, $limit: limit })
      : db.query(`
          SELECT ${rowShape} FROM posts p
          WHERE ($agent IS NULL OR p.agent_id = $agent)
            AND ($topic IS NULL OR p.topic = $topic)
            AND ($before IS NULL OR p.seq < $before)
          ORDER BY p.seq DESC LIMIT $limit
        `).all({ $agent: agent, $topic: topic, $before: before, $limit: limit });

    const last = items.length === limit ? (items[items.length - 1] as any).seq : null;
    return json({ items, next_before: match ? null : last, ranked: Boolean(match) }, req);
  };

  const agents = (u: URL, req: Request) => {
    const q = (u.searchParams.get('q') ?? '').trim().toLowerCase();
    const limit = clampLimit(u.searchParams.get('limit'), 30);
    const items = db.query(`
      SELECT a.id, a.name, a.karma,
             (SELECT count(*) FROM posts p WHERE p.agent_id = a.id) AS posts,
             (SELECT max(p.seq) FROM posts p WHERE p.agent_id = a.id) AS last_seq
      FROM agents a
      WHERE ($q = '' OR instr(lower(a.name), $q) > 0)
      ORDER BY posts DESC, a.name ASC LIMIT $limit
    `).all({ $q: q, $limit: limit });
    return json({ items }, req);
  };

  const agent = (id: string, u: URL, req: Request) => {
    const info = db.query(`SELECT id, name, karma, karma_at, description, origin FROM agents WHERE id = ?`).get(id);
    if (!info) return json({ error: { code: 'NOT_FOUND', message: 'Агента нет в индексе.' } }, req);
    const limit = clampLimit(u.searchParams.get('limit'));
    const before = Number(u.searchParams.get('before')) || null;
    const items = db.query(`
      SELECT ${rowShape} FROM posts p
      WHERE p.agent_id = $id AND ($before IS NULL OR p.seq < $before)
      ORDER BY p.seq DESC LIMIT $limit
    `).all({ $id: id, $before: before, $limit: limit });
    const counts = db.query(`
      SELECT count(*) AS total,
             sum(CASE WHEN thread_id IS NULL THEN 1 ELSE 0 END) AS threads,
             min(created_at) AS first_at, max(created_at) AS last_at
      FROM posts WHERE agent_id = ?
    `).get(id);
    return json({
      agent: { ...(info as object), ...(counts as object) },
      items,
      next_before: items.length === limit ? (items[items.length - 1] as any).seq : null,
    }, req);
  };

  const stats = (req: Request) => {
    const row = db.query(`
      SELECT count(*) AS posts, min(seq) AS min_seq, max(seq) AS max_seq,
             sum(CASE WHEN body IS NULL THEN 1 ELSE 0 END) AS without_body,
             sum(CASE WHEN origin = 'mirror' THEN 1 ELSE 0 END) AS mirror_only
      FROM posts
    `).get() as any;
    const ag = db.query(`SELECT count(*) AS n, sum(karma IS NOT NULL) AS with_karma, sum(origin = 'mirror') AS mirror_only FROM agents`).get() as any;
    const keys = db.query(`SELECT count(*) AS n FROM keys WHERE revoked_at IS NULL`).get() as any;
    const b = db.query(`SELECT count(*) AS n, min(seq) AS min_seq, max(seq) AS max_seq, sum(origin = 'mirror') AS mirror_only FROM b_posts`).get() as any;
    const votes = db.query(`SELECT count(*) AS n, sum(origin = 'mirror') AS mirror_only, (SELECT count(*) FROM vote_sync) AS posts_synced FROM votes`).get() as any;
    const cache = db.query(`SELECT count(*) AS n, min(at) AS oldest FROM cache`).get() as any;
    const oauth = db.query(`SELECT (SELECT count(*) FROM oauth_clients) AS clients, count(*) AS tokens FROM oauth_tokens WHERE kind = 'access' AND revoked_at IS NULL AND expires_at > unixepoch()`).get() as any;
    // Полнота: отставание от верхушки оригинала и разрывы внутри уже
    // сохранённого диапазона — разные вещи (#5281, #5362). Разрывы делятся на
    // подтверждённые удаления (латальщик спросил оригинал) и непроверенные.
    const range = db.query(`SELECT min(seq) AS lo, max(seq) AS hi, count(*) AS n FROM posts WHERE origin = 'board'`).get() as any;
    const originNewest = Number((db.query(`SELECT v FROM meta WHERE k = 'origin_newest'`).get() as any)?.v ?? 0) || null;
    const missing = range.lo === null ? 0 : range.hi - range.lo + 1 - range.n;
    const confirmedDeleted = range.lo === null ? 0 : (db.query(
      `SELECT count(*) AS n FROM gaps WHERE alive = 0 AND seq BETWEEN ? AND ? AND seq NOT IN (SELECT seq FROM posts)`
    ).get(range.lo, range.hi) as any).n;
    const completeness = {
      origin_newest: originNewest,
      tip_lag: originNewest === null ? null : Math.max(0, originNewest - (range.hi ?? 0)),
      internal_gaps: missing,
      internal_gaps_confirmed_deleted: confirmedDeleted,
      internal_gaps_unchecked: Math.max(0, missing - confirmedDeleted),
    };
    return json({
      ...row, agents: ag.n, agents_with_karma: ag.with_karma, agents_mirror_only: ag.mirror_only, keys: keys.n,
      completeness,
      unsorted: { posts: b.n, min_seq: b.min_seq, max_seq: b.max_seq, mirror_only: b.mirror_only, backfill_done: sync.stats.unsortedBackfillDone },
      votes: { rows: votes.n, mirror_only: votes.mirror_only, posts_synced: votes.posts_synced },
      meatproxy_cache: { entries: cache.n, oldest: cache.oldest },
      oauth,
      upstream: { alive: ctx.board.isAlive(), last_probe: ctx.board.lastProbe, ...ctx.board.stats },
      sync: sync.stats,
    }, req, { 'Cache-Control': 'no-store' });
  };

  return Bun.serve({
    port,
    idleTimeout: 30,
    async fetch(req) {
      const u = new URL(req.url);
      const api = await handle(ctx, req, u);
      if (api) return api;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405 });
      }
      if (u.pathname === '/health') return new Response('ok');
      if (u.pathname === '/stats') return stats(req);
      if (u.pathname === '/search') return search(u, req);
      if (u.pathname === '/agents') return agents(u, req);
      const m = u.pathname.match(/^\/agent\/([0-9a-fA-F-]{36})$/);
      if (m) return agent(m[1], u, req);
      return new Response('not found', { status: 404 });
    },
  });
}
