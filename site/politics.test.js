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

// Мини-DOM: ровно столько, чтобы собрать дерево и прочитать с него атрибуты.
// Браузера здесь нет, и «посмотреть глазами» нечем — поэтому то, что можно
// утверждать без картинки, утверждается числом.
function node(tag) {
  return {
    tag, attrs: {}, styles: {}, className: '', children: [], text: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    handlers: {},
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    classList: {
      set: new Set(),
      toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
      has(c) { return this.set.has(c); },
    },
    append(...kids) {
      for (const k of kids.flat(Infinity)) {
        if (k === null || k === undefined || k === false) continue;
        if (typeof k === 'string' || typeof k === 'number') this.text += String(k);
        else this.children.push(k);
      }
    },
    get style() {
      const self = this;
      return { setProperty(prop, v) { self.styles[prop] = String(v); } };
    },
  };
}

const el = (tag, attrs = {}, ...kids) => {
  const n = node(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.styles, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids);
  return n;
};

function load() {
  const path = require.resolve('./politics.js');
  const context = {
    Intl, Math, Map, Set, Object, Array, String, Number, JSON, Date,
    setInterval: () => 0,
    clearInterval: () => {},
    document: { createElementNS: (_ns, tag) => node(tag) },
    requestAnimationFrame: () => 0,
    ResizeObserver: undefined,
    window: {
      AB: {
        el, errorNode: () => node('div'), idxApi: async () => ({}),
        timeNode: () => node('time'), bodyNode: () => node('div'),
        hashFor: () => '', app: node('main'), status: () => node('div'),
      },
    },
  };
  runInNewContext(readFileSync(path, 'utf8'), context, { filename: path });
  return context.window.ABPolitics.__test;
}

// Обход дерева: собрать все узлы с данным тегом или классом.
const walk = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; };
const byTag = (root, tag) => walk(root).filter((x) => x.tag === tag);
const byClass = (root, cls) => walk(root).filter((x) => (x.className || '').split(' ').includes(cls));

const { paletteFor, roundLayout, GEOM, NAMES_W, roundsChart, edgeState, wheelStep,
        voterBreakdown, heldByRound } = load();

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

describe('раскладка диаграммы не сжимается от числа раундов', () => {
  // Пока подписи опций жили внутри SVG, картинка растягивалась по ширине
  // колонки: на шести раундах естественная ширина ≈1300 px против доступных
  // 1040 — масштаб 0,78, а на телефоне 0,42, и текст в 11 px превращался в
  // пять. Проверяется механика починки, раз посмотреть глазами нечем.
  const mk = (nRounds, nOpts) => {
    const opts = Array.from({ length: nOpts }, (_, i) => `o${i}`);
    const counts = Object.fromEntries(opts.map((o, i) => [o, nOpts - i]));
    const rounds = Array.from({ length: nRounds }, (_, r) => ({
      round: r + 1, counts, continuing: 10, exhausted: 0, majority: 6,
      eliminated: [], transfers: {},
    }));
    return roundsChart({ rounds, floor: 5 }, (x) => x, () => 'red');
  };

  test('у SVG проставлены ширина и высота в пикселях, а не растяжение', () => {
    const fig = mk(6, 10);
    const [s] = byTag(fig, 'svg');
    assert.ok(s, 'svg не построен');
    assert.ok(/^\d+$/.test(s.attrs.width), `ширина должна быть в пикселях, получено ${s.attrs.width}`);
    assert.ok(/^\d+$/.test(s.attrs.height), `высота должна быть в пикселях, получено ${s.attrs.height}`);
    const L = roundLayout(Array.from({ length: 6 }, (_, r) => ({
      round: r + 1, counts: {}, majority: 6,
    })), 5, Array.from({ length: 10 }, (_, i) => `o${i}`), GEOM);
    assert.equal(Number(s.attrs.width), L.W);
    assert.equal(Number(s.attrs.height), L.H);
  });

  test('ширина растёт с числом раундов, а не ужимает строку', () => {
    const w = (n) => Number(byTag(mk(n, 6), 'svg')[0].attrs.width);
    assert.ok(w(6) > w(2), 'шесть раундов должны быть шире двух');
    // Высота от числа раундов не зависит — она от числа опций.
    const h = (n) => Number(byTag(mk(n, 6), 'svg')[0].attrs.height);
    assert.equal(h(2), h(6));
  });

  test('имена опций лежат вне прокрутки и совпадают по строкам с SVG', () => {
    const fig = mk(4, 7);
    const [names] = byClass(fig, 'rc-names');
    assert.ok(names, 'колонки имён нет');
    assert.equal(names.styles['padding-top'], `${GEOM.TOP}px`);
    assert.equal(names.styles.width, `${NAMES_W}px`);
    const rows = byClass(fig, 'rc-nrow');
    assert.equal(rows.length, 7, 'строк имён должно быть по числу опций');
    for (const r of rows) assert.equal(r.styles.height, `${GEOM.ROW}px`);
    // Имена не должны остаться внутри прокручиваемой области.
    const [scroll] = byClass(fig, 'chart-scroll');
    assert.equal(byClass(scroll, 'rc-nrow').length, 0);
  });
});

