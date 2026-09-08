// Ряд во времени: оригинал отдаёт «сейчас», история кармы и счёта существует
// только в копии. Строка пишется триггером при изменении значения, поэтому
// ни один путь записи её не минует.
import { describe, expect, test } from 'bun:test';
import { open, upsertRows, setKarma, karmaHistory, scoreHistory, type Row } from '../src/db';

const row = (seq: number, score: number): Row => ({
  seq, id: `id-${seq}`, thread_id: null, agent_id: 'a1', author: 'agent-one',
  topic: 'meta', title: '', body: 'body', preview: 'body', score, created_at: 1000,
});

describe('history', () => {
  test('карма пишется при первом значении и при каждом изменении', () => {
    const db = open(':memory:');
    try {
      setKarma(db, 'a1', 'agent-one', 5);
      setKarma(db, 'a1', 'agent-one', 5);
      db.run(`UPDATE karma_history SET at = at - 10 WHERE karma = 5`);
      setKarma(db, 'a1', 'agent-one', 7);
      db.run(`UPDATE karma_history SET at = at - 5 WHERE karma = 7`);
      setKarma(db, 'a1', 'agent-one', 3);
      const points = karmaHistory(db, 'a1');
      expect(points.map((p) => p.karma)).toEqual([5, 7, 3]);
      // Повтор того же значения новой точки не создаёт.
      expect(points.length).toBe(3);
    } finally { db.close(false); }
  });

  test('счёт записи пишется при вставке и при изменении, не при повторе', () => {
    const db = open(':memory:');
    try {
      upsertRows(db, [row(1, 0)]);
      db.run(`UPDATE score_history SET at = at - 10`);
      upsertRows(db, [row(1, 0)]);
      upsertRows(db, [row(1, 4)]);
      const points = scoreHistory(db, 1);
      expect(points.map((p) => p.score)).toEqual([0, 4]);
      expect(points[0]!.at).toBeLessThan(points[1]!.at);
    } finally { db.close(false); }
  });

  test('засев первой точки для того, что уже лежит в копии', () => {
    const db = open(':memory:');
    try {
      upsertRows(db, [row(1, 3), row(2, 6)]);
      // Как если бы копия наполнялась версией без истории: рядов нет.
      db.run(`DELETE FROM score_history`);
      expect(scoreHistory(db, 1)).toEqual([]);
      // Тот самый запрос, который выполняет миграция при первом запуске.
      db.exec(`INSERT OR IGNORE INTO score_history (seq, at, score)
               SELECT seq, coalesce(seen_at, created_at), score FROM posts`);
      expect(scoreHistory(db, 1).map((p) => p.score)).toEqual([3]);
      expect(scoreHistory(db, 2).map((p) => p.score)).toEqual([6]);
    } finally { db.close(false); }
  });
});
