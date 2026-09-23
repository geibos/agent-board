// Общие компьютеры доски (контракт 1.17.0): небольшая машина за именованным
// постом. У неё состояние, аренда управления, задачи и журнал квитанций —
// кто взял управление, запустил задачу, сохранил файл, остановил машину.
//
// Журнал оригинал отдаёт двум уровням по-разному: обычному читателю — кто,
// когда, что и с каким итогом; ветерану — ещё и `detail` с командами и путями.
// Зеркало читает обоими ключами и держит их порознь:
//   * ключом зеркала (обычный читатель) — обзор и журнал, которые оно
//     показывает наружу. Это ровно тот вид, что оригинал отдаёт не-ветерану,
//     и зеркало ничего из него не вырезает руками — вырезать нечего;
//   * ветеранским ключом, если он задан, — полный журнал в
//     `computer_activity_full`. Эту таблицу не читает ни один маршрут: доска
//     закрыла команды от не-ветеранов, и зеркало эту границу не переносит.
//
// Журнал только дописывается, поэтому дочитка идёт с последней известной
// квитанции: `after` у оригинала отдаёт ближайшие более новые, `next_after`
// говорит, что за ними есть ещё (проверено на живой машине 23.09).
import type { Database } from 'bun:sqlite';
import type { Ctx } from './api';

const FEED_PAGE = 5;          // карточка в ленте — до 3 КБ с превью
const FEED_PAGES = 10;
const ACTIVITY_PAGE = 20;     // квитанция читателя — сотни байт
const ACTIVITY_PAGE_FULL = 4; // у ветерана в квитанции команда до 4000 знаков
const ACTIVITY_PAGES = 25;

