// Синхронизация с оригиналом. Независимые фазы, каждая со своим темпом:
// лента (новое сверху и добор истории вниз), тела постов, карма, пины.
import type { Database } from 'bun:sqlite';
import type { Board } from './board';
import type { Ctx } from './api';
import { getMeta, setMeta, upsertRows, setBody, markBodyMissing, markChecked, markWithdrawn, setKarma, replacePins, upsertBRows, maxBSeq, minBSeq, type Row, type PinRow, type BRow } from './db';
import { syncVotes } from './votes';
import { warmMeatproxy } from './proxy';

type Feed = { items: Row[]; next_before: number | null; newest_cursor?: number };

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);

const toRow = (i: any): Row => ({
  seq: i.seq, id: i.id, thread_id: i.thread_id ?? null, agent_id: i.agent_id,
  author: i.author ?? '', topic: i.topic ?? '', title: i.title ?? '',
  body: null, preview: i.preview ?? '', score: num(i.score), created_at: num(i.created_at),
});

type BFeed = { items: BRow[]; next_before: number | null };

export class Sync {
  #db: Database;
  #board: Board;
  #ctx: Ctx | null;
  stats = { newRows: 0, gapsFilled: 0, bodies: 0, bodyShapeErrors: 0, karma: 0, pins: 0, unsorted: 0, votes: 0, meatproxy: 0, presenceChecked: 0, withdrawn: 0,
    sweep: null as null | { at: number; pages: number; top: number; floor: number; served: number; withdrawn: number; refetched: number; rescored: number },
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
      const feed: Feed = await this.#board.get('/v1/activity', { limit: 30, before });
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
    for (const r of rows) {
      try {
        const t: any = await this.#board.get(`/v1/posts/${r.id}`, { limit: 1 });
        const body = t?.post?.body;
        // Пустая строка в схеме — «снято до докачки»; ответ 200 без поля body —
        // не отзыв, а неразобранная форма. Оставляем NULL и считаем (#11507).
        if (typeof body === 'string' && body.length > 0) { setBody(this.#db, r.seq, body); this.stats.bodies += 1; }
        else this.stats.bodyShapeErrors += 1;
      } catch (err: any) {
        if (err?.status === 404) markBodyMissing(this.#db, r.seq);
        else throw err;
      }
    }
  }

  // Сверка присутствия: наличие в копии — не факт о мире. По одному запросу
  // на запись: 404 оригинала — запись снята, помечаем, тело не трогаем
  // (отдавать ли его дальше — решение оператора). Сначала непроверенные корни,
  // потом непроверенные ответы, потом самые давно проверенные.
  async verifyPresence(limit = 60) {
    const rows = this.#db.query(`
      SELECT seq, id FROM posts
      WHERE origin = 'board' AND withdrawn_at IS NULL
      ORDER BY (checked_at IS NULL) DESC, (thread_id IS NULL) DESC, coalesce(checked_at, 0) ASC, seq DESC
      LIMIT ?
    `).all(limit) as { seq: number; id: string }[];
    for (const r of rows) {
      try {
        await this.#board.get(`/v1/posts/${r.id}`, { limit: 1 });
        markChecked(this.#db, r.seq);
      } catch (err: any) {
        if (err?.status !== 404) throw err;
        markWithdrawn(this.#db, r.seq);
        this.stats.withdrawn += 1;
      }
      this.stats.presenceChecked += 1;
    }
  }

  // Сплошной обход ленты оригинала как детектор отзыва: поштучная сверка
  // обходит архив часами, а автор, забравший слова, ждать столько не должен.
  // Один проход (~370 страниц по 30) даёт множество номеров, которые оригинал
  // отдаёт сейчас; всё, что держим мы и чего в нём нет, — кандидат на снятие,
  // подтверждаемый прямым запросом (лента могла сдвинуться во время обхода).
  // Попутно номера, которых нет у нас, добираются как разрывы.
  async sweepPresence(intervalSec = 20 * 60) {
    const last = Number(getMeta(this.#db, 'sweep_at') ?? 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - last < intervalSec) return;
    const floor = this.#minSeq();
    if (!floor) return;
    const served = new Set<number>();
    const scores = new Map<number, number>();
    const missingHere: Row[] = [];
    let before: number | null = null;
    let pages = 0;
    let top = 0;
    for (;;) {
      const feed: Feed = await this.#board.get('/v1/activity', { limit: 30, before });
      pages += 1;
      const items = (feed.items ?? []).map(toRow);
      if (pages === 1 && typeof feed.newest_cursor === 'number') top = feed.newest_cursor;
      for (const r of items) {
        served.add(r.seq);
        scores.set(r.seq, r.score);
        if (r.seq > top) top = r.seq;
      }
      if (!items.length || !feed.next_before) break;
      if (items[items.length - 1].seq <= floor) break;
      before = feed.next_before;
      if (pages > 2000) break;
    }
    const have = this.#db.query(`SELECT seq, id FROM posts WHERE origin = 'board' AND withdrawn_at IS NULL AND seq BETWEEN ? AND ?`)
      .all(floor, top) as { seq: number; id: string }[];
    const haveSeqs = new Set(have.map((r) => r.seq));
    // Заодно освежаем счёт: лента несёт актуальный score, а копия иначе
    // узнаёт о нём только при появлении записи.
    const upd = this.#db.query(`UPDATE posts SET score = ? WHERE seq = ? AND score != ?`);
    let rescored = 0;
    this.#db.transaction(() => { for (const [seq, sc] of scores) { if (upd.run(sc, seq, sc).changes) rescored += 1; } })();
    let withdrawn = 0;
    for (const r of have) {
      if (served.has(r.seq)) continue;
      try {
        await this.#board.get(`/v1/posts/${r.id}`, { limit: 1 });
        markChecked(this.#db, r.seq); // лента сдвинулась, запись на месте
      } catch (err: any) {
        if (err?.status !== 404) throw err;
        markWithdrawn(this.#db, r.seq);
        withdrawn += 1;
      }
    }
    // Оригинал отдаёт номера, которых нет у нас: дозагрузка тем же обходом.
    for (const seq of served) if (!haveSeqs.has(seq)) missingHere.push({ seq } as Row);
    if (missingHere.length) {
      // Полные строки уже прошли мимо; повторно пройдём только нужные окна.
      for (const gap of missingHere.slice(0, 30)) {
        const feed: Feed = await this.#board.get('/v1/activity', { limit: 1, before: gap.seq + 1 });
        const hit = (feed.items ?? []).map(toRow).find((r) => r.seq === gap.seq);
        if (hit) { upsertRows(this.#db, [hit]); this.stats.gapsFilled += 1; }
      }
    }
    setMeta(this.#db, 'sweep_at', String(nowSec));
    this.stats.sweep = { at: nowSec, pages, top, floor, served: served.size, withdrawn, refetched: Math.min(missingHere.length, 30), rescored };
    this.stats.withdrawn += withdrawn;
  }

  // Карма: по агенту за запрос, поэтому обновляем самых свежих и тех, у кого
  // значение старше суток.
  async refreshKarma(limit = 8) {
    const rows = this.#db.query(`
      SELECT a.id, a.name FROM agents a
      WHERE a.origin = 'board' AND (a.karma_at IS NULL OR a.karma_at < unixepoch() - 86400)
      ORDER BY a.karma_at IS NULL DESC, a.karma_at ASC LIMIT ?
    `).all(limit) as { id: string; name: string }[];
    for (const a of rows) {
      const j: any = await this.#board.get('/jovan', { agent: a.id });
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
  async #phase(name: string, fn: () => Promise<unknown>) {
    try { await fn(); }
    catch (err) {
      const msg = `${name}: ${(err as Error).message}`;
      this.stats.lastError = [this.stats.lastError, msg].filter(Boolean).join('; ');
      console.error('синк', msg);
    }
  }

  async tick() {
    try {
      this.stats.lastError = '';
      await this.#phase('лента', () => this.pullNew());
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
    } finally {
      this.stats.lastTick = Math.floor(Date.now() / 1000);
      setMeta(this.#db, 'last_tick', String(this.stats.lastTick));
    }
  }
}
