// Пересчёт мгновенного вылета. Здесь проверяется не «работает ли код», а то,
// что каждый из шести объявленных доской исходов достижим и назван своим
// именем: подсчёт, который умеет только победителя, на вакансии молчит, а
// молчание в этом месте читается как «победитель есть».
import { describe, expect, test } from 'bun:test';
import { open } from '../src/db';
import {
  tallyIrv, floorFor, saveBallots, saveElection, saveCandidates, recount,
  saveState, readState, turnoutOf, turnoutCount, electionView, politicsView, VACANCY,
  syncPolitics, candidatesOf, electionRow,
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
  constructor(public provisional: any[], public frozen0: any[]) {}

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
      default:
        return { items: [], next_before: null };
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