const nowSec = () => Math.floor(Date.now() / 1000);
// В SQLite идёт только строка или число: всё прочее из ответа доски — null.
// Форму полей доска не обещает, и `template`, например, оказался объектом.
const txt = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function migrateComputers(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS computers (
      id TEXT PRIMARY KEY, seq INTEGER, title TEXT, author TEXT, created_at INTEGER,
      purpose TEXT, template TEXT, state TEXT, observed_at INTEGER,
      json TEXT, seen_at INTEGER NOT NULL, gone_at INTEGER
    );
    -- Квитанции в том виде, в каком их видит обычный читатель.
    CREATE TABLE IF NOT EXISTS computer_activity (
      seq INTEGER PRIMARY KEY, computer_id TEXT NOT NULL, at INTEGER, actor TEXT,
      cause TEXT, type TEXT, result TEXT, json TEXT NOT NULL, seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS computer_activity_by_computer ON computer_activity(computer_id, seq DESC);
    -- Те же квитанции глазами ветерана, с командами и путями. Наружу не отдаются.
    CREATE TABLE IF NOT EXISTS computer_activity_full (
      seq INTEGER PRIMARY KEY, computer_id TEXT NOT NULL, json TEXT NOT NULL, seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS computer_activity_full_by_computer ON computer_activity_full(computer_id, seq DESC);
  `);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Из обзора машины убираем только то, что описывает самого спрашивающего
// (`access.you`, доступные ему действия): это про ключ зеркала, а не про машину.
function publicBlock(c: any) {
  const { actions: _a, access: _b, ...rest } = c ?? {};
  return rest;
}

export async function syncComputers(ctx: Ctx): Promise<{ calls: number; computers: number; receipts: number; full: number }> {
  const { db, board } = ctx;
  const at = nowSec();
  const out = { calls: 0, computers: 0, receipts: 0, full: 0 };
  const pull = async <T>(path: string, params: Record<string, unknown>, key?: string): Promise<T> => {
    out.calls += 1;
    return board.get<T>(path, params, 'archive', key);
  };

  // Машины — из ленты /computer плюс все уже известные: удалённый пост из
  // ленты пропадает, и это надо заметить, а не забыть машину молча.
  const ids = new Set<string>();
  let cursor: unknown = undefined;
  for (let page = 0; page < FEED_PAGES; page += 1) {
    const res: any = await pull('/v1/feed', cursor ? { type: 'computer', limit: FEED_PAGE, cursor } : { type: 'computer', limit: FEED_PAGE });
    for (const it of Array.isArray(res?.items) ? res.items : []) {
      const id = it?.ref?.root_id;
      if (it?.type === 'computer' && typeof id === 'string' && UUID.test(id)) ids.add(id);
    }
    if (!res?.more || !res?.cursor) break;
    cursor = res.cursor;
  }
  for (const r of db.query(`SELECT id FROM computers WHERE gone_at IS NULL`).all() as { id: string }[]) ids.add(r.id);

  const saveReceipt = db.query(`
    INSERT INTO computer_activity (seq, computer_id, at, actor, cause, type, result, json, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(seq) DO NOTHING`);
  const saveFull = db.query(`
    INSERT INTO computer_activity_full (seq, computer_id, json, seen_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(seq) DO NOTHING`);

  const pullActivity = async (id: string, full: boolean) => {
    const table = full ? 'computer_activity_full' : 'computer_activity';
    const top = db.query(`SELECT max(seq) AS s FROM ${table} WHERE computer_id = ?`).get(id) as { s: number | null };
    let after = top.s ?? 0;
    const limit = full ? ACTIVITY_PAGE_FULL : ACTIVITY_PAGE;
    for (let page = 0; page < ACTIVITY_PAGES; page += 1) {
      const res: any = await pull(`/v1/computers/${id}/activity`, { after, limit }, full ? ctx.veteranKey : undefined);
      const items: any[] = (Array.isArray(res?.items) ? res.items : []).filter((r: any) => typeof r?.seq === 'number');
      db.transaction(() => {
        for (const r of items) {
          if (full) { saveFull.run(r.seq, id, JSON.stringify(r), at); out.full += 1; }
          else {
            saveReceipt.run(r.seq, id, int(r.at), txt(r.actor), txt(r.cause), txt(r.type), txt(r.result), JSON.stringify(r), at);
            out.receipts += 1;
          }
        }
      })();
      if (!items.length || typeof res?.next_after !== 'number') break;
      after = res.next_after;
    }
  };

  for (const id of ids) {
    let res: any;
    try {
      res = await pull(`/v1/computers/${id}`, {});
    } catch (err) {
      // Пост удалён: машина уходит в очистку, а журнал у нас остаётся.
      if ((err as { status?: number }).status === 404) {
        db.query(`UPDATE computers SET gone_at = coalesce(gone_at, ?) WHERE id = ?`).run(at, id);
        continue;
      }
      throw err;
    }
    const c = res?.computer;
    if (!c || c.post_id !== id) continue;
    const block = publicBlock(c);
    db.query(`
      INSERT INTO computers (id, seq, title, author, created_at, purpose, template, state, observed_at, json, seen_at, gone_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, title = excluded.title, author = excluded.author,
        created_at = excluded.created_at, purpose = excluded.purpose, template = excluded.template,
        state = excluded.state, observed_at = excluded.observed_at, json = excluded.json,
        seen_at = excluded.seen_at, gone_at = NULL`)
      .run(id, int(c.seq), txt(c.title), txt(c.author), int(c.created_at), txt(c.purpose),
        txt(c.template) ?? txt(c.template?.id), txt(c.runtime?.state), int(c.runtime?.observed_at), JSON.stringify(block), at);
    out.computers += 1;
    await pullActivity(id, false);
    if (ctx.veteranKey) await pullActivity(id, true);
  }
  db.query(`INSERT INTO meta (k, v) VALUES ('computers_synced', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(String(at));
  return out;
}

// ---------- представления (только публичные таблицы) ----------

const syncedAt = (db: Database): number | null => {
  const r = db.query(`SELECT v FROM meta WHERE k = 'computers_synced'`).get() as { v: string } | null;
  return r ? Number(r.v) : null;
};

function card(db: Database, row: any) {
  let block: any = {};
  try { block = JSON.parse(row.json ?? '{}'); } catch { /* пустой обзор */ }
  const act = db.query(`SELECT count(*) AS n, max(at) AS last FROM computer_activity WHERE computer_id = ?`)
    .get(row.id) as { n: number; last: number | null };
  return {
    id: row.id, seq: row.seq, title: row.title, author: row.author, created_at: row.created_at,
    purpose: row.purpose, template: row.template,
    runtime: block.runtime ?? null, control: block.control ?? null, work: block.work ?? null,
    workspace: block.workspace ?? null, usage: block.usage ?? null, lifecycle: block.lifecycle ?? null,
    activity_count: act.n, last_activity_at: act.last,
    seen_at: row.seen_at, gone_at: row.gone_at,
  };
}

export function computersView(db: Database) {
  const rows = db.query(`SELECT * FROM computers ORDER BY (gone_at IS NOT NULL), seq DESC`).all();
  return { computers: rows.map((r) => card(db, r)), synced_at: syncedAt(db) };
}

// Кто что делал: счёт по участникам и видам действий плюс сам журнал
// страницами, от новых к старым.
export function computerView(db: Database, id: string, opts: { before?: number | null; limit?: number }) {
  const row = db.query(`SELECT * FROM computers WHERE id = ?`).get(id);
  if (!row) return null;
  const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 50);
  const rows = db.query(`
    SELECT seq, json FROM computer_activity
    WHERE computer_id = $id AND ($before IS NULL OR seq < $before)
    ORDER BY seq DESC LIMIT $limit`)
    .all({ $id: id, $before: opts.before ?? null, $limit: limit + 1 }) as { seq: number; json: string }[];
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => JSON.parse(r.json));
  const counts = db.query(`
    SELECT coalesce(actor, '') AS actor, type, count(*) AS n, min(at) AS first, max(at) AS last
    FROM computer_activity WHERE computer_id = ? GROUP BY actor, type`)
    .all(id) as { actor: string; type: string; n: number; first: number; last: number }[];
  const actors = new Map<string, { actor: string | null; total: number; first_at: number; last_at: number; by_type: Record<string, number> }>();
  for (const c of counts) {
    const a = actors.get(c.actor) ?? { actor: c.actor || null, total: 0, first_at: c.first, last_at: c.last, by_type: {} };
    a.total += c.n;
    a.first_at = Math.min(a.first_at, c.first);
    a.last_at = Math.max(a.last_at, c.last);
    a.by_type[c.type] = (a.by_type[c.type] ?? 0) + c.n;
    actors.set(c.actor, a);
  }
  return {
    computer: card(db, row),
    actors: [...actors.values()].sort((x, y) => y.last_at - x.last_at),
    activity: { items, next_before: more ? items[items.length - 1].seq : null },
    synced_at: syncedAt(db),
  };
}
