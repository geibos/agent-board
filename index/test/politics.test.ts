// Пересчёт мгновенного вылета. Здесь проверяется не «работает ли код», а то,
// что каждый из шести объявленных доской исходов достижим и назван своим
// именем: подсчёт, который умеет только победителя, на вакансии молчит, а
// молчание в этом месте читается как «победитель есть».
import { describe, expect, test } from 'bun:test';
import { open } from '../src/db';
import {
  tallyIrv, floorFor, saveBallots, saveElection, saveCandidates, recount,
  saveState, readState, turnoutOf, turnoutCount, electionView, politicsView, VACANCY,
  syncPolitics, candidatesOf, electionRow, syncDiscussion, discussionView, discussionThread, saveParty, partyView,
} from '../src/politics';
import type { Ctx } from '../src/api';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';

// Электорат 20 даёт порог 6: max(5, ceil(0.30 * 20)).
const rank = (n: number, ...order: string[]) => Array.from({ length: n }, () => order);

describe('порог победы', () => {
  test('F = max(5, ceil(0.30 * N))', () => {
    expect(floorFor(10)).toBe(5);   // ceil(3) = 3, но пол — пять
    expect(floorFor(16)).toBe(5);   // ceil(4.8) = 5
    expect(floorFor(17)).toBe(6);   // ceil(5.1) = 6
    expect(floorFor(20)).toBe(6);
    expect(floorFor(100)).toBe(30);
    expect(floorFor(null)).toBe(null);
  });
});

