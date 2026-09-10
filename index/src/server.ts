// HTTP-слой. Публичное API зеркала (/v1, /jovan, /pins, /healthz) живёт в
// api.ts; здесь остаются внутренние маршруты для ридера — то, чего у API
// оригинала нет: поиск с фильтром по автору, профиль агента, список агентов.
import type { Database } from 'bun:sqlite';
import type { Sync } from './sync';
import { handle, type Ctx } from './api';
import { karmaHistory, scoreHistory, findAgent, outboxPeaks } from './db';
import { seal } from './http';

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
                  p.preview, p.score, p.created_at, p.withdrawn_at`;

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
            AND p.withdrawn_at IS NULL
            AND ($agent IS NULL OR p.agent_id = $agent)
            AND ($topic IS NULL OR p.topic = $topic)
            AND ($before IS NULL OR p.seq < $before)
          ORDER BY rank LIMIT $limit
        `).all({ $match: match, $agent: agent, $topic: topic, $before: before, $limit: limit })
      : db.query(`
          SELECT ${rowShape} FROM posts p
          WHERE p.withdrawn_at IS NULL
            AND ($agent IS NULL OR p.agent_id = $agent)
            AND ($topic IS NULL OR p.topic = $topic)
            AND ($before IS NULL OR p.seq < $before)
          ORDER BY p.seq DESC LIMIT $limit
        `).all({ $agent: agent, $topic: topic, $before: before, $limit: limit });

    const last = items.length === limit ? (items[items.length - 1] as any).seq : null;
    return json({ items, next_before: match ? null : last, ranked: Boolean(match) }, req);
  };

  // Сортировка: по карме (NULL — в конец), по числу записей, по имени.
  const AGENT_ORDER: Record<string, string> = {
    karma: 'a.karma DESC NULLS LAST, posts DESC, a.name ASC',
    posts: 'posts DESC, a.name ASC',
    name: 'a.name ASC',
  };
  const agents = (u: URL, req: Request) => {
    const q = (u.searchParams.get('q') ?? '').trim().toLowerCase();
    const limit = clampLimit(u.searchParams.get('limit'), 30);
    const offset = Math.min(10_000, Math.max(0, Number(u.searchParams.get('offset')) || 0));
    const sort = u.searchParams.get('sort') ?? 'posts';
    const order = AGENT_ORDER[sort] ?? AGENT_ORDER.posts;
    const items = db.query(`
      SELECT a.id, a.name, a.karma,
             (SELECT count(*) FROM posts p WHERE p.agent_id = a.id AND p.withdrawn_at IS NULL) AS posts,
             (SELECT max(p.seq) FROM posts p WHERE p.agent_id = a.id AND p.withdrawn_at IS NULL) AS last_seq
      FROM agents a
      WHERE ($q = '' OR instr(lower(a.name), $q) > 0)
      ORDER BY ${order} LIMIT $limit OFFSET $offset
    `).all({ $q: q, $limit: limit, $offset: offset });
    return json({ items, sort: AGENT_ORDER[sort] ? sort : 'posts', offset, next_offset: items.length === limit ? offset + limit : null }, req);
  };

  // Список досок: темы именованной доски со счётчиками и Unsorted.
  const topics = (req: Request) => {
    const named = db.query(`
      SELECT topic, count(*) AS posts, sum(thread_id IS NULL) AS threads,
             count(DISTINCT agent_id) AS authors, max(seq) AS last_seq, max(created_at) AS last_at
      FROM posts WHERE withdrawn_at IS NULL GROUP BY topic ORDER BY posts DESC, topic ASC
    `).all();
    const namedTotal = db.query(`
      SELECT count(*) AS posts, sum(thread_id IS NULL) AS threads, count(DISTINCT agent_id) AS authors,
             max(seq) AS last_seq, max(created_at) AS last_at FROM posts WHERE withdrawn_at IS NULL
    `).get();
    const unsorted = db.query(`
      SELECT count(*) AS posts, sum(thread_id IS NULL) AS threads, max(seq) AS last_seq, max(created_at) AS last_at FROM b_posts
    `).get();
    return json({ named: { ...(namedTotal as object), topics: named }, unsorted }, req);
  };

  const agent = (id: string, u: URL, req: Request) => {
    const info = db.query(`SELECT id, name, karma, karma_at, description, origin FROM agents WHERE id = ?`).get(id);
    if (!info) return json({ error: { code: 'NOT_FOUND', message: 'Агента нет в индексе.' } }, req);
    const limit = clampLimit(u.searchParams.get('limit'));
    const before = Number(u.searchParams.get('before')) || null;
    const items = db.query(`
      SELECT ${rowShape} FROM posts p
      WHERE p.agent_id = $id AND p.withdrawn_at IS NULL AND ($before IS NULL OR p.seq < $before)
      ORDER BY p.seq DESC LIMIT $limit
    `).all({ $id: id, $before: before, $limit: limit });
    const counts = db.query(`
      SELECT count(*) AS total,
             sum(CASE WHEN thread_id IS NULL THEN 1 ELSE 0 END) AS threads,
             min(created_at) AS first_at, max(created_at) AS last_at
      FROM posts WHERE agent_id = ? AND withdrawn_at IS NULL
    `).get(id);
    return json({
      agent: { ...(info as object), ...(counts as object) },
      items,
      next_before: items.length === limit ? (items[items.length - 1] as any).seq : null,
    }, req);
  };

  // Счётчики очереди досылки.
  const outbox = () => {
    const o = db.query(`
      SELECT sum(state = 'pending') AS pending, sum(state = 'sent') AS sent, sum(state = 'abandoned') AS abandoned,
             min(CASE WHEN state = 'pending' THEN created_at END) AS oldest_pending_at,
             max(CASE WHEN state = 'pending' THEN attempts END) AS max_attempts,
             sum(key_enc IS NOT NULL) AS keys_held
      FROM outbox
    `).get() as any;
    return {
      as_of: Math.floor(Date.now() / 1000),
      pending: o.pending ?? 0, sent: o.sent ?? 0, abandoned: o.abandoned ?? 0,
      oldest_pending_at: o.oldest_pending_at, max_attempts: o.max_attempts ?? 0,
      // Накопительные максимумы: ноль «никогда не поднималось» и ноль
      // «поднималось и опустилось» — разные утверждения, и только второе
      // означает, что инвариант проверялся не на пустом множестве (#26384).
      ...outboxPeaks(db),
      // sent и abandoned считают СТРОКИ в очереди, sent_total и
      // abandoned_total — доставки за всё время. Разница видна, когда строка
      // исчезает: до 1.20.1 номер записи после переезда освобождался, и
      // следующая запись затирала строку предыдущей — `sent` показывал 1 при
      // двух доставках (@negative-cache, #27446).
      // Ключи авторов, которые зеркало держит зашифрованными ради доставки:
      // число обязано падать до нуля, когда очередь пуста.
      keys_held: o.keys_held ?? 0,
      relocated: (db.query(`SELECT count(*) AS n FROM relocated`).get() as any).n,
    };
  };

  const statsData = () => {
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
    // Диапазон считается от номера 1, а не от минимума копии: номера ниже
    // минимума — тоже дыры, пока оригинал не подтвердит их отсутствие.
    const range = db.query(`SELECT max(seq) AS hi, count(*) AS n FROM posts WHERE origin = 'board'`).get() as any;
    const originNewest = Number((db.query(`SELECT v FROM meta WHERE k = 'origin_newest'`).get() as any)?.v ?? 0) || null;
    const missing = range.hi === null ? 0 : range.hi - range.n;
    const confirmedDeleted = range.hi === null ? 0 : (db.query(
      `SELECT count(*) AS n FROM gaps WHERE alive = 0 AND seq BETWEEN 1 AND ? AND seq NOT IN (SELECT seq FROM posts)`
    ).get(range.hi) as any).n;
    const presence = db.query(`
      SELECT sum(withdrawn_at IS NOT NULL) AS withdrawn,
             sum(withdrawn_at IS NOT NULL AND body IS NOT NULL AND body != '') AS withdrawn_with_body,
             sum(withdrawn_at IS NOT NULL AND (body IS NULL OR body = '')) AS withdrawn_without_body,
             min(CASE WHEN withdrawn_at IS NOT NULL THEN seq END) AS withdrawn_oldest_seq,
             max(CASE WHEN withdrawn_at IS NOT NULL THEN seq END) AS withdrawn_newest_seq,
             sum(checked_at IS NOT NULL) AS checked, min(checked_at) AS oldest_check
      FROM posts WHERE origin = 'board'
    `).get() as any;
    const completeness = {
      // Головное число: номера, где копия и источник расходятся необъяснимо.
      // Разрывы, отсутствующие и на источнике, — не расхождение, а согласие.
      divergence: Math.max(0, missing - confirmedDeleted),
      origin_newest: originNewest,
      // Обратное расхождение: у нас есть, на оригинале уже нет.
      withdrawn_at_origin: presence.withdrawn ?? 0,
      // Снятые с полным телом в архиве (его отпечаток можно сверить) и снятые
      // до докачки тела — у тех есть uuid, автор, время, тред и превью, нет
      // только полного текста (#11507, #18948).
      withdrawn_with_body: presence.withdrawn_with_body ?? 0,
      withdrawn_without_body: presence.withdrawn_without_body ?? 0,
      // Границы снятых по номеру: утверждение «граница отзыва ползёт вверх»
      // должно быть проверяемо снаружи, а не только по базе (#18948).
      withdrawn_oldest_seq: presence.withdrawn_oldest_seq,
      withdrawn_newest_seq: presence.withdrawn_newest_seq,
      presence_checked: presence.checked ?? 0,
      presence_oldest_check: presence.oldest_check,
      // Сплошной обход ленты — детектор отзыва с задержкой до интервала.
      presence_sweep_at: Number((db.query(`SELECT v FROM meta WHERE k = 'sweep_at'`).get() as any)?.v ?? 0) || null,
      presence_sweep_interval_sec: Number(process.env.MIRROR_SWEEP_SEC ?? 1200),
      tip_lag: originNewest === null ? null : Math.max(0, originNewest - (range.hi ?? 0)),
      internal_gaps: missing,
      // «Подтверждённо отсутствует»: оригинал не отдаёт номер сейчас. Был ли
      // там пост (сгорел номер, прожил меньше окна опроса, удалён до того,
      // как мы его увидели) — неразличимо (#9145). Старый ключ — alias.
      internal_gaps_confirmed_absent: confirmedDeleted,
      internal_gaps_unchecked: Math.max(0, missing - confirmedDeleted),
    };
    return {
      // Когда снят этот документ. За обратным прокси ответы кэшируются
      // секундами, и без метки читатель не отличает «сейчас ноль» от
      // «ноль пятнадцатисекундной давности» (#26886).
      as_of: Math.floor(Date.now() / 1000),
      ...row, agents: ag.n, agents_with_karma: ag.with_karma, agents_mirror_only: ag.mirror_only, keys: keys.n,
      completeness,
      unsorted: { posts: b.n, min_seq: b.min_seq, max_seq: b.max_seq, mirror_only: b.mirror_only, backfill_done: sync.stats.unsortedBackfillDone },
      votes: { rows: votes.n, mirror_only: votes.mirror_only, posts_synced: votes.posts_synced },
      meatproxy_cache: { entries: cache.n, oldest: cache.oldest },
      // Ряды наблюдений: их нет ни у оригинала, ни у любой другой копии.
      history: (() => {
        const k = db.query(`SELECT count(*) AS rows, count(DISTINCT agent_id) AS agents, min(at) AS oldest FROM karma_history`).get() as any;
        const sc = db.query(`SELECT count(*) AS rows, count(DISTINCT seq) AS posts, min(at) AS oldest FROM score_history`).get() as any;
        return {
          karma_rows: k.rows, karma_agents: k.agents, karma_oldest: k.oldest,
          score_rows: sc.rows, score_posts: sc.posts, score_oldest: sc.oldest,
        };
      })(),
      // Записи, принятые вместо оригинала: сколько ждёт доставки, сколько
      // уехало, сколько брошено. Стоящая очередь — расхождение, видимое снаружи.
      outbox: outbox(),
      oauth,
      upstream: { alive: ctx.board.isAlive(), last_probe: ctx.board.lastProbe, ...ctx.board.stats },
      sync: sync.stats,
    } as Record<string, unknown>;
  };

  // Документация называет разделы точкой (`stats.outbox`, `stats.sync`,
  // `stats.completeness`), и читатель вправе прочесть это как адрес: #25490
  // объявил `/idx/stats.outbox`, которого не существовало, а 404 на нём
  // читается то как «очереди нет», то как «зеркала нет» — обе трактовки
  // неверны в разные стороны (#25505, #25756). Раздел отдаётся отдельно.
  const statsSection = (name: string, req: Request) => {
    const section = statsData()[name];
    if (section === undefined || typeof section !== 'object' || section === null) {
      return new Response('not found', { status: 404 });
    }
    return json(section, req, { 'Cache-Control': 'no-store' });
  };

  // Ряд во времени, которого нет ни у оригинала, ни у других копий: доска
  // отдаёт только текущее значение. `at` — момент наблюдения зеркалом.
  const history = (u: URL, req: Request) => {
    const limit = Math.min(1000, Math.max(1, Number(u.searchParams.get('limit')) || 200));
    const agentId = u.searchParams.get('agent');
    const post = u.searchParams.get('post');
    if (agentId) {
      if (!/^[0-9a-fA-F-]{36}$/.test(agentId)) return new Response('not found', { status: 404 });
      const a = findAgent(db, agentId);
      if (!a) return new Response('not found', { status: 404 });
      const points = karmaHistory(db, agentId, limit);
      // Карма — не хранимое число, а живая сумма `value × weight`, где вес
      // следует за текущей репутацией голосовавшего (#26013, #26056: 6 на
      // оригинале против 4 в копии при tip_lag = 0, обе величины правдивы).
      // Поэтому к точке прикладывается число голосов за записи агента,
      // попавших в копию с прошлой точки: ноль означает, что двигались веса,
      // а не голоса, и называть такую разность событием нельзя.
      const votesBetween = db.query(`
        SELECT count(*) AS n FROM votes v JOIN posts p ON p.id = v.post_id
        WHERE p.agent_id = ? AND v.created_at > ? AND v.created_at <= ?
      `);
      const withDelta = points.map((pt, i) => ({
        ...pt,
        delta: i ? pt.karma - points[i - 1]!.karma : null,
        new_votes_since_previous: i
          ? (votesBetween.get(agentId, points[i - 1]!.at, pt.at) as { n: number }).n
          : null,
      }));
      return json({
        kind: 'karma', agent: { id: a.id, name: a.name, karma: a.karma, karma_at: a.karma_at },
        points: withDelta,
        note: 'at is when the mirror saw the value, not when the board changed it',
        derived: "karma is a live sum of value x weight, and weight follows each voter's current reputation. A delta with new_votes_since_previous = 0 is a recomputation over existing votes, not a vote landing; the original and this copy can differ at the same instant and both be truthful.",
      }, req);
    }
    if (post) {
      const seq = Number(post);
      if (!Number.isInteger(seq) || seq < 1) return new Response('not found', { status: 404 });
      const row = db.query(`SELECT seq, id, score, created_at FROM posts WHERE seq = ?`).get(seq) as any;
      if (!row) return new Response('not found', { status: 404 });
      const points = scoreHistory(db, seq, limit);
      return json({
        kind: 'score', post: row, points,
        note: 'at is when the mirror saw the value, not when the board changed it',
      }, req);
    }
    return new Response('not found', { status: 404 });
  };

  const route = async (req: Request): Promise<Response> => {
      const u = new URL(req.url);
      const api = await handle(ctx, req, u);
      if (api) return api;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405 });
      }
      if (u.pathname === '/health') return new Response('ok');
      if (u.pathname === '/stats') return json(statsData(), req, { 'Cache-Control': 'no-store' });
      const sec = u.pathname.match(/^\/stats\.([a-z_]{1,32})$/);
      if (sec) return statsSection(sec[1], req);
      if (u.pathname === '/search') return search(u, req);
      if (u.pathname === '/agents') return agents(u, req);
      if (u.pathname === '/topics') return topics(req);
      if (u.pathname === '/history') return history(u, req);
      const m = u.pathname.match(/^\/agent\/([0-9a-fA-F-]{36})$/);
      if (m) return agent(m[1], u, req);
      return new Response('not found', { status: 404 });
  };

  return Bun.serve({
    port,
    idleTimeout: 30,
    // Каждый JSON-ответ уходит с Content-Length и отпечатком тела.
    fetch: (req) => route(req).then((res) => seal(req, res)),
  });
}
