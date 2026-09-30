'use strict';
// Просмотрщик хилла без страницы: разбор ячеек как у `cw list`, таблица и
// прогноз как в cw (hill.rs), и проигрыватель раунда против самого движка —
// cw.wasm из site/corewar, тот же файл, что грузит страница.

const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./hill-core.js');
const { instantiate } = require('./hill-engine.js');

const RULES = { core_size: 8000, cycles: 80000, processes: 8000, length: 100, distance: 100 };
const word = (op, mod, am, bm) => op | (mod << 5) | (am << 8) | (bm << 11);

describe('разбор ячеек', () => {
  test('как `cw list`: модификатор, режимы, числа со знаком', () => {
    const ix = (s) => H.MODES.indexOf(s);
    assert.equal(H.disasm(word(15, 6, ix('*'), ix('@')), 7997, 7997, 8000), 'SNE.I *-3, @-3');
    assert.equal(H.disasm(word(0, 4, ix('#'), ix('#')), 172, 61, 8000), 'DAT.F #172, #61');
    assert.equal(H.disasm(word(1, 3, ix('}'), ix('>')), 4000, 4001, 8000), 'MOV.BA }4000, >-3999');
    assert.equal(H.disasm(word(18, 2, ix('{'), ix('<')), 0, 1, 8000), 'STP.AB {0, <1');
  });
});

const doc = {
  rules: { size: 3, rounds: 10, tie_break: 'older', points: { win: 3, tie: 1, loss: 0 } },
  next: 4,
  members: [
    { id: 'a', name: 'A', author: 'x', arrived: 1, age: 2 },
    { id: 'b', name: 'B', author: 'y', arrived: 2, age: 1 },
    { id: 'c', name: 'C', author: 'z', arrived: 3, age: 0 },
  ],
  results: {
    'a:b': { w1: 6, w2: 2, ties: 2 },
    'a:c': { w1: 5, w2: 5, ties: 0 },
    'b:c': { w1: 4, w2: 4, ties: 2 },
  },
};

describe('таблица хилла', () => {
  test('очки по всем парам, со стороны каждого', () => {
    const t = H.table(doc);
    assert.deepEqual(t.map((r) => [r.id, r.score, r.wins, r.ties, r.losses]),
      [['a', 35, 11, 2, 7], ['b', 22, 6, 4, 10], ['c', 29, 9, 2, 9]]);
  });

  test('новичок пересчитывает всех; при равенстве выше старший; лишний выбывает', () => {
    // Против a — 10:0, против b и c — вничью: 30 + 10 + 10 = 50, первое место.
    const p = H.predict(doc, { id: 'n', name: 'N', author: 'me' },
      { a: { w: 10, t: 0, l: 0 }, b: { w: 0, t: 10, l: 0 }, c: { w: 0, t: 10, l: 0 } });
    assert.equal(p.place, 1);
    assert.equal(p.entered, true);
    assert.deepEqual(p.pushed.map((r) => r.id), ['b']);
    // Как cw (hill.rs, challenge): место — по очкам со всеми, потом лишние
    // выбывают, и оставшиеся пересчитываются без их матчей: у c пропадают
    // очки за b. Выбывший — в конце, со счётом на момент выбывания.
    assert.deepEqual(p.rows.map((r) => [r.id, r.score, r.out]),
      [['n', 40, false], ['c', 25, false], ['a', 15, false], ['b', 32, true]]);

    // Ровно столько же, сколько у a: новичок младше и уступает.
    const q = H.predict(doc, { id: 'n', name: 'N', author: 'me' },
      { a: { w: 5, t: 0, l: 5 }, b: { w: 5, t: 0, l: 5 }, c: { w: 3, t: 5, l: 2 } });
    const order = q.rows.map((r) => r.id);
    assert.ok(order.indexOf('a') < order.indexOf('n'), order.join());
  });

  test('на одной машине несколько сезонов: карточка ведёт в последний', () => {
    const index = { seasons: [{ season: 1, computer: 'c-1', machine_seq: 55500 }, { season: 2, computer: 'c-1', machine_seq: 55500 },
      { season: 3, computer: 'c-9', machine_seq: 90000 }] };
    assert.equal(H.seasonFor(index, 'c-1').season, 2);
    assert.deepEqual(H.seasonsFor(index, '55500').map((s) => s.season), [2, 1]);
  });

  test('сезон находится по id машины и по номеру её поста', () => {
    const index = { seasons: [{ season: 1, computer: 'c-1', machine_seq: 55500 }, { season: 2, computer: 'c-2', machine_seq: 70000 }] };
    assert.equal(H.seasonFor(index, 'c-2').season, 2);
    assert.equal(H.seasonFor(index, '55500').season, 1);
    assert.equal(H.seasonFor(index, 'nope'), null);
  });
});

const DWARF = ';redcode-94\n;name Dwarf\n;author A. K. Dewdney\n        ADD.AB  #4, bomb\n        MOV.AB  #0, @bomb\n        JMP     -2\nbomb    DAT     #0, #0\n        end\n';
const PAPER = ';redcode-94\n;name paper\n;author t\n       SPL    1\n       SPL    1\n       SPL    1\nloop   MOV.I  <-10, {20\n       ADD.AB #37, loop\n       JMP    loop\n';
const SWITCH = ';redcode-94\n;name switch\n;author t\nstart  LDP.AB #0, sel\n       JMZ.B  imp, sel\ndwarf  ADD.AB #4, bomb\n       MOV.I  bomb, @bomb\n       JMP    dwarf\nbomb   DAT    #0, #0\nimp    MOV.I  0, 1\nsel    DAT    #0, #0\n';

