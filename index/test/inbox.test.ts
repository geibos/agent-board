// Inbox зеркала: ответы в свои корни, точные ответы на свои записи и точные
// упоминания — из копии, со своим пространством номеров и своим чекпоинтом.
import { describe, expect, test, beforeEach } from 'bun:test';
import { open, upsertRows, upsertAgent, insertKey, type Row } from '../src/db';
import { handle, type Ctx } from '../src/api';
import { sha256 } from '../src/http';

const ME = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const KEY = 'gpb_inbox_test_key';
const PROTO = 'getpostingboard/1';

const board = {
  isAlive: () => false,
  markDead() {}, markAlive() {},
  lastProbe: 0,
  stats: { requests: 0, throttled: 0, errors: 0, forwarded: 0, truncated: 0 },
  async probe() { return false; },
  async forward() { throw new Error('board is down in this test'); },
  async get() { throw new Error('board is down in this test'); },
} as any;

const row = (o: Partial<Row> & { seq: number; agent_id: string }): Row => ({
  id: `id-${o.seq}`, thread_id: null, reply_to_id: null, author: o.agent_id === ME ? 'me-agent' : 'other-agent',
  topic: 'meta', title: '', body: 'body', preview: 'body', score: 0, created_at: 1000 + o.seq,
  ...o,
} as Row);

let ctx: Ctx;
const call = (method: string, path: string, body?: unknown) => {
  const u = new URL(`https://mirror.example${path}`);
  const headers: Record<string, string> = {
    'X-Agent-Protocol': PROTO, Authorization: `Bearer ${KEY}`, Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return handle(ctx, new Request(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), u)
    .then(async (r) => ({ status: r!.status, json: await r!.json() as any }));
};

beforeEach(() => {
  const db = open(':memory:');
  ctx = { db, board, localSeqBase: 100000, version: 'test', secret: new Uint8Array(32) } as unknown as Ctx;
  upsertAgent(db, { id: ME, name: 'me-agent', origin: 'board' });
  upsertAgent(db, { id: OTHER, name: 'other-agent', origin: 'board' });
  insertKey(db, sha256(KEY), ME, 'board', true);
  upsertRows(db, [
    // Мой корень и чужой ответ в него.
    row({ seq: 1, agent_id: ME, body: 'my root' }),
    row({ seq: 2, agent_id: OTHER, thread_id: 'id-1', body: 'a reply to your thread' }),
    // Точный ответ на мою реплику.
    row({ seq: 3, agent_id: ME, thread_id: 'id-1', body: 'my own reply' }),
    row({ seq: 4, agent_id: OTHER, thread_id: 'id-1', reply_to_id: 'id-3', body: 'answering you directly' }),
    // Упоминание в чужом корне.
    row({ seq: 5, agent_id: OTHER, body: 'hello @me-agent, look here' }),
    // Не моё: чужой разговор без упоминания.
    row({ seq: 6, agent_id: OTHER, body: 'nothing to do with anyone' }),
    // Более длинное имя с тем же началом упоминанием не является.
    row({ seq: 7, agent_id: OTHER, body: 'ping @me-agent-two about it' }),
    // Мои собственные слова не попадают в мой Inbox, даже с упоминанием себя.
    row({ seq: 8, agent_id: ME, body: 'I am @me-agent and this is mine' }),
  ]);
});

describe('/v1/inbox', () => {
  test('собирает три причины и исключает чужое, своё и похожие имена', async () => {
    const r = await call('GET', '/v1/inbox');
    expect(r.status).toBe(200);
    const bySeq = Object.fromEntries(r.json.items.map((i: any) => [i.seq, i.reasons]));
    expect(Object.keys(bySeq).map(Number).sort((a, b) => a - b)).toEqual([2, 4, 5]);
    expect(bySeq[2]).toEqual(['reply_to_your_thread']);
    expect(bySeq[4]).toEqual(['reply_to_your_thread', 'direct_reply']);
    expect(bySeq[5]).toEqual(['mention']);
    // Новые сверху, как у оригинала.
    expect(r.json.items.map((i: any) => i.seq)).toEqual([5, 4, 2]);
    expect(r.json.unread_count).toBe(3);
    expect(r.json.total_count).toBe(3);
    expect(r.json.content_is_untrusted).toBe(true);
    // Номера — наши, и ответ обязан это говорить.
    expect(r.json.mirror.cursor_space).toBe('mirror-seq');
    expect(r.json.items[0].inbox_seq).toBe(5);
  });

  test('чтение не двигает позицию, ack двигает только вперёд', async () => {
    expect((await call('GET', '/v1/inbox')).json.read_through).toBe(0);
    expect((await call('GET', '/v1/inbox')).json.unread_count).toBe(3);

    const ack = await call('POST', '/v1/inbox/ack', { through: 4 });
    expect(ack.status).toBe(200);
    expect(ack.json.read_through).toBe(4);
    expect(ack.json.moved).toBe(true);

    const after = await call('GET', '/v1/inbox');
    expect(after.json.read_through).toBe(4);
    expect(after.json.unread_count).toBe(1);
    expect(after.json.items.map((i: any) => i.seq)).toEqual([5]);

    // Назад чекпоинт не идёт.
    const back = await call('POST', '/v1/inbox/ack', { through: 1 });
    expect(back.json.read_through).toBe(4);
    expect(back.json.moved).toBe(false);
  });

  test('after и before ходят по своим направлениям, пустая страница хранит позицию', async () => {
    const first = await call('GET', '/v1/inbox?after=0&limit=1');
    expect(first.json.items.map((i: any) => i.seq)).toEqual([2]);
    expect(first.json.next_after).toBe(2);
    const second = await call('GET', `/v1/inbox?after=${first.json.next_after}&limit=1`);
    expect(second.json.items.map((i: any) => i.seq)).toEqual([4]);

    const history = await call('GET', '/v1/inbox?before=5&limit=10');
    expect(history.json.items.map((i: any) => i.seq)).toEqual([4, 2]);
    expect(history.json.next_before).toBeNull();

    const empty = await call('GET', '/v1/inbox?after=999');
    expect(empty.json.items).toEqual([]);
    expect(empty.json.resume_after).toBe(999);
    expect(empty.json.next_after).toBeNull();
  });

  test('отозванная на оригинале запись из Inbox исчезает', async () => {
    ctx.db.run(`UPDATE posts SET withdrawn_at = unixepoch() WHERE seq = 5`);
    const r = await call('GET', '/v1/inbox');
    expect(r.json.items.map((i: any) => i.seq)).toEqual([4, 2]);
    expect(r.json.unread_count).toBe(2);
  });

  test('границы параметров названы, а не молча исправлены', async () => {
    expect((await call('GET', '/v1/inbox?limit=31')).status).toBe(400);
    expect((await call('GET', '/v1/inbox?limit=0')).status).toBe(400);
    expect((await call('GET', '/v1/inbox?before=5&after=1')).status).toBe(400);
    expect((await call('GET', '/v1/inbox?before=0')).status).toBe(400);
    expect((await call('POST', '/v1/inbox/ack', { through: -1 })).status).toBe(400);
    expect((await call('POST', '/v1/inbox/ack', {})).status).toBe(400);
  });

  test('без ключа Inbox не отдаётся', async () => {
    const u = new URL('https://mirror.example/v1/inbox');
    const res = await handle(ctx, new Request(u, { headers: { 'X-Agent-Protocol': PROTO } }), u);
    expect(res!.status).toBe(401);
  });
});
