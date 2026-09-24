// Общие компьютеры доски (контракт 1.17.0): машина за постом, у неё состояние,
// аренда управления и журнал квитанций «кто что делал». Журнал видят все
// именованные читатели, но команды и пути в нём (`detail`) — только ветераны.
//
// Зеркало читает двумя ключами. Своим (обычный читатель) — то, что показывает
// наружу: ровно тот вид, который доска отдаёт не-ветерану. Ветеранским — полный
// журнал в отдельную таблицу, которая наружу не отдаётся ни одним маршрутом.
import { describe, expect, test, beforeEach } from 'bun:test';
import { open } from '../src/db';
import { syncComputers, computersView, computerView } from '../src/computers';

const READER = 'gpb_reader';
const VETERAN = 'gpb_veteran';
const WIRE_CAP = 20000;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Receipt = { seq: number; at: number; actor: string | null; cause: string; type: string; result: string; summary: string; detail?: unknown };

class ComputerBoard {
  computers = new Map<string, { title: string; author: string; state: string; holder: string | null; receipts: Receipt[] }>();
  calls: { path: string; params: any; key: string }[] = [];
  gone = new Set<string>();

  add(id: string, title: string, author: string) {
    this.computers.set(id, { title, author, state: 'stopped', holder: null, receipts: [] });
  }
  receipt(id: string, r: Omit<Receipt, 'seq'>) {
    const all = [...this.computers.values()].flatMap((c) => c.receipts);
    const seq = all.reduce((m, x) => Math.max(m, x.seq), 100) + 1;
    this.computers.get(id)!.receipts.push({ seq, ...r });
    return seq;
  }
  #cap(x: unknown) {
    if (JSON.stringify(x).length > WIRE_CAP) throw new Error('response over the wire cap');
    return x;
  }
  #view(r: Receipt, key: string) {
    const { detail, ...rest } = r;
    return key === VETERAN && detail !== undefined ? { ...rest, detail } : rest;
  }
  async get(path: string, params: any = {}, _lane = 'archive', key = READER) {
    this.calls.push({ path, params, key });
    if (path === '/v1/feed') {
      expect(params.type).toBe('computer');
      const ids = [...this.computers.keys()].filter((id) => !this.gone.has(id));
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = ids.slice(start, start + (params.limit ?? 20));
      const more = start + page.length < ids.length;
      return this.#cap({
        items: page.map((id) => ({ ref: { source: 'named', root_id: id }, type: 'computer', title: this.computers.get(id)!.title,
          author: this.computers.get(id)!.author, root_preview: 'x'.repeat(600) })),
        cursor: more ? String(start + page.length) : null, more,
      });
    }
    const m = path.match(/^\/v1\/computers\/([0-9a-f-]{36})(\/activity)?$/);
    if (!m || !this.computers.has(m[1]!) || this.gone.has(m[1]!)) {
      const e: any = new Error('board 404'); e.status = 404; throw e;
    }
    const c = this.computers.get(m[1]!)!;
    const newest = [...c.receipts].sort((x, y) => y.seq - x.seq);
    if (!m[2]) {
      return this.#cap({
        computer: { post_id: m[1], title: c.title, author: c.author, seq: 5000, created_at: 1790000000, purpose: `Purpose of ${c.title}`,
          // Шаблон у живой доски — объект, а не строка: так 1.29.0 падала
          // на записи в SQLite при каждом проходе, а тесты с заглушкой-строкой шли.
          template: { id: 'shared-1x-1gb', cpus: 1, memory_mb: 1024, workspace_gb: 2 }, runtime: { state: c.state, observed_at: 1790000100, stale: false, pending: null },
          control: { state: c.holder ? 'held' : 'available', holder: c.holder, generation: 1, expires_at: null },
          work: { active: [], recent: [] }, access: { you: { eligible: key === VETERAN } } },
        recent_activity: { items: newest.slice(0, 3).map((r) => this.#view(r, key)) },
      });
    }
    const limit = params.limit ?? 20;
    let items: Receipt[];
    let nextAfter: number | null = null;
    if (params.after !== undefined) {
      const newer = [...c.receipts].sort((x, y) => x.seq - y.seq).filter((r) => r.seq > Number(params.after));
      const page = newer.slice(0, limit);
      if (newer.length > limit) nextAfter = page[page.length - 1]!.seq;
      items = page.reverse();
    } else {
      items = newest.slice(0, limit);
    }
    return this.#cap({ items: items.map((r) => this.#view(r, key)), next_after: nextAfter, detail_visible: key === VETERAN });
  }
}

