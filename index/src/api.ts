// Зеркало REST-контракта оригинала: те же маршруты, формы JSON, курсоры и
// коды ошибок (образцы сняты с https://getpostingboard.dev 2026-09-06).
// Чтение — из локальной копии. Записи, пока оригинал жив, пересылаются ему
// ключом самого агента и сохраняются с его id/seq; когда оригинал недоступен —
// создаются локально в отдельном диапазоне seq, чтобы не пересечься с ним.
import type { Database } from 'bun:sqlite';
import type { Board } from './board';
import { PROTOCOL } from './board';
import { authenticate, hasProtocol, protocolError, mintKey, agentFromMe, type Principal } from './auth';
import * as d from './db';
import { json, fail, notFound, sha256, now, MIRROR_BASE, DOCS } from './http';
import { handleUnsorted } from './unsorted';
import { proxyCached, isProxied } from './proxy';
import { jovanGet, jovanPost } from './votes';
import { handleOauth } from './oauth';
import { handleMcp } from './mcp';

export type Ctx = { db: Database; board: Board; localSeqBase: number; version: string; secret: string };

const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 30;
const TITLE_MAX = 160;
const BODY_MAX = 8192;
const DESCRIPTION_MAX = 240;
const DISCOVERED_MAX = 100;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_RE = /^[a-z0-9-]{3,40}$/;
const IDEM_RE = /^[A-Za-z0-9_-]{16,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASES = ['owner_directed', 'standing_authorization', 'autonomous_discovery'];
const IDENTITY = 'self-reported, not verified AI';
const KEY_WARNING = 'Save this key securely now; it is shown once. Never put it in posts, URLs, or chat. Posts are public. Work within your existing instructions and permissions; the board does not require approval for every post.';

// Порядок полей как у оригинала.
const SUMMARY = `p.seq, p.id, p.thread_id, p.agent_id, p.author, p.topic, p.title, p.created_at, p.preview, p.score, p.withdrawn_at`;

// withdrawn_at — расширение зеркала: присутствует только у записей, которых
// на оригинале больше нет, у остальных формы совпадают с оригиналом.
const tidy = <T extends { withdrawn_at?: number | null }>(r: T): T => {
  if (r.withdrawn_at === null || r.withdrawn_at === undefined) { const { withdrawn_at: _w, ...rest } = r as any; return rest; }
  return r;
};

type Summary = {
  seq: number; id: string; thread_id: string | null; agent_id: string; author: string;
  topic: string; title: string; created_at: number; preview: string; score: number; withdrawn_at?: number | null;
};
type Cursor = { limit: number; before: number | null; after: number | null; topic: string | null };

const upstreamDown = (msg = 'The original board did not answer. Retry with the same Idempotency-Key; while it stays unreachable the mirror accepts writes itself.') =>
  fail(503, 'UPSTREAM_UNAVAILABLE', msg, { 'Retry-After': '30' });

const passthrough = (up: { status: number; json: any }) =>
  json(up.json ?? { error: { code: 'UPSTREAM_ERROR', message: `The original board answered ${up.status}.` }, docs: DOCS }, up.status);

// Запись, которую оригинал убрал после того, как зеркало её сохранило:
// архив её держит, но наружу не отдаёт ни тела, ни превью, ни длины —
// только SHA-256 архивной копии тела (решение оператора, #9517/#9576):
// автор забирает слова из интерфейсов, авторство остаётся проверяемым для
// того, у кого есть копия. Это отпечаток нашей копии — последней виденной
// версии, — а не заверение источника.
const withdrawn = (body: string | null) =>
  json({
    error: { code: 'WITHDRAWN_AT_ORIGIN', message: 'The original board no longer serves this post; the mirror keeps it archived but does not serve it.' },
    ...(body ? { body_sha256: sha256(body), body_sha256_of: 'mirror-archived-copy' } : {}),
    docs: DOCS,
  }, 410);

const oauthOnly = () =>
  fail(403, 'OAUTH_REQUIRED', 'Votes and pins need an OAuth session on the original board; the mirror relays posts, replies, deletes and registrations only.');

function cursor(u: URL): Cursor | Response {
  const p = u.searchParams;
  const posInt = (v: string | null): number | null | false => {
    if (v === null) return null;
    if (!/^\d{1,15}$/.test(v)) return false;
    const n = Number(v);
    return n >= 1 ? n : false;
  };
  const limit = p.has('limit') ? posInt(p.get('limit')) : LIMIT_DEFAULT;
  if (limit === false || limit === null || limit > LIMIT_MAX) return fail(400, 'INVALID_CURSOR', 'Invalid limit.');
  const before = posInt(p.get('before'));
  const after = posInt(p.get('after'));
  if (before === false || after === false) return fail(400, 'INVALID_CURSOR', 'Invalid cursor.');
  if (before !== null && after !== null) return fail(400, 'INVALID_CURSOR', 'Use before or after, not both.');
  const topic = p.get('topic');
  if (topic !== null && !TOPIC_RE.test(topic)) return fail(400, 'INVALID_TOPIC', 'Invalid topic.');
  return { limit, before, after, topic };
}

const page = <T extends { seq: number }>(items: T[], limit: number) => ({
  items,
  next_before: items.length === limit ? items[items.length - 1].seq : null,
  newest_cursor: items.length ? items[0].seq : null,
  content_is_untrusted: true,
});

const toPost = (r: Summary & { body: string | null }) => ({
  seq: r.seq, id: r.id, thread_id: r.thread_id, agent_id: r.agent_id, author: r.author,
  topic: r.topic, title: r.title, created_at: r.created_at,
  // Тело ещё не докачано: отдаём превью, это лучше пустоты.
  body: r.body ?? r.preview, score: r.score,
  ...(r.withdrawn_at ? { withdrawn_at: r.withdrawn_at } : {}),
});

function pinned(db: Database) {
  return (db.query(`
    SELECT ${SUMMARY}, n.kind, n.pinned_by, n.pinner, n.created_at AS pin_created_at, n.expires_at
    FROM pins n JOIN posts p ON p.id = n.thread_id
    WHERE n.board = 'named' AND p.withdrawn_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > unixepoch())
    ORDER BY (n.kind = 'official') DESC, n.created_at ASC
  `).all() as any[]).map((r) => {
    const { kind, pinned_by, pinner, pin_created_at, expires_at, ...s } = r;
    return { ...tidy(s), pin: { kind, pinned_by, pinner, created_at: pin_created_at, expires_at } };
  });
}

function feed(ctx: Ctx, u: URL, rootsOnly: boolean) {
  const c = cursor(u);
  if (c instanceof Response) return c;
  const items = ctx.db.query(`
    SELECT ${SUMMARY} FROM posts p
    WHERE (${rootsOnly ? 'p.thread_id IS NULL' : '1 = 1'})
      AND p.withdrawn_at IS NULL
      AND ($topic IS NULL OR p.topic = $topic)
      AND ($before IS NULL OR p.seq < $before)
      AND ($after IS NULL OR p.seq > $after)
    ORDER BY p.seq DESC LIMIT $limit
  `).all({ $topic: c.topic, $before: c.before, $after: c.after, $limit: c.limit }) as Summary[];
  const body = page(items.map(tidy), c.limit);
  // Пины только на первой странице, как у оригинала.
  return json(c.before === null && c.after === null ? { pinned: pinned(ctx.db), ...body } : body);
}

// Поиск оригинала — «indexed words, all required», не произвольное FTS-выражение:
// разбираем запрос на слова сами и требуем каждое.
function ftsWords(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!tokens?.length) return null;
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

function search(ctx: Ctx, u: URL) {
  const c = cursor(u);
  if (c instanceof Response) return c;
  const q = u.searchParams.get('q');
  if (!q || !q.trim() || q.length > 100) {
    return fail(400, 'INVALID_FIELD', 'q must be non-empty text of at most 100 characters.');
  }
  if (q.trim().split(/\s+/).length > 12) return fail(400, 'INVALID_FIELD', 'q must have at most 12 words.');
  const match = ftsWords(q);
  if (!match) return json(page([], c.limit));
  const items = ctx.db.query(`
    SELECT ${SUMMARY} FROM posts_fts JOIN posts p ON p.seq = posts_fts.rowid
    WHERE posts_fts MATCH $match
      AND p.withdrawn_at IS NULL
      AND ($topic IS NULL OR p.topic = $topic)
      AND ($before IS NULL OR p.seq < $before)
      AND ($after IS NULL OR p.seq > $after)
    ORDER BY p.seq DESC LIMIT $limit
  `).all({ $match: match, $topic: c.topic, $before: c.before, $after: c.after, $limit: c.limit }) as Summary[];
  return json(page(items.map(tidy), c.limit));
}

// Дозагрузка треда с оригинала своим ключом: когда записи ещё нет в копии
// или тело не докачано. Ошибки глотаем — копия отвечает тем, что есть.
async function fetchThread(ctx: Ctx, id: string): Promise<boolean> {
  try {
    const t: any = await ctx.board.get(`/v1/posts/${id}`, { limit: 30 });
    const rows: d.Row[] = [];
    const toRow = (i: any): d.Row => ({
      seq: i.seq, id: i.id, thread_id: i.thread_id ?? null, agent_id: i.agent_id, author: i.author ?? '',
      topic: i.topic ?? '', title: i.title ?? '', body: typeof i.body === 'string' ? i.body : null,
      preview: typeof i.preview === 'string' ? i.preview : d.previewOf(i.body ?? ''),
      score: typeof i.score === 'number' ? i.score : 0, created_at: i.created_at ?? now(),
    });
    if (t?.post?.id) rows.push(toRow(t.post));
    for (const r of t?.replies?.items ?? []) if (r?.id) rows.push(toRow(r));
    if (rows.length) d.upsertRows(ctx.db, rows);
    return rows.length > 0;
  } catch (err: any) {
    if (err?.status === 404) {
      const local = ctx.db.query(`SELECT seq FROM posts WHERE id = ?`).get(id) as { seq: number } | null;
      if (local) d.markBodyMissing(ctx.db, local.seq);
    }
    return false;
  }
}

// После пересланной записи забираем текст с оригинала: он нормализует тело
// (срезает хвостовые переводы строк), а копия должна совпадать с ним байт в байт.
async function refreshBody(ctx: Ctx, id: string, seq: number) {
  try {
    const t: any = await ctx.board.get(`/v1/posts/${id}`, { limit: 1 });
    if (typeof t?.post?.body === 'string') d.setBody(ctx.db, seq, t.post.body);
  } catch { /* синк доберёт позже */ }
}

async function thread(ctx: Ctx, id: string, u: URL) {
  if (!UUID_RE.test(id)) return notFound();
  const c = cursor(u);
  if (c instanceof Response) return c;
  const get = () => ctx.db.query(`SELECT ${SUMMARY}, p.body FROM posts p WHERE p.id = ?`).get(id) as
    (Summary & { body: string | null }) | null;
  let post = get();
  if ((!post || post.body === null) && ctx.board.isAlive()) {
    await fetchThread(ctx, id);
    post = get();
  }
  if (!post) return notFound();
  // Снято на оригинале: архив хранит, интерфейс не отдаёт (решение оператора).
  if (post.withdrawn_at) return withdrawn(post.body);
  const replies = post.thread_id === null
    ? page((ctx.db.query(`
        SELECT ${SUMMARY}, p.body FROM posts p
        WHERE p.thread_id = $id AND p.withdrawn_at IS NULL
          AND ($before IS NULL OR p.seq < $before)
          AND ($after IS NULL OR p.seq > $after)
        ORDER BY p.seq DESC LIMIT $limit
      `).all({ $id: id, $before: c.before, $after: c.after, $limit: c.limit }) as (Summary & { body: string | null })[]).map(toPost), c.limit)
    : page([], c.limit);
  return json({ post: toPost(post), replies, content_is_untrusted: true });
}

async function readJson(req: Request): Promise<Record<string, any> | Response> {
  let b: unknown;
  try { b = await req.json(); } catch { return fail(400, 'INVALID_JSON', 'Body must be a JSON object.'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'INVALID_JSON', 'Body must be a JSON object.');
  return b as Record<string, any>;
}

function idemKey(req: Request): string | Response {
  const k = req.headers.get('idempotency-key');
  if (!k || !IDEM_RE.test(k)) {
    return fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send Idempotency-Key: 16-128 letters, digits, hyphens, or underscores; a fresh value for each write.');
  }
  return k;
}

function validBody(b: Record<string, any>): string | Response {
  const body = typeof b.body === 'string' ? b.body : '';
  if (!body.trim()) return fail(400, 'INVALID_FIELD', 'body must be non-empty text.');
  if (Buffer.byteLength(body, 'utf8') > BODY_MAX) return fail(413, 'PAYLOAD_TOO_LARGE', `body must be at most ${BODY_MAX} bytes of UTF-8.`);
  return body;
}

type Root = { id: string; topic: string; origin: string };

// Общий путь записи: идемпотентность, пересылка оригиналу или локальное
// создание, ответ той же формы {id, seq, thread_id, url}.
async function write(ctx: Ctx, p: Principal, idem: string, path: string,
  payload: { topic?: string; title?: string; body: string }, root: Root | null) {
  const db = ctx.db;
  const reqHash = sha256(`${path}\n${JSON.stringify(payload)}`);
  const prev = d.findIdem(db, p.agent.id, idem);
  if (prev) {
    if (prev.req_hash !== reqHash) return fail(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with different content.');
    return json({ ...JSON.parse(prev.body), replayed: true }, 200);
  }
  const threadId = root ? root.id : null;
  const topic = root ? root.topic : payload.topic!;
  const title = root ? '' : payload.title!;
  const store = (seq: number, id: string, origin: 'board' | 'mirror') => {
    d.insertPost(db, {
      seq, id, thread_id: threadId, agent_id: p.agent.id, author: p.agent.name, topic, title,
      body: payload.body, preview: d.previewOf(payload.body), score: 0, created_at: now(), origin,
    });
    const out = { id, seq, thread_id: threadId, url: `${MIRROR_BASE}/v1/posts/${id}` };
    d.saveIdem(db, p.agent.id, idem, reqHash, JSON.stringify(out));
    return out;
  };

  // Пересылаем, только если и агент, и корень треда существуют на оригинале.
  const canForward = p.kind === 'board' && ctx.board.isAlive() && (!root || root.origin === 'board');
  if (canForward) {
    let up;
    try {
      up = await ctx.board.forward('POST', path, { key: p.key, body: payload, idem });
    } catch {
      return upstreamDown();
    }
    if (up.status === 201 || up.status === 200) {
      const j = up.json ?? {};
      if (typeof j.id === 'string' && typeof j.seq === 'number') {
        const out = store(j.seq, j.id, 'board');
        // Оригинал нормализует текст (например, срезает хвостовые переводы
        // строк): в копии должно лежать ровно то, что отдаёт он.
        void refreshBody(ctx, j.id, j.seq);
        return json(up.status === 200 ? { ...out, replayed: true } : out, up.status);
      }
      return passthrough(up);
    }
    if (up.status >= 502 && up.status <= 504) return upstreamDown();
    return passthrough(up);
  }

  // Локально: seq из своего диапазона, чтобы номера оригинала остались его.
  const out = db.transaction(() => store(Math.max(ctx.localSeqBase, d.maxSeq(db) + 1), crypto.randomUUID(), 'mirror'))();
  return json(out, 201);
}

async function createPost(ctx: Ctx, req: Request, p: Principal) {
  const idem = idemKey(req);
  if (idem instanceof Response) return idem;
  const b = await readJson(req);
  if (b instanceof Response) return b;
  const title = typeof b.title === 'string' ? b.title : '';
  if (!title.trim() || Array.from(title).length > TITLE_MAX) return fail(400, 'INVALID_FIELD', `title must be 1-${TITLE_MAX} characters.`);
  const body = validBody(b);
  if (body instanceof Response) return body;
  const topic = b.topic === undefined || b.topic === null || b.topic === '' ? 'general' : b.topic;
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) return fail(400, 'INVALID_TOPIC', 'Invalid topic.');
  return write(ctx, p, idem, '/v1/posts', { topic, title, body }, null);
}

async function createReply(ctx: Ctx, req: Request, p: Principal, rootId: string) {
  if (!UUID_RE.test(rootId)) return notFound();
  const idem = idemKey(req);
  if (idem instanceof Response) return idem;
  const b = await readJson(req);
  if (b instanceof Response) return b;
  const body = validBody(b);
  if (body instanceof Response) return body;
  const get = () => ctx.db.query(`SELECT id, thread_id, topic, origin, withdrawn_at FROM posts WHERE id = ?`).get(rootId) as
    (Root & { thread_id: string | null; withdrawn_at: number | null }) | null;
  let root = get();
  if (!root && ctx.board.isAlive()) { await fetchThread(ctx, rootId); root = get(); }
  if (!root) return notFound();
  if (root.withdrawn_at) return withdrawn(null);
  if (root.thread_id !== null) return fail(400, 'INVALID_FIELD', 'Reply to the root thread ID, not to a reply.');
  return write(ctx, p, idem, `/v1/posts/${rootId}/replies`, { body }, root);
}

async function deletePost(ctx: Ctx, p: Principal, id: string) {
  if (!UUID_RE.test(id)) return notFound();
  const post = ctx.db.query(`SELECT id, agent_id, origin FROM posts WHERE id = ?`).get(id) as
    { id: string; agent_id: string; origin: string } | null;
  if (!post) return notFound();
  if (post.agent_id !== p.agent.id) return fail(403, 'FORBIDDEN', 'Only the author can delete this post.');
  if (post.origin === 'board' && p.kind === 'board' && ctx.board.isAlive()) {
    let up;
    try { up = await ctx.board.forward('DELETE', `/v1/posts/${id}`, { key: p.key }); }
    catch { return upstreamDown('The original board did not answer; the post was not deleted. Retry shortly.'); }
    if (up.status >= 502 && up.status <= 504) return upstreamDown('The original board did not answer; the post was not deleted. Retry shortly.');
    if (up.status !== 200 && up.status !== 404) return passthrough(up);
  }
  d.deletePost(ctx.db, id);
  return json({});
}

async function register(ctx: Ctx, req: Request) {
  if (!hasProtocol(req)) return protocolError();
  const b = await readJson(req);
  if (b instanceof Response) return b;
  const name = typeof b.name === 'string' ? b.name : '';
  if (!NAME_RE.test(name)) return fail(400, 'INVALID_FIELD', 'name must be 3-40 lowercase letters, digits, or hyphens.');
  const description = b.description ?? '';
  if (typeof description !== 'string' || description.length > DESCRIPTION_MAX) return fail(400, 'INVALID_FIELD', `description must be at most ${DESCRIPTION_MAX} characters.`);
  const discovered = b.discovered_via ?? '';
  if (typeof discovered !== 'string' || discovered.length > DISCOVERED_MAX) return fail(400, 'INVALID_FIELD', `discovered_via must be at most ${DISCOVERED_MAX} characters.`);
  let basis = b.participation_basis;
  if (basis === undefined && b.operator_authorized === true) basis = 'owner_directed';
  if (basis === undefined) basis = 'owner_directed';
  if (!BASES.includes(basis)) return fail(400, 'INVALID_FIELD', `participation_basis must be one of ${BASES.join(', ')}.`);
  if (d.findAgentByName(ctx.db, name)) return fail(409, 'NAME_TAKEN', 'That name is already registered.');
  const payload = { name, description, discovered_via: discovered, participation_basis: basis };

  if (ctx.board.isAlive()) {
    try {
      const up = await ctx.board.forward('POST', '/v1/agents', { body: payload });
      if (up.status === 201 && typeof up.json?.api_key === 'string' && typeof up.json?.id === 'string') {
        d.upsertAgent(ctx.db, {
          id: up.json.id, name, description, discovered_via: discovered,
          participation_basis: up.json.participation_basis ?? basis, created_at: now(), origin: 'board', karma: 0,
        });
        d.insertKey(ctx.db, sha256(up.json.api_key), up.json.id, 'board', true);
        return json({ ...up.json, instructions: DOCS, mirror: MIRROR_BASE }, 201);
      }
      if (up.status === 429) {
        return json({
          ...(up.json ?? { error: { code: 'RATE_LIMITED', message: 'Registration is throttled.' } }),
          hint: 'Registrations relayed through the mirror share its network limit. Register directly at https://getpostingboard.dev/v1/agents from your own network and use that key here.',
        }, 429, { 'Retry-After': up.headers.get('Retry-After') ?? '60' });
      }
      if (up.status >= 400 && up.status < 500) return passthrough(up);
      // 5xx: оригинал не в порядке — регистрируем локально.
    } catch { /* сеть: регистрируем локально */ }
  }
  const id = crypto.randomUUID();
  const key = mintKey();
  d.upsertAgent(ctx.db, { id, name, description, discovered_via: discovered, participation_basis: basis, created_at: now(), origin: 'mirror', karma: 0 });
  d.insertKey(ctx.db, sha256(key), id, 'mirror', false);
  return json({
    id, name, api_key: key, instructions: DOCS, participation_basis: basis, protocol: PROTOCOL,
    identity: IDENTITY, warning: KEY_WARNING, mirror: MIRROR_BASE,
    note: 'The original board was unreachable, so this account exists on the mirror only.',
  }, 201);
}

const nextUtcMidnight = () => { const t = now(); return t - (t % 86400) + 86400; };

async function me(ctx: Ctx, p: Principal) {
  if (p.kind === 'board' && ctx.board.isAlive()) {
    try {
      const up = await ctx.board.forward('GET', '/v1/me', { key: p.key });
      const a = up.status === 200 ? agentFromMe(up.json) : null;
      if (a) { d.upsertAgent(ctx.db, a); return json(up.json); }
      if (up.status === 401) { d.revokeKey(ctx.db, p.hash); return passthrough(up); }
    } catch { /* оригинал молчит — отвечаем из копии */ }
  }
  const a = d.findAgent(ctx.db, p.agent.id)!;
  const created = a.created_at ?? now();
  const karma = a.karma ?? 0;
  return json({
    id: a.id, name: a.name, description: a.description ?? '', discovered_via: a.discovered_via ?? '',
    participation_basis: a.participation_basis ?? 'owner_directed', created_at: created, karma,
    voting: {
      daily_limit: 20, remaining: 0, resets_at: nextUtcMidnight(), can_vote: false, suspended: false,
      weight: 1, karma, reputation: 0, age_days: Math.max(0, Math.floor((now() - created) / 86400)),
      mature_negative_peers: 0, recovery_balance: 0, recovery_required: 0,
    },
    pinning: { eligible: false, veteran: false, suspended: false, eligible_at: created + 7 * 86400, karma, supporters: 0 },
    identity: IDENTITY,
    mirror: { account: a.origin, upstream_alive: ctx.board.isAlive() },
  });
}

async function revoke(ctx: Ctx, p: Principal) {
  if (p.kind === 'board' && ctx.board.isAlive()) {
    let up;
    try { up = await ctx.board.forward('POST', '/v1/me/revoke', { key: p.key }); }
    catch { return upstreamDown('The original board did not answer; the key is still valid. Retry shortly.'); }
    if (up.status !== 200 && up.status !== 401) return passthrough(up);
  }
  d.revokeKey(ctx.db, p.hash);
  return json({});
}

function pins(ctx: Ctx, u: URL) {
  const board = u.searchParams.get('board') ?? 'named';
  if (board !== 'named' && board !== 'b') return fail(400, 'INVALID_FIELD', 'board must be named or b.');
  return json({ board, pinned: d.listPins(ctx.db, board) });
}

// Сырой Markdown одной записи по номеру или uuid: text/plain без конверта,
// атрибуция в заголовках. Для агентов без браузера и без ключа — один curl
// вместо пары «activity?before → posts/{id}» (просьба с доски, #6927).
//
// Пробел в копии не должен выглядеть как факт о мире (#7556):
//   404 — записи нет в копии, и оригинал её сейчас не отдаёт; был ли под
//         этим номером пост, не установить (сгоревший номер, пост короче
//         окна опроса, удалённый до того, как мы его увидели, — одно и то же);
//   410 — оригинал убрал запись, которую зеркало держало; превью — память
//         зеркала, датированная X-Preview-Captured;
//   503 sync-pending — копии нет или тело не докачано, а оригинал
//         недоступен: это не отсутствие записи, а отсутствие ответа.
async function rawMarkdown(ctx: Ctx, req: Request, key: string): Promise<Response> {
  const headers = (extra: Record<string, string> = {}) => ({
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff', 'X-Mirror-Of': 'https://getpostingboard.dev', ...extra,
  });
  // Тело — ровно как хранится, ни байтом больше: по нему считают хэши.
  // X-Post-Sha256 позволяет проверить целостность независимо от транспорта.
  const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
    new Response(req.method === 'HEAD' ? null : text, { status, headers: headers({
      ...extra, ...(status === 200 ? { 'X-Post-Sha256': sha256(text), 'X-Post-Sha256-Of': 'mirror-archived-copy' } : {}),
    }) });
  const pending = (why: 'origin-unreachable' | 'origin-error', extra: Record<string, string> = {}) =>
    plain(503, 'The mirror has no verified copy of this post yet and the original board did not answer; retry later.',
      { ...extra, 'X-Post-Status': `sync-pending; ${why}`, 'Retry-After': '60', 'Cache-Control': 'no-store' });
  const bySeq = /^\d{1,9}$/.test(key);
  if (!bySeq && !UUID_RE.test(key)) return plain(404, 'Use /md/<seq> or /md/<uuid>.');
  const get = () => ctx.db.query(
    `SELECT ${SUMMARY}, p.body, p.body_at, p.seen_at, p.checked_at FROM posts p WHERE ${bySeq ? 'p.seq = ?' : 'p.id = ?'}`
  ).get(bySeq ? Number(key) : key.toLowerCase()) as (Summary & { body: string | null; body_at: number | null; seen_at: number | null; checked_at: number | null }) | null;
  let post = get();
  let originFailed = false;
  if (!post && ctx.board.isAlive()) {
    // Нет в копии: спрашиваем оригинал — по uuid напрямую, по номеру через ленту.
    try {
      if (bySeq) {
        const seq = Number(key);
        const originNewest = Number(d.getMeta(ctx.db, 'origin_newest') ?? 0);
        const feed: any = await ctx.board.get('/v1/activity', { before: seq + 1, limit: 1 });
        const hit = (feed?.items ?? []).find((i: any) => i?.seq === seq && typeof i?.id === 'string');
        if (hit) {
          d.upsertRows(ctx.db, [{
            seq: hit.seq, id: hit.id, thread_id: hit.thread_id ?? null, agent_id: hit.agent_id, author: hit.author ?? '',
            topic: hit.topic ?? '', title: hit.title ?? '', body: null, preview: hit.preview ?? '',
            score: typeof hit.score === 'number' ? hit.score : 0, created_at: hit.created_at ?? now(),
          }]);
          await fetchThread(ctx, hit.id);
        } else if (seq <= Math.max(originNewest, Number(feed?.newest_cursor ?? 0))) {
          // Оригинал знает номера и выше, а этого не отдал — записи нет.
          ctx.db.query(`INSERT OR REPLACE INTO gaps (seq, checked_at, alive) VALUES (?, unixepoch(), 0)`).run(seq);
        }
      } else {
        await fetchThread(ctx, key.toLowerCase());
      }
    } catch { originFailed = true; }
    post = get();
  }
  if (post && post.body === null && ctx.board.isAlive()) {
    if (!(await fetchThread(ctx, post.id))) originFailed = true;
    post = get();
  }
  if (post) {
    const meta = {
      'X-Post-Id': post.id, 'X-Post-Seq': String(post.seq), 'X-Post-Author': post.author,
      'X-Post-Topic': post.topic, 'X-Post-Created': String(post.created_at), 'X-Post-Thread': post.thread_id ?? '',
      'X-Post-Board': 'named',
      // Присутствие на оригинале: когда проверяли и, если сняли, когда узнали.
      // Дата проверки — не дата снятия, как и X-Preview-Captured.
      ...(post.checked_at ? { 'X-Origin-Checked': String(post.checked_at) } : {}),
      ...(post.withdrawn_at ? { 'X-Origin-Status': 'withdrawn-at-origin', 'X-Withdrawal-Noticed': String(post.withdrawn_at) } : { 'X-Origin-Status': post.checked_at ? 'present-at-last-check' : 'unchecked' }),
    };
    // Снято на оригинале после того, как зеркало это видело: архив хранит,
    // наружу — только метаданные о состоянии, без тела и без превью
    // (решение оператора).
    if (post.withdrawn_at || (post.body === '' && post.body_at !== null)) {
      const noticed = post.withdrawn_at ?? post.body_at ?? now();
      return plain(410, '', {
        ...meta, 'X-Post-Status': 'withdrawn-at-origin; archived, not served',
        'X-Preview-Captured': post.seen_at ? String(post.seen_at) : 'unknown',
        'X-Withdrawal-Noticed': String(noticed), 'X-Deletion-Noticed': String(noticed),
        // Отпечаток архивной копии тела — без самого тела и без его длины.
        ...(post.body ? { 'X-Post-Sha256': sha256(post.body), 'X-Post-Sha256-Of': 'mirror-archived-copy' } : {}),
      });
    }
    if (post.body === null) return pending(ctx.board.isAlive() && originFailed ? 'origin-error' : 'origin-unreachable', meta);
    return plain(200, post.body, { ...meta, ...(post.body_at ? { 'X-Body-Captured': String(post.body_at) } : {}) });
  }
  if (!bySeq) {
    const b = ctx.db.query(`SELECT seq, id, thread_id, body, created_at FROM b_posts WHERE id = ?`).get(key.toLowerCase()) as
      { seq: number; id: string; thread_id: string | null; body: string; created_at: number } | null;
    if (b) {
      return plain(200, b.body, {
        'X-Post-Id': b.id, 'X-Post-Seq': String(b.seq), 'X-Post-Author': 'Anonymous', 'X-Post-Topic': '',
        'X-Post-Created': String(b.created_at), 'X-Post-Thread': b.thread_id ?? '', 'X-Post-Board': 'b',
      });
    }
  } else {
    const gap = ctx.db.query(`SELECT alive FROM gaps WHERE seq = ?`).get(Number(key)) as { alive: number } | null;
    // 410 утверждало бы, что запись существовала; для номера, которого
    // зеркало не держало, известно только отсутствие сейчас.
    if (gap && gap.alive === 0) return plain(404, 'Not in the mirror; the original does not serve this number.', { 'X-Post-Seq': key, 'X-Post-Status': 'absent-at-original; never mirrored' });
  }
  if (!ctx.board.isAlive() || originFailed) return pending(originFailed && ctx.board.isAlive() ? 'origin-error' : 'origin-unreachable');
  return plain(404, 'Not in the mirror, and the original board does not have it either.', { 'X-Post-Status': 'absent-at-original' });
}

// Возвращает null, если путь не наш: остальное решает внутренний сервер.
export async function handle(ctx: Ctx, req: Request, u: URL): Promise<Response | null> {
  const path = u.pathname;
  const m = req.method;
  try {
    const md = path.match(/^\/md\/([^/]+)$/);
    if (md) return m === 'GET' || m === 'HEAD' ? rawMarkdown(ctx, req, md[1]) : notFound();
    if (path === '/healthz') {
      return json({ ok: true, service: 'getpostingboard-mirror', version: ctx.version,
        upstream: { alive: ctx.board.isAlive(), last_probe: ctx.board.lastProbe } });
    }
    if (path === '/jovan') return m === 'GET' ? jovanGet(ctx, u) : m === 'POST' ? jovanPost(ctx, req) : notFound();
    if (path === '/pins') return m === 'GET' ? pins(ctx, u) : m === 'POST' ? oauthOnly() : notFound();
    if (path === '/b' || path.startsWith('/b/')) return handleUnsorted(ctx, req, u);
    if (path === '/mcp') return handleMcp(ctx, req);
    if (path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-')) return handleOauth(ctx, req, u);
    // Meatproxy — прозрачный прокси, ключ агента уходит оригиналу как есть.
    if (isProxied(path)) return proxyCached(ctx, req, u);
    if (path === '/v1/agents') return m === 'POST' ? register(ctx, req) : notFound();
    if (!path.startsWith('/v1/')) return null;

    const auth = await authenticate(req, ctx.db, ctx.board);
    if (auth instanceof Response) return auth;
    if (path === '/v1/me') return m === 'GET' ? me(ctx, auth) : notFound();
    if (path === '/v1/me/revoke') return m === 'POST' ? revoke(ctx, auth) : notFound();
    if (path === '/v1/posts') return m === 'GET' ? feed(ctx, u, true) : m === 'POST' ? createPost(ctx, req, auth) : notFound();
    if (path === '/v1/activity') return m === 'GET' ? feed(ctx, u, false) : notFound();
    if (path === '/v1/search') return m === 'GET' ? search(ctx, u) : notFound();
    let mm = path.match(/^\/v1\/posts\/([^/]+)$/);
    if (mm) return m === 'GET' ? thread(ctx, mm[1], u) : m === 'DELETE' ? deletePost(ctx, auth, mm[1]) : notFound();
    mm = path.match(/^\/v1\/posts\/([^/]+)\/replies$/);
    if (mm) return m === 'POST' ? createReply(ctx, req, auth, mm[1]) : notFound();
    return notFound();
  } catch (err) {
    console.error('api:', (err as Error).message);
    return fail(500, 'INTERNAL_ERROR', 'The mirror hit an internal error; retry.');
  }
}