describe('горизонтальная прокрутка удобна мышью', () => {
  const box = (scrollLeft, scrollWidth = 1300, clientWidth = 700) =>
    ({ scrollLeft, scrollWidth, clientWidth });

  test('вертикальное колесо листает вбок', () => {
    const r = wheelStep({ ...box(0), deltaX: 0, deltaY: 120 });
    assert.equal(r.consume, true);
    assert.equal(r.dx, 120);
  });

  test('на краю событие отдаётся странице, а не съедается', () => {
    // Иначе страница замирает под курсором, стоит диаграмме упереться.
    const atEnd = wheelStep({ ...box(600), deltaX: 0, deltaY: 120 });
    assert.equal(atEnd.consume, false);
    const atStart = wheelStep({ ...box(0), deltaX: 0, deltaY: -120 });
    assert.equal(atStart.consume, false);
  });

  test('у края шаг обрезается по остатку, а не перелетает', () => {
    const r = wheelStep({ ...box(550), deltaX: 0, deltaY: 400 });
    assert.equal(r.consume, true);
    assert.equal(r.dx, 50);          // 1300 - 700 - 550
  });

  test('горизонтальный жест трекпада не перехватывается', () => {
    const r = wheelStep({ ...box(100), deltaX: -80, deltaY: 10 });
    assert.equal(r.consume, false);
  });

  test('когда всё помещается, колесо не трогаем вовсе', () => {
    const r = wheelStep({ scrollLeft: 0, scrollWidth: 600, clientWidth: 700, deltaX: 0, deltaY: 120 });
    assert.equal(r.consume, false);
  });

  test('края определяются для теней и кнопок', () => {
    assert.deepEqual(
      (({ overflowing, atStart, atEnd }) => ({ overflowing, atStart, atEnd }))(edgeState(box(0))),
      { overflowing: true, atStart: true, atEnd: false });
    assert.deepEqual(
      (({ atStart, atEnd }) => ({ atStart, atEnd }))(edgeState(box(600))),
      { atStart: false, atEnd: true });
    const fits = edgeState({ scrollLeft: 0, scrollWidth: 600, clientWidth: 700 });
    assert.equal(fits.overflowing, false);
    assert.equal(fits.atStart && fits.atEnd, true);   // кнопок и теней нет
  });

  test('кнопки и обработчики построены', () => {
    const opts = Array.from({ length: 6 }, (_, i) => `o${i}`);
    const counts = Object.fromEntries(opts.map((o, i) => [o, 6 - i]));
    const rounds = Array.from({ length: 6 }, (_, r) => ({
      round: r + 1, counts, continuing: 10, exhausted: 0, majority: 6, eliminated: [], transfers: {},
    }));
    const fig = roundsChart({ rounds, floor: 5 }, (x) => x, () => 'red');
    const navs = byClass(fig, 'rc-nav');
    assert.equal(navs.length, 2, 'должны быть обе кнопки');
    for (const b of navs) {
      assert.ok(b.attrs['aria-label'], 'кнопке нужна подпись для чтения с экрана');
      assert.ok((b.handlers.click || []).length, 'кнопка без обработчика бесполезна');
    }
    const [sc] = byClass(fig, 'chart-scroll');
    assert.ok((sc.handlers.wheel || []).length, 'колесо не подключено');
    assert.ok((sc.handlers.keydown || []).length, 'стрелки не подключены');
    assert.equal(sc.attrs.tabindex, '0', 'без фокуса стрелки недоступны');
  });
});

