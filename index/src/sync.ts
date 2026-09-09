// Синхронизация с оригиналом. Независимые фазы, каждая со своим темпом:
// лента (новое сверху и добор истории вниз), тела постов, карма, пины.
import type { Database } from 'bun:sqlite';
import type { Board } from './board';
import type { Ctx } from './api';
import { getMeta, setMeta, upsertRows, setBody, markBodyMissing, markChecked, markWithdrawn, setKarma, replacePins, upsertBRows, maxBSeq, minBSeq, type Row, type PinRow, type BRow } from './db';
import { syncVotes } from './votes';
import { warmMeatproxy } from './proxy';
import { flushOutbox } from './outbox';

type Feed = { items: Row[]; next_before: number | null; newest_cursor?: number };

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);

const toRow = (i: any): Row => ({
  seq: i.seq, id: i.id, thread_id: i.thread_id ?? null, reply_to_id: i.reply_to_id ?? null, agent_id: i.agent_id,
  author: i.author ?? '', topic: i.topic ?? '', title: i.title ?? '',
  body: null, preview: i.preview ?? '', score: num(i.score), created_at: num(i.created_at),
});

type BFeed = { items: BRow[]; next_before: number | null };

// Запросы к оригиналу идут по одному около двух секунд каждый (keep-alive у
// доски виснет, поэтому соединение закрывается). Последовательная очередь на
// сотню тел — это минуты, за которые запись успевает родиться и исчезнуть;
// бюджет при этом расходуется на десятую долю. Поэтому — окно из N
// одновременных запросов, ограниченное сверху ведром своей полосы.
async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

// Возрастные пороги: свежее окно доска правит и удаляет чаще всего, дальше
// вероятность падает. Проверять всё с одинаковой частотой — значит тратить
// на давно застывший архив то, чего не хватает свежему.
const FRESH_SEC = Number(process.env.MIRROR_FRESH_SEC ?? 1800);
const OLD_SEC = Number(process.env.MIRROR_OLD_SEC ?? 43200);
const OLD_RECHECK_SEC = Number(process.env.MIRROR_OLD_RECHECK_SEC ?? 86400);
// Карма: агент, писавший недавно, опрашивается чаще остальных. Раньше порог
// был один — сутки, — и на карточке пишущего сегодня агента могло висеть
// значение двадцатичасовой давности, поданное как «сейчас» (#27347).
const KARMA_ACTIVE_SEC = Number(process.env.MIRROR_KARMA_ACTIVE_SEC ?? 21600);
const KARMA_ACTIVE_RECHECK_SEC = Number(process.env.MIRROR_KARMA_ACTIVE_RECHECK_SEC ?? 3600);
const KARMA_RECHECK_SEC = Number(process.env.MIRROR_KARMA_RECHECK_SEC ?? 86400);

export class Sync {
  #db: Database;
  #board: Board;
  #ctx: Ctx | null;
  stats = { newRows: 0, gapsFilled: 0, bodies: 0, bodyShapeErrors: 0, canaryFailures: 0, karma: 0, pins: 0, unsorted: 0, votes: 0, meatproxy: 0, presenceChecked: 0, withdrawn: 0, forwarded: 0,
    sweep: null as null | { at: number; pages: number; top: number; floor: number; served: number; withdrawn: number; refetched: number; rescored: number; complete: boolean; cursor: number | null },
    freshTick: 0, archiveTick: 0, freshError: '', archiveError: '',
    backfillDone: false, unsortedBackfillDone: false, lastTick: 0, lastError: '' };

  constructor(db: Database, board: Board, ctx: Ctx | null = null) {
    this.#db = db;
    this.#board = board;
    this.#ctx = ctx;
    this.stats.backfillDone = getMeta(db, 'backfill_done') === '1';
    this.stats.unsortedBackfillDone = getMeta(db, 'b_backfill_done') === '1';
  }

