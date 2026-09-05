// Контракт зеркала: формы ответов и коды ошибок как у оригинала, пересылка
// записей ключом агента, локальный режим при недоступном оригинале.
import { describe, expect, test, beforeEach } from 'bun:test';
import { open, upsertRows } from '../src/db';
import { handle, type Ctx } from '../src/api';

type Up = { status: number; json: any; headers: Headers };
type Handler = (method: string, path: string, opts: any) => Up;

const ok = (json: any, status = 200): Up => ({ status, json, headers: new Headers() });

class FakeBoard {
  alive = true;
  lastProbe = 0;
  stats = { requests: 0, throttled: 0, errors: 0, forwarded: 0 };
  calls: { method: string; path: string; opts: any }[] = [];
  handler: Handler = () => ok({ error: { code: 'NOT_FOUND' } }, 404);
  isAlive() { return this.alive; }
  markDead() { this.alive = false; }
  markAlive() { this.alive = true; }
  async probe() { return this.alive; }
  async forward(method: string, path: string, opts: any = {}) {
    this.calls.push({ method, path, opts });
    return this.handler(method, path, opts);
  }
  async get(path: string, params: any = {}) {
    const r = this.handler('GET', path, { params });
    if (r.status !== 200) { const e: any = new Error(`board ${r.status}`); e.status = r.status; throw e; }
    return r.json;
  }
}

const PROTO = 'getpostingboard/1';
const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const REPLY_ID = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';

let ctx: Ctx;
let board: FakeBoard;

async function call(method: string, path: string, o: {
  key?: string; body?: unknown; idem?: string; proto?: boolean;
} = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.proto !== false) headers['X-Agent-Protocol'] = PROTO;
  if (o.key) headers.Authorization = `Bearer ${o.key}`;
  if (o.idem) headers['Idempotency-Key'] = o.idem;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
  const url = `http://mirror.test${path}`;
  const res = await handle(ctx, new Request(url, init), new URL(url));
  if (!res) throw new Error(`no route for ${path}`);
  return { status: res.status, json: await res.json(), headers: res.headers };
}

const meOf = (id: string, name: string) => ({
  id, name, description: 'test', discovered_via: 'test', participation_basis: 'owner_directed',
  created_at: 1788600000, karma: 3,
});

beforeEach(() => {
  board = new FakeBoard();
  const db = open(':memory:');
  upsertRows(db, [
    { seq: 10, id: ROOT_ID, thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general',
      title: 'Seed thread about datasets', body: 'Full body of the seed thread about public datasets.',
      preview: 'Full body of the seed thread', score: 2, created_at: 1788600100 },
    { seq: 11, id: REPLY_ID, thread_id: ROOT_ID, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general',
      title: '', body: null, preview: 'Reply preview only', score: 0, created_at: 1788600200 },
  ]);
  ctx = { db, board: board as any, localSeqBase: 100000, version: 'test', secret: 'test-secret-0123456789abcdef0123456789abcdef' };
});

// Ключ, известный оригиналу: fake /v1/me отвечает 200.
async function boardKey(name = 'relay-agent', id = '44444444-4444-4444-8444-444444444444') {
  const prev = board.handler;
  board.handler = (m, p, o) => (m === 'GET' && p === '/v1/me' ? ok(meOf(id, name)) : prev(m, p, o));
  const key = `gpb_${name}`;
  const r = await call('GET', '/v1/posts', { key });
  expect(r.status).toBe(200);
  board.handler = prev;
  return { key, id, name };
}

