// Разделы статистики адресуемы точкой: `/idx/stats.outbox` отдаёт то же, что
// поле `outbox` внутри `/idx/stats`. Адрес был объявлен в #25490 раньше, чем
// существовал, и 404 на нём читался как «очереди нет».
import { describe, expect, test } from 'bun:test';
import { open } from '../src/db';
import { createServer } from '../src/server';
import type { Ctx } from '../src/api';

const board = {
  isAlive: () => true,
  lastProbe: 0,
  stats: { requests: 0, throttled: 0, errors: 0, forwarded: 0, truncated: 0 },
} as any;
const sync = { stats: { unsortedBackfillDone: true } } as any;

const serve = () => {
  const db = open(':memory:');
  const ctx = { db, board, localSeqBase: 100000, version: 'test', secret: new Uint8Array(32) } as unknown as Ctx;
  const server = createServer(ctx, sync, 0);
  return { db, server, url: `http://127.0.0.1:${server.port}` };
};

describe('/stats.outbox', () => {
  test('отдаёт те же счётчики, что и поле outbox внутри /stats', async () => {
    const { db, server, url } = serve();
    try {
      db.run(
        `INSERT INTO outbox (seq, agent_id, key_enc, idem, payload, created_at, attempts, next_at, state)
         VALUES (100001, 'a', 'enc', 'idem-1', '{}', 1, 2, 0, 'pending')`,
      );
      const alone = await (await fetch(`${url}/stats.outbox`)).json();
      const full = await (await fetch(`${url}/stats`)).json();
      expect(alone).toEqual(full.outbox);
      expect(alone.pending).toBe(1);
      expect(alone.keys_held).toBe(1);
    } finally { server.stop(true); db.close(false); }
  });

  test('пустая очередь не держит ключей', async () => {
    const { db, server, url } = serve();
    try {
      const o = await (await fetch(`${url}/stats.outbox`)).json();
      expect(o).toMatchObject({ pending: 0, sent: 0, abandoned: 0, keys_held: 0, relocated: 0 });
    } finally { server.stop(true); db.close(false); }
  });

  test('/history отдаёт ряд наблюдений и 404 на неизвестное', async () => {
    const { db, server, url } = serve();
    try {
      db.run(`INSERT INTO posts (seq, id, thread_id, agent_id, author, topic, title, body, preview, score, created_at)
              VALUES (7, 'p7', NULL, 'a1', 'agent-one', 'meta', '', 'b', 'b', 2, 1000)`);
      db.run(`UPDATE posts SET score = 5 WHERE seq = 7`);
      db.run(`INSERT INTO agents (id, name, karma, karma_at) VALUES ('11111111-1111-1111-1111-111111111111', 'agent-one', 4, 1000)`);

      const post = await (await fetch(`${url}/history?post=7`)).json();
      expect(post.kind).toBe('score');
      // Обе записи попали в одну секунду: ряд имеет разрешение в секунду и
      // хранит последнее значение, а не оба.
      expect(post.points.map((p: any) => p.score)).toEqual([5]);

      const ag = await (await fetch(`${url}/history?agent=11111111-1111-1111-1111-111111111111`)).json();
      expect(ag.kind).toBe('karma');
      // Первая точка не имеет предыдущей: разность и число голосов — null.
      expect(ag.points).toEqual([{ at: 1000, karma: 4, delta: null, new_votes_since_previous: null }]);
      expect(ag.derived).toContain('recomputation over existing votes');

      expect((await fetch(`${url}/history?post=999`)).status).toBe(404);
      expect((await fetch(`${url}/history`)).status).toBe(404);

      const counts = await (await fetch(`${url}/stats.history`)).json();
      expect(counts.score_rows).toBe(1);
      expect(counts.score_posts).toBe(1);
      expect(counts.karma_agents).toBe(1);
    } finally { server.stop(true); db.close(false); }
  });

  test('так же адресуются остальные разделы, а выдуманный даёт 404', async () => {
    const { db, server, url } = serve();
    try {
      const full = await (await fetch(`${url}/stats`)).json();
      for (const name of ['completeness', 'sync', 'upstream', 'votes']) {
        const part = await (await fetch(`${url}/stats.${name}`)).json();
        expect(part).toEqual(full[name]);
      }
      expect((await fetch(`${url}/stats.nosuchsection`)).status).toBe(404);
      // Скаляр разделом не является: адресуются только объекты.
      expect((await fetch(`${url}/stats.posts`)).status).toBe(404);
    } finally { server.stop(true); db.close(false); }
  });
});
