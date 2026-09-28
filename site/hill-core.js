'use strict';
// Core War для просмотрщика хилла — то, что не касается страницы: разбор
// ячеек движка cw, таблица хилла по его результатам, прогноз для нового
// бойца и проигрыватель записанного раунда. Без DOM: те же функции
// проверяются в node (hill-core.test.js).
//
// Формат ячейки и события — board-corewar, wasm/src/lib.rs: ячейка — три
// слова (op | модификатор << 5 | режим A << 8 | режим B << 11, число A,
// число B); событие — одна инструкция: слово w | pushed << 1 | written << 3,
// исполненная ячейка (голова очереди бойца w), pushed ячеек, добавленных в
// конец его очереди, и по четыре слова на каждую записанную ячейку (адрес и
// её три слова после инструкции).
(function (root) {
  const OPS = ['DAT', 'MOV', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'JMP', 'JMZ', 'JMN', 'DJN', 'SPL', 'SLT', 'CMP',
    'SEQ', 'SNE', 'NOP', 'LDP', 'STP'];
  const MODS = ['A', 'B', 'AB', 'BA', 'F', 'X', 'I'];
  const MODES = '#$*@{<}>';
  const DAT = 0;

  // Как redcode::signed у cw: числа больше половины ядра печатаются
  // отрицательным смещением.
  const signed = (v, cs) => (v > Math.floor(cs / 2) ? v - cs : v);
  const opOf = (w0) => w0 & 31;

  function disasm(w0, a, b, cs) {
    return `${OPS[w0 & 31]}.${MODS[(w0 >> 5) & 7]} ${MODES[(w0 >> 8) & 7]}${signed(a, cs)}, ` +
      `${MODES[(w0 >> 11) & 7]}${signed(b, cs)}`;
  }

  // Код бойца из вывода cw_assemble: по строке на инструкцию, как `cw list`.
  function listing(code, cs) {
    const out = [];
    for (let i = 0; i + 2 < code.length; i += 3) out.push(disasm(code[i], code[i + 1], code[i + 2], cs));
    return out;
  }

  // ---------- хилл ----------

  const pairKey = (x, y) => (x < y ? `${x}:${y}` : `${y}:${x}`);

  // Итог матча x против y с точки зрения x, или null, если его нет.
  function versus(results, x, y) {
    const r = results[pairKey(x, y)];
    if (!r) return null;
    return x < y ? { w: r.w1, t: r.ties, l: r.w2 } : { w: r.w2, t: r.ties, l: r.w1 };
  }

  const pointsOf = (p, r) => p.win * r.w + p.tie * r.t + p.loss * r.l;

  // Очки участников `ms` друг против друга, как считает cw (hill.rs,
  // records): по всем их парам, за раунд — очки правил. Порядок — как в ms.
  function scored(ms, results, p) {
    return ms.map((m) => {
      const row = { id: m.id, name: m.name, author: m.author, arrived: m.arrived, age: m.age,
        score: 0, wins: 0, ties: 0, losses: 0 };
      for (const o of ms) {
        if (o.id === m.id) continue;
        const r = versus(results, m.id, o.id);
        if (!r) continue;
        row.wins += r.w; row.ties += r.t; row.losses += r.l;
        row.score += pointsOf(p, r);
      }
      return row;
    });
  }

  // Порядок cw (hill.rs, ranked): очки, при равенстве — стаж по tie_break.
  function ranked(rows, tieBreak) {
    const newer = tieBreak === 'newer';
    return rows.slice().sort((x, y) => (y.score - x.score) || (newer ? y.arrived - x.arrived : x.arrived - y.arrived));
  }

  // Таблица в порядке state.json.
  function table(doc) {
    return scored(doc.members, doc.results, doc.rules.points).map((r, i) => ({ ...r, place: i + 1 }));
  }

  // Что было бы с хиллом, если бы пришёл `newcomer` ({id, name, author}) с
  // результатами `vs` (id соперника → {w, t, l} со стороны новичка). Как cw
  // (hill.rs, challenge): новичок встаёт в ряд, все ранжируются по очкам со
  // всеми — отсюда его место; лишние сверх size выбывают; оставшиеся
  // ранжируются снова, уже без матчей с выбывшими. Выбывшие — в конце rows,
  // со счётом на момент выбывания.
  function predict(doc, newcomer, vs) {
    const p = doc.rules.points;
    const results = { ...doc.results };
    for (const [id, m] of Object.entries(vs)) {
      results[pairKey(newcomer.id, id)] = newcomer.id < id ? { w1: m.w, w2: m.l, ties: m.t } : { w1: m.l, w2: m.w, ties: m.t };
    }
    const all = doc.members.concat([{ id: newcomer.id, name: newcomer.name, author: newcomer.author, arrived: doc.next, age: 0 }]);
    const first = ranked(scored(all, results, p), doc.rules.tie_break);
    const size = doc.rules.size || 0;
    const kept = size > 0 ? first.slice(0, size) : first;
    const gone = size > 0 ? first.slice(size) : [];
    const keptIds = new Set(kept.map((r) => r.id));
    const second = ranked(scored(all.filter((m) => keptIds.has(m.id)), results, p), doc.rules.tie_break);
    const rows = second.map((r, i) => ({ ...r, place: i + 1, out: false }))
      .concat(gone.map((r) => ({ ...r, place: null, out: true })));
    rows.forEach((r) => { r.newcomer = r.id === newcomer.id; });
    const place = first.findIndex((r) => r.id === newcomer.id) + 1;
    return { rows, place, entered: keptIds.has(newcomer.id), pushed: rows.filter((r) => r.out && !r.newcomer) };
  }

  // Сезоны машины (id поста или её номер), последний первым: новый сезон
  // может идти на той же машине, что и прошлый.
  function seasonsFor(index, idOrSeq) {
    const list = (index && Array.isArray(index.seasons)) ? index.seasons : [];
    return list.filter((s) => s.computer === idOrSeq || String(s.machine_seq) === String(idOrSeq))
      .sort((x, y) => y.season - x.season);
  }
  const seasonFor = (index, idOrSeq) => seasonsFor(index, idOrSeq)[0] || null;

  // ---------- проигрыватель раунда ----------

  // Состояние ядра и очередей после любого числа инструкций записанного
  // раунда. Назад — заново с начала: раунд — не больше 2·cycles событий, и
  // проход по ним занимает миллисекунды.
  class Round {
    // o: {cs, maxProcesses, core (Uint32Array 3·cs, как загружено), events,
    //     warriors: [{pos, length, start}, {pos, length, start}]}
    constructor(o) {
      this.cs = o.cs;
      this.max = o.maxProcesses;
      this.init = o.core;
      this.events = o.events;
      this.warriors = o.warriors;
      const off = [];
      for (let i = 0; i < o.events.length;) {
        off.push(i);
        const h = o.events[i];
        i += 2 + ((h >>> 1) & 3) + 4 * (h >>> 3);
      }
      off.push(o.events.length);
      this.off = Uint32Array.from(off);
      this.total = off.length - 1;
      this.core = new Uint32Array(this.init.length);
      this.owner = new Int8Array(this.cs);
      this.wrote = new Int32Array(this.cs);
      this.wroteBy = new Int8Array(this.cs);
      this.ran = new Int32Array(this.cs);
      this.ranBy = new Int8Array(this.cs);
      this.q = [new Int32Array(this.max), new Int32Array(this.max)];
      this.reset();
    }

    reset() {
      this.core.set(this.init);
      this.owner.fill(-1);
      this.wrote.fill(0);
      this.wroteBy.fill(-1);
      this.ran.fill(0);
      this.ranBy.fill(-1);
      this.qh = [0, 0];
      this.ql = [0, 0];
      this.territory = [0, 0];
      this.warriors.forEach((w, k) => {
        for (let i = 0; i < w.length; i++) this.own((w.pos + i) % this.cs, k);
        this.q[k][0] = (w.pos + w.start) % this.cs;
        this.ql[k] = 1;
      });
      this.step = 0;
      this.last = null;
    }

    own(c, w) {
      const was = this.owner[c];
      if (was === w) return;
      if (was >= 0) this.territory[was]--;
      this.owner[c] = w;
      this.territory[w]++;
    }

    // Следующая инструкция: кто, какую ячейку исполнил, что записал.
    apply() {
      const e = this.events;
      let i = this.off[this.step];
      const h = e[i];
      const w = h & 1;
      const pushed = (h >>> 1) & 3;
      const written = h >>> 3;
      const pc = e[i + 1];
      const q = this.q[w];
      this.qh[w] = (this.qh[w] + 1) % this.max;
      this.ql[w]--;
      for (let k = 0; k < pushed; k++) {
        q[(this.qh[w] + this.ql[w]) % this.max] = e[i + 2 + k];
        this.ql[w]++;
      }
      this.step++;
      this.ran[pc] = this.step;
      this.ranBy[pc] = w;
      i += 2 + pushed;
      for (let k = 0; k < written; k++, i += 4) {
        const c = e[i];
        this.core[3 * c] = e[i + 1];
        this.core[3 * c + 1] = e[i + 2];
        this.core[3 * c + 2] = e[i + 3];
        this.own(c, w);
        this.wrote[c] = this.step;
        this.wroteBy[c] = w;
      }
      this.last = { w, pc, written };
    }

    seek(target) {
      const t = Math.max(0, Math.min(this.total, target));
      if (t < this.step) this.reset();
      while (this.step < t) this.apply();
    }

    processes(w) { return this.ql[w]; }
    // Ячейка, которую боец исполнит следующей, или -1.
    head(w) { return this.ql[w] ? this.q[w][this.qh[w]] : -1; }
    // Все процессы бойца по порядку очереди.
    queue(w, limit = Infinity) {
      const out = [];
      const n = Math.min(this.ql[w], limit);
      for (let k = 0; k < n; k++) out.push(this.q[w][(this.qh[w] + k) % this.max]);
      return out;
    }
    cell(c) { return [this.core[3 * c], this.core[3 * c + 1], this.core[3 * c + 2]]; }
    text(c) { return disasm(this.core[3 * c], this.core[3 * c + 1], this.core[3 * c + 2], this.cs); }
    cycle(step = this.step) { return Math.ceil(step / 2); }
  }

  // Один проход по всему раунду: графики для шкалы времени (процессы и
  // территория по корзинам), первое попадание каждого бойца в чужой код и
  // причина конца — какую ячейку исполнил последний процесс проигравшего, что
  // в ней было и кто её туда записал.
  function analyze(round, buckets = 600) {
    const n = Math.max(1, Math.min(buckets, round.total));
    const series = { steps: new Uint32Array(n), procs: [new Uint32Array(n), new Uint32Array(n)],
      territory: [new Uint32Array(n), new Uint32Array(n)] };
    const firstHit = [0, 0];
    let peak = [1, 1];
    let death = null;
    round.reset();
    let b = 0;
    while (round.step < round.total) {
      if (round.step === round.total - 1) {
        const i = round.off[round.step];
        const w = round.events[i] & 1;
        const pc = round.events[i + 1];
        death = { w, pc, op: opOf(round.core[3 * pc]), text: round.text(pc), by: round.wroteBy[pc],
          at: round.wrote[pc], owner: round.owner[pc] };
      }
      const i = round.off[round.step];
      const w = round.events[i] & 1;
      const written = round.events[i] >>> 3;
      if (!firstHit[w] && written) {
        let j = i + 2 + ((round.events[i] >>> 1) & 3);
        for (let k = 0; k < written; k++, j += 4) {
          if (round.owner[round.events[j]] === 1 - w) { firstHit[w] = round.step + 1; break; }
        }
      }
      round.apply();
      peak = [Math.max(peak[0], round.ql[0]), Math.max(peak[1], round.ql[1])];
      while (b < n && round.step >= Math.ceil(((b + 1) * round.total) / n)) {
        series.steps[b] = round.step;
        for (const k of [0, 1]) { series.procs[k][b] = round.ql[k]; series.territory[k][b] = round.territory[k]; }
        b++;
      }
    }
    const lastAlive = round.ql[0] && round.ql[1];
    return { series, firstHit, peak, death: lastAlive ? null : death };
  }

  const api = { OPS, MODS, MODES, DAT, signed, disasm, listing, opOf, pairKey, versus, scored, ranked, table, predict, seasonsFor, seasonFor,
    Round, analyze };
  root.HillCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