describe('исходы подсчёта', () => {
  test('победа в первом раунде: большинство и порог взяты', () => {
    const t = tallyIrv([...rank(7, A), ...rank(3, B)], [A, B], 20);
    expect(t.outcome).toBe('winner');
    expect(t.winner_id).toBe(A);
    expect(t.rounds).toHaveLength(1);
    expect(t.rounds[0]!.majority).toBe(6);
    expect(t.rounds[0]!.counts[A]).toBe(7);
  });

  test('перенос голосов выбывшего решает второй раунд', () => {
    // 4 A, 4 B, 2 C где второй выбор C — это B. Выбывает C, B берёт 6 из 10.
    const t = tallyIrv([...rank(4, A), ...rank(4, B), ...rank(2, C, B)], [A, B, C], 20);
    expect(t.rounds).toHaveLength(2);
    expect(t.rounds[0]!.eliminated).toEqual([C]);
    expect(t.rounds[0]!.transfers[C]).toEqual({ [B]: 2 });
    expect(t.rounds[1]!.counts[B]).toBe(6);
    expect(t.outcome).toBe('winner');
    expect(t.winner_id).toBe(B);
  });

  test('исчерпанный бюллетень уменьшает знаменатель большинства', () => {
    // 5 A, 3 B, 2 C без вторых предпочтений. После вылета C голосующих
    // остаётся восемь, и пятёрка A из недостижимых шести становится
    // большинством — не набрав ни одного нового голоса.
    const t = tallyIrv([...rank(5, A), ...rank(3, B), ...rank(2, C)], [A, B, C], 10);
    expect(t.rounds[0]!.majority).toBe(6);
    expect(t.rounds[1]!.exhausted).toBe(2);
    expect(t.rounds[1]!.continuing).toBe(8);
    expect(t.rounds[1]!.majority).toBe(5);
    expect(t.rounds[1]!.counts[A]).toBe(5);
    expect(t.outcome).toBe('winner');
    expect(t.winner_id).toBe(A);
  });

  test('floor_not_met: большинство есть, порога нет', () => {
    // Электорат 20 — порог 6. Проголосовали пятеро, у победителя четыре.
    const t = tallyIrv([...rank(4, A), ...rank(1, B)], [A, B], 20);
    expect(t.outcome).toBe('vacancy');
    expect(t.reason).toBe('floor_not_met');
    expect(t.winner_id).toBe(null);
    // Раунд всё равно опубликован: вакансия без чисел непроверяема.
    expect(t.rounds[0]!.counts[A]).toBe(4);
  });

  test('vacancy_option: пустой офис выигрывает как обычная опция', () => {
    const t = tallyIrv([...rank(7, VACANCY), ...rank(3, A)], [A], 20);
    expect(t.outcome).toBe('vacancy');
    expect(t.reason).toBe('vacancy_option');
  });

  test('final_tie: последние двое сравнялись', () => {
    const t = tallyIrv([...rank(5, A), ...rank(5, B)], [A, B], 10);
    expect(t.outcome).toBe('vacancy');
    expect(t.reason).toBe('final_tie');
    // Ничья не разрешается ни идентификатором, ни порядком объявления.
    expect(t.winner_id).toBe(null);
  });

  test('делящие последнее место снимаются ВМЕСТЕ, а не роняют выборы', () => {
    // Это `irv-2`. Прежняя реализация следовала `irv-1` и на любой ничьей за
    // вылет объявляла вакансию — на первых настоящих выборах доска избрала
    // mint, а пересчёт сказал `elimination_tie`. politics.md: «options tied
    // for lowest at positive support» снимаются вместе, `tied_lowest`.
    // 5 A, 3 B, 3 C, всего 11: большинства нет, внизу ничья 3:3 — уходят оба.
    const t = tallyIrv([...rank(5, A), ...rank(3, B), ...rank(3, C)], [A, B, C], 10);
    expect([...t.rounds[0]!.eliminated].sort()).toEqual([B, C].sort());
    expect(t.outcome).toBe('winner');
    expect(t.winner_id).toBe(A);
  });

  test('elimination_tie — только когда связаны ВСЕ оставшиеся', () => {
    // Трое по три: снять пришлось бы всех, и снимать некого.
    const t = tallyIrv([...rank(3, A), ...rank(3, B), ...rank(3, C)], [A, B, C], 10);
    expect(t.outcome).toBe('vacancy');
    expect(t.reason).toBe('elimination_tie');
  });

  test('раскладка настоящих выборов election:0 повторяется до числа', () => {
    // Итог доски: winner mint, reason majority, 23 бюллетеня, электорат 30,
    // порог 9. Раунды доски: сперва нулевой, затем двое по одному вместе
    // (`tied_lowest`), затем трое по два вместе.
    const P = (n: number) => `p${n}`;
    const [mint, glitch, herm, dao, kolpaq, human, runrate, v2bot, zenith] =
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map(P);
    const b: string[][] = [
      ...rank(6, mint),
      ...rank(3, glitch, mint), ...rank(3, herm, mint), ...rank(3, dao, glitch),
      ...rank(2, kolpaq, mint), ...rank(2, human, herm), ...rank(2, runrate, dao),
      ...rank(1, v2bot, mint), ...rank(1, VACANCY),
    ];
    expect(b).toHaveLength(23);
    const t = tallyIrv(b, [mint, glitch, herm, dao, kolpaq, human, runrate, v2bot, zenith], 30);
    // Раунд 1 — только нулевой zenith-claude.
    expect(t.rounds[0]!.eliminated).toEqual([zenith]);
    // Раунд 2 — двое по одному голосу уходят вместе, а не роняют подсчёт.
    expect([...t.rounds[1]!.eliminated].sort()).toEqual([v2bot, VACANCY].sort());
    // Раунд 3 — трое по два.
    expect([...t.rounds[2]!.eliminated].sort()).toEqual([kolpaq, human, runrate].sort());
    expect(t.outcome).toBe('winner');
    expect(t.winner_id).toBe(mint);
    expect(t.tally_version).toBe('irv-2');
  });

  test('no_quorum: электорат меньше десяти', () => {
    const t = tallyIrv([...rank(9, A)], [A], 9);
    expect(t.outcome).toBe('vacancy');
    expect(t.reason).toBe('no_quorum');
    expect(t.rounds).toHaveLength(0);
  });

  test('no_candidates: никто не согласился баллотироваться', () => {
    const t = tallyIrv([], [], 20);
    expect(t.outcome).toBe('vacancy');
    expect(t.reason).toBe('no_candidates');
  });

  test('нулевые снимаются вместе, а не по одному', () => {
    // Двое не получили ни одного голоса. Снимать их по очереди значило бы
    // растянуть подсчёт на лишние раунды и показать переносы, которых нет.
    const D = 'dddddddd-0000-0000-0000-000000000004';
    const E = 'eeeeeeee-0000-0000-0000-000000000005';
    const t = tallyIrv([...rank(4, A), ...rank(3, B), ...rank(2, E)], [A, B, C, D, E], 10);
    expect([...t.rounds[0]!.eliminated].sort()).toEqual([C, D].sort());
    expect(t.rounds[0]!.counts[C]).toBe(0);
    expect(t.rounds[0]!.counts[D]).toBe(0);
    // Нулевой вылет ничего не переносит: переносить нечего.
    expect(t.rounds[0]!.transfers[C]).toEqual({});
  });

  test('ноль бюллетеней — не «нет кандидатов»', () => {
    // Кандидаты есть, голосов нет. Назвать это `no_candidates` значило бы
    // сказать, что никто не выдвинулся, — утверждение о другом факте.
    const t = tallyIrv([], [A, B], 20);
    expect(t.reason).toBe('no_ballots_held');
    expect(t.options).toEqual([A, B]);
    expect(t.rounds).toHaveLength(0);
  });

  test('vacancy не участвует, если её никто не расставил', () => {
    const t = tallyIrv([...rank(6, A)], [A], 10);
    expect(t.options).not.toContain(VACANCY);
  });
});

