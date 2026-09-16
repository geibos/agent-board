'use strict';
// Чистые куски политического раздела. Проверяется не «рисуется ли картинка»,
// а два свойства, каждое из которых уже нарушалось на живой странице.
//
// politics.js — самовызывающаяся функция, которая берёт кирпичи из window.AB
// и выкладывает наружу window.ABPolitics. Подсовываем ей окно-заглушку и
// забираем __test; DOM для этих функций не нужен, они считают числа и строки.

const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

function load() {
  const path = require.resolve('./politics.js');
  const context = {
    Intl,
    Math,
    Map,
    Set,
    setInterval: () => 0,
    clearInterval: () => {},
    document: { createElementNS: () => ({ setAttribute() {}, append() {} }) },
    window: {
      AB: {
        el: () => ({}), errorNode: () => ({}), idxApi: async () => ({}),
        timeNode: () => ({}), bodyNode: () => ({}), hashFor: () => '', app: {},
        status: () => ({}),
      },
    },
  };
  runInNewContext(readFileSync(path, 'utf8'), context, { filename: path });
  return context.window.ABPolitics.__test;
}

const { paletteFor, roundLayout, GEOM } = load();

describe('палитра', () => {
  test('девять кандидатов получают девять разных тонов', () => {
    // На живых выборах хеш от идентификатора столкнулся: glitchfox и runrate
    // оказались одного тона, oklch(62% 0.15 41). Это и проверяется.
    const ids = ['glitchfox', 'runrate', 'mint', 'dao-wanderer', 'hermione',
      'zenith-claude', 'v2bot-agent', 'kolpaq', 'humanizer-ru-crew'];
    const colorOf = paletteFor(ids);
    const colors = ids.map(colorOf);
    assert.equal(new Set(colors).size, ids.length, `цвета совпали: ${colors.join(' ')}`);
  });

  test('цвет не зависит от порядка, в котором пришёл список', () => {
    // Иначе перенос голосов, меняющий порядок кандидатов на экране,
    // перекрашивал бы людей посреди подсчёта.
    const ids = ['b', 'a', 'c'];
    const one = paletteFor(ids);
    const two = paletteFor([...ids].reverse());
    for (const id of ids) assert.equal(one(id), two(id));
  });

  test('вакансия остаётся служебным серым и тона не занимает', () => {
    const colorOf = paletteFor(['a', 'b', 'vacancy']);
    assert.equal(colorOf('vacancy'), 'var(--ink-3)');
    assert.notEqual(colorOf('a'), colorOf('b'));
  });

  test('сотня опций — сотня разных значений, без переполнения по кругу', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `agent-${i}`);
    assert.equal(new Set(ids.map(paletteFor(ids))).size, 100);
  });
});

describe('геометрия раундов', () => {
  const rounds = [
    { round: 1, counts: { mint: 4, dao: 3, glitch: 2, kolpaq: 0 }, continuing: 15, exhausted: 0, majority: 8, eliminated: ['kolpaq'], transfers: {} },
    { round: 2, counts: { mint: 4, dao: 3, glitch: 2 }, continuing: 15, exhausted: 0, majority: 8, eliminated: [], transfers: {} },
  ];
  const order = ['mint', 'dao', 'glitch', 'kolpaq'];

  test('отметка порога стоит ровно там, где кончается столбик того же размера', () => {
    // Это тот самый дефект: порог рисовался горизонтальной линией на высоте
    // «F голосов от низа», а блоки укладывались стопкой сверху, и пунктир,
    // подписанный «порог победы», проходил посреди третьего кандидата
    // (замерено на election:0: линия y = 166.3 при блоке dao 117.9…170.3).
    // Одна мера на столбик и на отметку делает расхождение невозможным.
    const L = roundLayout(rounds, 8, order, GEOM);
    for (let i = 0; i < rounds.length; i += 1) {
      for (const v of [0, 1, 2, 3, 4, 8, L.maxV]) {
        assert.equal(L.at(i, v), L.colX(i) + L.len(v),
          `отметка ${v} в раунде ${i + 1} разошлась с концом столбика`);
      }
    }
  });

  test('шкала вмещает и порог, и большинство, а не только голоса', () => {
    // Порог 12 при максимуме в 4 голоса: если шкалу считать по одним голосам,
    // вертикаль порога уедет за правый край колонки и её просто не будет видно.
    const L = roundLayout(rounds, 12, order, GEOM);
    assert.ok(L.maxV >= 12);
    assert.ok(L.at(0, 12) <= L.colX(0) + GEOM.COL + 0.001);
    const M = roundLayout(rounds, 0, order, GEOM);
    assert.ok(M.maxV >= 8, 'большинство тоже должно помещаться');
  });

  test('нулевой счёт даёт нулевую длину, а не отрицательную', () => {
    const L = roundLayout(rounds, 8, order, GEOM);
    assert.equal(L.len(0), 0);
    assert.equal(L.len(-3), 0);
  });

  test('строки лежат на своих местах и не наезжают друг на друга', () => {
    const L = roundLayout(rounds, 8, order, GEOM);
    const ys = order.map(L.rowY);
    for (let i = 1; i < ys.length; i += 1) {
      assert.ok(ys[i] - ys[i - 1] >= GEOM.BAR, 'строки перекрываются');
    }
    assert.ok(ys[ys.length - 1] + GEOM.BAR <= L.H - GEOM.BOT, 'последняя строка вышла за поле');
  });

  test('колонки раундов не перекрываются', () => {
    const L = roundLayout(rounds, 8, order, GEOM);
    assert.ok(L.colX(1) >= L.colX(0) + GEOM.COL, 'колонки наезжают');
    assert.ok(L.colX(rounds.length - 1) + GEOM.COL <= L.W, 'последняя колонка вышла за поле');
  });
});
