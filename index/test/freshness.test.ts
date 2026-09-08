// Свежесть: лента и тела только что появившихся записей не должны ждать
// обслуживания архива, а обход архива не должен держать цикл целиком.
import { describe, expect, test, beforeEach } from 'bun:test';
import { open, upsertRows, setMeta, getMeta } from '../src/db';
import { Sync } from '../src/sync';
import type { Ctx } from '../src/api';

type Up = { status: number; json: any; headers: Headers };
const ok = (json: any, status = 200): Up => ({ status, json, headers: new Headers() });

class FakeBoard {
  alive = true;
  lastProbe = 0;
  stats = { requests: 0, throttled: 0, errors: 0, forwarded: 0, truncated: 0 };
  calls: { path: string; lane: string; at: number }[] = [];
  inFlight = 0;
  peak = 0;
  delayMs = 0;
  handler: (m: string, p: string, o: any) => Up = () => ok(null, 404);
  isAlive() { return this.alive; }
  markDead() { this.alive = false; }
  markAlive() { this.alive = true; }
  async probe() { return this.alive; }
  async forward(method: string, path: string, opts: any = {}) { return this.handler(method, path, opts); }
  async get(path: string, params: any = {}, lane = 'archive') {
    this.calls.push({ path, lane, at: Date.now() });
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      if (this.delayMs) await Bun.sleep(this.delayMs);
      const r = this.handler('GET', path, { params });
      if (r.status !== 200) { const e: any = new Error(`board ${r.status}`); e.status = r.status; throw e; }
      return r.json;
    } finally { this.inFlight -= 1; }
  }
  async getPublic(path: string, params: any = {}, lane = 'archive') { return this.get(path, params, lane); }
}

const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const now = () => Math.floor(Date.now() / 1000);

let ctx: Ctx;
let board: FakeBoard;
let sync: Sync;

beforeEach(() => {
  board = new FakeBoard();
  const db = open(':memory:');
  ctx = { db, board: board as any, localSeqBase: 100000, version: 'test', secret: 'test-secret-0123456789abcdef0123456789abcdef' };
  sync = new Sync(db, board as any, ctx);
});

const seed = (seqs: number[], ageSec: number, body: string | null = null) =>
  upsertRows(ctx.db, seqs.map((seq) => ({
    seq, id: uuid(seq), thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general',
    title: `t${seq}`, body, preview: `p${seq}`, score: 0, created_at: now() - ageSec,
  })));

describe('fresh bodies come first and in parallel', () => {
  test('only just-published posts are taken, on the fresh lane, several at a time', async () => {
    seed([10, 11, 12, 13, 14, 15], 60);        // свежие, тел нет
    seed([20, 21], 4 * 3600);                   // старые, тел нет
    board.delayMs = 20;
    board.handler = (m, p) => ok({ post: { id: p.split('/').pop(), body: 'full body' } });

    await sync.fetchFreshBodies();

    const asked = board.calls.map((c) => c.path);
    expect(asked.length).toBe(6);
    expect(asked.every((p) => [10, 11, 12, 13, 14, 15].some((s) => p.endsWith(uuid(s))))).toBe(true);
    expect(board.calls.every((c) => c.lane === 'fresh')).toBe(true);
    // Именно параллельность: последовательный проход дал бы пик 1.
    expect(board.peak).toBeGreaterThan(1);
    expect(sync.stats.bodies).toBe(6);
    const stale = ctx.db.query(`SELECT count(*) AS n FROM posts WHERE body IS NULL AND seq IN (20, 21)`).get() as any;
    expect(stale.n).toBe(2);
  });

  test('a fresh post withdrawn before its body was taken is recorded as withdrawn', async () => {
    seed([30], 30);
    board.handler = () => ok({ error: { code: 'NOT_FOUND' } }, 404);
    await sync.fetchFreshBodies();
    const row = ctx.db.query(`SELECT body, withdrawn_at IS NOT NULL AS w FROM posts WHERE seq = 30`).get() as any;
    expect([row.body, row.w]).toEqual(['', 1]);
  });
});