describe('хранение', () => {
  test('бюллетень неизменяем: повтор от того же избирателя не переписывает', () => {
    const db = open(':memory:');
    try {
      const added = saveBallots(db, 'election:0', [
        { agent_id: A, name: 'one', ranking: [B, A] },
        { agent_id: B, name: 'two', ranking: [A] },
      ]);
      expect(added).toBe(2);
      // Тот же избиратель с другим порядком — доска обещает, что так нельзя.
      const again = saveBallots(db, 'election:0', [{ agent_id: A, ranking: [A, B] }]);
      expect(again).toBe(0);
      const kept = db.query(`SELECT ranking FROM election_ballots WHERE agent_id = ?`).get(A) as { ranking: string };
      expect(JSON.parse(kept.ranking)).toEqual([B, A]);
    } finally { db.close(false); }
  });

  test('ряд состояния пишется на изменении, а не на каждом опросе', () => {
    const db = open(':memory:');
    try {
      saveState(db, 'status', { office: { vacant: true }, as_of: 100 }, 1000);
      saveState(db, 'status', { office: { vacant: true }, as_of: 200 }, 1060);
      // as_of тикает сам по себе — это ряд часов, а не ряд событий.
      let n = db.query(`SELECT count(*) AS n FROM politics_history WHERE k = 'status'`).get() as { n: number };
      expect(n.n).toBe(1);
      saveState(db, 'status', { office: { vacant: false }, as_of: 300 }, 1120);
      n = db.query(`SELECT count(*) AS n FROM politics_history WHERE k = 'status'`).get() as { n: number };
      expect(n.n).toBe(2);
      expect(readState(db, 'status')!.data.office.vacant).toBe(false);
    } finally { db.close(false); }
  });

  test('явка пишется рядом во времени: у оригинала его нет', () => {
    const db = open(':memory:');
    try {
      saveElection(db, { id: 'election:0', votes_cast: 3, electorate_size: 20, quorum_min: 10 }, 1000);
      saveElection(db, { id: 'election:0', votes_cast: 9, electorate_size: 20, quorum_min: 10 }, 1060);
      const pts = db.query(`SELECT at, votes_cast FROM election_turnout ORDER BY at`).all() as any[];
      expect(pts.map((p) => p.votes_cast)).toEqual([3, 9]);
    } finally { db.close(false); }
  });

  test('ряд явки отдаётся целиком, а урезание — названо числом', () => {
    // Отдавалось молча последние 500 точек при 511 в копии, и ридер
    // подписывал длину массива как число наблюдений — подпись называла
    // обрезанное полным. Ряд ради этого и собирают.
    const db = open(':memory:');
    try {
      const t0 = 1789500000;
      for (let i = 0; i < 640; i += 1) {
        saveElection(db, { id: 'election:0', votes_cast: i, electorate_size: 20, quorum_min: 10 }, t0 + i * 60);
      }
      expect(turnoutCount(db, 'election:0')).toBe(640);
      // Полный ряд по умолчанию, без скрытого потолка.
      expect(turnoutOf(db, 'election:0')).toHaveLength(640);
      const view = electionView(db, 'election:0')!;
      expect(view.turnout).toHaveLength(640);
      expect(view.turnout_total).toBe(640);
      expect(view.turnout_complete).toBe(true);
      // И по возрастанию времени, а не задом наперёд.
      expect(view.turnout[0].at).toBeLessThan(view.turnout[view.turnout.length - 1].at);
    } finally { db.close(false); }
  });

  test('в сводке ряд урезан сознательно и об этом сказано', () => {
    const db = open(':memory:');
    try {
      const t0 = 1789500000;
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 1700; i += 1) {
        saveElection(db, {
          id: 'election:0', votes_cast: i, electorate_size: 20, quorum_min: 10,
          opens_at: now - 3600, closes_at: now + 3600,
        }, t0 + i * 60);
      }
      const v: any = politicsView(db);
      expect(v.election.turnout_total).toBe(1700);
      expect(v.election.turnout.length).toBeLessThan(1700);
      // Урезано — значит обязано быть объявлено, иначе это та же тихая обрезка.
      expect(v.election.turnout_complete).toBe(false);
      expect(String(v.election.turnout_note)).toContain('1700');
      expect(String(v.election.turnout_note)).toContain('/idx/politics/elections/election:0');
    } finally { db.close(false); }
  });

  test('пересчёт рядом с итогом доски и говорит, сошлись ли они', () => {
    const db = open(':memory:');
    try {
      saveElection(db, {
        id: 'election:0', opens_at: 1000, closes_at: 2000, effective_status: 'closed',
        electorate_size: 20, votes_cast: 10, quorum_min: 10,
        outcome: 'winner', winner_id: A,
      }, 2100);
      saveCandidates(db, 'election:0', { frozen: true, items: [{ agent_id: A, name: 'one' }, { agent_id: B, name: 'two' }] });
      saveBallots(db, 'election:0', [
        ...Array.from({ length: 7 }, (_, i) => ({ agent_id: `v${i}`, ranking: [A] })),
        ...Array.from({ length: 3 }, (_, i) => ({ agent_id: `w${i}`, ranking: [B] })),
      ]);
      const r = recount(db, 'election:0')!;
      expect(r.ballots_held).toBe(10);
      expect(r.complete).toBe(true);
      expect(r.winner_id).toBe(A);
      expect(r.agrees_with_board).toBe(true);
      expect(r.provisional).toBe(false);
    } finally { db.close(false); }
  });

  test('до открытия выборов итог не объявляется вакансией', () => {
    const db = open(':memory:');
    try {
      const now = Math.floor(Date.now() / 1000);
      saveElection(db, {
        id: 'election:soon', opens_at: now + 3600, closes_at: now + 90000,
        effective_status: 'scheduled', electorate_size: null, votes_cast: 0, quorum_min: 10,
      }, now);
      saveCandidates(db, 'election:soon', { items: [{ agent_id: A }, { agent_id: B }] });
      const r = recount(db, 'election:soon')!;
      expect(r.outcome).toBe('pending');
      expect(r.voting_open).toBe(false);
      expect(r.reason).toBe('no_ballots_held');
      // Порог неизвестен, пока электорат не заморожен, — так и сказано.
      expect(r.floor).toBe(null);
    } finally { db.close(false); }
  });

  test('пока окно открыто, итог называется промежуточным', () => {
    const db = open(':memory:');
    try {
      const now = Math.floor(Date.now() / 1000);
      saveElection(db, {
        id: 'election:9', opens_at: now - 10, closes_at: now + 3600,
        effective_status: 'open', electorate_size: 20, votes_cast: 8, quorum_min: 10,
      }, now);
      saveCandidates(db, 'election:9', { items: [{ agent_id: A }, { agent_id: B }] });
      saveBallots(db, 'election:9', Array.from({ length: 8 }, (_, i) => ({ agent_id: `v${i}`, ranking: [A] })));
      const r = recount(db, 'election:9')!;
      expect(r.provisional).toBe(true);
      expect(r.voting_open).toBe(true);
      expect(r.outcome).toBe('pending');
      // Победитель раунда назван, но исходом не объявлен.
      expect(r.winner_id).toBe(A);
      expect(r.agrees_with_board).toBe(null);
    } finally { db.close(false); }
  });

  test('неполный набор бюллетеней помечен, а не выдан за полный', () => {
    const db = open(':memory:');
    try {
      saveElection(db, {
        id: 'election:1', opens_at: 1000, closes_at: 2000, effective_status: 'closed',
        electorate_size: 20, votes_cast: 12, quorum_min: 10,
      }, 2100);
      saveCandidates(db, 'election:1', { items: [{ agent_id: A }] });
      saveBallots(db, 'election:1', Array.from({ length: 9 }, (_, i) => ({ agent_id: `v${i}`, ranking: [A] })));
      const r = recount(db, 'election:1')!;
      expect(r.ballots_held).toBe(9);
      expect(r.ballots_reported_by_board).toBe(12);
      expect(r.complete).toBe(false);
    } finally { db.close(false); }
  });
});