describe('кто за кого голосовал', () => {
  // Форма настоящих выборов election:0: 23 бюллетеня, шесть раундов, победил
  // mint. Проверяется, что «голосовал за» разложено на три разных факта, а
  // не слито в одно число.
  const B = (n, ...ranking) => Array.from({ length: n }, (_, i) => ({
    agent_id: `v${ranking[0]}${i}`, name: `v${ranking[0]}${i}`, ranking,
  }));
  const ballots = [
    ...B(6, 'mint'),
    ...B(3, 'glitch', 'mint'), ...B(3, 'herm', 'mint'), ...B(3, 'dao', 'glitch'),
    ...B(2, 'kolpaq', 'mint'), ...B(2, 'human', 'herm'), ...B(2, 'runrate', 'dao'),
    ...B(1, 'v2bot', 'mint'), ...B(1, 'vacancy'),
  ];
  const rounds = [
    { round: 1, eliminated: ['zenith'] },
    { round: 2, eliminated: ['v2bot', 'vacancy'] },
    { round: 3, eliminated: ['kolpaq', 'human', 'runrate'] },
    { round: 4, eliminated: ['herm'] },
    { round: 5, eliminated: ['dao'] },
    { round: 6, eliminated: [] },
  ];

  test('первые предпочтения считаются отдельно от переносов', () => {
    const v = voterBreakdown(ballots, rounds, 'mint');
    assert.equal(v.first.length, 6, 'шесть поставили mint первым');
    const gained = v.gained.reduce((n, g) => n + g.voters.length, 0);
    assert.equal(v.first.length + gained, v.finalCount,
      'первые плюс перешедшие должны дать счёт последнего раунда');
    assert.equal(v.finalCount, 12);
  });

  test('переносы названы по раунду и по донору', () => {
    const v = voterBreakdown(ballots, rounds, 'mint');
    const r2 = v.gained.find((g) => g.round === 2 && g.from === 'v2bot');
    assert.ok(r2, 'перенос от v2bot во втором раунде не найден');
    assert.equal(r2.voters.length, 1);
    const r3 = v.gained.find((g) => g.round === 3 && g.from === 'kolpaq');
    assert.equal(r3.voters.length, 2);
  });

  test('уход голосов после вылета разделён по адресатам', () => {
    // herm вылетает в 4-м раунде. Три его собственных бюллетеня идут к mint
    // (он у них вторым), а двое пришедших от human имеют порядок
    // ['human','herm'] — после herm там ничего нет, они исчерпываются.
    // Свалить всё в одно число значило бы сказать, что пятеро перешли к mint.
    const v = voterBreakdown(ballots, rounds, 'herm');
    const out = v.lost.filter((l) => l.round === 4);
    assert.equal(out.length, 2, 'должно быть два адресата: mint и исчерпание');
    const toMint = out.find((l) => l.to === 'mint');
    const gone = out.find((l) => l.to === '__exhausted__');
    assert.equal(toMint.voters.length, 3);
    assert.equal(gone.voters.length, 2);
  });

  test('исчерпанный бюллетень назван исчерпанным, а не отданным кому-то', () => {
    const v = voterBreakdown(ballots, rounds, 'vacancy');
    const out = v.lost.find((l) => l.round === 2);
    assert.ok(out, 'vacancy вылетает во 2-м раунде');
    assert.equal(out.to, '__exhausted__');
    assert.equal(out.voters.length, 1);
  });

  test('упомянутые ниже в порядке не выдаются за проголосовавших', () => {
    const v = voterBreakdown(ballots, rounds, 'mint');
    const ids = new Set([...v.first, ...v.gained.flatMap((g) => g.voters)].map((b) => b.agent_id));
    for (const m of v.mentioned) {
      assert.ok(!ids.has(m.agent_id), 'один избиратель не может быть и там, и там');
      assert.ok(m.rank > 1, 'у упомянутого место в порядке ниже первого');
    }
  });

  test('держатель бюллетеня считается тем же правилом, что и подсчёт', () => {
    const held = heldByRound(ballots, rounds);
    assert.equal(held.length, rounds.length);
    // В первом раунде держатель — первая опция порядка.
    assert.equal(held[0][0], 'mint');
    // После вылета v2bot его бюллетень переходит ко второму предпочтению.
    const idx = ballots.findIndex((b) => b.ranking[0] === 'v2bot');
    assert.equal(held[1][idx], 'v2bot', 'во втором раунде он ещё считается за v2bot');
    assert.equal(held[2][idx], 'mint', 'в третьем — уже за mint');
  });
});
