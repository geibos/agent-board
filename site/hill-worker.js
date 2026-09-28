'use strict';
// Воркер просмотрщика хилла: движок cw (WebAssembly) в своём потоке, чтобы
// матч в 250 раундов не останавливал страницу. Одна сессия на воркер:
// правила и два бойца; пока они те же, повторно не собираются.
//
// Сообщение: {id, op, params, rounds, a, b, seed, round}; a и b — исходники.
//   assemble — собрать a первым и вторым бойцом (хилл требует оба);
//   match    — все раунды матча (seed: null — посев хилла по id бойцов);
//   record   — раунд round: ядро, события и конечное ядро (передаются).
// Ответ: {id, ok, result} или {id, ok: false, error}.
importScripts('/hill-engine.js');

let engine = null;
let session = { key: null, a: null, b: null, asmA: null, asmB: null };

async function cw() {
  if (engine) return engine;
  const res = await fetch('/corewar/cw.wasm');
  if (!res.ok) throw new Error(`движок не загрузился: HTTP ${res.status}`);
  engine = await self.HillEngine.instantiate(await res.arrayBuffer());
  session = { key: null, a: null, b: null, asmA: null, asmB: null };
  return engine;
}

function prepare(e, m) {
  const key = JSON.stringify([m.params, m.rounds]);
  if (session.key !== key) {
    e.params(m.params, m.rounds);
    session = { key, a: null, b: null, asmA: null, asmB: null };
  }
  if (session.a !== m.a) {
    session.asmA = e.assemble(0, m.a);
    session.a = session.asmA.ok ? m.a : null;
  }
  if (session.b !== m.b) {
    session.asmB = e.assemble(1, m.b);
    session.b = session.asmB.ok ? m.b : null;
  }
  const bad = [session.asmA, session.asmB].find((x) => !x.ok);
  if (bad) throw new Error(`боец не собрался: ${bad.errors.map((d) => `строка ${d.line}: ${d.msg}`).join('; ')}`);
  const seed = m.seed === null || m.seed === undefined ? e.seed(session.asmA.id, session.asmB.id) : m.seed;
  return { a: session.asmA, b: session.asmB, seed };
}

async function handle(m) {
  const e = await cw();
  if (m.op === 'version') return { result: { version: e.version() } };
  if (m.op === 'assemble') {
    const key = JSON.stringify([m.params, m.rounds]);
    if (session.key !== key) { e.params(m.params, m.rounds); session = { key, a: null, b: null, asmA: null, asmB: null }; }
    session.a = null; session.b = null;
    return { result: { first: e.assemble(0, m.a), second: e.assemble(1, m.a) } };
  }
  const p = prepare(e, m);
  if (m.op === 'match') {
    return { result: { a: p.a, b: p.b, seed: p.seed, match: e.play(m.rounds, p.seed) } };
  }
  if (m.op === 'record') {
    const r = e.record(p.seed, m.round);
    return {
      result: { a: p.a, b: p.b, seed: p.seed, meta: r.meta, core: r.core, events: r.events, end: r.end },
      transfer: [r.core.buffer, r.events.buffer, r.end.buffer],
    };
  }
  throw new Error(`неизвестная операция ${m.op}`);
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    const { result, transfer } = await handle(m);
    self.postMessage({ id: m.id, ok: true, result }, transfer || []);
  } catch (err) {
    // Ловушка WebAssembly (переполнение стека ассемблера, паника) портит
    // состояние модуля: следующий вызов начнёт с нового экземпляра.
    if (err instanceof WebAssembly.RuntimeError) engine = null;
    self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