let db: ReturnType<typeof open>;
let board: ComputerBoard;
const ctx = (veteranKey?: string) => ({ db, board: board as any, localSeqBase: 100000, version: 't', secret: 's', veteranKey });

beforeEach(() => {
  db = open(':memory:');
  board = new ComputerBoard();
  board.add(A, 'Recount lab', 'agent-board-sobieg');
  board.receipt(A, { at: 1790000000, actor: 'agent-board-sobieg', cause: 'actor', type: 'created', result: 'accepted', summary: 'Created the computer.' });
  board.receipt(A, { at: 1790000010, actor: null, cause: 'system', type: 'provisioned', result: 'succeeded', summary: 'Provisioned.' });
  board.receipt(A, { at: 1790000100, actor: 'hermione', cause: 'actor', type: 'job_submitted', result: 'accepted', summary: 'Submitted a job.',
    detail: { command: 'python3 recount.py --secret-flag', cwd: 'lab' } });
});

describe('общие компьютеры', () => {
  test('находит машины по ленте /computer и хранит обзор, каким его видит обычный читатель', async () => {
    board.add(B, 'Archive checks', 'hermione');
    const r = await syncComputers(ctx(VETERAN));
    expect(r.computers).toBe(2);
    const v = computersView(db);
    expect(v.computers.map((c: any) => c.id).sort()).toEqual([A, B]);
    const a = v.computers.find((c: any) => c.id === A)!;
    expect(a).toMatchObject({ title: 'Recount lab', author: 'agent-board-sobieg', purpose: 'Purpose of Recount lab',
      template: 'shared-1x-1gb', runtime: { state: 'stopped' }, control: { state: 'available', holder: null }, activity_count: 3 });
    // Обзор — ключом читателя, не ветерана.
    const detailCalls = board.calls.filter((c) => c.path === `/v1/computers/${A}`);
    expect(detailCalls.every((c) => c.key === READER)).toBe(true);
    expect(JSON.stringify(v)).not.toContain('"eligible":true');
    expect(v.observed_since).toBeGreaterThan(0);
  });

  test('журнал «кто что делал»: публично — без команд, полный — только в своей таблице', async () => {
    await syncComputers(ctx(VETERAN));
    const v = computerView(db, A, {})!;
    expect(v.activity.items.map((i: any) => i.seq)).toEqual([103, 102, 101]);
    expect(v.activity.items[0]).toMatchObject({ actor: 'hermione', type: 'job_submitted', summary: 'Submitted a job.' });
    expect(v.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: 'hermione', total: 1 }),
      expect.objectContaining({ actor: 'agent-board-sobieg', total: 1 }),
    ]));
    const everything = JSON.stringify([v, computersView(db)]);
    expect(everything).not.toContain('recount.py');
    expect(everything).not.toContain('"detail"');
    // А полный журнал лежит у зеркала — с командой.
    const full = db.query(`SELECT json FROM computer_activity_full WHERE seq = 103`).get() as { json: string };
    expect(JSON.parse(full.json).detail.command).toBe('python3 recount.py --secret-flag');
  });

  test('без ветеранского ключа полный журнал не пишется, публичный — пишется', async () => {
    await syncComputers(ctx(undefined));
    expect((db.query(`SELECT count(*) AS n FROM computer_activity`).get() as any).n).toBe(3);
    expect((db.query(`SELECT count(*) AS n FROM computer_activity_full`).get() as any).n).toBe(0);
    expect(board.calls.some((c) => c.key === VETERAN)).toBe(false);
  });

  test('дочитывает журнал с последней квитанции, страницами, без дыр', async () => {
    await syncComputers(ctx(VETERAN));
    for (let i = 0; i < 45; i += 1) {
      board.receipt(A, { at: 1790001000 + i, actor: 'deal-to-rule', cause: 'actor', type: 'file_saved', result: 'succeeded',
        summary: `Saved a file (${i}).`, detail: { path: `results/r${i}.txt`, note: 'y'.repeat(2000) } });
    }
    board.calls = [];
    await syncComputers(ctx(VETERAN));
    const pub = db.query(`SELECT seq FROM computer_activity WHERE computer_id = ? ORDER BY seq`).all(A) as { seq: number }[];
    const full = db.query(`SELECT seq FROM computer_activity_full WHERE computer_id = ? ORDER BY seq`).all(A) as { seq: number }[];
    const want = Array.from({ length: 48 }, (_, i) => 101 + i);
    expect(pub.map((r) => r.seq)).toEqual(want);
    expect(full.map((r) => r.seq)).toEqual(want);
    // Каждый запрос журнала начинается с того, что уже есть: первый — after=103.
    const firstPub = board.calls.find((c) => c.path === `/v1/computers/${A}/activity` && c.key === READER)!;
    expect(firstPub.params.after).toBe(103);
    const v = computerView(db, A, { limit: 10 })!;
    expect(v.activity.items).toHaveLength(10);
    expect(v.activity.items[0].seq).toBe(148);
    expect(v.activity.next_before).toBe(139);
    const older = computerView(db, A, { before: 139, limit: 10 })!;
    expect(older.activity.items[0].seq).toBe(138);
    expect(v.actors.find((x: any) => x.actor === 'deal-to-rule')).toMatchObject({ total: 45, by_type: { file_saved: 45 } });
  });

  test('машина, чей пост удалён, остаётся в списке с отметкой, а не пропадает', async () => {
    await syncComputers(ctx(VETERAN));
    board.gone.add(A);
    await syncComputers(ctx(VETERAN));
    const a = computersView(db).computers.find((c: any) => c.id === A)!;
    expect(a.gone_at).toBeGreaterThan(0);
    expect(a.activity_count).toBe(3);
  });

  test('неизвестная машина — null', () => {
    expect(computerView(db, B, {})).toBeNull();
    expect(computersView(db).observed_since).toBeNull();
  });
});

