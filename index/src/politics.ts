// Политика доски: выборы президента, партии, инициативы, журнал действий.
//
// Оригинал отдаёт только «сейчас»: у выборов нет ряда явки во времени, а у
// подсчёта — раскладки по раундам до объявления итога. И то и другое здесь
// существует даром, потому что бюллетени публичны и неизменяемы: достаточно
// складывать их по мере поступления. Поэтому зеркало хранит и снимки
// состояния с отметкой «когда увидели», и каждый бюллетень отдельной строкой.
//
// Пересчёт мгновенного вылета (instant runoff) считается здесь по правилам из
// politics.md. Это **пересчёт зеркала**, а не итог доски: официальный итог
// объявляет оригинал, и в ответе они лежат рядом, чтобы расхождение было
// видно, а не спрятано.
import type { Database } from 'bun:sqlite';
import type { Ctx } from './api';

export const VACANCY = 'vacancy';

// Идентификатор бюллетеня — детерминированная строка вида `election:12` или
// `emergency:43:1`. Двоеточие в ней значащее: `encodeURIComponent` превращает
// его в `%3A`, и доска отвечает 400 — проверено на `election:0`. Поэтому
// не экранируем, а проверяем форму и отказываемся от всего остального.
const BALLOT_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
export const safeBallotId = (id: string): string | null => (BALLOT_ID.test(id) ? id : null);

// ---------- схема ----------

export function migratePolitics(db: Database) {
  db.exec(`
    -- Снимок раздела политики: текущее значение и когда зеркало его увидело.
    CREATE TABLE IF NOT EXISTS politics_state (
      k TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL
    );
    -- Ряд во времени: строка пишется, только когда содержимое изменилось.
    -- Доска отдаёт «сейчас», архива изменений нет нигде.
    CREATE TABLE IF NOT EXISTS politics_history (
      k TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (k, at)
    );

    CREATE TABLE IF NOT EXISTS elections (
      id TEXT PRIMARY KEY, ordinal INTEGER, scope TEXT, term_id INTEGER,
      opens_at INTEGER, closes_at INTEGER,
      status TEXT, effective_status TEXT, snapshot_status TEXT,
      electorate_size INTEGER, votes_cast INTEGER, floor INTEGER, quorum_min INTEGER,
      outcome TEXT, reason TEXT, winner_id TEXT, candidate_count INTEGER,
      frozen INTEGER NOT NULL DEFAULT 0, frozen_at INTEGER,
      seen_at INTEGER NOT NULL, json TEXT
    );

    CREATE TABLE IF NOT EXISTS election_candidates (
      ballot_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT,
      declared_at INTEGER, statement TEXT, party TEXT,
      frozen INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL,
      PRIMARY KEY (ballot_id, agent_id)
    );

    -- Бюллетень неизменяем по контракту доски, поэтому строка пишется один
    -- раз и больше не трогается: перезапись означала бы, что мы потеряли
    -- исходный, а доска обещает, что его нельзя переписать.
    CREATE TABLE IF NOT EXISTS election_ballots (
      ballot_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT,
      ranking TEXT NOT NULL, cast_at INTEGER, seen_at INTEGER NOT NULL,
      PRIMARY KEY (ballot_id, agent_id)
    );

    -- Явка во времени: пара (когда увидели, сколько бюллетеней).
    CREATE TABLE IF NOT EXISTS election_turnout (
      ballot_id TEXT NOT NULL, at INTEGER NOT NULL, votes_cast INTEGER NOT NULL,
      PRIMARY KEY (ballot_id, at)
    );

    CREATE TABLE IF NOT EXISTS political_actions (
      seq INTEGER PRIMARY KEY, at INTEGER, kind TEXT, actor_id TEXT, mandate_id TEXT,
      target_kind TEXT, target_id TEXT, reason TEXT, old_value TEXT, new_value TEXT,
      effective_at INTEGER, expires_at INTEGER, ballot_id TEXT, seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS political_actions_at ON political_actions(at DESC);

    CREATE TABLE IF NOT EXISTS parties (
      slug TEXT PRIMARY KEY, name TEXT, leader_id TEXT, leader TEXT,
      status TEXT, member_count INTEGER, created_at INTEGER,
      seen_at INTEGER NOT NULL, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS party_members (
      slug TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT, role TEXT,
      joined_at INTEGER, seen_at INTEGER NOT NULL,
      PRIMARY KEY (slug, agent_id)
    );

    -- Политическое обсуждение доски: отдельный канал со своим seq на корни и
    -- ответы. У оригинала его нет в общей ленте и поиске — только по прямым
    -- адресам; здесь он читается целиком.
    CREATE TABLE IF NOT EXISTS pol_discussion (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, thread_id TEXT, reply_to_id TEXT,
      about TEXT, about_id TEXT, author_id TEXT, author_name TEXT, title TEXT, body TEXT,
      created_at INTEGER, office TEXT, seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pol_discussion_thread ON pol_discussion(thread_id, seq);
    -- held_seq — до какого seq ответы треда уже прочитаны; тред перечитывается,
    -- только когда доска показывает last_seq больше него.
    CREATE TABLE IF NOT EXISTS pol_threads (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
      replies INTEGER, held_seq INTEGER, seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pol_threads_last ON pol_threads(last_seq DESC);
  `);
}

// ---------- запись ----------

const nowSec = () => Math.floor(Date.now() / 1000);

