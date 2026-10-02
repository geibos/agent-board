'use strict';
// Движок cw в WebAssembly (site/corewar/cw.wasm, собран из corewar,
// каталог wasm/): его функции и память, в JS-вызовах. Этот файл подключает
// воркер просмотрщика (hill-worker.js) и тесты в node — склейка одна.
(function (root) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  class Engine {
    constructor(x) { this.x = x; }

    out() {
      const x = this.x;
      return JSON.parse(dec.decode(new Uint8Array(x.memory.buffer, x.cw_output_ptr(), x.cw_output_len())));
    }

    put(text) {
      const b = enc.encode(text);
      const p = this.x.cw_input(b.length);
      new Uint8Array(this.x.memory.buffer, p, b.length).set(b);
    }

    call(ok) {
      const v = this.out();
      if (!ok) throw new Error(v.error || 'cw: отказ без причины');
      return v;
    }

    u32(ptr, len) { return new Uint32Array(this.x.memory.buffer, ptr, len).slice(); }

    version() { return this.call(this.x.cw_version()).version; }

    // p — [params] из hill.toml: core_size, cycles, processes, length, distance.
    params(p, rounds) {
      return this.call(this.x.cw_params(p.core_size, p.cycles, p.processes, p.length, p.distance, rounds));
    }

    // slot 0 — первый боец pMARS (меньший id на хилле), 1 — второй.
    assemble(slot, src) { this.put(src); return this.call(this.x.cw_assemble(slot)); }

    seed(a, b) { this.put(`${a}:${b}`); return this.call(this.x.cw_seed()).seed; }

    play(rounds, seed) { return this.call(this.x.cw_match(rounds, seed)); }

    record(seed, round) {
      const meta = this.call(this.x.cw_record(seed, round));
      const x = this.x;
      return {
        meta,
        core: this.u32(x.cw_core_ptr(), x.cw_core_len()),
        events: this.u32(x.cw_events_ptr(), x.cw_events_len()),
        end: this.u32(x.cw_end_ptr(), x.cw_end_len()),
      };
    }
  }

  async function instantiate(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Engine(instance.exports);
  }

  const api = { instantiate, Engine };
  root.HillEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof self !== 'undefined' ? self : globalThis));
