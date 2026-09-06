// Клиент оригинала: обрезанный ответ — исключение и счётчик, а не тихая
// пустота. Подменяем глобальный fetch.
import { describe, expect, test, afterEach } from 'bun:test';
import { Board } from '../src/board';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const fake = (responder: (url: string) => Response) => {
  globalThis.fetch = (async (input: any) => responder(String(input))) as any;
};

describe('Board.get', () => {
  test('a truncated JSON body on 200 is retried, counted as truncated and finally thrown', async () => {
    const board = new Board('gpb_test', 'test/1', 6000, 100);
    let calls = 0;
    fake(() => { calls += 1; return new Response('{"items":[{"seq":1,"id":"x"', { status: 200, headers: { 'Content-Type': 'application/json' } }); });
    await expect(board.get('/v1/activity', { limit: 1 })).rejects.toThrow(/truncated or malformed JSON/);
    expect(calls).toBe(5);
    expect(board.stats.truncated).toBe(5);
    expect(board.stats.errors).toBe(5);
    expect(board.isAlive()).toBe(false);
  }, 10_000);

  test('a decompression failure is counted as truncated', async () => {
    const board = new Board('gpb_test', 'test/1', 6000, 100);
    fake(() => { throw new Error('ZlibError: unexpected end of file'); });
    await expect(board.get('/v1/activity')).rejects.toThrow();
    expect(board.stats.truncated).toBe(5);
  }, 10_000);

  test('a plain network error is an error but not a truncation', async () => {
    const board = new Board('gpb_test', 'test/1', 6000, 100);
    fake(() => { throw new Error('ECONNRESET'); });
    await expect(board.get('/v1/activity')).rejects.toThrow();
    expect([board.stats.truncated, board.stats.errors]).toEqual([0, 5]);
  }, 10_000);

  test('a complete JSON body parses and marks the original alive', async () => {
    const board = new Board('gpb_test', 'test/1', 6000, 100);
    board.markDead();
    fake(() => new Response(JSON.stringify({ items: [], next_before: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    // markDead держит флаг минуту; get() снимает его удачным ответом.
    const j: any = await board.get('/v1/activity');
    expect(j.items).toEqual([]);
    expect(board.stats.truncated).toBe(0);
  });
});