// Чтение для ветеранов: зритель вставляет ключ своего агента, зеркало
// пересылает запрос оригиналу этим ключом и ничего не хранит. Решает доска:
// ветерану она отдаёт команды, задачи, вывод и файлы, остальным — отказ.
import { veteranRead } from '../src/computers';

describe('данные для ветеранов по ключу зрителя', () => {
  const KEY = 'gpb_viewerKey_0123456789abcdef';
  type Fwd = { method: string; path: string; opts: any };
  const fwd: Fwd[] = [];
  let answer: (path: string) => { status: number; json: any } = () => ({ status: 200, json: { items: [] } });
  const vctx = () => ({ db, localSeqBase: 100000, version: 't', secret: 's',
    board: { forward: async (method: string, path: string, opts: any) => { fwd.push({ method, path, opts }); return { ...answer(path), headers: new Headers() }; } } as any });
  const call = (sub: string, key: string | null, qs = '') =>
    veteranRead(vctx(), A, sub, new URL(`http://m/computers/${A}/v/${sub}${qs}`), key);
  beforeEach(() => { fwd.length = 0; answer = () => ({ status: 200, json: { items: [{ command: 'bash run.sh' }] } }); });

  test('без ключа и с ключом не той формы — 401, оригиналу ничего не уходит', async () => {
    for (const k of [null, '', 'not-a-key', 'gpb_short', 'gpb_ok0123456789abcdef x']) {
      const r = await call('jobs', k);
      expect(r.status).toBe(401);
    }
    expect(fwd).toHaveLength(0);
  });

  test('ключ уходит оригиналу на тот же маршрут, только разрешённые параметры, ответ без кеша', async () => {
    const r = await call('jobs', KEY, '?limit=20&before=5&evil=1&path=x');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ items: [{ command: 'bash run.sh' }] });
    expect(fwd).toEqual([{ method: 'GET', path: `/v1/computers/${A}/jobs`, opts: expect.objectContaining({ key: KEY }) }]);
    expect(fwd[0]!.opts.params).toEqual({ limit: '20', before: '5', path: 'x' });
    const j = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await call(`jobs/${j}/output`, KEY, '?offset=300&limit=65536');
    expect(fwd[1]!.path).toBe(`/v1/computers/${A}/jobs/${j}/output`);
  });

  test('отказ доски проходит насквозь: не ветеран — не ветеран', async () => {
    answer = () => ({ status: 403, json: { error: { code: 'COMPUTER_VETERAN_REQUIRED', message: 'x' } } });
    const r = await call('activity', KEY);
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('COMPUTER_VETERAN_REQUIRED');
  });

  test('маршруты вне списка не пересылаются', async () => {
    for (const sub of ['control', 'lifecycle', 'files/../control', 'jobs/not-a-uuid', 'jobs/x/cancel']) {
      const r = await call(sub, KEY);
      expect(r.status).toBe(404);
    }
    expect(fwd).toHaveLength(0);
  });

  test('оригинал молчит — 503, а не пустой ответ', async () => {
    const r = await veteranRead({ ...vctx(), board: { forward: async () => { throw new Error('ECONNRESET'); } } as any },
      A, 'jobs', new URL(`http://m/x`), KEY);
    expect(r.status).toBe(503);
  });

  test('ключ зрителя нигде не остаётся', async () => {
    await call('jobs', KEY);
    const tables = (db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      const rows = db.query(`SELECT * FROM "${t}"`).all();
      expect(JSON.stringify(rows)).not.toContain(KEY);
    }
  });
});
