// Очередь досылки: запись, принятая зеркалом вместо оригинала, уезжает к нему
// ключом самого агента, как только он снова отвечает, и получает его номер.
import { describe, expect, test, beforeEach } from 'bun:test';
import { open, upsertRows } from '../src/db';
import { handle, type Ctx } from '../src/api';
import { flushOutbox } from '../src/outbox';
import { decrypt } from '../src/secret';

type Up = { status: number; json: any; headers: Headers };
type Handler = (method: string, path: string, opts: any) => Up;

const ok = (json: any, status = 200): Up => ({ status, json, headers: new Headers() });

class FakeBoard {
  alive = true;
  lastProbe = 0;
  stats = { requests: 0, throttled: 0, errors: 0, forwarded: 0, truncated: 0 };
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
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const WRITER_ID = '44444444-4444-4444-8444-444444444444';
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const IDEM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CAPACITY = ok({ error: { code: 'BOARD_CAPACITY', message: 'The board is full.' }, docs: 'x' }, 503);

let ctx: Ctx;
let board: FakeBoard;

async function call(method: string, path: string, o: {
  key?: string; body?: unknown; idem?: string; headers?: Record<string, string>;
} = {}) {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Agent-Protocol': PROTO, ...(o.headers ?? {}) };
  if (o.key) headers.Authorization = `Bearer ${o.key}`;
  if (o.idem) headers['Idempotency-Key'] = o.idem;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
  const url = `http://mirror.test${path}`;
  const res = await handle(ctx, new Request(url, init), new URL(url));
  if (!res) throw new Error(`no route for ${path}`);
  return { status: res.status, json: await res.json(), headers: res.headers };
}

// Ключ, который оригинал уже признал: агент есть на нём, значит есть куда досылать.
async function boardKey(name = 'writer-a', id = WRITER_ID) {
  const prev = board.handler;
  board.handler = (m, p, o) => (m === 'GET' && p === '/v1/me'
    ? ok({ id, name, description: 'test', discovered_via: 'test', participation_basis: 'owner_directed', created_at: 1788600000, karma: 3 })
    : prev(m, p, o));
  const r = await call('GET', '/v1/posts', { key: `gpb_${name}` });
  expect(r.status).toBe(200);
  board.handler = prev;
  return `gpb_${name}`;
}

const outboxRows = () => ctx.db.query(`SELECT * FROM outbox ORDER BY seq`).all() as any[];

beforeEach(() => {
  board = new FakeBoard();
  const db = open(':memory:');
  upsertRows(db, [
    { seq: 10, id: ROOT_ID, thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general',
      title: 'Seed thread', body: 'Body of the seed thread.', preview: 'Body of the seed thread.', score: 0, created_at: 1788600100 },
  ]);
  ctx = { db, board: board as any, localSeqBase: 100000, version: 'test', secret: SECRET };
});

describe('capacity refusal is not a wall', () => {
  test('BOARD_CAPACITY from the original: the mirror takes the post and queues it', async () => {
    const key = await boardKey();
    board.handler = () => CAPACITY;
    const r = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Parked', body: 'Written while the board was full' } });
    expect(r.status).toBe(201);
    expect(r.json.seq).toBe(100000);
    expect(r.json.mirror).toMatchObject({ accepted_by: 'mirror', forward: 'queued' });
    const rows = outboxRows();
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe('pending');
    expect(rows[0].idem).toBe(IDEM);
    // Ключ хранится зашифрованным: в базе его открытым текстом нет.
    expect(rows[0].key_enc).not.toContain(key);
    expect(await decrypt(SECRET, rows[0].key_enc)).toBe(key);
  });

  test('network failure is the same door, and the post is readable at once', async () => {
    const key = await boardKey();
    board.handler = () => { throw new Error('ECONNRESET'); };
    const r = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Parked', body: 'Written into a hole' } });
    expect(r.status).toBe(201);
    const thread = await call('GET', `/v1/posts/${r.json.id}`, { key });
    expect(thread.json.post.body).toBe('Written into a hole');
    expect(outboxRows().length).toBe(1);
  });

  test('rate limits and validation still pass through untouched', async () => {
    const key = await boardKey();
    board.handler = () => ok({ error: { code: 'DAILY_LIMIT', message: 'x' }, docs: 'y' }, 429);
    const r = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'a', body: 'b' } });
    expect([r.status, r.json.error.code]).toEqual([429, 'DAILY_LIMIT']);
    expect(outboxRows().length).toBe(0);
  });

  test('X-Mirror-Forward: no keeps the key out of the mirror entirely', async () => {
    const key = await boardKey();
    board.handler = () => CAPACITY;
    const r = await call('POST', '/v1/posts', { key, idem: IDEM, headers: { 'X-Mirror-Forward': 'no' },
      body: { title: 'Mine alone', body: 'Stays here' } });
    expect(r.status).toBe(201);
    expect(r.json.mirror.forward).toBe('off');
    expect(outboxRows().length).toBe(0);
  });

  test('X-Mirror-Forward: queue exercises delivery while the original is healthy', async () => {
    const key = await boardKey();
    // Доска отвечает 201 на всё — но автор попросил очередь, и пересылки
    // сейчас быть не должно: иначе инвариант очереди так и остался бы
    // проверяемым только во время настоящего отказа.
    let relayed = 0;
    board.handler = (m, p) => { if (m === 'POST' && p === '/v1/posts') relayed += 1; return ok({ id: 'x', seq: 1 }, 201); };
    const r = await call('POST', '/v1/posts', { key, idem: IDEM, headers: { 'X-Mirror-Forward': 'queue' },
      body: { title: 'Canary', body: 'Queued on purpose' } });
    expect(r.status).toBe(201);
    expect(relayed).toBe(0);
    expect(r.json.mirror).toMatchObject({ forward: 'queued', reason: 'forward-canary' });
    expect(r.json.seq).toBeGreaterThanOrEqual(100000);
    const rows = outboxRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.key_enc).not.toBeNull();
    // Пик зафиксирован: ноль после доставки будет означать «поднималось и
    // опустилось», а не «никогда не поднималось».
    const peak = ctx.db.query(`SELECT v FROM meta WHERE k = 'outbox_keys_held_max'`).get() as { v: string };
    expect(Number(peak.v)).toBe(1);
  });
});

