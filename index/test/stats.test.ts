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