async function engine() {
  return instantiate(readFileSync(path.join(__dirname, 'corewar', 'cw.wasm')));
}

function roundOf(cw, a, b, seed, n) {
  const r = cw.record(seed, n);
  return {
    r,
    round: new H.Round({
      cs: RULES.core_size, maxProcesses: RULES.processes, core: r.core, events: r.events,
      warriors: [{ pos: 0, length: a.code.length / 3, start: a.start },
        { pos: r.meta.position, length: b.code.length / 3, start: b.start }],
    }),
  };
}

describe('проигрыватель против движка', () => {
  test('события раунда приводят к ядру и процессам, с которыми раунд кончился', async () => {
    const cw = await engine();
    cw.params(RULES, 20);
    for (const [sa, sb, seed] of [[DWARF, PAPER, 9], [SWITCH, DWARF, 1234], [PAPER, SWITCH, 55]]) {
      const a = cw.assemble(0, sa);
      const b = cw.assemble(1, sb);
      const played = cw.play(20, seed);
      for (const n of [1, 2, 7]) {
        const { r, round } = roundOf(cw, a, b, seed, n);
        assert.equal(round.total, r.meta.steps);
        round.seek(round.total);
        assert.deepEqual(Array.from(round.core), Array.from(r.end), `раунд ${n}: ядро`);
        assert.deepEqual([round.processes(0), round.processes(1)], r.meta.processes);
        assert.equal(round.cycle(), r.meta.end_cycle);
        const row = played.rounds[n - 1];
        assert.equal(row[2], r.meta.winner === null ? -1 : r.meta.winner);
      }
    }
  });

  test('перемотка назад даёт то же, что проход вперёд', async () => {
    const cw = await engine();
    cw.params(RULES, 5);
    const a = cw.assemble(0, PAPER);
    const b = cw.assemble(1, DWARF);
    const { round } = roundOf(cw, a, b, 77, 1);
    const mid = Math.floor(round.total / 3);
    round.seek(mid);
    const snap = [Array.from(round.core), round.queue(0), round.queue(1), Array.from(round.owner), round.territory.slice()];
    round.seek(round.total);
    round.seek(mid);
    assert.deepEqual([Array.from(round.core), round.queue(0), round.queue(1), Array.from(round.owner), round.territory.slice()], snap);
    assert.equal(round.head(0), round.queue(0)[0]);
  });

  test('разбор раунда называет того, кто погиб, и чем', async () => {
    const cw = await engine();
    cw.params(RULES, 10);
    const a = cw.assemble(0, DWARF);
    const b = cw.assemble(1, PAPER);
    const played = cw.play(10, 3);
    const n = played.rounds.findIndex((x) => x[2] >= 0) + 1;
    assert.ok(n > 0, 'в десяти раундах есть победа');
    const { r, round } = roundOf(cw, a, b, 3, n);
    const info = H.analyze(round);
    assert.equal(info.death.w, 1 - r.meta.winner);
    assert.equal(round.step, round.total);
    assert.equal(info.series.steps[info.series.steps.length - 1], round.total);
    const total = round.territory[0] + round.territory[1];
    assert.ok(total > 0 && total <= RULES.core_size);
  });

  test('P-space: второй раунд переключателя помнит первый', async () => {
    const cw = await engine();
    cw.params(RULES, 4);
    cw.assemble(0, SWITCH);
    cw.assemble(1, DWARF);
    const played = cw.play(4, 11);
    const r2 = cw.record(11, 2).meta;
    const want = { '-1': 2, 0: 1, 1: 0 }[played.rounds[0][2]];
    assert.equal(r2.pspace[0][0], want);
  });
});

describe('раскладка матчей хилла', () => {
  const doc = {
    rules: { placement: 'random' },
    seeds: { '23dc0b1281db3987:4d04bef5eff35452': 4581, '4d04bef5eff35452:b00630878a95f194': 681 },
  };

  test('матч хилла играется с посевом, записанным при нём, в любом порядке id', () => {
    assert.equal(H.hillSeed(doc, '23dc0b1281db3987', '4d04bef5eff35452'), 4581);
    assert.equal(H.hillSeed(doc, 'b00630878a95f194', '4d04bef5eff35452'), 681);
  });

  test('на хилле на хешах посева при матче нет: движок выводит его из id', () => {
    assert.equal(H.hillSeed({ rules: {} }, 'a', 'b'), null);
    assert.equal(H.hillSeed(doc, 'a', 'b'), null);
    assert.equal(H.randomPlacement({ rules: {} }), false);
    assert.equal(H.randomPlacement(doc), true);
  });

  test('посев из числа вызова — как у cw: sha256(«число:A:B»), 8 байт, по модулю позиций', async () => {
    // Число и посевы — из вызова `cw hill challenge` на хилле второго сезона
    // (ядро 8192, дистанция 128: позиций 8193 − 256).
    const draw = '9359844588196023976';
    assert.equal(await H.drawnSeed(draw, '23dc0b1281db3987', '4d04bef5eff35452', 7937), 4581);
    assert.equal(await H.drawnSeed(draw, '23dc0b1281db3987', 'b00630878a95f194', 7937), 4468);
    assert.equal(await H.drawnSeed(draw, '4d04bef5eff35452', 'b00630878a95f194', 7937), 681);
  });
});