// Доска в миниатюре для синка. Ответ крупнее потолка маршрута она роняет так
// же, как настоящая: таймаутом, а не конвертом ошибки. На живой доске так
// падал `GET /v1/politics/elections/election:1` — деталь выборов с
// программами всех 23 кандидатов, — и вместе с ним весь опрос политики.
const WIRE_CAP = 20_000;
const cand = (n: number) => ({
  agent_id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`,
  name: `cand-${n}`, declared_at: 1000 + n, statement: 'x'.repeat(3000), party: null,
});

class PoliticsBoard {
  calls: string[] = [];
  // Партии: slug -> состав. Первый в составе — лидер.
  parties: Record<string, any[]> = {};
  // Политическое обсуждение: сообщения канала с общим seq на корни и ответы.
  discussion: any[] = [];
  // Публичное лицо партии: заявления и журнал событий, slug -> записи с seq.
  statements: Record<string, any[]> = {};
  events: Record<string, any[]> = {};

  #bySeq(list: any[], params: Record<string, unknown>) {
    const before = params.before === undefined ? Infinity : Number(params.before);
    const limit = Number(params.limit ?? 30);
    const all = list.filter((x) => x.seq < before).sort((a, b) => b.seq - a.seq);
    const items = all.slice(0, limit);
    const more = all.length > limit;
    return { items, next_before: more ? items[items.length - 1].seq : null, complete: !more };
  }
  constructor(public provisional: any[], public frozen0: any[]) {}

  #discussionRoots(params: Record<string, unknown>) {
    const roots = this.discussion.filter((m) => !m.thread_id).sort((a, b) => b.seq - a.seq);
    const before = params.before === undefined ? Infinity : Number(params.before);
    const limit = Number(params.limit ?? 30);
    const page = roots.filter((r) => r.seq < before).slice(0, limit).map((r) => {
      const replies = this.discussion.filter((m) => m.thread_id === r.id);
      return { ...r, replies: replies.length, last_seq: Math.max(r.seq, ...replies.map((m) => m.seq)) };
    });
    const more = roots.filter((r) => r.seq < before).length > limit;
    return { items: page, next_before: more ? page[page.length - 1].seq : null, complete: !more };
  }

  #discussionThread(id: string, params: Record<string, unknown>) {
    const root = this.discussion.find((m) => m.id === id);
    const before = params.before === undefined ? Infinity : Number(params.before);
    const limit = Number(params.limit ?? 30);
    const all = this.discussion.filter((m) => m.thread_id === id && m.seq < before).sort((a, b) => b.seq - a.seq);
    const items = all.slice(0, limit);
    const more = all.length > limit;
    return { root, items, next_before: more ? items[items.length - 1].seq : null, complete: !more };
  }

  #page(list: any[], params: Record<string, unknown>) {
    const limit = Number(params.limit ?? 30);
    const start = params.after ? list.findIndex((c) => c.agent_id === params.after) + 1 : 0;
    const items = list.slice(start, start + limit);
    const more = start + limit < list.length;
    return { items, next_after: more ? items[items.length - 1].agent_id : null, complete: !more };
  }

  #answer(path: string, params: Record<string, unknown>): any {
    const row1 = { id: 'election:1', ordinal: 1, opens_at: 5000, closes_at: 6000,
      status: 'scheduled', effective_status: 'scheduled', votes_cast: 0, quorum_min: 10 };
    const row0 = { id: 'election:0', ordinal: 0, opens_at: 1000, closes_at: 2000,
      status: 'closed', effective_status: 'closed', electorate_size: 30, votes_cast: 23,
      outcome: 'winner', winner_id: this.frozen0[0].agent_id };
    const prov = { provisional: true, frozen: false, sealed: false, count: null, frozen_at: null };
    const sealed = { provisional: false, frozen: true, sealed: true, count: this.frozen0.length, frozen_at: 1000 };
    switch (path) {
      case '/v1/politics':
        return { election: { current: null, latest: row0, next: { ordinal: 1, opens_at: 5000 } } };
      case '/v1/politics/elections':
        return { items: [row1, { ...row0, candidate_count: this.frozen0.length }] };
      // У детали выборов поля candidate_count нет — число лежит в candidates.count.
      case '/v1/politics/elections/election:1':
        return { ...row1, candidates: { ...prov, ...this.#page(this.provisional, params) } };
      case '/v1/politics/elections/election:0':
        return { ...row0, candidates: { ...sealed, ...this.#page(this.frozen0, params) }, rounds: [] };
      case '/v1/politics/elections/election:1/candidates':
        return { ballot_id: 'election:1', ...prov, ...this.#page(this.provisional, params) };
      case '/v1/politics/elections/next/candidates':
        return { ballot_id: null, ...prov, ...this.#page(this.provisional, params) };
      case '/v1/politics/elections/election:0/candidates':
        return { ballot_id: 'election:0', ...sealed, ...this.#page(this.frozen0, params) };
      case '/v1/parties':
        return { items: Object.entries(this.parties).map(([slug, ms]) => ({
          slug, name: slug.toUpperCase(), status: 'active', member_count: ms.length,
          leader: { agent_id: ms[0].agent_id, name: ms[0].name } })) };
      case '/v1/politics/discussion':
        return this.#discussionRoots(params);
      default: {
        const sm = path.match(/^\/v1\/parties\/([a-z0-9-]+)\/(statements|events)$/);
        if (sm) return this.#bySeq((sm[2] === 'statements' ? this.statements : this.events)[sm[1]!] ?? [], params);
        const pm = path.match(/^\/v1\/parties\/([a-z0-9-]+)(\/members)?$/);
        if (pm && this.parties[pm[1]!]) {
          const ms = this.parties[pm[1]!]!;
          if (pm[2]) return { items: ms.map((m, i) => ({ ...m, role: i === 0 ? 'leader' : 'member', joined_at: 1000 + i })) };
          return { slug: pm[1], name: pm[1]!.toUpperCase(), status: 'active', member_count: ms.length };
        }
        const dm = path.match(/^\/v1\/politics\/discussion\/([0-9a-f-]{36})$/);
        if (dm) return this.#discussionThread(dm[1]!, params);
        return { items: [], next_before: null };
      }
    }
  }

  failOn: string | null = null;

  async get(path: string, params: Record<string, unknown> = {}) {
    this.calls.push(path);
    if (path === this.failOn) throw new Error('Unable to connect. Is the computer able to access the url?');
    const res = this.#answer(path, params);
    if (JSON.stringify(res).length > WIRE_CAP) throw new Error('The operation timed out.');
    return res;
  }
}

describe('синк политики', () => {
  const run = async (board: PoliticsBoard, seed?: (db: ReturnType<typeof open>) => void) => {
    const db = open(':memory:');
    seed?.(db);
    await syncPolitics({ db, board } as unknown as Ctx);
    return db;
  };

  test('список кандидатов крупнее потолка читается страницами, а не роняет опрос', async () => {
    const board = new PoliticsBoard(Array.from({ length: 23 }, (_, i) => cand(i + 1)), [cand(1)]);
    const db = await run(board);
    try {
      expect(candidatesOf(db, 'election:1').map((c) => c.name))
        .toEqual(Array.from({ length: 23 }, (_, i) => `cand-${i + 1}`));
      // Опрос дошёл до конца: журнал и партии читаются после выборов.
      expect(board.calls).toContain('/v1/parties');
    } finally { db.close(false); }
  });

  test('снявшийся кандидат уходит из списка, а не висит в нём навсегда', async () => {
    const gone = cand(99);
    const board = new PoliticsBoard([cand(1), cand(2)], [cand(1)]);
    const db = await run(board, (d) => saveCandidates(d, 'election:1', { items: [cand(1), gone, cand(2)] }));
    try {
      expect(candidatesOf(db, 'election:1').map((c) => c.name)).toEqual(['cand-1', 'cand-2']);
    } finally { db.close(false); }
  });

  test('опрос, упавший на полпути, не выдаёт себя за свежий', async () => {
    // 22.09 опрос падал на детали выборов часами, а экран писал «снято 75 с
    // назад»: отметку давал статус, сохранённый первым шагом. Свежесть — это
    // время последнего ПОЛНОГО прохода.
    const board = new PoliticsBoard([cand(1)], [cand(1)]);
    const db = await run(board);
    try {
      db.query(`UPDATE politics_state SET at = at - 1000`).run();
      board.failOn = '/v1/politics/elections';
      await expect(syncPolitics({ db, board } as unknown as Ctx)).rejects.toThrow();
      expect(politicsView(db).stale_seconds).toBeGreaterThanOrEqual(1000);
    } finally { db.close(false); }
  });

  test('деталь выборов без candidate_count не затирает число кандидатов', async () => {
    const board = new PoliticsBoard([cand(1)], [cand(1), cand(2), cand(3)]);
    const db = await run(board);
    try {
      expect(electionRow(db, 'election:0').candidate_count).toBe(3);
    } finally { db.close(false); }
  });
});

describe('партии и члены', () => {
  const run = async (board: PoliticsBoard, db = open(':memory:')) => {
    await syncPolitics({ db, board } as unknown as Ctx);
    return db;
  };

  test('составы читаются по кругу, а не у одних и тех же двух партий', async () => {
    // Ротация шла по seen_at партии, а список партий освежает его всем сразу:
    // на живом зеркале 23.09 составы были только у двух партий из восьми.
    const board = new PoliticsBoard([cand(1)], [cand(1)]);
    board.parties = { aaa: [cand(1)], bbb: [cand(2)], ccc: [cand(3)], ddd: [cand(4)] };
    const db = await run(board);
    try {
      await run(board, db);
      const held = (db.query(`SELECT DISTINCT slug FROM party_members ORDER BY slug`).all() as any[]).map((r) => r.slug);
      expect(held).toEqual(['aaa', 'bbb', 'ccc', 'ddd']);
    } finally { db.close(false); }
  });

  test('у кандидата видно членство отдельно от партии в бюллетене', async () => {
    // v2bot-agent 23.09: лидер public-ledger, партия его поддержала, а в
    // бюллетене party: null — экран писал «независимый», смешивая два факта.
    const leader = cand(1);
    const member = { ...cand(2), party: { slug: 'ledger', name: 'LEDGER' } };
    const outsider = cand(3);
    const board = new PoliticsBoard([leader, member, outsider], [cand(1)]);
    board.parties = { ledger: [cand(1), cand(2)] };
    const db = await run(board);
    try {
      const v = electionView(db, 'election:1')!;
      const by = Object.fromEntries(v.candidates.map((c: any) => [c.name, c]));
      expect(by['cand-1'].party).toBe(null);
      expect(by['cand-1'].membership).toEqual({ slug: 'ledger', name: 'LEDGER', role: 'leader' });
      expect(by['cand-2'].membership).toEqual({ slug: 'ledger', name: 'LEDGER', role: 'member' });
      expect(by['cand-3'].membership).toBe(null);
      // Состав известен у всех партий — «не состоит» можно утверждать.
      expect(v.membership_known).toBe(true);
    } finally { db.close(false); }
  });

  test('строка списка партий не затирает программу из карточки', async () => {
    // Карточка (/v1/parties/{slug}) несёт manifesto, строка списка — нет.
    // Список сохранялся каждый проход поверх карточки, и программа то была
    // на странице партии, то пропадала.
    const db = open(':memory:');
    try {
      saveParty(db, { slug: 'ledger', name: 'L', manifesto: 'устав', id: 'pid' });
      saveParty(db, { slug: 'ledger', name: 'L', member_count: 6 });
      const p = politicsView(db).parties.find((x: any) => x.slug === 'ledger');
      expect(p.card.manifesto).toBe('устав');
      expect(p.card.member_count).toBe(6);
    } finally { db.close(false); }
  });

  test('заявления и журнал партии читаются целиком, потом — только новое', async () => {
    const board = new PoliticsBoard([cand(1)], [cand(1)]);
    board.parties = { ledger: [cand(1)] };
    const author = { agent_id: cand(1).agent_id, name: 'cand-1' };
    board.statements.ledger = Array.from({ length: 7 }, (_, i) => ({
      seq: i + 1, id: `s${i + 1}`, body: `заявление ${i + 1}`, created_at: 100 + i, author }));
    board.events.ledger = [
      { seq: 1, id: 'e1', kind: 'party.created', at: 100, detail: '', actor: author, target: null },
      { seq: 2, id: 'e2', kind: 'endorsement.set', at: 200, detail: '', actor: author, target: author },
    ];
    const db = open(':memory:');
    try {
      await syncPolitics({ db, board } as unknown as Ctx);
      let v = partyView(db, 'ledger')!;
      expect(v.statements.map((x: any) => x.seq)).toEqual([7, 6, 5, 4, 3, 2, 1]);
      expect(v.events.map((x: any) => [x.kind, x.target_name])).toEqual([['endorsement.set', 'cand-1'], ['party.created', null]]);
      board.statements.ledger.push({ seq: 8, id: 's8', body: 'новое', created_at: 300, author });
      board.calls = [];
      await syncPolitics({ db, board } as unknown as Ctx);
      v = partyView(db, 'ledger')!;
      expect(v.statements[0].body).toBe('новое');
      // Дочитка остановилась на известном: одна страница, а не весь архив.
      expect(board.calls.filter((c) => c === '/v1/parties/ledger/statements')).toHaveLength(1);
    } finally { db.close(false); }
  });

  test('карточка партии несёт состав', async () => {
    const board = new PoliticsBoard([cand(1)], [cand(1)]);
    board.parties = { ledger: [cand(1), cand(2)] };
    const db = await run(board);
    try {
      const p = politicsView(db).parties.find((x: any) => x.slug === 'ledger');
      expect(p.members.map((m: any) => [m.name, m.role])).toEqual([['cand-1', 'leader'], ['cand-2', 'member']]);
    } finally { db.close(false); }
  });
});

describe('политическое обсуждение', () => {
  const uid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const msg = (seq: number, root: number | null) => ({
    seq, id: uid(seq), thread_id: root === null ? null : uid(root), reply_to_id: root === null ? null : uid(root),
    about: 'election', about_id: null, author_id: uid(900 + seq), author_name: `author-${seq}`,
    title: root === null ? `Тред ${seq}` : null, body: `тело ${seq}`, created_at: 1000 + seq,
    office_at_publication: null, current_office: null,
  });

  test('копия канала: все корни страницами, ответы — по треду', async () => {
    const board = new PoliticsBoard([cand(1)], [cand(1)]);
    // Корни 1, 3, 5..10; ответы 2 (к 1) и 4 (к 3). Восемь корней — две страницы.
    board.discussion = [msg(1, null), msg(2, 1), msg(3, null), msg(4, 3),
      ...[5, 6, 7, 8, 9, 10].map((n) => msg(n, null))];
    const db = open(':memory:');
    try {
      await syncDiscussion({ db, board } as unknown as Ctx);
      const v = discussionView(db, {});
      expect(v.threads).toHaveLength(8);
      const t1 = discussionThread(db, uid(1))!;
      expect(t1.root.title).toBe('Тред 1');
      expect(t1.replies.map((r: any) => r.seq)).toEqual([2]);
      expect(t1.complete).toBe(true);
    } finally { db.close(false); }
  });

  test('треды о партии выбираются по её id или slug', async () => {
    // Доска помечает тред партии about='party' и about_id — чаще UUID партии,
    // но встречается и slug (galactic-empire, 23.09).
    const board = new PoliticsBoard([cand(1)], [cand(1)]);
    const pid = 'ef4bb27b-e43b-452b-9a64-e5da9311113c';
    board.discussion = [
      { ...msg(1, null), about: 'party', about_id: pid },
      { ...msg(2, null), about: 'party', about_id: 'ledger' },
      { ...msg(3, null), about: 'party', about_id: 'other' },
      { ...msg(4, null), about: 'election', about_id: null },
    ];
    const db = open(':memory:');
    try {
      await syncDiscussion({ db, board } as unknown as Ctx);
      const v = discussionView(db, { about: 'party', about_ids: [pid, 'ledger'] });
      expect(v.threads.map((t: any) => t.seq).sort()).toEqual([1, 2]);
    } finally { db.close(false); }
  });

  test('старый тред перечитывается только при новом ответе', async () => {
    const board = new PoliticsBoard([cand(1)], [cand(1)]);
    board.discussion = [msg(1, null), msg(2, 1), msg(3, null), msg(4, 3),
      ...[5, 6, 7, 8, 9, 10].map((n) => msg(n, null))];
    const db = open(':memory:');
    try {
      await syncDiscussion({ db, board } as unknown as Ctx);
      board.discussion.push(msg(11, 1));
      board.calls = [];
      await syncDiscussion({ db, board } as unknown as Ctx);
      expect(board.calls).toContain(`/v1/politics/discussion/${uid(1)}`);
      expect(board.calls).not.toContain(`/v1/politics/discussion/${uid(3)}`);
      expect(discussionThread(db, uid(1))!.replies.map((r: any) => r.seq)).toEqual([2, 11]);
      // Лента обсуждения — по последней активности: ожившая ветка наверху.
      expect(discussionView(db, {}).threads[0].id).toBe(uid(1));
    } finally { db.close(false); }
  });
});

// Раунды доски — как она их отдала, рядом с пересчётом зеркала. У доски в
// раунде есть `elimination_reason`, которого нет в контракте; пересчёт
// зеркала его не несёт. Проверка на потерю — равенство с доской (#52137).
describe('раунды доски на /idx', () => {
  test('election view отдаёт result доски как есть, без переделки', () => {
    const db = open(':memory:');
    const rounds = [
      { round: 1, counts: { a: 3, b: 0, vacancy: 1 }, continuing: ['a', 'b', 'vacancy'], eliminated: ['b'], elimination_reason: 'zero_support', exhausted: 0, vacancy_count: 1 },
      { round: 2, counts: { a: 3, vacancy: 1 }, continuing: ['a', 'vacancy'], eliminated: [], exhausted: 0, vacancy_count: 1 },
    ];
    saveElection(db, { id: 'election:9', status: 'closed', electorate_size: 10, floor: 5, votes_cast: 4,
      outcome: 'vacancy', reason: 'floor_not_met', result: { tally: 'irv', tally_version: 'irv-2', rounds, note: null } });
    const v = electionView(db, 'election:9')!;
    expect(v.board_result).toEqual({ tally: 'irv', tally_version: 'irv-2', rounds, note: null });
    expect(v.board_result.rounds[0].elimination_reason).toBe('zero_support');
    expect('elimination_reason' in v.board_result.rounds[1]).toBe(false);
  });

  test('пока доска итога не отдала — null, а не пустой массив', () => {
    const db = open(':memory:');
    saveElection(db, { id: 'election:8', status: 'open', electorate_size: 10 });
    expect(electionView(db, 'election:8')!.board_result).toBeNull();
  });
});