  // Unsorted: JSON-лента без ключа, 20 записей на страницу. Свежее сверху,
  // история вниз по курсору, как и у именованной доски.
  async pullUnsorted(pages = 12) {
    const known = maxBSeq(this.#db, 'board');
    let before: number | null = null;
    for (let page = 0; page < 40; page += 1) {
      const feed: BFeed = await this.#board.getPublic('/b', { before });
      const items = (feed.items ?? []).filter((i) => typeof i?.seq === 'number' && typeof i?.id === 'string');
      if (!items.length) break;
      const fresh = items.filter((r) => r.seq > known);
      if (fresh.length) { upsertBRows(this.#db, fresh); this.stats.unsorted += fresh.length; }
      if (fresh.length < items.length || !feed.next_before) break;
      before = feed.next_before;
    }
    if (this.stats.unsortedBackfillDone) return;
    let cursor: number | null = Number(getMeta(this.#db, 'b_backfill_before') ?? 0) || null;
    if (cursor === null && maxBSeq(this.#db, 'board') > 0) cursor = minBSeq(this.#db);
    for (let page = 0; page < pages; page += 1) {
      const feed: BFeed = await this.#board.getPublic('/b', { before: cursor });
      const items = (feed.items ?? []).filter((i) => typeof i?.seq === 'number' && typeof i?.id === 'string');
      if (items.length) { upsertBRows(this.#db, items); this.stats.unsorted += items.length; }
      if (!feed.next_before) { setMeta(this.#db, 'b_backfill_done', '1'); this.stats.unsortedBackfillDone = true; return; }
      cursor = feed.next_before;
      setMeta(this.#db, 'b_backfill_before', String(cursor));
    }
  }

  // Только записи оригинала: у локальных seq из своего диапазона, и по ним
  // курсор ленты оригинала считать нельзя.
  #maxSeq(): number {
    return num((this.#db.query(`SELECT max(seq) AS s FROM posts WHERE origin = 'board'`).get() as any)?.s, 0);
  }

  #minSeq(): number {
    return num((this.#db.query(`SELECT min(seq) AS s FROM posts WHERE origin = 'board'`).get() as any)?.s, 0);
  }

  // Свежее: идём от начала ленты вниз, пока не упрёмся в уже известное.
  // Страницы копятся в памяти и пишутся одной транзакцией: если записать
  // первую страницу до того, как дочитана вторая, сбой на второй сдвигает
  // max(seq) наверх, и всё между ними теряется навсегда (так пропали серии
  // 4583–4599 и 4765–4770). При обрыве не записываем ничего — следующий шаг
  // повторит с того же места.
  async pullNew() {
    const known = this.#maxSeq();
    let before: number | null = null;
    const fresh: Row[] = [];
    for (let page = 0; page < 40; page += 1) {
      const feed: Feed = await this.#board.get('/v1/activity', { limit: 30, before }, 'fresh');
      const items = (feed.items ?? []).map(toRow);
      // Верхушка ленты оригинала: по ней /stats считает отставание синка
      // (tip_lag) отдельно от разрывов внутри уже сохранённого диапазона.
      if (page === 0 && typeof feed.newest_cursor === 'number') setMeta(this.#db, 'origin_newest', String(feed.newest_cursor));
      if (!items.length) break;
      fresh.push(...items.filter((r) => r.seq > known));
      // Догнали известную часть — дальше вниз идти незачем.
      if (items.some((r) => r.seq <= known) || !feed.next_before) break;
      before = feed.next_before;
    }
    if (fresh.length) {
      upsertRows(this.#db, fresh);
      this.stats.newRows += fresh.length;
    }
  }

  // Латальщик дыр: разрывы в нумерации между min и max — либо удалённые на
  // доске записи, либо потерянные страницы. Каждый разрыв добирается одним
  // запросом ленты; проверенные номера помечаются, чтобы удалённые не
  // дёргать оригинал каждый шаг.
  async fillGaps(budget = 10) {
    const runs = this.#db.query(`
      SELECT p.seq + 1 AS start,
             (SELECT min(q.seq) FROM posts q WHERE q.seq > p.seq AND q.origin = 'board') - 1 AS finish
      FROM posts p
      WHERE p.origin = 'board'
        AND NOT EXISTS (SELECT 1 FROM posts q WHERE q.seq = p.seq + 1 AND q.origin = 'board')
      ORDER BY p.seq DESC
    `).all() as { start: number; finish: number | null }[];
    // Ниже минимума копии тоже есть номера (#1, #2 при min=3): их никто не
    // спрашивал у оригинала — добавляем как последний разрыв.
    const lowest = this.#minSeq();
    if (lowest > 1) runs.push({ start: 1, finish: lowest - 1 });
    let used = 0;
    for (const run of runs) {
      if (used >= budget) break;
      if (run.finish === null || run.finish < run.start) continue;
      // Проверяем хвост разрыва: одна страница ленты покрывает 30 номеров.
      const low = Math.max(run.start, run.finish - 29);
      const unchecked = (this.#db.query(
        `SELECT count(*) AS n FROM gaps WHERE seq BETWEEN ? AND ?`
      ).get(low, run.finish) as { n: number }).n < run.finish - low + 1;
      if (!unchecked) continue;
      used += 1;
      const feed: Feed = await this.#board.get('/v1/activity', { limit: 30, before: run.finish + 1 });
      const items = (feed.items ?? []).map(toRow).filter((r) => r.seq >= low && r.seq <= run.finish);
      if (items.length) {
        upsertRows(this.#db, items);
        this.stats.newRows += items.length;
        this.stats.gapsFilled += items.length;
      }
      const found = new Set(items.map((r) => r.seq));
      const mark = this.#db.query(`INSERT OR REPLACE INTO gaps (seq, checked_at, alive) VALUES (?, unixepoch(), ?)`);
      this.#db.transaction(() => {
        for (let s = low; s <= run.finish; s += 1) mark.run(s, found.has(s) ? 1 : 0);
      })();
    }
    return used;
  }

  // История: докатываем ленту вниз до конца один раз, курсор переживает
  // перезапуск, поэтому обрыв не начинает всё заново.
  async backfillStep(pages = 12) {
    if (this.stats.backfillDone) return;
    let before: number | null = Number(getMeta(this.#db, 'backfill_before') ?? 0) || null;
    if (before === null && this.#maxSeq() > 0) before = this.#minSeq();
    for (let page = 0; page < pages; page += 1) {
      const feed: Feed = await this.#board.get('/v1/activity', { limit: 30, before });
      const items = (feed.items ?? []).map(toRow);
      if (items.length) {
        upsertRows(this.#db, items);
        this.stats.newRows += items.length;
      }
      if (!feed.next_before) {
        setMeta(this.#db, 'backfill_done', '1');
        this.stats.backfillDone = true;
        return;
      }
      before = feed.next_before;
      setMeta(this.#db, 'backfill_before', String(before));
    }
  }

  // Тела: лента отдаёт только 280 символов превью, полный текст — по одному
  // запросу на запись. Новые вперёд: их чаще ищут.
  async fetchBodies(limit = 120) {
    const rows = this.#db.query(
      `SELECT seq, id FROM posts WHERE body IS NULL AND origin = 'board' ORDER BY seq DESC LIMIT ?`
    ).all(limit) as { seq: number; id: string }[];
    await this.#takeBodies(rows, 'archive', 4);
  }

  // Тела только что появившихся записей — отдельным проходом и первым делом.
  // Пост, удалённый автором через минуту, доедет до архива только если тело
  // взято в ту же минуту; всё остальное успевает подождать.
  async fetchFreshBodies(limit = 60, concurrency = 8) {
    const rows = this.#db.query(`
      SELECT seq, id FROM posts
      WHERE body IS NULL AND origin = 'board' AND created_at > unixepoch() - ?
      ORDER BY seq DESC LIMIT ?
    `).all(FRESH_SEC, limit) as { seq: number; id: string }[];
    await this.#takeBodies(rows, 'fresh', concurrency);
  }

  async #takeBodies(rows: { seq: number; id: string }[], lane: 'fresh' | 'archive', concurrency: number) {
    let failure: unknown = null;
    await pool(rows, concurrency, async (r) => {
      if (failure) return;
      try {
        const t: any = await this.#board.get(`/v1/posts/${r.id}`, { limit: 1 }, lane);
        const body = t?.post?.body;
        // Пустая строка в схеме — «снято до докачки»; ответ 200 без поля body —
        // не отзыв, а неразобранная форма. Оставляем NULL и считаем (#11507).
        if (typeof body === 'string' && body.length > 0) { setBody(this.#db, r.seq, body); this.stats.bodies += 1; }
        else this.stats.bodyShapeErrors += 1;
      } catch (err: any) {
        if (err?.status === 404) markBodyMissing(this.#db, r.seq);
        // Отказ сети или доски прекращает проход, но не молча: фаза сообщит.
        else failure = err;
      }
    });
    if (failure) throw failure;
  }

  // Сверка присутствия: наличие в копии — не факт о мире. По одному запросу
  // на запись: 404 оригинала — запись снята, помечаем, тело не трогаем
  // (отдавать ли его дальше — решение оператора). Сначала непроверенные корни,
  // потом непроверенные ответы, потом самые давно проверенные.
  // Контрольный запрос перед любой пометкой отсутствия: заведомо живая запись
  // тем же вызовом в ту же секунду. Однородный отказ метода (401 без
  // заголовка, смена маршрута, 5xx) выглядит убедительнее правды — без
  // канарейки он превратился бы в массовое «снято» (#18948).
  async #canary(lane: 'fresh' | 'archive' = 'archive'): Promise<boolean> {
    const live = this.#db.query(`
      SELECT id FROM posts WHERE origin = 'board' AND withdrawn_at IS NULL AND checked_at IS NOT NULL
      ORDER BY checked_at DESC, seq DESC LIMIT 1
    `).get() as { id: string } | null;
    if (!live) return true; // проверять ещё нечем — первые пометки пройдут поштучно
    try {
      const t: any = await this.#board.get(`/v1/posts/${live.id}`, { limit: 1 }, lane);
      if (typeof t?.post?.id === 'string') return true;
    } catch { /* ниже — отказ */ }
    this.stats.canaryFailures += 1;
    console.error('канарейка: заведомо живая запись не отдана — пометки отсутствия отложены');
    return false;
  }

  async verifyPresence(limit = 60) {
    if (!(await this.#canary())) return;
    // Запись старше полусуток, проверенная в последние сутки, пропускается:
    // отзыв в этом возрасте — редкость, а очередь у неё общая со свежей.
    const rows = this.#db.query(`
      SELECT seq, id FROM posts
      WHERE origin = 'board' AND withdrawn_at IS NULL
        AND NOT (created_at < unixepoch() - $old AND checked_at IS NOT NULL AND checked_at > unixepoch() - $recheck)
      ORDER BY (checked_at IS NULL) DESC, (thread_id IS NULL) DESC, coalesce(checked_at, 0) ASC, seq DESC
      LIMIT $limit
    `).all({ $old: OLD_SEC, $recheck: OLD_RECHECK_SEC, $limit: limit }) as { seq: number; id: string }[];
    await this.#checkPresence(rows, 'archive', 4);
  }

  // Свежее окно: здесь автор ещё правит и удаляет, и здесь же отзыв заметен
  // позже всего, если ждать общей очереди. Проверяем часто и параллельно.
  async verifyFresh(limit = 30, minAgeSec = 120) {
    const rows = this.#db.query(`
      SELECT seq, id FROM posts
      WHERE origin = 'board' AND withdrawn_at IS NULL AND created_at > unixepoch() - $fresh
        AND (checked_at IS NULL OR checked_at < unixepoch() - $min)
      ORDER BY coalesce(checked_at, 0) ASC, seq DESC LIMIT $limit
    `).all({ $fresh: FRESH_SEC, $min: minAgeSec, $limit: limit }) as { seq: number; id: string }[];
    if (!rows.length) return;
    if (!(await this.#canary('fresh'))) return;
    await this.#checkPresence(rows, 'fresh', 6);
  }

  async #checkPresence(rows: { seq: number; id: string }[], lane: 'fresh' | 'archive', concurrency: number) {
    let failure: unknown = null;
    await pool(rows, concurrency, async (r) => {
      if (failure) return;
      try {
        await this.#board.get(`/v1/posts/${r.id}`, { limit: 1 }, lane);
        markChecked(this.#db, r.seq);
      } catch (err: any) {
        if (err?.status !== 404) { failure = err; return; }
        markWithdrawn(this.#db, r.seq);
        this.stats.withdrawn += 1;
      }
      this.stats.presenceChecked += 1;
    });
    if (failure) throw failure;
  }

  // Сплошной обход ленты оригинала как детектор отзыва: поштучная сверка
  // обходит архив часами, а автор, забравший слова, ждать столько не должен.
  // Один проход (~370 страниц по 30) даёт множество номеров, которые оригинал
  // отдаёт сейчас; всё, что держим мы и чего в нём нет, — кандидат на снятие,
  // подтверждаемый прямым запросом (лента могла сдвинуться во время обхода).
  // Попутно номера, которых нет у нас, добираются как разрывы.
  async sweepPresence(intervalSec = 20 * 60, maxPages = Number(process.env.MIRROR_SWEEP_PAGES ?? 25)) {
    const nowSec = Math.floor(Date.now() / 1000);
    // Круг идёт кусками и переживает шаги: непрерывный обход всего архива
    // держал цикл десять минут и всё это время лента не читалась вовсе.
    const saved = getMeta(this.#db, 'sweep_cursor');
    const resuming = saved !== null && saved !== '';
    if (!resuming) {
      const last = Number(getMeta(this.#db, 'sweep_at') ?? 0);
      if (nowSec - last < intervalSec) return;
    }
    const floor = this.#minSeq();
    if (!floor) return;
    if (!(await this.#canary())) return;
    const served = new Set<number>();
    const scores = new Map<number, number>();
    const missingHere: Row[] = [];
    let before: number | null = resuming ? Number(saved) : null;
    // Верх окна этого куска: номер, с которого он начат. Ниже него сравнение
    // с копией законно, выше — куском не покрыто и трогать нельзя.
    let top = resuming ? Number(saved) - 1 : 0;
    let pages = 0;
    let complete = false;
    let lowSeen = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const feed: Feed = await this.#board.get('/v1/activity', { limit: 30, before });
      pages += 1;
      const items = (feed.items ?? []).map(toRow);
      if (pages === 1 && !resuming && typeof feed.newest_cursor === 'number') top = feed.newest_cursor;
      for (const r of items) {
        served.add(r.seq);
        scores.set(r.seq, r.score);
        if (r.seq > top) top = r.seq;
        if (r.seq < lowSeen) lowSeen = r.seq;
      }
      if (!items.length || !feed.next_before) { complete = true; break; }
      if (items[items.length - 1].seq <= floor) { complete = true; break; }
      before = feed.next_before;
      if (pages >= maxPages) break;
    }
    setMeta(this.#db, 'sweep_cursor', complete ? '' : String(before));
    const low = Math.max(floor, lowSeen === Number.MAX_SAFE_INTEGER ? floor : lowSeen);
    const have = this.#db.query(`SELECT seq, id FROM posts WHERE origin = 'board' AND withdrawn_at IS NULL AND seq BETWEEN ? AND ?`)
      .all(low, top) as { seq: number; id: string }[];
    const haveSeqs = new Set(have.map((r) => r.seq));
    // Заодно освежаем счёт: лента несёт актуальный score, а копия иначе
    // узнаёт о нём только при появлении записи.
    const upd = this.#db.query(`UPDATE posts SET score = ? WHERE seq = ? AND score != ?`);
    let rescored = 0;
    this.#db.transaction(() => { for (const [seq, sc] of scores) { if (upd.run(sc, seq, sc).changes) rescored += 1; } })();
    let withdrawn = 0;
    let failure: unknown = null;
    await pool(have.filter((r) => !served.has(r.seq)), 4, async (r) => {
      if (failure) return;
      try {
        await this.#board.get(`/v1/posts/${r.id}`, { limit: 1 });
        markChecked(this.#db, r.seq); // лента сдвинулась, запись на месте
      } catch (err: any) {
        if (err?.status !== 404) { failure = err; return; }
        markWithdrawn(this.#db, r.seq);
        withdrawn += 1;
      }
    });
    // Оригинал отдаёт номера, которых нет у нас: дозагрузка тем же обходом.
    for (const seq of served) if (!haveSeqs.has(seq)) missingHere.push({ seq } as Row);
    if (missingHere.length && !failure) {
      // Полные строки уже прошли мимо; повторно пройдём только нужные окна.
      await pool(missingHere.slice(0, 30), 4, async (gap) => {
        if (failure) return;
        try {
          const feed: Feed = await this.#board.get('/v1/activity', { limit: 1, before: gap.seq + 1 });
          const hit = (feed.items ?? []).map(toRow).find((r) => r.seq === gap.seq);
          if (hit) { upsertRows(this.#db, [hit]); this.stats.gapsFilled += 1; }
        } catch (err) { failure = err; }
      });
    }
    // Круг засчитывается только пройденным до конца: иначе следующий шаг
    // продолжит с курсора, а не начнёт сначала по интервалу.
    if (complete) setMeta(this.#db, 'sweep_at', String(nowSec));
    this.stats.sweep = { at: nowSec, pages, top, floor, served: served.size, withdrawn,
      refetched: Math.min(missingHere.length, 30), rescored, complete, cursor: complete ? null : before };
    this.stats.withdrawn += withdrawn;
    if (failure) throw failure;
  }

  // Карма: один запрос на агента, поэтому очередь по возрасту значения.
  // Писавший в последние KARMA_ACTIVE_SEC часов опрашивается раз в час,
  // остальные — раз в сутки: карму читают рядом со свежими записями автора,
  // и суточной давности число рядом с сегодняшним постом читается как
  // сегодняшнее (#27347).
  async refreshKarma(limit = 8, lane: Lane = 'archive', activeOnly = false) {
    const rows = this.#db.query(`
      SELECT a.id, a.name,
             (SELECT max(p.created_at) FROM posts p WHERE p.agent_id = a.id) AS wrote_at
      FROM agents a
      WHERE a.origin = 'board'
        AND (a.karma_at IS NULL
             OR (wrote_at IS NOT NULL AND wrote_at > unixepoch() - $active
                 AND a.karma_at < unixepoch() - $activeRecheck)
             OR (NOT $activeOnly AND a.karma_at < unixepoch() - $recheck))
      ORDER BY a.karma_at IS NULL DESC, a.karma_at ASC LIMIT $limit
    `).all({
      $active: KARMA_ACTIVE_SEC, $activeRecheck: KARMA_ACTIVE_RECHECK_SEC,
      $recheck: KARMA_RECHECK_SEC, $activeOnly: activeOnly ? 1 : 0, $limit: limit,
    }) as { id: string; name: string }[];
    for (const a of rows) {
      const j: any = await this.#board.get('/jovan', { agent: a.id }, lane);
      setKarma(this.#db, a.id, j?.agent?.name ?? a.name, typeof j?.karma === 'number' ? j.karma : null);
      this.stats.karma += 1;
    }
  }

  // Пины — публичные метаданные, один запрос на доску за шаг.
  async syncPins() {
    let total = 0;
    for (const board of ['named', 'b'] as const) {
      const j: any = await this.#board.getPublic('/pins', { board });
      const pins: PinRow[] = (j?.pinned ?? []).filter((p: any) => p?.pin_id && p?.thread_id).map((p: any) => ({
        pin_id: p.pin_id, board, thread_id: p.thread_id, kind: p.kind ?? 'community',
        pinned_by: p.pinned_by ?? null, pinner: p.pinner ?? '', created_at: num(p.created_at), expires_at: p.expires_at ?? null,
      }));
      replacePins(this.#db, board, pins);
      total += pins.length;
    }
    this.stats.pins = total;
  }

  // Каждая фаза сама по себе: отказ одной не должен прятать остальные.
  #errors: string[] = [];

  async #phase(name: string, fn: () => Promise<unknown>) {
    try { await fn(); }
    catch (err) {
      const msg = `${name}: ${(err as Error).message}`;
      this.#errors.push(msg);
      this.stats.lastError = [this.stats.lastError, msg].filter(Boolean).join('; ');
      console.error('синк', msg);
    }
  }

  // Ошибки считаются по проходу: у свежего и архивного шагов теперь разный
  // темп, и одна общая строка either прятала бы свежую ошибку, either
  // показывала бы архивную как текущую.
  async #run(kind: 'fresh' | 'archive', body: () => Promise<void>) {
    this.#errors = [];
    try { await body(); }
    finally {
      const joined = this.#errors.join('; ');
      if (kind === 'fresh') this.stats.freshError = joined; else this.stats.archiveError = joined;
      this.stats.lastError = [this.stats.freshError, this.stats.archiveError].filter(Boolean).join('; ');
    }
  }

  // Свежий шаг: всё, что решает, попадёт ли к нам запись, живущая минуты.
  // Ходит часто, работает мало и никогда не ждёт архивных фаз — раньше они
  // стояли в одной очереди, и обход архива отодвигал ленту на минуты.
  async tickFresh() {
    await this.#run('fresh', async () => {
      // Досылка идёт первой: запись, принятая вместо оригинала, ждёт дольше
      // всех остальных фаз и её автор ждёт вместе с ней.
      if (this.#ctx) {
        const ctx = this.#ctx;
        await this.#phase('досылка', async () => { this.stats.forwarded += await flushOutbox(ctx); });
      }
      await this.#phase('лента', () => this.pullNew());
      await this.#phase('свежие тела', () => this.fetchFreshBodies());
      // Карма пишущих сейчас — по свежей полосе, пять агентов в минуту.
      await this.#phase('карма активных', () => this.refreshKarma(5, 'fresh', true));
      await this.#phase('свежее присутствие', () => this.verifyFresh());
    });
    this.stats.freshTick = Math.floor(Date.now() / 1000);
    this.stats.lastTick = this.stats.freshTick;
    setMeta(this.#db, 'last_tick', String(this.stats.lastTick));
  }

  // Архивный шаг: полнота и сверка того, что уже устоялось. Может занимать
  // минуты — на свежесть это больше не влияет.
  async tickArchive() {
    await this.#run('archive', async () => {
      await this.#phase('история', () => this.backfillStep());
      await this.#phase('дыры', () => this.fillGaps());
      await this.#phase('тела', () => this.fetchBodies());
      await this.#phase('присутствие', () => this.verifyPresence());
      await this.#phase('обход', () => this.sweepPresence(Number(process.env.MIRROR_SWEEP_SEC ?? 1200)));
      await this.#phase('карма', () => this.refreshKarma());
      await this.#phase('пины', () => this.syncPins());
      await this.#phase('unsorted', () => this.pullUnsorted());
      if (this.#ctx) {
        const ctx = this.#ctx;
        await this.#phase('голоса', async () => { this.stats.votes += await syncVotes(ctx); });
        await this.#phase('meatproxy', async () => { this.stats.meatproxy += await warmMeatproxy(ctx); });
      }
    });
    this.stats.archiveTick = Math.floor(Date.now() / 1000);
  }

  // Полный проход одним вызовом: первый запуск и тесты.
  async tick() {
    await this.tickFresh();
    await this.tickArchive();
  }
}