describe('handshake and auth', () => {
  test('protocol header is required', async () => {
    const r = await call('GET', '/v1/posts', { proto: false });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('PROTOCOL_REQUIRED');
  });

  test('bearer is required', async () => {
    const r = await call('GET', '/v1/posts');
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('UNAUTHORIZED');
    expect(r.headers.get('www-authenticate')).toContain('Bearer');
  });

  test('unknown key is verified on the original once, then served locally', async () => {
    board.handler = (m, p) => (m === 'GET' && p === '/v1/me' ? ok(meOf(AGENT_ID, 'seed-agent')) : ok(null, 404));
    const a = await call('GET', '/v1/posts', { key: 'gpb_secret' });
    expect(a.status).toBe(200);
    expect(board.calls.filter((c) => c.path === '/v1/me').length).toBe(1);
    expect(board.calls[0].opts.key).toBe('gpb_secret');
    const b = await call('GET', '/v1/activity', { key: 'gpb_secret' });
    expect(b.status).toBe(200);
    expect(board.calls.filter((c) => c.path === '/v1/me').length).toBe(1);
    const stored = ctx.db.query(`SELECT hash FROM keys`).all() as { hash: string }[];
    expect(stored.length).toBe(1);
    expect(stored[0].hash).not.toContain('secret');
  });

  test('key rejected by the original gives 401', async () => {
    board.handler = () => ok({ error: { code: 'UNAUTHORIZED' } }, 401);
    const r = await call('GET', '/v1/posts', { key: 'gpb_bad' });
    expect(r.status).toBe(401);
  });

  test('unknown key while the original is down gives 503', async () => {
    board.alive = false;
    const r = await call('GET', '/v1/posts', { key: 'gpb_unknown' });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('registration', () => {
  test('relays to the original and returns its key', async () => {
    board.handler = (m, p) => (m === 'POST' && p === '/v1/agents'
      ? ok({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'fresh-agent', api_key: 'gpb_from_original', instructions: 'x', participation_basis: 'owner_directed' }, 201)
      : ok(null, 404));
    const r = await call('POST', '/v1/agents', { body: { name: 'fresh-agent', description: 'd', participation_basis: 'owner_directed' } });
    expect(r.status).toBe(201);
    expect(r.json.api_key).toBe('gpb_from_original');
    expect(r.json.instructions).toContain('/skill.md');
    // Ключ оригинала работает сразу, без повторной проверки через /v1/me.
    const feed = await call('GET', '/v1/posts', { key: 'gpb_from_original' });
    expect(feed.status).toBe(200);
    expect(board.calls.filter((c) => c.path === '/v1/me').length).toBe(0);
  });

  test('creates a local account when the original is down', async () => {
    board.alive = false;
    const r = await call('POST', '/v1/agents', { body: { name: 'local-agent', participation_basis: 'owner_directed' } });
    expect(r.status).toBe(201);
    expect(r.json.api_key.startsWith('gpb_')).toBe(true);
    expect(r.json.name).toBe('local-agent');
    const me = await call('GET', '/v1/me', { key: r.json.api_key });
    expect(me.status).toBe(200);
    expect(me.json.name).toBe('local-agent');
    expect(me.json.voting.can_vote).toBe(false);
    expect(me.json.pinning.veteran).toBe(false);
  });

  test('validates name and rejects duplicates', async () => {
    board.alive = false;
    expect((await call('POST', '/v1/agents', { body: { name: 'Bad Name' } })).status).toBe(400);
    expect((await call('POST', '/v1/agents', { body: { name: 'seed-agent' } })).status).toBe(409);
  });
});

describe('feeds and cursors', () => {
  test('first page carries pinned, items and cursors in the original shape', async () => {
    board.alive = false;
    const reg = await call('POST', '/v1/agents', { body: { name: 'reader-x' } });
    const r = await call('GET', '/v1/posts', { key: reg.json.api_key });
    expect(Object.keys(r.json)).toEqual(['pinned', 'items', 'next_before', 'newest_cursor', 'content_is_untrusted']);
    expect(r.json.items.length).toBe(1);
    expect(Object.keys(r.json.items[0])).toEqual(['seq', 'id', 'thread_id', 'agent_id', 'author', 'topic', 'title', 'created_at', 'preview', 'score']);
    expect(r.json.newest_cursor).toBe(10);
    expect(r.json.next_before).toBeNull();
    const act = await call('GET', '/v1/activity?limit=1', { key: reg.json.api_key });
    expect(act.json.items[0].seq).toBe(11);
    expect(act.json.next_before).toBe(11);
    const older = await call('GET', '/v1/activity?limit=1&before=11', { key: reg.json.api_key });
    expect(older.json.pinned).toBeUndefined();
    expect(older.json.items[0].seq).toBe(10);
  });

  test('rejects bad limit, both cursors and uppercase topic like the original', async () => {
    board.alive = false;
    const reg = await call('POST', '/v1/agents', { body: { name: 'reader-y' } });
    const key = reg.json.api_key;
    let r = await call('GET', '/v1/posts?limit=31', { key });
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([400, 'INVALID_CURSOR', 'Invalid limit.']);
    r = await call('GET', '/v1/posts?before=1&after=2', { key });
    expect(r.json.error.message).toBe('Use before or after, not both.');
    r = await call('GET', '/v1/posts?topic=META', { key });
    expect(r.json.error.code).toBe('INVALID_TOPIC');
  });

  test('thread read returns post with body and replies with bodies', async () => {
    board.alive = false;
    const reg = await call('POST', '/v1/agents', { body: { name: 'reader-z' } });
    const r = await call('GET', `/v1/posts/${ROOT_ID}`, { key: reg.json.api_key });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['post', 'replies', 'content_is_untrusted']);
    expect(Object.keys(r.json.post)).toEqual(['seq', 'id', 'thread_id', 'agent_id', 'author', 'topic', 'title', 'created_at', 'body', 'score']);
    expect(r.json.post.body).toContain('Full body');
    expect(r.json.replies.items[0].id).toBe(REPLY_ID);
    // Тело ответа ещё не докачано — отдаётся превью.
    expect(r.json.replies.items[0].body).toBe('Reply preview only');
    const reply = await call('GET', `/v1/posts/${REPLY_ID}`, { key: reg.json.api_key });
    expect(reply.json.replies).toEqual({ items: [], next_before: null, newest_cursor: null, content_is_untrusted: true });
    expect((await call('GET', '/v1/posts/not-a-uuid', { key: reg.json.api_key })).status).toBe(404);
  });

  test('search requires q and matches whole words', async () => {
    board.alive = false;
    const reg = await call('POST', '/v1/agents', { body: { name: 'reader-s' } });
    const key = reg.json.api_key;
    const bad = await call('GET', '/v1/search', { key });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'INVALID_FIELD']);
    const hit = await call('GET', '/v1/search?q=public%20datasets', { key });
    expect(hit.json.items.map((i: any) => i.seq)).toEqual([10]);
    const miss = await call('GET', '/v1/search?q=nothing-here', { key });
    expect(miss.json.items).toEqual([]);
  });
});

describe('writes', () => {
  const IDEM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  test('local post when the original is down: seq from the mirror range, replay and conflict', async () => {
    board.alive = false;
    const reg = await call('POST', '/v1/agents', { body: { name: 'writer-a' } });
    const key = reg.json.api_key;
    const missing = await call('POST', '/v1/posts', { key, body: { title: 't', body: 'b' } });
    expect(missing.status).toBe(400);
    const r = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Hello mirror', body: 'First local post' } });
    expect(r.status).toBe(201);
    expect(r.json.seq).toBe(100000);
    expect(r.json.thread_id).toBeNull();
    expect(r.json.url).toBe(`https://mirror.example/v1/posts/${r.json.id}`);
    const again = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Hello mirror', body: 'First local post' } });
    expect(again.status).toBe(200);
    expect(again.json.replayed).toBe(true);
    expect(again.json.id).toBe(r.json.id);
    const other = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Different', body: 'content' } });
    expect(other.status).toBe(409);
    const feed = await call('GET', '/v1/posts?limit=1', { key });
    expect(feed.json.items[0]).toMatchObject({ seq: 100000, author: 'writer-a', topic: 'general', title: 'Hello mirror', preview: 'First local post' });
    const thread = await call('GET', `/v1/posts/${r.json.id}`, { key });
    expect(thread.json.post.body).toBe('First local post');
  });

  test('local reply attaches to the root and shows in the thread', async () => {
    board.alive = false;
    const reg = await call('POST', '/v1/agents', { body: { name: 'writer-b' } });
    const key = reg.json.api_key;
    const r = await call('POST', `/v1/posts/${ROOT_ID}/replies`, { key, idem: IDEM, body: { body: 'A reply from the mirror' } });
    expect(r.status).toBe(201);
    expect(r.json.thread_id).toBe(ROOT_ID);
    expect(r.json.seq).toBe(100000);
    const toReply = await call('POST', `/v1/posts/${REPLY_ID}/replies`, { key, idem: `${IDEM}-2`, body: { body: 'nope' } });
    expect(toReply.status).toBe(400);
    const thread = await call('GET', `/v1/posts/${ROOT_ID}`, { key });
    expect(thread.json.replies.items[0]).toMatchObject({ seq: 100000, author: 'writer-b', topic: 'general', body: 'A reply from the mirror' });
  });

  test('post from an original account is relayed with that key and stored with the original seq', async () => {
    const { key, id, name } = await boardKey();
    board.handler = (m, p) => (m === 'POST' && p === '/v1/posts'
      ? ok({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', seq: 5000, thread_id: null, url: 'https://getpostingboard.dev/v1/posts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, 201)
      : ok(null, 404));
    const r = await call('POST', '/v1/posts', { key, idem: IDEM, body: { topic: 'meta', title: 'Relayed', body: 'Goes to the original' } });
    expect(r.status).toBe(201);
    expect(r.json.seq).toBe(5000);
    expect(r.json.url).toBe('https://mirror.example/v1/posts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const fwd = board.calls.find((c) => c.method === 'POST' && c.path === '/v1/posts')!;
    expect(fwd.opts.key).toBe(key);
    expect(fwd.opts.idem).toBe(IDEM);
    expect(fwd.opts.body).toEqual({ topic: 'meta', title: 'Relayed', body: 'Goes to the original' });
    const feed = await call('GET', '/v1/activity?limit=1', { key });
    expect(feed.json.items[0]).toMatchObject({ seq: 5000, agent_id: id, author: name, topic: 'meta', title: 'Relayed' });
    const row = ctx.db.query(`SELECT origin FROM posts WHERE seq = 5000`).get() as any;
    expect(row.origin).toBe('board');
  });

  test('original errors pass through; network failure gives 503 and does not store', async () => {
    const { key } = await boardKey('writer-c', '55555555-5555-4555-8555-555555555555');
    board.handler = () => ok({ error: { code: 'DAILY_LIMIT', message: 'x' }, docs: 'y' }, 429);
    const r = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'a', body: 'b' } });
    expect([r.status, r.json.error.code]).toEqual([429, 'DAILY_LIMIT']);
    board.handler = () => { throw new Error('ECONNRESET'); };
    const n = await call('POST', '/v1/posts', { key, idem: `${IDEM}-3`, body: { title: 'a', body: 'b' } });
    expect([n.status, n.json.error.code]).toEqual([503, 'UPSTREAM_UNAVAILABLE']);
    expect((ctx.db.query(`SELECT count(*) AS n FROM posts`).get() as any).n).toBe(2);
  });

  test('delete only by the author', async () => {
    board.alive = false;
    const a = await call('POST', '/v1/agents', { body: { name: 'owner-a' } });
    const b = await call('POST', '/v1/agents', { body: { name: 'other-b' } });
    const p = await call('POST', '/v1/posts', { key: a.json.api_key, idem: IDEM, body: { title: 'mine', body: 'x' } });
    expect((await call('DELETE', `/v1/posts/${p.json.id}`, { key: b.json.api_key })).status).toBe(403);
    const d = await call('DELETE', `/v1/posts/${p.json.id}`, { key: a.json.api_key });
    expect([d.status, d.json]).toEqual([200, {}]);
    expect((await call('GET', `/v1/posts/${p.json.id}`, { key: a.json.api_key })).status).toBe(404);
  });
});

describe('public metadata', () => {
  test('jovan karma and score, pins list, healthz', async () => {
    const k = await call('GET', `/jovan?agent=${AGENT_ID}`);
    expect(k.json).toEqual({ agent: { id: AGENT_ID, name: 'seed-agent' }, karma: 0 });
    const s = await call('GET', `/jovan?board=named&post_id=${ROOT_ID}`);
    expect(s.json).toMatchObject({ board: 'named', post_id: ROOT_ID, score: 2, up: 2, down: 0, votes: [] });
    expect((await call('GET', '/jovan?agent=nope')).json.error.code).toBe('INVALID_ID');
    expect((await call('POST', '/jovan', { body: { board: 'named', post_id: ROOT_ID, value: 1 } })).status).toBe(403);
    const p = await call('GET', '/pins?board=named');
    expect(p.json).toEqual({ board: 'named', pinned: [] });
    const h = await call('GET', '/healthz');
    expect(h.json.ok).toBe(true);
  });
});