describe('presence is checked by age', () => {
  test('fresh posts are re-checked, long-settled ones are skipped', async () => {
    seed([40], 60, 'fresh body');                    // свежий
    seed([41], 20 * 3600, 'old body');               // старый
    // Канарейка берёт запись с самой свежей проверкой — пусть это будет
    // отдельная запись, иначе её запрос не отличить от запроса обхода.
    seed([39], 20 * 3600, 'canary body');
    ctx.db.query(`UPDATE posts SET checked_at = unixepoch() WHERE seq = 39`).run();
    // Старый проверен час назад — в пределах суток, значит не трогаем.
    ctx.db.query(`UPDATE posts SET checked_at = unixepoch() - 3600 WHERE seq = 41`).run();
    ctx.db.query(`UPDATE posts SET checked_at = unixepoch() - 3600 WHERE seq = 40`).run();
    board.handler = () => ok({ post: { id: 'x' } });

    await sync.verifyPresence();
    expect(board.calls.some((c) => c.path.endsWith(uuid(41)))).toBe(false);

    // Общий обход свежую запись уже отметил; свежий шаг возвращается к ней
    // снова, как только его собственный интервал перепроверки истёк.
    ctx.db.query(`UPDATE posts SET checked_at = unixepoch() - 3600 WHERE seq = 40`).run();
    board.calls = [];
    await sync.verifyFresh();
    expect(board.calls.some((c) => c.path.endsWith(uuid(40)))).toBe(true);
    expect(board.calls.every((c) => c.lane === 'fresh' || c.path.endsWith(uuid(40)))).toBe(true);
  });

  test('a long-settled post is still re-checked once its last check is old enough', async () => {
    seed([42], 20 * 3600, 'old body');
    ctx.db.query(`UPDATE posts SET checked_at = unixepoch() - 2 * 86400 WHERE seq = 42`).run();
    board.handler = () => ok({ post: { id: 'x' } });
    await sync.verifyPresence();
    expect(board.calls.some((c) => c.path.endsWith(uuid(42)))).toBe(true);
  });
});

describe('the archive walk goes in chunks', () => {
  const page = (from: number) => ({
    items: Array.from({ length: 30 }, (_, i) => ({
      seq: from - i, id: uuid(from - i), thread_id: null, agent_id: AGENT_ID, author: 'seed-agent',
      topic: 'general', title: `t${from - i}`, created_at: now() - 7200, preview: 'p', score: 0,
    })),
    next_before: from - 30 + 1,
    newest_cursor: 1000,
  });

  test('one step walks at most maxPages and resumes from the cursor', async () => {
    seed([1000], 7200, 'x');
    ctx.db.query(`UPDATE posts SET checked_at = unixepoch() WHERE seq = 1000`).run();
    seed([500], 7200, 'x');
    board.handler = (m, p, o) => {
      if (p !== '/v1/activity') return ok({ post: { id: 'x' } });
      const before = o.params?.before ?? null;
      return ok(page(before === null ? 1000 : before - 1));
    };

    await sync.sweepPresence(0, 3);
    expect(sync.stats.sweep).toMatchObject({ pages: 3, complete: false });
    const cursor = getMeta(ctx.db, 'sweep_cursor');
    expect(cursor).toBeTruthy();
    // Круг не закрыт — отметки о завершении быть не должно.
    expect(getMeta(ctx.db, 'sweep_at')).toBeNull();

    board.calls = [];
    await sync.sweepPresence(0, 3);
    // Продолжение началось с сохранённого курсора, а не сверху.
    const firstFeed = board.calls.find((c) => c.path === '/v1/activity')!;
    expect(firstFeed).toBeTruthy();
    expect(getMeta(ctx.db, 'sweep_cursor')).not.toBe(cursor);
  });

  test('a finished circle stamps the time and clears the cursor', async () => {
    seed([100, 101], 7200, 'x');
    board.handler = (m, p) => (p === '/v1/activity'
      ? ok({ items: [{ seq: 101, id: uuid(101), thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general', title: 't', created_at: now() - 7200, preview: 'p', score: 0 },
                     { seq: 100, id: uuid(100), thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general', title: 't', created_at: now() - 7200, preview: 'p', score: 0 }],
              next_before: null, newest_cursor: 101 })
      : ok({ post: { id: 'x' } }));
    ctx.db.query(`UPDATE posts SET checked_at = unixepoch() WHERE seq = 100`).run();
    await sync.sweepPresence(0, 25);
    expect(sync.stats.sweep).toMatchObject({ complete: true, cursor: null });
    expect(getMeta(ctx.db, 'sweep_cursor')).toBe('');
    expect(getMeta(ctx.db, 'sweep_at')).toBeTruthy();
  });
});

describe('the two steps are independent', () => {
  test('the fresh step touches neither karma, pins, unsorted nor the walk', async () => {
    seed([50], 30);
    board.handler = (m, p) => {
      if (p === '/v1/activity') return ok({ items: [], next_before: null, newest_cursor: 50 });
      return ok({ post: { id: 'x', body: 'b' } });
    };
    await sync.tickFresh();
    const paths = board.calls.map((c) => c.path);
    expect(paths.some((p) => p.startsWith('/jovan'))).toBe(false);
    expect(paths.some((p) => p === '/pins')).toBe(false);
    expect(paths.some((p) => p === '/b')).toBe(false);
    expect(sync.stats.freshTick).toBeGreaterThan(0);
    expect(sync.stats.archiveTick).toBe(0);
  });

  test('an archive failure does not show up as a fresh failure', async () => {
    board.handler = (m, p) => (p === '/v1/activity'
      ? ok({ items: [], next_before: null, newest_cursor: 1 })
      : ok(null, 500));
    await sync.tickFresh();
    expect(sync.stats.freshError).toBe('');
    await sync.tickArchive();
    expect(sync.stats.archiveError).not.toBe('');
    expect(sync.stats.freshError).toBe('');
  });
});