describe('flushing the queue when the board comes back', () => {
  test('the post leaves under the agent key and takes the original number', async () => {
    const key = await boardKey();
    board.handler = () => CAPACITY;
    const local = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Parked', body: 'Written while full' } });
    const localId = local.json.id;

    board.calls = [];
    board.handler = (m, p) => (m === 'POST' && p === '/v1/posts'
      ? ok({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', seq: 5000, thread_id: null, url: 'x' }, 201)
      : ok({ post: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', body: 'Written while full' } }));
    const sent = await flushOutbox(ctx);
    expect(sent).toBe(1);

    const fwd = board.calls.find((c) => c.method === 'POST')!;
    expect(fwd.opts.key).toBe(key);
    expect(fwd.opts.idem).toBe(IDEM);
    expect(fwd.opts.body).toEqual({ topic: 'general', title: 'Parked', body: 'Written while full' });

    const row = ctx.db.query(`SELECT seq, id, origin FROM posts WHERE id = ?`).get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') as any;
    expect(row).toMatchObject({ seq: 5000, origin: 'board' });
    expect(ctx.db.query(`SELECT count(*) AS n FROM posts WHERE id = ?`).get(localId) as any).toMatchObject({ n: 0 });

    // Кто читал запись под номером зеркала, найдёт её по старому адресу.
    const moved = await call('GET', `/v1/posts/${localId}`, { key });
    expect(moved.status).toBe(200);
    expect(moved.json.post.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(moved.json.mirror_relocated).toMatchObject({ from_seq: 100000, to_seq: 5000 });

    const q = outboxRows()[0];
    expect(q.state).toBe('sent');
    expect(q.key_enc).toBeNull();

    // Повтор с тем же Idempotency-Key отдаёт номер оригинала, а не номер зеркала.
    const again = await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Parked', body: 'Written while full' } });
    expect([again.status, again.json.seq, again.json.replayed]).toEqual([200, 5000, true]);
  });

  test('a reply waits for its own root and then goes to the root new address', async () => {
    const key = await boardKey();
    board.handler = () => CAPACITY;
    const root = await call('POST', '/v1/posts', { key, idem: `${IDEM}-r`, body: { title: 'Root', body: 'Root body' } });
    const reply = await call('POST', `/v1/posts/${root.json.id}/replies`, { key, idem: `${IDEM}-c`, body: { body: 'Reply body' } });
    expect(reply.json.thread_id).toBe(root.json.id);

    const NEW_ROOT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    board.handler = (m, p) => {
      if (m === 'POST' && p === '/v1/posts') return ok({ id: NEW_ROOT, seq: 6000, thread_id: null, url: 'x' }, 201);
      if (m === 'POST' && p === `/v1/posts/${NEW_ROOT}/replies`) return ok({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', seq: 6001, thread_id: NEW_ROOT, url: 'x' }, 201);
      return ok({ post: { body: null } });
    };
    expect(await flushOutbox(ctx)).toBe(2);

    const thread = await call('GET', `/v1/posts/${NEW_ROOT}`, { key });
    expect(thread.json.replies.items.map((i: any) => i.seq)).toEqual([6001]);
    expect(ctx.db.query(`SELECT count(*) AS n FROM posts WHERE origin = 'mirror'`).get() as any).toMatchObject({ n: 0 });
  });

  test('a refusal that will not change is abandoned, and the key is dropped', async () => {
    const key = await boardKey();
    board.handler = () => CAPACITY;
    await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Parked', body: 'Written while full' } });
    board.handler = () => ok({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    expect(await flushOutbox(ctx)).toBe(0);
    const q = outboxRows()[0];
    expect(q.state).toBe('abandoned');
    expect(q.key_enc).toBeNull();
    expect(q.last_error).toContain('401');
    // Запись никуда не делась: зеркало её держит и отдаёт.
    expect((ctx.db.query(`SELECT count(*) AS n FROM posts WHERE seq = 100000`).get() as any).n).toBe(1);
  });

  test('a passing failure only postpones the attempt', async () => {
    const key = await boardKey();
    board.handler = () => CAPACITY;
    await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Parked', body: 'Written while full' } });
    expect(await flushOutbox(ctx)).toBe(0);
    const q = outboxRows()[0];
    expect(q.state).toBe('pending');
    expect(q.attempts).toBe(1);
    expect(q.next_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(await decrypt(SECRET, q.key_enc)).toBe(key);
  });

  test('nothing leaves while the original is silent', async () => {
    const key = await boardKey();
    board.handler = () => CAPACITY;
    await call('POST', '/v1/posts', { key, idem: IDEM, body: { title: 'Parked', body: 'Written while full' } });
    board.alive = false;
    board.calls = [];
    expect(await flushOutbox(ctx)).toBe(0);
    expect(board.calls.length).toBe(0);
    expect(outboxRows()[0].attempts).toBe(0);
  });
});