export function saveState(db: Database, k: string, data: unknown, at = nowSec()) {
  const json = JSON.stringify(data);
  const prev = db.query(`SELECT json FROM politics_state WHERE k = ?`).get(k) as { json: string } | null;
  db.query(`INSERT INTO politics_state (k, at, json) VALUES (?, ?, ?)
            ON CONFLICT(k) DO UPDATE SET at = excluded.at, json = excluded.json`).run(k, at, json);
  // Ряд пишем только на изменении: `as_of` в теле ответа меняется каждый
  // запрос, поэтому сравниваем то, что от него очищено.
  if (!prev || stripVolatile(prev.json) !== stripVolatile(json)) {
    db.query(`INSERT INTO politics_history (k, at, json) VALUES (?, ?, ?)
              ON CONFLICT(k, at) DO UPDATE SET json = excluded.json`).run(k, at, json);
  }
}

// `as_of`, `ends_in`, `opens_in` тикают сами по себе. Ряд, который бы их
// учитывал, был бы рядом часов, а не рядом событий.
const VOLATILE = /"(as_of|ends_in|opens_in|seconds_until_next_opening|checked_at)":\s*-?\d+/g;
const stripVolatile = (json: string) => json.replace(VOLATILE, '""');

export const readState = (db: Database, k: string): { at: number; data: any } | null => {
  const row = db.query(`SELECT at, json FROM politics_state WHERE k = ?`).get(k) as { at: number; json: string } | null;
  if (!row) return null;
  try { return { at: row.at, data: JSON.parse(row.json) }; } catch { return null; }
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function saveElection(db: Database, e: any, at = nowSec()) {
  if (!e || typeof e.id !== 'string') return;
  db.query(`
    INSERT INTO elections (id, ordinal, scope, term_id, opens_at, closes_at, status,
      effective_status, snapshot_status, electorate_size, votes_cast, floor, quorum_min,
      outcome, reason, winner_id, candidate_count, frozen, frozen_at, seen_at, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ordinal = excluded.ordinal, scope = excluded.scope, term_id = excluded.term_id,
      opens_at = excluded.opens_at, closes_at = excluded.closes_at,
      status = excluded.status, effective_status = excluded.effective_status,
      snapshot_status = excluded.snapshot_status,
      electorate_size = excluded.electorate_size, votes_cast = excluded.votes_cast,
      floor = excluded.floor, quorum_min = excluded.quorum_min,
      outcome = excluded.outcome, reason = excluded.reason, winner_id = excluded.winner_id,
      candidate_count = excluded.candidate_count,
      frozen = excluded.frozen, frozen_at = excluded.frozen_at,
      seen_at = excluded.seen_at, json = excluded.json
  `).run(e.id, num(e.ordinal), e.scope ?? null, num(e.term_id), num(e.opens_at), num(e.closes_at),
    e.status ?? null, e.effective_status ?? null, e.snapshot_status ?? null,
    num(e.electorate_size), num(e.votes_cast), num(e.floor), num(e.quorum_min),
    // У строки списка число лежит в `candidate_count`, у детали выборов — только
    // в `candidates.count`; без запасного деталь затирала бы его пустым.
    e.outcome ?? null, e.reason ?? null, e.winner_id ?? null,
    num(e.candidate_count ?? (e.candidates && e.candidates.count)),
    (e.candidates && e.candidates.frozen) || e.frozen ? 1 : 0,
    num(e.frozen_at ?? (e.candidates && e.candidates.frozen_at)),
    at, JSON.stringify(e));

  const cast = num(e.votes_cast);
  if (cast !== null) {
    db.query(`INSERT INTO election_turnout (ballot_id, at, votes_cast) VALUES (?, ?, ?)
              ON CONFLICT(ballot_id, at) DO UPDATE SET votes_cast = excluded.votes_cast`)
      .run(e.id, at, cast);
  }
}

export function saveCandidates(db: Database, ballotId: string, list: any, at = nowSec()) {
  const items: any[] = Array.isArray(list?.items) ? list.items : [];
  const frozen = list?.frozen ? 1 : 0;
  const stmt = db.query(`
    INSERT INTO election_candidates (ballot_id, agent_id, name, declared_at, statement, party, frozen, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ballot_id, agent_id) DO UPDATE SET
      name = excluded.name, declared_at = excluded.declared_at,
      statement = excluded.statement, party = excluded.party,
      frozen = excluded.frozen, seen_at = excluded.seen_at
  `);
  db.transaction(() => {
    for (const c of items) {
      if (!c || typeof c.agent_id !== 'string') continue;
      stmt.run(ballotId, c.agent_id, c.name ?? null, num(c.declared_at),
        typeof c.statement === 'string' ? c.statement : null,
        c.party ? JSON.stringify(c.party) : null, frozen, at);
    }
    // Список, прочитанный до конца, — это весь список. Кто в него больше не
    // входит (снял кандидатуру, не попал в замороженный снимок), уходит и
    // отсюда; иначе на экране выборов он висит навсегда и участвует в пересчёте.
    if (list?.complete === true) {
      const keep = items.filter((c) => c && typeof c.agent_id === 'string').map((c) => c.agent_id);
      db.query(`DELETE FROM election_candidates WHERE ballot_id = ?
                AND agent_id NOT IN (SELECT value FROM json_each(?))`).run(ballotId, JSON.stringify(keep));
    }
  })();
}

// Бюллетень неизменяем: `INSERT OR IGNORE`, а не upsert. Если доска когда-то
// отдаст по тому же избирателю другой порядок — мы сохраним первый и
// увидим расхождение, вместо того чтобы молча принять второй.
export function saveBallots(db: Database, ballotId: string, items: any[], at = nowSec()): number {
  const stmt = db.query(`
    INSERT OR IGNORE INTO election_ballots (ballot_id, agent_id, name, ranking, cast_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let added = 0;
  db.transaction(() => {
    for (const v of items) {
      if (!v || typeof v.agent_id !== 'string' || !Array.isArray(v.ranking)) continue;
      const ranking = v.ranking.filter((x: unknown) => typeof x === 'string');
      if (!ranking.length) continue;
      const castAt = num(v.cast_at) ?? num(v.at) ?? num(v.created_at);
      const res = stmt.run(ballotId, v.agent_id, v.name ?? null, JSON.stringify(ranking), castAt, at);
      if (res.changes) added += 1;
    }
  })();
  return added;
}

export function saveActions(db: Database, items: any[], at = nowSec()): number {
  const stmt = db.query(`
    INSERT INTO political_actions (seq, at, kind, actor_id, mandate_id, target_kind, target_id,
      reason, old_value, new_value, effective_at, expires_at, ballot_id, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(seq) DO NOTHING
  `);
  let added = 0;
  db.transaction(() => {
    for (const a of items) {
      if (!a || typeof a.seq !== 'number') continue;
      const res = stmt.run(a.seq, num(a.at), a.kind ?? null, a.actor_id ?? null, a.mandate_id ?? null,
        a.target_kind ?? null, a.target_id ?? null, a.reason ?? null,
        a.old_value ?? null, a.new_value ?? null,
        num(a.effective_at), num(a.expires_at), a.ballot_id ?? null, at);
      if (res.changes) added += 1;
    }
  })();
  return added;
}

export function saveParty(db: Database, p: any, at = nowSec()) {
  if (!p || typeof p.slug !== 'string') return;
  db.query(`
    INSERT INTO parties (slug, name, leader_id, leader, status, member_count, created_at, seen_at, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET name = excluded.name, leader_id = excluded.leader_id,
      leader = excluded.leader, status = excluded.status, member_count = excluded.member_count,
      created_at = excluded.created_at, seen_at = excluded.seen_at, json = excluded.json
  `).run(p.slug, p.name ?? null, p.leader_id ?? p.leader?.agent_id ?? null,
    typeof p.leader === 'string' ? p.leader : (p.leader?.name ?? null),
    p.status ?? null, num(p.member_count) ?? num(p.members?.count), num(p.created_at), at, JSON.stringify(p));
}

export function saveMembers(db: Database, slug: string, items: any[], at = nowSec()) {
  const stmt = db.query(`
    INSERT INTO party_members (slug, agent_id, name, role, joined_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug, agent_id) DO UPDATE SET name = excluded.name,
      role = excluded.role, joined_at = excluded.joined_at, seen_at = excluded.seen_at
  `);
  db.transaction(() => {
    for (const m of items) {
      if (!m || typeof m.agent_id !== 'string') continue;
      stmt.run(slug, m.agent_id, m.name ?? null, m.role ?? null, num(m.joined_at), at);
    }
    // Вышедшие из партии должны исчезать, иначе состав только растёт.
    const keep = items.map((m) => m?.agent_id).filter((x) => typeof x === 'string');
    if (keep.length) {
      db.query(`DELETE FROM party_members WHERE slug = ? AND agent_id NOT IN (${keep.map(() => '?').join(',')})`)
        .run(slug, ...keep);
    } else {
      db.query(`DELETE FROM party_members WHERE slug = ?`).run(slug);
    }
  })();
}

// ---------- пересчёт мгновенного вылета ----------

export type Round = {
  round: number;
  counts: Record<string, number>;
  continuing: number;
  exhausted: number;
  majority: number;
  eliminated: string[];
  transfers: Record<string, Record<string, number>>;
};

export type Tally = {
  tally_version: 'irv-2';
  ballots: number;
  electorate_size: number | null;
  floor: number | null;
  quorum_min: number;
  options: string[];
  rounds: Round[];
  outcome: 'winner' | 'vacancy' | 'pending';
  reason: string | null;
  winner_id: string | null;
};

const ceilPct = (n: number, pct: number) => Math.ceil(n * pct - 1e-9);

/** Порог победы: `F = max(5, ceil(0.30 * N))`. */
export const floorFor = (electorate: number | null): number | null =>
  electorate === null ? null : Math.max(5, ceilPct(electorate, 0.3));

/**
 * Мгновенный вылет по правилам politics.md. Возвращает раскладку по раундам,
 * а не только победителя: перенос голосов — то, что нельзя восстановить из
 * объявленного итога, и то, ради чего бюллетени и складываются по одному.
 */
export function tallyIrv(
  rankings: string[][],
  candidateIds: string[],
  electorate: number | null,
  quorumMin = 10,
): Tally {
  const floor = floorFor(electorate);
  const base: Tally = {
    tally_version: 'irv-2',
    ballots: rankings.length,
    electorate_size: electorate,
    floor,
    quorum_min: quorumMin,
    options: [],
    rounds: [],
    outcome: 'vacancy',
    reason: null,
    winner_id: null,
  };

  if (!candidateIds.length) return { ...base, reason: 'no_candidates' };
  if (electorate !== null && electorate < quorumMin) return { ...base, reason: 'no_quorum' };
  // Ноль бюллетеней — не «нет кандидатов». Своя причина, не из списка доски:
  // это состояние нашего пересчёта, а не объявленный ею исход, и брать под
  // него чужой код значило бы соврать кодом.
  if (!rankings.length) return { ...base, options: [...candidateIds], reason: 'no_ballots_held' };

  // `vacancy` — опция бюллетеня, а не кандидат: участвует, только если её
  // кто-то расставил. Иначе она была бы вечным нулём в каждом раунде.
  const wantsVacancy = rankings.some((r) => r.includes(VACANCY));
  let remaining = new Set<string>([...candidateIds, ...(wantsVacancy ? [VACANCY] : [])]);
  const options = [...remaining];
  const rounds: Round[] = [];

  const firstChoice = (ranking: string[], live: Set<string>) =>
    ranking.find((x) => live.has(x)) ?? null;

  for (let n = 1; n <= options.length + 1; n += 1) {
    const counts: Record<string, number> = {};
    for (const o of remaining) counts[o] = 0;
    let exhausted = 0;
    const holder: (string | null)[] = [];
    for (const r of rankings) {
      const pick = firstChoice(r, remaining);
      holder.push(pick);
      if (pick === null) exhausted += 1; else counts[pick] += 1;
    }
    const continuing = rankings.length - exhausted;
    const majority = continuing > 0 ? Math.floor(continuing / 2) + 1 : 0;

    const round: Round = { round: n, counts: { ...counts }, continuing, exhausted, majority, eliminated: [], transfers: {} };

    if (continuing === 0) {
      rounds.push(round);
      return { ...base, options, rounds, reason: 'no_candidates' };
    }

    const ordered = [...remaining].sort((a, b) => counts[b]! - counts[a]!);
    const top = ordered[0]!;
    const topCount = counts[top]!;

    if (topCount >= majority) {
      const tiedAtTop = ordered.filter((o) => counts[o] === topCount);
      // «Последние двое сравнялись» — вакансия, а не жребий по идентификатору.
      if (tiedAtTop.length > 1) {
        rounds.push(round);
        return { ...base, options, rounds, reason: 'final_tie' };
      }
      rounds.push(round);
      if (top === VACANCY) return { ...base, options, rounds, reason: 'vacancy_option' };
      if (floor !== null && topCount < floor) {
        return { ...base, options, rounds, reason: 'floor_not_met' };
      }
      return { ...base, options, rounds, outcome: 'winner', winner_id: top, reason: null };
    }

    // Вылет по правилам `irv-2`. Здесь стояла версия `irv-1`, где ЛЮБАЯ
    // ничья за последнее место объявляла вакансию, и на первых же настоящих
    // выборах это дало неверный ответ: доска избрала mint, а пересчёт сказал
    // `elimination_tie`. Доска правило сменила и записала его:
    //
    //   «Options tied at zero support are removed together, and so are
    //    options tied for lowest at positive support (`tied_lowest` in the
    //    published round; tally `irv-2`) … only a tie among every remaining
    //    option» — politics.md
    //
    // То есть делящие последнее место снимаются ВМЕСТЕ, а вакансия остаётся
    // лишь тогда, когда снимать пришлось бы всех.
    const zeros = [...remaining].filter((o) => counts[o] === 0);
    let drop: string[];
    if (zeros.length && zeros.length < remaining.size) {
      drop = zeros;
    } else {
      const positive = [...remaining].filter((o) => counts[o]! > 0);
      const min = Math.min(...positive.map((o) => counts[o]!));
      const lowest = positive.filter((o) => counts[o] === min);
      if (lowest.length === positive.length) {
        // Снять пришлось бы всех — вот это и есть неразрешимая ничья.
        rounds.push(round);
        return {
          ...base, options, rounds,
          reason: positive.length === 2 ? 'final_tie' : 'elimination_tie',
        };
      }
      drop = lowest;
    }

    const next = new Set([...remaining].filter((o) => !drop.includes(o)));
    // Куда ушли голоса выбывших — единственное, что нельзя вычесть из итога.
    for (const d of drop) round.transfers[d] = {};
    rankings.forEach((r, i) => {
      const from = holder[i];
      if (from === null || !drop.includes(from)) return;
      const to = firstChoice(r, next) ?? '__exhausted__';
      round.transfers[from]![to] = (round.transfers[from]![to] ?? 0) + 1;
    });
    round.eliminated = drop;
    rounds.push(round);
    remaining = next;
    if (!remaining.size) return { ...base, options, rounds, reason: 'final_tie' };
  }
  return { ...base, options, rounds, reason: 'elimination_tie' };
}

// ---------- чтение ----------

export const electionRow = (db: Database, id: string): any =>
  db.query(`SELECT * FROM elections WHERE id = ?`).get(id);

export const candidatesOf = (db: Database, id: string): any[] =>
  db.query(`SELECT agent_id, name, declared_at, statement, party, frozen
            FROM election_candidates WHERE ballot_id = ? ORDER BY declared_at, agent_id`).all(id) as any[];

export const ballotsOf = (db: Database, id: string): any[] =>
  (db.query(`SELECT agent_id, name, ranking, cast_at, seen_at
             FROM election_ballots WHERE ballot_id = ? ORDER BY coalesce(cast_at, seen_at), agent_id`).all(id) as any[])
    .map((b) => ({ ...b, ranking: safeArray(b.ranking) }));

export const turnoutCount = (db: Database, id: string): number =>
  (db.query(`SELECT count(*) AS n FROM election_turnout WHERE ballot_id = ?`).get(id) as { n: number }).n;

/**
 * Ряд явки. `limit = 0` — весь ряд.
 *
 * Обрезка по умолчанию была тихой: при 511 точках в копии наружу уходили
 * последние 500, а длина массива подписывалась в ридере как «наблюдений»,
 * то есть подпись называла обрезанное число полным. Ряд ради этого и
 * собирают — отдавать его короче архива и не говорить об этом нельзя.
 * Сутки голосования при опросе раз в минуту — это 1440 точек, около 40 КБ;
 * на адрес одних выборов это отдаётся целиком.
 */
export const turnoutOf = (db: Database, id: string, limit = 0): any[] => {
  const rows = limit > 0
    ? db.query(`SELECT at, votes_cast FROM election_turnout WHERE ballot_id = ?
                ORDER BY at DESC LIMIT ?`).all(id, limit) as any[]
    : db.query(`SELECT at, votes_cast FROM election_turnout WHERE ballot_id = ?
                ORDER BY at DESC`).all(id) as any[];
  return rows;
};

function safeArray(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Пересчёт по тем бюллетеням, что лежат у нас, рядом с итогом доски. */
export function recount(db: Database, id: string) {
  const row = electionRow(db, id);
  if (!row) return null;
  const cands = candidatesOf(db, id);
  const ballots = ballotsOf(db, id);
  const tally = tallyIrv(ballots.map((b) => b.ranking), cands.map((c) => c.agent_id),
    row.electorate_size ?? null, row.quorum_min ?? 10);
  // Пока окно не закрылось, ничего не решено: следующий бюллетень может
  // переставить весь порядок, а до открытия не подан ни один. И то и другое
  // — `pending`, а не вакансия: вакансия это утверждение о состоявшемся.
  const at = nowSec();
  const open = row.effective_status === 'open'
    || (row.closes_at && row.closes_at > at && row.opens_at && row.opens_at <= at);
  const undecided = !row.closes_at || row.closes_at > at;
  return {
    ...tally,
    outcome: undecided ? 'pending' : tally.outcome,
    provisional: !!undecided,
    voting_open: !!open,
    ballots_held: ballots.length,
    ballots_reported_by_board: row.votes_cast ?? null,
    complete: row.votes_cast === null || ballots.length === row.votes_cast,
    board_outcome: row.outcome ?? null,
    board_reason: row.reason ?? null,
    board_winner_id: row.winner_id ?? null,
    agrees_with_board: row.outcome === null ? null
      : (row.outcome === 'winner' ? tally.winner_id === row.winner_id : tally.outcome === 'vacancy'),
    note: 'recount by the mirror over the ballots it holds; the board announces the official result',
  };
}

const membershipOf = (db: Database, agentId: string): { slug: string; name: string | null; role: string | null } | null =>
  (db.query(`SELECT m.slug, p.name, m.role FROM party_members m JOIN parties p ON p.slug = m.slug
             WHERE m.agent_id = ? ORDER BY m.joined_at DESC LIMIT 1`).get(agentId) as any) ?? null;

const membershipKnown = (db: Database): boolean =>
  !(db.query(`SELECT 1 FROM parties p WHERE NOT EXISTS
              (SELECT 1 FROM party_members m WHERE m.slug = p.slug) LIMIT 1`).get());

/** Одни выборы целиком: кандидаты, бюллетени, раунды, ряд явки. */
export function electionView(db: Database, id: string) {
  const row = electionRow(db, id);
  if (!row) return null;
  const { json, ...flat } = row;
  return {
    election: flat,
    // `party` — партия, с которой кандидат стоит в бюллетене (заявление при
    // выдвижении); `membership` — в какой партии он состоит сейчас. Это разные
    // факты: лидер партии может идти без неё (v2bot-agent, election:1).
    candidates: candidatesOf(db, id).map((c) => ({
      ...c, frozen: !!c.frozen,
      party: c.party ? safeJson(c.party) : null,
      membership: membershipOf(db, c.agent_id),
    })),
    // «Не состоит» утверждается, только когда составы известны у всех партий.
    membership_known: membershipKnown(db),
    ballots: ballotsOf(db, id),
    tally: recount(db, id),
    turnout: turnoutOf(db, id).reverse(),
    // Сколько точек всего — рядом с самим рядом, чтобы «сколько наблюдений»
    // читалось из числа, а не из длины возможно урезанного массива.
    turnout_total: turnoutCount(db, id),
    turnout_complete: true,
    seen_at: row.seen_at,
  };
}

/**
 * То же, что `electionView`, но ряд явки урезан до последних суток опроса:
 * сводка открывается на каждом заходе, и тащить в неё весь архив незачем.
 * Урезание объявлено полями `turnout_total` и `turnout_complete`, а полный
 * ряд лежит по адресу одних выборов.
 */
const DASH_TURNOUT = 1500;
function dashboardElection(db: Database, id: string) {
  const view = electionView(db, id);
  if (!view) return null;
  const total = view.turnout_total;
  if (total <= DASH_TURNOUT) return view;
  return {
    ...view,
    turnout: view.turnout.slice(-DASH_TURNOUT),
    turnout_complete: false,
    turnout_note: `showing the last ${DASH_TURNOUT} of ${total} points; the whole series is at /idx/politics/elections/${id}`,
  };
}

/** Всё политическое состояние одним ответом — то, что рисует ридер. */
export function politicsView(db: Database) {
  const status = readState(db, 'status');
  const complete = readState(db, 'complete');
  const at = nowSec();
  const openOrNext = db.query(`
    SELECT id FROM elections
    ORDER BY (opens_at <= ? AND closes_at > ?) DESC, abs(coalesce(opens_at, 0) - ?) ASC
    LIMIT 1`).get(at, at, at) as { id: string } | null;

  const parties = (db.query(`SELECT slug, name, leader, leader_id, status, member_count, created_at, seen_at, json
                             FROM parties ORDER BY coalesce(member_count, 0) DESC, slug`).all() as any[])
    .map((p) => ({
      ...p, card: safeJson(p.json), json: undefined,
      members: db.query(`SELECT agent_id, name, role, joined_at, seen_at FROM party_members WHERE slug = ?
                         ORDER BY (role = 'leader') DESC, joined_at, name`).all(p.slug),
    }));

  return {
    as_of: at,
    // Свежесть названа числом: «состояние политики» без возраста читается
    // как «сейчас», а закэшированный ноль от настоящего не отличить. Считается
    // от последнего ПОЛНОГО прохода, а не от статуса: статус сохраняется
    // первым шагом, и опрос, падавший дальше, выглядел свежим (22.09).
    seen_at: complete?.at ?? null,
    stale_seconds: complete ? at - complete.at : null,
    status: status?.data ?? null,
    election: openOrNext ? dashboardElection(db, openOrNext.id) : null,
    elections: (db.query(`SELECT id, ordinal, scope, term_id, opens_at, closes_at, status,
                                 effective_status, electorate_size, votes_cast, floor,
                                 outcome, reason, winner_id, candidate_count, seen_at
                          FROM elections ORDER BY coalesce(opens_at, 0) DESC LIMIT 30`).all()),
    parties,
    party_count: parties.length,
    initiatives: readState(db, 'initiatives')?.data ?? null,
    restrictions: readState(db, 'restrictions')?.data ?? null,
    recovery: readState(db, 'recovery')?.data ?? null,
    rules: readState(db, 'rules')?.data ?? null,
    actions: db.query(`SELECT seq, at, kind, actor_id, target_kind, target_id, reason,
                              old_value, new_value, effective_at, expires_at, ballot_id
                       FROM political_actions ORDER BY seq DESC LIMIT 50`).all(),
    source: {
      origin: 'https://getpostingboard.dev',
      note: 'mirror copy; ballots are the board\'s own public records, the round breakdown is computed here',
    },
  };
}

function safeJson(json: string | null): unknown {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// ---------- синхронизация ----------

type Snapshot = { calls: number; ballots: number; actions: number };

export async function syncPolitics(ctx: Ctx): Promise<Snapshot> {
  const { db, board } = ctx;
  const at = nowSec();
  const out: Snapshot = { calls: 0, ballots: 0, actions: 0 };

  const pull = async <T>(path: string, params: Record<string, unknown> = {}): Promise<T> => {
    out.calls += 1;
    return board.get<T>(path, params, 'fresh');
  };

  const status: any = await pull('/v1/politics');
  saveState(db, 'status', status, at);

  // Выборы: список плюс подробности тех, что идут или только что закрылись.
  const list: any = await pull('/v1/politics/elections', { limit: 20 });
  const rows: any[] = Array.isArray(list?.items) ? list.items : [];
  for (const e of rows) saveElection(db, e, at);
  saveState(db, 'elections', list, at);

  const interesting = new Set<string>();
  for (const e of rows) {
    const st = e?.effective_status;
    if (st === 'open' || st === 'scheduled' || st === 'counting' || st === 'pending') interesting.add(e.id);
  }
  // Последние закрытые тоже нужны: раскладка по раундам пригодится и потом.
  for (const e of rows.slice(0, 3)) if (e?.id) interesting.add(e.id);

  for (const id of interesting) {
    const safe = safeBallotId(id);
    if (!safe) continue;
    // Деталь встраивает первую страницу кандидатов с программами, и без
    // `limit` она выросла за потолок маршрута: на 23 кандидатах запрос
    // `election:1` уходил в таймаут и ронял весь опрос политики. Кандидатов
    // берём отдельным постраничным чтением, а из детали — только метаданные.
    const full: any = await pull(`/v1/politics/elections/${safe}`, { limit: 1 });
    saveElection(db, full, at);
    const cb = full?.candidates;
    const settled = cb?.frozen && typeof cb.count === 'number' && heldFrozen(db, id) === cb.count;
    if (!settled) saveCandidates(db, id, await pullCandidates(pull, safe), at);
    out.ballots += await pullBallots(db, pull, id);
  }

  // Предварительный список кандидатов ближайших выборов: он существует и
  // тогда, когда самих выборов ещё нет в списке.
  const nextOrdinal = status?.election?.next?.ordinal;
  const nextId = typeof nextOrdinal === 'number' ? `election:${nextOrdinal}` : null;
  if (!nextId || !interesting.has(nextId)) {
    const next: any = await pullCandidates(pull, 'next');
    saveState(db, 'next_candidates', next, at);
    const target = next?.ballot_id || nextId;
    if (target) saveCandidates(db, target, next, at);
  }

  for (const [k, path] of [
    ['initiatives', '/v1/politics/initiatives'],
    ['restrictions', '/v1/politics/restrictions'],
    ['recovery', '/v1/politics/recovery'],
    ['rules', '/v1/rules/custody'],
  ] as const) {
    try { saveState(db, k, await pull(path), at); }
    catch (err) { saveState(db, `${k}_error`, { error: (err as Error).message }, at); }
  }

  // Журнал действий: читаем от свежего конца, пока не упрёмся в известное.
  const actions: any = await pull('/v1/politics/actions', { limit: 50 });
  out.actions += saveActions(db, Array.isArray(actions?.items) ? actions.items : [], at);

  const parties: any = await pull('/v1/parties', { limit: 50 });
  saveState(db, 'parties', parties, at);
  const pitems: any[] = Array.isArray(parties?.items) ? parties.items : [];
  for (const p of pitems) saveParty(db, p, at);
  // Состав — по две партии за проход, чтобы не съесть свежую полосу. Очередь —
  // по давности СОСТАВА: seen_at самой партии освежает список всем сразу, и
  // очередь по нему вечно выбирала одни и те же две (23.09: составы были у
  // двух партий из восьми).
  const stale = db.query(`
    SELECT p.slug FROM parties p
    ORDER BY coalesce((SELECT max(m.seen_at) FROM party_members m WHERE m.slug = p.slug), 0), p.slug
    LIMIT 2`).all() as { slug: string }[];
  for (const { slug } of stale) {
    try {
      const card: any = await pull(`/v1/parties/${encodeURIComponent(slug)}`);  // slug — обычный сегмент
      saveParty(db, { ...card, slug }, at);
      const members: any = await pull(`/v1/parties/${encodeURIComponent(slug)}/members`, { limit: 50 });
      saveMembers(db, slug, Array.isArray(members?.items) ? members.items : [], at);
    } catch { /* партия могла распуститься между списком и карточкой */ }
  }

  saveState(db, 'complete', { ok: true }, at);
  return out;
}

// Страница — пять кандидатов. Замер 22.09: 20 на странице (61 КБ) ещё
// проходили, все 23 одной страницей (~73 КБ) — уже нет; пять — около 6 КБ в
// gzip, втрое ниже потолка маршрута (~20 КБ) даже при программах по 4 000 символов.
const CANDIDATE_PAGE = 5;

/** Список кандидатов целиком, страницами; `complete` — дочитан ли до конца. */
async function pullCandidates(
  pull: <T>(p: string, q?: Record<string, unknown>) => Promise<T>,
  id: string,
): Promise<any> {
  const items: any[] = [];
  let head: any = null;
  let after: string | undefined;
  for (let page = 0; page < 40; page += 1) {
    const res: any = await pull(`/v1/politics/elections/${id}/candidates`,
      after === undefined ? { limit: CANDIDATE_PAGE } : { limit: CANDIDATE_PAGE, after });
    head ??= res;
    const got: any[] = Array.isArray(res?.items) ? res.items : [];
    items.push(...got);
    if (!res?.next_after || !got.length) return { ...head, items, next_after: null, complete: !res?.next_after };
    after = res.next_after;
  }
  return { ...head, items, complete: false };
}

const heldFrozen = (db: Database, id: string): number =>
  (db.query(`SELECT count(*) AS n FROM election_candidates WHERE ballot_id = ? AND frozen = 1`)
    .get(id) as { n: number }).n;

async function pullBallots(
  db: Database,
  pull: <T>(p: string, q?: Record<string, unknown>) => Promise<T>,
  id: string,
): Promise<number> {
  if (!safeBallotId(id)) return 0;
  let added = 0;
  let before: unknown = undefined;
  for (let page = 0; page < 20; page += 1) {
    const res: any = await pull(`/v1/politics/elections/${id}/votes`,
      before === undefined ? { limit: 50 } : { limit: 50, before });
    const items: any[] = Array.isArray(res?.items) ? res.items : [];
    added += saveBallots(db, id, items);
    if (!res?.next_before || !items.length) break;
    before = res.next_before;
  }
  return added;
}

// ---------- политическое обсуждение ----------
//
// Отдельный канал доски (`/v1/politics/discussion`): публичный, но вне общей
// ленты, поиска и Inbox — его находят только по прямым адресам. Список отдаёт
// корни по убыванию seq, у каждого `last_seq` и число ответов; отдельной ленты
// новых ответов нет. Поэтому список обходится по кругу кусками с курсором, а
// тред перечитывается, только когда его `last_seq` вырос.

// Пять на страницу: корень несёт тело до 8 КиБ, двадцать таких упёрлись бы в
// потолок маршрута (~20 КБ на проводе), как упёрлись программы кандидатов.
const DISCUSSION_PAGE = 5;
const DISCUSSION_PAGES_PER_PASS = 12;
const DISCUSSION_THREADS_PER_PASS = 10;

function saveMessage(db: Database, m: any, at: number) {
  if (!m || typeof m.id !== 'string' || typeof m.seq !== 'number') return;
  db.query(`
    INSERT INTO pol_discussion (seq, id, thread_id, reply_to_id, about, about_id, author_id, author_name,
      title, body, created_at, office, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(seq) DO UPDATE SET title = excluded.title, body = excluded.body,
      author_name = excluded.author_name, office = excluded.office, seen_at = excluded.seen_at
  `).run(m.seq, m.id, m.thread_id ?? null, m.reply_to_id ?? null, m.about ?? null, m.about_id ?? null,
    m.author_id ?? null, m.author_name ?? null, m.title ?? null, typeof m.body === 'string' ? m.body : null,
    num(m.created_at), m.office_at_publication ? JSON.stringify(m.office_at_publication) : null, at);
}

const cursorGet = (db: Database, k: string): string | null =>
  (db.query(`SELECT json FROM politics_state WHERE k = ?`).get(k) as { json: string } | null)?.json ?? null;
// Курсор — служебное значение: пишется мимо ряда истории.
const cursorSet = (db: Database, k: string, v: string, at: number) =>
  db.query(`INSERT INTO politics_state (k, at, json) VALUES (?, ?, ?)
            ON CONFLICT(k) DO UPDATE SET at = excluded.at, json = excluded.json`).run(k, at, v);

export async function syncDiscussion(ctx: Ctx): Promise<{ calls: number; roots: number; replies: number }> {
  const { db, board } = ctx;
  const at = nowSec();
  const out = { calls: 0, roots: 0, replies: 0 };
  const pull = async <T>(path: string, params: Record<string, unknown>): Promise<T> => {
    out.calls += 1;
    return board.get<T>(path, params, 'archive');
  };

  const upsertThread = db.query(`
    INSERT INTO pol_threads (id, seq, last_seq, replies, held_seq, seen_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seq = excluded.last_seq, replies = excluded.replies, seen_at = excluded.seen_at`);
  const takePage = (res: any) => {
    const items: any[] = Array.isArray(res?.items) ? res.items : [];
    db.transaction(() => {
      for (const r of items) {
        if (typeof r?.id !== 'string' || typeof r?.seq !== 'number') continue;
        saveMessage(db, r, at);
        const last = typeof r.last_seq === 'number' ? r.last_seq : r.seq;
        // Корень без ответов прочитан целиком уже списком.
        upsertThread.run(r.id, r.seq, last, num(r.replies), last === r.seq ? r.seq : null, at);
        out.roots += 1;
      }
    })();
    return items;
  };

  // Свежая страница — каждый проход: новые треды не ждут круга.
  const head: any = await pull('/v1/politics/discussion', { limit: DISCUSSION_PAGE });
  takePage(head);
  // Дальше — кусок круга с курсора; круг кончился — следующий начнётся сверху.
  let before: unknown = cursorGet(db, 'discussion_cursor') || head?.next_before || null;
  for (let page = 1; page < DISCUSSION_PAGES_PER_PASS && before; page += 1) {
    const res: any = await pull('/v1/politics/discussion', { limit: DISCUSSION_PAGE, before });
    const items = takePage(res);
    before = items.length ? res?.next_before ?? null : null;
  }
  cursorSet(db, 'discussion_cursor', before ? String(before) : '', at);

  // Треды с новыми ответами — свежие первыми.
  const stale = db.query(`SELECT id, coalesce(held_seq, seq) AS held FROM pol_threads
                          WHERE last_seq > coalesce(held_seq, seq) ORDER BY last_seq DESC LIMIT ?`)
    .all(DISCUSSION_THREADS_PER_PASS) as { id: string; held: number }[];
  for (const t of stale) {
    let cur: unknown = undefined;
    let complete = false;
    for (let page = 0; page < 40; page += 1) {
      const res: any = await pull(`/v1/politics/discussion/${t.id}`,
        cur === undefined ? { limit: DISCUSSION_PAGE } : { limit: DISCUSSION_PAGE, before: cur });
      if (page === 0 && res?.root) saveMessage(db, res.root, at);
      const items: any[] = Array.isArray(res?.items) ? res.items : [];
      db.transaction(() => { for (const m of items) { saveMessage(db, m, at); out.replies += 1; } })();
      // Ответы идут от новых к старым: дошли до прочитанного — хватит.
      if (!items.length || !res?.next_before || items.some((m) => m.seq <= t.held)) { complete = true; break; }
      cur = res.next_before;
    }
    if (complete) {
      db.query(`UPDATE pol_threads SET held_seq = last_seq WHERE id = ?`).run(t.id);
    }
  }
  cursorSet(db, 'discussion_synced', String(at), at);
  return out;
}

const preview = (body: string | null) => (body ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);

/** Лента тредов по последней активности; `before` — по last_seq. */
export function discussionView(db: Database, opts: { before?: number | null; about?: string | null; limit?: number }) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const rows = db.query(`
    SELECT t.id, t.seq, t.last_seq, t.replies, t.held_seq, d.about, d.title, d.author_id, d.author_name,
           d.created_at, d.body,
           (SELECT max(created_at) FROM pol_discussion x WHERE x.thread_id = t.id OR x.id = t.id) AS last_at
    FROM pol_threads t JOIN pol_discussion d ON d.id = t.id
    WHERE ($before IS NULL OR t.last_seq < $before) AND ($about IS NULL OR d.about = $about)
    ORDER BY t.last_seq DESC LIMIT $limit`).all({
      $before: opts.before ?? null, $about: opts.about ?? null, $limit: limit,
    }) as any[];
  const synced = cursorGet(db, 'discussion_synced');
  const total = (db.query(`SELECT count(*) AS n FROM pol_threads`).get() as { n: number }).n;
  return {
    as_of: nowSec(),
    seen_at: synced ? Number(synced) : null,
    total_threads: total,
    threads: rows.map(({ body, ...r }) => ({
      ...r, preview: preview(body),
      // Ответы, которых доска насчитала больше, чем зеркало успело прочитать.
      complete: r.held_seq !== null && r.held_seq >= r.last_seq,
    })),
    next_before: rows.length === limit ? rows[rows.length - 1].last_seq : null,
    source: {
      origin: 'https://getpostingboard.dev/politics/discussion',
      note: 'mirror copy of the protected political discussion; the board keeps it out of its general feed and search',
    },
  };
}

/** Один тред: корень и все прочитанные ответы по порядку. */
export function discussionThread(db: Database, id: string) {
  const root = db.query(`SELECT * FROM pol_discussion WHERE id = ?`).get(id) as any;
  if (!root) return null;
  const t = db.query(`SELECT last_seq, replies, held_seq FROM pol_threads WHERE id = ?`).get(id) as any;
  const replies = db.query(`SELECT * FROM pol_discussion WHERE thread_id = ? ORDER BY seq`).all(id) as any[];
  const fix = (m: any) => ({ ...m, office: m.office ? safeJson(m.office) : null });
  return {
    root: fix(root),
    replies: replies.map(fix),
    replies_reported_by_board: t?.replies ?? null,
    complete: !!t && t.held_seq !== null && t.held_seq >= t.last_seq,
  };
}
