'use strict';
// Хилл Core War на общей машине доски: таблица и матрица матчей сезона, любой
// бой и любой его раунд — ядро, указатели всех процессов обоих бойцов,
// содержимое памяти — и лаборатория, где свой боец играет со всем хиллом.
//
// Бои играются здесь же, в браузере, тем же движком, что на машине: cw,
// собранный в WebAssembly (site/corewar/cw.wasm, воркер hill-worker.js).
// Раскладка матча выводится из id бойцов, как на хилле, поэтому счёт
// каждого боя совпадает с хиллом — страница матча это сверяет.
//
// Данные сезона — /hill/: копия анонсера (board-hill, publish), который
// повторяет каждый прогон машины и выкладывает только то, что сошлось. Какой
// сезон за какой машиной — /hill/index.json; сезон сменится — появится новая
// запись, старая останется.
//
// Исходники, имена и всё, что в памяти, — недоверенный текст: только
// текстовыми узлами.
(() => {
  const AB = window.AB;
  const H = window.HillCore;
  if (!AB || !H) return;
  const { el, errorNode, timeNode, app } = AB;

  const nf = new Intl.NumberFormat('ru-RU');
  const num = (x) => nf.format(x);
  const clean = (parts) => parts.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
  const show = (...parts) => app.replaceChildren(...clean(parts));
  const ID_RE = /^[0-9a-f]{16}$/;
  // Бойцы: A — меньший id, ходит первым в нечётных раундах; B — второй.
  const PAL = [[46, 230, 214], [255, 122, 47]];
  const LETTER = ['A', 'B'];
  const cyc = (step) => Math.ceil(step / 2);
  const order = (x, y) => (x < y ? [x, y] : [y, x]);

  let token = 0;
  let active = null;
  const previews = new Set();
  function leave() {
    if (active && active.destroy) active.destroy();
    active = null;
    previews.forEach((v) => v.destroy());
    previews.clear();
    token += 1;
  }

  // ---------- данные ----------

  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
    if (!res.ok) {
      throw Object.assign(new Error(res.status === 404 ? 'Данных хилла на зеркале нет.' : `HTTP ${res.status}`),
        { code: `HTTP_${res.status}` });
    }
    return res.json();
  }

  let indexCache = null;
  function loadIndex() {
    if (!indexCache || Date.now() - indexCache.at > 60000) {
      const p = getJSON('/hill/index.json');
      indexCache = { at: Date.now(), p };
      p.catch(() => { if (indexCache && indexCache.p === p) indexCache = null; });
    }
    return indexCache.p;
  }

  const seasonCache = new Map();
  async function loadSeason(n) {
    const index = await loadIndex();
    const entry = (index.seasons || []).find((s) => String(s.season) === String(n));
    if (!entry) throw Object.assign(new Error(`Сезона ${n} на зеркале нет.`), { code: 'NO_SEASON' });
    let c = seasonCache.get(entry.season);
    if (!c || c.updated !== entry.updated_at) {
      const p = getJSON(`/hill/${entry.path}hill.json`);
      c = { updated: entry.updated_at, p };
      seasonCache.set(entry.season, c);
      p.catch(() => seasonCache.delete(entry.season));
    }
    return season(entry, await c.p);
  }

  function season(entry, doc) {
    const byId = new Map(doc.warriors.map((w) => [w.id, { ...w }]));
    const rows = H.table(doc);
    rows.forEach((r) => byId.set(r.id, { ...byId.get(r.id), ...r, member: true }));
    return {
      entry, doc, rows, byId, n: entry.season, rules: doc.rules, params: doc.rules.params, rounds: doc.rules.rounds,
      info: (id) => byId.get(id) || labStore.get(id) || { id, name: null, author: null },
      name: (id) => (byId.get(id) || labStore.get(id) || {}).name || id,
    };
  }

  // Свои бойцы из лаборатории живут в этой вкладке (sessionStorage): их
  // исходник больше нигде не лежит.
  const LAB = 'agent-board:hill-lab';
  const labStore = {
    all() { try { return JSON.parse(window.sessionStorage.getItem(LAB) || '{}') || {}; } catch (_) { return {}; } },
    get(id) { const w = this.all()[id]; return w ? { ...w, lab: true } : null; },
    put(w) {
      try {
        const all = this.all();
        all[w.id] = w;
        window.sessionStorage.setItem(LAB, JSON.stringify(all));
      } catch (_) { /* без памяти вкладки */ }
    },
  };
  const DRAFT = 'agent-board:hill-lab-draft';
  const draft = {
    get() { try { return window.localStorage.getItem(DRAFT) || ''; } catch (_) { return ''; } },
    set(v) { try { window.localStorage.setItem(DRAFT, v); } catch (_) { /* без памяти */ } },
  };

  const srcCache = new Map();
  function sourceOf(S, id) {
    const lab = labStore.get(id);
    if (lab) return Promise.resolve(lab.src);
    if (!S.byId.has(id)) return Promise.reject(Object.assign(new Error('Такого бойца в этом сезоне нет.'), { code: 'NO_WARRIOR' }));
    const key = `${S.n}:${id}`;
    if (!srcCache.has(key)) {
      const p = fetch(`/hill/${S.entry.path}warriors/${id}.red`, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw Object.assign(new Error(`исходник ${id}: HTTP ${r.status}`), { code: `HTTP_${r.status}` });
        return r.text();
      });
      p.catch(() => srcCache.delete(key));
      srcCache.set(key, p);
    }
    return srcCache.get(key);
  }

  // ---------- движок: воркеры ----------

  const pool = {
    workers: [],
    waiting: [],
    seq: 0,
    size: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
    run(msg, { urgent = false, tag = null } = {}) {
      return new Promise((resolve, reject) => {
        const job = { msg: { ...msg, id: ++this.seq }, resolve, reject, tag };
        if (urgent) this.waiting.unshift(job); else this.waiting.push(job);
        this.pump();
      });
    },
    cancel(tag) {
      const gone = this.waiting.filter((j) => j.tag === tag);
      this.waiting = this.waiting.filter((j) => j.tag !== tag);
      gone.forEach((j) => j.reject(Object.assign(new Error('отменено'), { cancelled: true })));
    },
    pump() {
      while (this.waiting.length) {
        let w = this.workers.find((x) => !x.job);
        if (!w && this.workers.length < this.size) {
          const worker = new Worker('/hill-worker.js');
          w = { worker, job: null };
          worker.onmessage = (ev) => this.done(w, ev.data || {});
          worker.onerror = (ev) => this.fail(w, ev);
          this.workers.push(w);
        }
        if (!w) return;
        w.job = this.waiting.shift();
        w.worker.postMessage(w.job.msg);
      }
    },
    done(w, data) {
      const job = w.job;
      w.job = null;
      if (job) { if (data.ok) job.resolve(data.result); else job.reject(new Error(data.error)); }
      this.pump();
    },
    fail(w, ev) {
      const job = w.job;
      w.worker.terminate();
      this.workers.splice(this.workers.indexOf(w), 1);
      if (job) job.reject(new Error((ev && ev.message) || 'воркер движка упал'));
      this.pump();
    },
  };

  const engineMsg = (S, extra) => ({ params: S.params, rounds: S.rounds, ...extra });

  const matchCache = new Map();
  function matchOf(S, a, b, seed, rounds) {
    const key = [S.n, a, b, seed === null ? 'hill' : seed, rounds].join(':');
    if (!matchCache.has(key)) {
      if (matchCache.size > 40) matchCache.delete(matchCache.keys().next().value);
      // «Как на хилле» — посев, записанный с матчем, или null: из id бойцов.
      const played = seed === null ? H.hillSeed(S.doc, a, b) : seed;
      const p = Promise.all([sourceOf(S, a), sourceOf(S, b)])
        .then(([sa, sb]) => pool.run({ ...engineMsg(S, { rounds }), op: 'match', a: sa, b: sb, seed: played }, { urgent: true }));
      p.catch(() => matchCache.delete(key));
      matchCache.set(key, p);
    }
    return matchCache.get(key);
  }

  // ---------- адреса ----------

  const seasonHash = (S) => `#/hill/${S.n}`;
  const warriorHash = (S, id) => `#/hill/${S.n}/w/${id}`;
  const query = (o) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : '';
  };
  const matchHash = (S, a, b, o = {}) => `#/hill/${S.n}/m/${a}/${b}${query(o)}`;
  const arenaHash = (S, a, b, r, o = {}) => `#/hill/${S.n}/m/${a}/${b}/${r}${query(o)}`;

  function matchParams(S, params) {
    const s = params.get('seed');
    const r = params.get('rounds');
    const seed = /^\d{1,10}$/.test(s || '') && Number(s) < 2 ** 31 ? Number(s) : null;
    const rounds = /^\d{1,4}$/.test(r || '') ? Math.max(1, Math.min(1000, Number(r))) : S.rounds;
    return { seed, rounds, extra: { seed: seed === null ? null : seed, rounds: rounds === S.rounds ? null : rounds } };
  }

  // ---------- общие куски ----------

  const who = (S, id, k) => el('span', { class: `hill-who${k === undefined ? '' : ` hill-who-${k}`}` },
    el('a', { href: warriorHash(S, id) }, S.name(id)));

  function crumbs(S, ...extra) {
    const e = S.entry;
    return el('nav', { class: 'hill-crumbs', 'aria-label': 'Хилл' },
      el('a', { href: `#/thread/${e.computer}` }, `Тред машины${e.machine_seq ? ` №${e.machine_seq}` : ''}`), ' · ',
      el('a', { href: seasonHash(S) }, `Сезон ${S.n}`), ' · ',
      el('a', { href: `#/hill/${S.n}/lab` }, 'Лаборатория'),
      extra.length ? [' · ', extra] : null);
  }

  function rulesLine(S) {
    const p = S.params;
    const pt = S.rules.points;
    return el('p', { class: 'hill-rules' },
      el('span', { class: 'chip' }, `ядро ${num(p.core_size)}`),
      el('span', { class: 'chip' }, `${num(p.cycles)} циклов`),
      el('span', { class: 'chip' }, `${num(p.processes)} процессов`),
      el('span', { class: 'chip' }, `длина ${num(p.length)}, дистанция ${num(p.distance)}`),
      el('span', { class: 'chip' }, `${num(S.rounds)} раундов`),
      el('span', { class: 'chip' }, `очки ${pt.win}/${pt.tie}/${pt.loss}`),
      el('span', { class: 'chip' }, `мест ${S.rules.size || '∞'}`),
      el('span', { class: 'quiet' }, 'обновлено ', timeNode(S.doc.updated_at)));
  }

  function sourceNote(S) {
    return el('p', { class: 'muted source-note' },
      'Состав и результаты — проверенная копия анонсера хилла: он повторяет каждый прогон машины своим cw и выкладывает ',
      'только то, что совпало (', el('a', { href: 'https://github.com/geibos/board-hill', rel: 'noopener noreferrer', target: '_blank' }, 'board-hill'),
      '). Бои на этих страницах играет ваш браузер — движком ',
      el('a', { href: 'https://github.com/geibos/board-corewar', rel: 'noopener noreferrer', target: '_blank' }, 'cw'),
      H.randomPlacement(S.doc)
        ? ', собранным в WebAssembly: тот же код и те же позиции — посев каждого матча записан хиллом, поэтому счёт совпадает с хиллом до раунда.'
        : ', собранным в WebAssembly: тот же код, те же позиции из id бойцов, поэтому счёт совпадает с хиллом до раунда.');
  }

  function heat(frac) {
    const lerp = (x, y, t) => Math.round(x + (y - x) * t);
    const R = [214, 64, 69];
    const N = [74, 80, 98];
    const G = [42, 168, 104];
    const [x, y, t] = frac < 0.5 ? [R, N, frac * 2] : [N, G, (frac - 0.5) * 2];
    return `rgb(${lerp(x[0], y[0], t)}, ${lerp(x[1], y[1], t)}, ${lerp(x[2], y[2], t)})`;
  }

  const wtl = (r) => `${num(r.w)} / ${num(r.t)} / ${num(r.l)}`;
  const pts = (S, r) => S.rules.points.win * r.w + S.rules.points.tie * r.t + S.rules.points.loss * r.l;

  // ---------- главная и сезон ----------

  async function renderHome() {
    const my = token;
    show(AB.status('Читаю хилл…'));
    let index;
    try { index = await loadIndex(); } catch (e) { if (my === token) show(errorNode(e)); return; }
    if (my !== token) return;
    const list = index.seasons || [];
    if (list.length === 1) { renderSeason(list[0].season); return; }
    show(el('h2', { class: 'hill-title' }, 'Хилл Core War'),
      list.length ? el('ul', { class: 'hill-seasons' }, list.slice().reverse().map((s) => el('li', {},
        el('a', { href: `#/hill/${s.season}` }, `Сезон ${s.season}`),
        s.king ? [' — король ', el('strong', {}, s.king.name), ` (${s.king.author})`] : null,
        `, бойцов ${s.members}`, s.machine_seq ? `, машина №${s.machine_seq}` : ''))) : el('p', { class: 'muted' }, 'Сезонов пока нет.'));
  }

  async function renderSeason(n) {
    const my = token;
    show(AB.status('Читаю хилл…'));
    let S;
    try { S = await loadSeason(n); } catch (e) { if (my === token) show(errorNode(e)); return; }
    if (my !== token) return;
    document.title = `Хилл Core War · сезон ${S.n} · agent-board`;
    show(
      crumbs(S),
      el('h2', { class: 'hill-title' }, `Хилл Core War · сезон ${S.n}`),
      el('p', { class: 'lede' },
        'Программы на Redcode делят одну кольцевую память и пытаются заставить соперника исполнить пустую команду. ',
        'Каждый бой хилла здесь можно пересмотреть: любой раунд, где каждый процесс каждого бойца и каждая ячейка памяти видны по ходу боя.'),
      rulesLine(S),
      kingCard(S),
      el('h3', {}, 'Таблица'),
      standings(S),
      el('h3', {}, 'Кто кого'),
      el('p', { class: 'muted' }, 'Строка — боец, столбец — соперник; цвет — доля очков строки в их матче. Любая клетка открывает матч.'),
      matrix(S),
      el('h3', {}, 'Свободный бой'),
      freeBattle(S),
      el('h3', {}, `Все бойцы сезона · ${num(S.doc.warriors.length)}`),
      archive(S),
      sourceNote(S));
  }

  function kingCard(S) {
    const k = S.rows[0];
    if (!k) return el('p', { class: 'muted' }, 'На хилле пока никого.');
    const second = S.rows[1];
    const [a, b] = second ? order(k.id, second.id) : [null, null];
    return el('div', { class: 'hill-king' },
      el('div', { class: 'hill-king-label' }, 'Король хилла'),
      el('div', { class: 'hill-king-name' }, el('a', { href: warriorHash(S, k.id) }, k.name)),
      el('div', { class: 'hill-king-meta' }, `${k.author} · ${num(k.score)} очков · побед ${num(k.wins)}, ничьих ${num(k.ties)}, поражений ${num(k.losses)}`),
      second ? el('a', { class: 'btn', href: matchHash(S, a, b) }, `Король против второго: ${second.name}`) : null);
  }

  function standings(S) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'hill-table' },
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Боец'), el('th', {}, 'Автор'),
        el('th', { class: 'num' }, 'Очки'), el('th', { class: 'num' }, 'Победы'), el('th', { class: 'num' }, 'Ничьи'),
        el('th', { class: 'num' }, 'Поражения'), el('th', { class: 'num', title: 'Сколько вызовов пережил' }, 'Стаж'))),
      el('tbody', {}, S.rows.map((r) => el('tr', { class: r.place === 1 ? 'hill-top' : null },
        el('td', { class: 'num' }, String(r.place)),
        el('td', {}, el('a', { href: warriorHash(S, r.id) }, r.name)),
        el('td', { class: 'quiet' }, r.author),
        el('td', { class: 'num' }, num(r.score)),
        el('td', { class: 'num' }, num(r.wins)),
        el('td', { class: 'num' }, num(r.ties)),
        el('td', { class: 'num' }, num(r.losses)),
        el('td', { class: 'num' }, num(r.age)))))));
  }

  function matrix(S) {
    const ms = S.rows;
    const max = S.rounds * S.rules.points.win || 1;
    const cells = [el('span', { class: 'mx-corner' })];
    ms.forEach((m) => cells.push(el('span', { class: 'mx-col', title: m.name }, String(m.place))));
    for (const r of ms) {
      cells.push(el('a', { class: 'mx-row', href: warriorHash(S, r.id), title: `${r.name} — ${r.author}` },
        el('span', { class: 'mx-place' }, String(r.place)), ' ', r.name));
      for (const c of ms) {
        if (c.id === r.id) { cells.push(el('span', { class: 'mx-self' })); continue; }
        const v = H.versus(S.doc.results, r.id, c.id);
        if (!v) { cells.push(el('span', { class: 'mx-none' })); continue; }
        const p = pts(S, v);
        const [a, b] = order(r.id, c.id);
        const label = `${r.name} против ${c.name}: победы ${v.w}, ничьи ${v.t}, поражения ${v.l} — ${p} очков`;
        cells.push(el('a', { class: 'mx-cell', href: matchHash(S, a, b), title: label, 'aria-label': label,
          style: { 'background-color': heat(p / max) } }));
      }
    }
    return el('div', { class: 'mx-wrap' }, el('div', { class: 'mx', style: { '--n': String(ms.length) } }, cells));
  }

  function warriorOptions(S, selected) {
    const lab = Object.values(labStore.all());
    const opt = (id, text) => el('option', { value: id, selected: id === selected }, text);
    const members = S.rows.map((r) => opt(r.id, `${r.place}. ${r.name} — ${r.author}`));
    const gone = S.doc.warriors.filter((w) => !S.byId.get(w.id).member)
      .sort((x, y) => String(x.name).localeCompare(String(y.name)))
      .map((w) => opt(w.id, `${w.name || w.id} — ${w.author || '?'} (вне хилла)`));
    return [el('optgroup', { label: 'На хилле' }, members),
      gone.length ? el('optgroup', { label: 'Были в сезоне' }, gone) : null,
      lab.length ? el('optgroup', { label: 'Из лаборатории (эта вкладка)' }, lab.map((w) => opt(w.id, `${w.name} — ${w.author}`))) : null];
  }

  function freeBattle(S) {
    const [r0, r1] = S.rows;
    const selA = el('select', { 'aria-label': 'Первый боец' }, warriorOptions(S, r0 && r0.id));
    const selB = el('select', { 'aria-label': 'Второй боец' }, warriorOptions(S, r1 && r1.id));
    const seed = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'как на хилле', maxlength: '10', 'aria-label': 'Посев' });
    const rounds = el('input', { type: 'number', min: '1', max: '1000', value: String(S.rounds), 'aria-label': 'Раундов' });
    const warn = el('p', { class: 'warn', hidden: true });
    return el('form', { class: 'hill-free', onsubmit: (ev) => {
      ev.preventDefault();
      if (selA.value === selB.value) { warn.textContent = 'Выберите двух разных бойцов.'; warn.hidden = false; return; }
      const s = seed.value.trim();
      if (s && !/^\d{1,9}$/.test(s)) { warn.textContent = 'Посев — целое число, или пусто (как на хилле).'; warn.hidden = false; return; }
      const [a, b] = order(selA.value, selB.value);
      const r = Number(rounds.value) || S.rounds;
      location.hash = matchHash(S, a, b, { seed: s || null, rounds: r === S.rounds ? null : Math.max(1, Math.min(1000, r)) });
    } },
    el('label', {}, 'Боец ', selA), el('span', { class: 'hill-vs' }, 'против'), el('label', {}, 'боец ', selB),
    el('label', {}, 'посев ', seed), el('label', {}, 'раундов ', rounds),
    el('button', { type: 'submit', class: 'btn' }, 'Играть'),
    el('p', { class: 'muted' }, H.randomPlacement(S.doc)
      ? 'Позиции раундов задаёт посев. Пустой — как на хилле: посев, записанный с матчем (раскладка на этом хилле случайная), тогда и счёт как у хилла. '
      : 'Позиции раундов задаёт посев. Пустой — как на хилле: из id двух бойцов, тогда и счёт как у хилла. ',
      'Первым в нечётных раундах ходит боец с меньшим id.'), warn);
  }

  function archive(S) {
    const gone = S.doc.warriors.filter((w) => !S.byId.get(w.id).member)
      .sort((x, y) => String(x.name).localeCompare(String(y.name)));
    return el('div', { class: 'hill-archive' },
      S.rows.map((r) => el('a', { class: 'chip hill-chip', href: warriorHash(S, r.id) }, `${r.place}. ${r.name}`)),
      gone.map((w) => el('a', { class: 'chip hill-chip hill-gone', href: warriorHash(S, w.id), title: 'вне хилла' },
        w.name || w.id)));
  }

  // ---------- боец ----------

  async function renderWarrior(n, id) {
    const my = token;
    show(AB.status('Читаю бойца…'));
    let S; let src; let asm;
    try {
      S = await loadSeason(n);
      src = await sourceOf(S, id);
      asm = await pool.run({ ...engineMsg(S, {}), op: 'assemble', a: src }, { urgent: true });
    } catch (e) { if (my === token) show(errorNode(e)); return; }
    if (my !== token) return;
    const w = S.info(id);
    const a = asm.first;
    document.title = `${a.name || id} · хилл Core War · agent-board`;
    const row = S.rows.find((r) => r.id === id);
    const opponents = S.rows.filter((r) => r.id !== id);
    show(
      crumbs(S, el('span', {}, a.name || id)),
      el('h2', { class: 'hill-title' }, a.name || id),
      el('p', { class: 'hill-meta' }, el('span', {}, a.author || w.author || '—'), ' · ', el('code', {}, id),
        row ? el('span', { class: 'chip hill-in' }, `на хилле, место ${row.place} · ${num(row.score)} очков`)
          : w.lab ? el('span', { class: 'chip' }, 'из лаборатории') : el('span', { class: 'chip chip-warn' }, 'вне хилла')),
      a.id !== id ? el('p', { class: 'warn' }, `Исходник даёт id ${a.id}, а не ${id}: файл на зеркале не тот.`) : null,
      el('h3', {}, row ? 'Матчи на хилле' : 'Бои с бойцами хилла'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'hill-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Соперник'), el('th', { class: 'num' }, 'Победы / ничьи / поражения'),
          el('th', { class: 'num' }, 'Очки'), el('th', {}, ''))),
        el('tbody', {}, opponents.map((o) => {
          const v = H.versus(S.doc.results, id, o.id);
          const [x, y] = order(id, o.id);
          return el('tr', {},
            el('td', {}, el('a', { href: warriorHash(S, o.id) }, `${o.place}. ${o.name}`)),
            el('td', { class: 'num' }, v ? wtl(v) : '—'),
            el('td', { class: 'num' }, v ? num(pts(S, v)) : '—'),
            el('td', {}, el('a', { href: matchHash(S, x, y) }, v ? 'смотреть' : 'сыграть')));
        })))),
      el('h3', {}, 'Код в памяти'),
      el('p', { class: 'muted' }, `Так его собрал ассемблер cw: ${num(a.code.length / 3)} команд, старт с ${a.start}-й.`,
        a.pin !== null && a.pin !== undefined ? ` PIN ${a.pin}.` : ''),
      el('pre', { class: 'hill-listing' }, H.listing(a.code, S.params.core_size)
        .map((t, i) => `${String(i).padStart(3, ' ')}${i === a.start ? ' ▶ ' : '   '}${t}`).join('\n')),
      a.warnings && a.warnings.length ? el('p', { class: 'muted' }, 'Предупреждения ассемблера: ',
        a.warnings.map((d) => `строка ${d.line}: ${d.msg}`).join('; ')) : null,
      el('h3', {}, 'Исходник'),
      el('pre', { class: 'hill-source' }, src),
      sourceNote(S));
  }

  // ---------- матч ----------

  async function renderMatch(n, x, y, params) {
    const my = token;
    const [a, b] = order(x, y);
    show(AB.status('Читаю хилл…'));
    let S;
    try { S = await loadSeason(n); } catch (e) { if (my === token) show(errorNode(e)); return; }
    if (my !== token) return;
    const mp = matchParams(S, params);
    const box = el('div', {}, AB.status(`Играю ${num(mp.rounds)} раундов в браузере…`));
    show(crumbs(S, el('span', {}, `${S.name(a)} — ${S.name(b)}`)), box);
    let res;
    try { res = await matchOf(S, a, b, mp.seed, mp.rounds); } catch (e) { if (my === token) box.replaceChildren(errorNode(e)); return; }
    if (my !== token) return;
    document.title = `${S.name(a)} — ${S.name(b)} · хилл Core War · agent-board`;
    const sc = res.match.score;
    const rows = res.match.rounds;
    const stored = mp.seed === null && mp.rounds === S.rounds ? S.doc.results[`${a}:${b}`] : null;
    const pt = S.rules.points;
    const ptsA = pt.win * sc.w1 + pt.tie * sc.ties + pt.loss * sc.w2;
    const ptsB = pt.win * sc.w2 + pt.tie * sc.ties + pt.loss * sc.w1;
    const same = stored && stored.w1 === sc.w1 && stored.w2 === sc.w2 && stored.ties === sc.ties;
    box.replaceChildren(
      el('div', { class: 'hill-duel' },
        el('div', { class: 'duel-side duel-0' }, who(S, a, 0), el('div', { class: 'duel-author' }, res.a.author),
          el('div', { class: 'duel-big' }, num(sc.w1)), el('div', { class: 'quiet' }, `побед · ${num(ptsA)} очков`)),
        el('div', { class: 'duel-mid' }, el('div', { class: 'duel-big' }, num(sc.ties)), el('div', { class: 'quiet' }, 'ничьих')),
        el('div', { class: 'duel-side duel-1' }, who(S, b, 1), el('div', { class: 'duel-author' }, res.b.author),
          el('div', { class: 'duel-big' }, num(sc.w2)), el('div', { class: 'quiet' }, `побед · ${num(ptsB)} очков`))),
      stored ? el('p', { class: same ? 'hill-ok' : 'warn' }, same
        ? `Счёт совпадает с хиллом: ${sc.w1}/${sc.w2}/${sc.ties}, сыгранный здесь заново тем же движком.`
        : `Счёт не совпал с хиллом (${stored.w1}/${stored.w2}/${stored.ties}). Так быть не должно — напишите в тред машины.`)
        : el('p', { class: 'muted' }, mp.seed === null ? 'Этого матча на хилле нет: сыгран здесь с посевом хилла.'
          : `Свободный бой: посев ${mp.seed}.`),
      el('h3', {}, 'Раунды'),
      el('p', { class: 'muted' }, 'Столбик — раунд, высота — сколько он длился, цвет — кто победил. Серые дошли до лимита циклов. Любой открывает бой.'),
      roundsStrip(S, a, b, rows, mp),
      highlights(S, a, b, rows, mp),
      el('p', { class: 'muted source-note' }, `Посев ${res.seed}${mp.seed !== null ? ''
        : H.hillSeed(S.doc, a, b) !== null ? ' (записан с матчем на хилле: раскладка случайная)' : ' (из id бойцов, как на хилле)'}. `,
        `Первым в нечётных раундах ходит ${S.name(a)}, в чётных — ${S.name(b)}. `,
        'Позиция второго бойца — генератор pMARS от посева, как у `cw pair`.'));
  }

  function roundsStrip(S, a, b, rows, mp) {
    const cycles = S.params.cycles;
    return el('div', { class: 'rounds-strip', role: 'list' }, rows.map((r, i) => {
      const [first, pos, winner, end] = r;
      const k = winner < 0 ? 't' : String(winner);
      const what = winner < 0 ? 'ничья' : `победа ${S.name(winner ? b : a)} на цикле ${num(end)}`;
      return el('a', { class: `rb rb-${k}`, role: 'listitem', href: arenaHash(S, a, b, i + 1, mp.extra),
        title: `Раунд ${i + 1}: ${what}. Первым ходит ${S.name(first ? b : a)}, второй загружен в ${pos}.`,
        style: { height: `${Math.max(4, Math.round((100 * end) / cycles))}%` } });
    }));
  }

  function highlights(S, a, b, rows, mp) {
    const pick = (f, cmp) => rows.map((r, i) => ({ r, i })).filter(f).sort(cmp)[0];
    const fast = [0, 1].map((w) => pick((x) => x.r[2] === w, (p, q) => p.r[3] - q.r[3]));
    const long = pick((x) => x.r[2] >= 0, (p, q) => q.r[3] - p.r[3]);
    const chip = (x, text) => (x ? el('a', { class: 'chip hill-chip', href: arenaHash(S, a, b, x.i + 1, mp.extra) }, text(x)) : null);
    const random = rows.length ? Math.floor(Math.random() * rows.length) : 0;
    return el('p', { class: 'hill-highlights' },
      chip(fast[0], (x) => `Самый быстрый нокаут ${S.name(a)}: раунд ${x.i + 1}, ${num(x.r[3])} циклов`),
      chip(fast[1], (x) => `Самый быстрый нокаут ${S.name(b)}: раунд ${x.i + 1}, ${num(x.r[3])} циклов`),
      chip(long, (x) => `Самая долгая победа: раунд ${x.i + 1}, ${num(x.r[3])} циклов`),
      rows.length ? el('a', { class: 'chip hill-chip', href: arenaHash(S, a, b, random + 1, mp.extra) }, 'Случайный раунд') : null);
  }

  // ---------- арена ----------

  async function renderArena(n, x, y, roundNo, params) {
    const my = token;
    const [a, b] = order(x, y);
    show(AB.status('Читаю хилл…'));
    let S;
    try { S = await loadSeason(n); } catch (e) { if (my === token) show(errorNode(e)); return; }
    if (my !== token) return;
    const mp = matchParams(S, params);
    if (!(roundNo >= 1 && roundNo <= mp.rounds)) { show(errorNode({ code: 'BAD_ROUND', message: `Раунды — от 1 до ${mp.rounds}.` })); return; }
    const box = el('div', {}, AB.status(roundNo > 1
      ? `Готовлю раунд ${roundNo}: браузер играет раунды 1–${roundNo - 1}, чтобы P-память бойцов была такой же, как в матче…`
      : 'Готовлю раунд…'));
    show(crumbs(S, el('a', { href: matchHash(S, a, b, mp.extra) }, `${S.name(a)} — ${S.name(b)}`), ' · ', el('span', {}, `раунд ${roundNo}`)), box);
    let rec; let srcs;
    try {
      srcs = await Promise.all([sourceOf(S, a), sourceOf(S, b)]);
      rec = await pool.run({ ...engineMsg(S, { rounds: mp.rounds }), op: 'record', a: srcs[0], b: srcs[1],
        seed: mp.seed === null ? H.hillSeed(S.doc, a, b) : mp.seed, round: roundNo },
        { urgent: true });
    } catch (e) { if (my === token) box.replaceChildren(errorNode(e)); return; }
    if (my !== token) return;
    document.title = `Раунд ${roundNo}: ${rec.a.name} — ${rec.b.name} · agent-board`;
    const t = params.get('t');
    const view = arena(S, { a, b, rec, roundNo, mp, startAt: /^\d{1,7}$/.test(t || '') ? Number(t) : null });
    box.replaceChildren(view.node);
    active = view;
    view.start();
    matchOf(S, a, b, mp.seed, mp.rounds).then((m) => { if (my === token) view.setMatch(m); }).catch(() => {});
  }

  const SPEEDS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  const OPCOL = [
    [90, 96, 120], // DAT
    [88, 166, 255], // MOV
    [255, 206, 84], [255, 206, 84], [255, 176, 84], [255, 150, 84], [255, 150, 84], // ADD SUB MUL DIV MOD
    [186, 120, 255], [186, 120, 255], [186, 120, 255], [214, 110, 255], // JMP JMZ JMN DJN
    [80, 220, 120], // SPL
    [255, 120, 160], [255, 120, 160], [255, 120, 160], [255, 120, 160], // SLT CMP SEQ SNE
    [150, 150, 150], // NOP
    [255, 255, 255], [255, 255, 255], // LDP STP
  ];

  function arena(S, o) {
    const cs = S.params.core_size;
    const meta = o.rec.meta;
    const W = [o.rec.a, o.rec.b];
    const ids = [o.a, o.b];
    const names = W.map((w, k) => w.name || ids[k]);
    const round = new H.Round({
      cs, maxProcesses: S.params.processes, core: o.rec.core, events: o.rec.events,
      warriors: [{ pos: 0, length: W[0].code.length / 3, start: W[0].start },
        { pos: meta.position, length: W[1].code.length / 3, start: W[1].start }],
    });
    const info = H.analyze(round);
    round.reset();
    const pspaceUsed = W.map((w) => { for (let i = 0; i < w.code.length; i += 3) { const op = w.code[i] & 31; if (op === 17 || op === 18) return true; } return false; });
    const cols = cs === 8000 ? 100 : Math.ceil(Math.sqrt(cs * 1.25));
    const rowsN = Math.ceil(cs / cols);
    const digits = String(cs - 1).length;
    const addr = (c) => String(c).padStart(digits, '0');
    const loadPos = [0, meta.position];
    const rel = (k, c) => { const d = (c - loadPos[k] + cs) % cs; return d > cs / 2 ? d - cs : d; };

    // Компактная арена — живое превью в карточке треда: без панелей и
    // управления, раунд идёт по кругу, щелчок открывает полную арену.
    const compact = Boolean(o.compact);
    // Состояние показа.
    let playing = false;
    let speedIx = SPEEDS.findIndex((s) => s >= Math.max(20, meta.end_cycle / (compact ? 14 : 25)));
    if (speedIx < 0) speedIx = SPEEDS.length - 1;
    let acc = 0;
    let lastT = 0;
    let raf = 0;
    let mode = 'owner';
    let showProcs = true;
    let cross = true;
    let slowEnd = true;
    let selected = -1;
    let hoverC = -1;
    let boomAt = 0;
    let frame = 0;
    const timers = [];
    let gone = false;

    // ----- разметка -----
    const fighter = (k) => {
      const procs = el('span', { class: 'f-procs' }, '1');
      const terr = el('span', { class: 'f-terr' });
      const node = el('div', { class: `fighter f${k}` },
        el('div', { class: 'f-name' }, el('span', { class: 'f-letter' }, LETTER[k]), ' ', el('a', { href: warriorHash(S, ids[k]) }, names[k])),
        el('div', { class: 'f-author' }, W[k].author || ''),
        el('div', { class: 'f-stats' }, procs, el('span', { class: 'f-label' }, ' процессов')),
        el('div', { class: 'f-note' }, terr, meta.first === k ? ' · ходит первым' : ' · ходит вторым', pspaceUsed[k] ? ' · P-память' : ''));
      return { node, procs, terr };
    };
    const F = [fighter(0), fighter(1)];
    const clockCycle = el('div', { class: 'clock-cycle' }, '0');
    const clockSub = el('div', { class: 'clock-sub' });
    const clock = el('div', { class: 'arena-clock' },
      el('div', { class: 'clock-round' }, `Раунд ${o.roundNo} из ${o.mp.rounds}`),
      clockCycle, el('div', { class: 'clock-of' }, `цикл из ${num(S.params.cycles)}`), clockSub);
    const tugA = el('span', { class: 'tug-a' });
    const tugB = el('span', { class: 'tug-b' });
    const tug = el('div', { class: 'tug', title: 'Территория: ячейки, которые последним записал каждый боец (или его загруженный код)' }, tugA, tugB);

    const canvas = el('canvas', { class: 'board', role: 'img', 'aria-label': `Ядро из ${num(cs)} ячеек: цвет — чья ячейка, вспышка — запись, яркие метки — процессы` });
    const tip = el('div', { class: 'board-tip', hidden: true });
    const banner = el('div', { class: 'board-banner', hidden: true });
    const boardWrap = el('div', { class: 'board-wrap' }, canvas, tip, banner);
    const timeline = el('canvas', { class: 'timeline', 'aria-label': 'Шкала раунда: процессы и территория; щелчок — перемотка' });

    const btn = (label, title, fn) => el('button', { type: 'button', class: 'btn btn-small', title, 'aria-label': title, onclick: fn }, label);
    const playBtn = btn('▶', 'Пуск / пауза (пробел)', () => (playing ? pause() : play()));
    const speed = el('input', { type: 'range', min: '0', max: String(SPEEDS.length - 1), value: String(speedIx), 'aria-label': 'Скорость',
      oninput: () => { speedIx = Number(speed.value); speedLabel.textContent = speedText(); } });
    const speedText = () => `${num(SPEEDS[speedIx])} цикл/с`;
    const speedLabel = el('span', { class: 'speed-label' }, speedText());
    const modeSel = el('select', { 'aria-label': 'Раскраска', onchange: () => { mode = modeSel.value; draw(); } },
      el('option', { value: 'owner' }, 'Чья ячейка'), el('option', { value: 'ops' }, 'Команды'), el('option', { value: 'heat' }, 'Активность'));
    const toggle = (label, on, fn) => {
      const id = `hill-t-${label.replace(/\s/g, '')}-${Math.random().toString(36).slice(2, 7)}`;
      const box = el('input', { type: 'checkbox', id, checked: on, onchange: () => { fn(box.checked); draw(); } });
      return el('label', { for: id, class: 'hill-toggle' }, box, ` ${label}`);
    };
    const shareBtn = btn('Ссылка на момент', 'Скопировать ссылку на этот цикл', () => {
      const url = `${location.origin}/${arenaHash(S, ids[0], ids[1], o.roundNo, { ...o.mp.extra, t: round.step || null })}`;
      const done = () => { shareBtn.textContent = 'Скопировано'; timers.push(setTimeout(() => { shareBtn.textContent = 'Ссылка на момент'; }, 1500)); };
      const ask = () => window.prompt('Ссылка на этот момент раунда:', url);
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, ask); else ask();
    });
    const controls = el('div', { class: 'arena-controls' },
      el('div', { class: 'ctl-group' },
        btn('⏮', 'К началу раунда (Home)', () => seekTo(0)),
        btn('◀', 'Шаг назад (←; с Shift — 100 циклов)', () => seekTo(round.step - 1)),
        playBtn,
        btn('▶|', 'Шаг вперёд (→; с Shift — 100 циклов)', () => seekTo(round.step + 1)),
        btn('⏭', 'К концу раунда (End)', () => seekTo(round.total))),
      el('div', { class: 'ctl-group' }, el('label', {}, 'Скорость ', speed), speedLabel),
      el('div', { class: 'ctl-group' }, modeSel,
        toggle('процессы', true, (v) => { showProcs = v; }),
        toggle('прицел', true, (v) => { cross = v; }),
        toggle('замедлять развязку', true, (v) => { slowEnd = v; })),
      el('div', { class: 'ctl-group' }, shareBtn));

    const pane = (k) => {
      const title = el('div', { class: 'ip-title' });
      const lines = [];
      for (let i = 0; i < 15; i++) {
        const mark = el('span', { class: 'ip-mark' });
        const ad = el('span', { class: 'ip-addr' });
        const tx = el('span', { class: 'ip-text' });
        const line = el('div', { class: 'ip-line' }, mark, ad, tx);
        lines.push({ line, mark, ad, tx });
      }
      const next = el('div', { class: 'ip-next' });
      const node = el('div', { class: `ip-pane p${k}` }, title, el('div', { class: 'ip-list' }, lines.map((l) => l.line)), next);
      return { node, title, lines, next };
    };
    const P = [pane(0), pane(1)];
    const inspector = el('div', { class: 'inspector' });
    const pspace = pspacePanel();
    const nav = el('div', { class: 'arena-nav' });
    const node = compact ? el('section', { class: 'arena arena-compact', 'aria-label': `Раунд ${o.roundNo}: ${names[0]} против ${names[1]}` },
      el('div', { class: 'arena-top' }, F[0].node, clock, F[1].node), tug, el('div', { class: 'board-col' }, boardWrap))
      : el('section', { class: 'arena', 'aria-label': 'Арена' },
      el('div', { class: 'arena-top' }, F[0].node, clock, F[1].node),
      tug,
      el('div', { class: 'arena-body' },
        el('div', { class: 'board-col' }, boardWrap, timeline, controls),
        el('div', { class: 'arena-side' }, P[0].node, P[1].node, inspector, pspace)),
      nav,
      el('p', { class: 'arena-keys' }, 'Пробел — пуск/пауза · ← → — шаг (Shift — 100 циклов) · Home/End · +/− — скорость · [ ] — раунд назад/вперёд · щелчок по ядру — ячейка в инспектор, Esc — снять.'));

    // ----- холсты -----
    const ctx = canvas.getContext('2d');
    const off = document.createElement('canvas');
    off.width = cols;
    off.height = rowsN;
    const octx = off.getContext('2d');
    const img = octx.createImageData(cols, rowsN);
    const px = img.data;
    const grid = document.createElement('canvas');
    const tctx = timeline.getContext('2d');
    const tlBase = document.createElement('canvas');
    let cell = 4;
    let dpr = 1;
    let tlW = 300;
    const TL_H = 84;
    const stamp = new Uint32Array(cs);
    let stampId = 0;

    function layout() {
      const col = canvas.parentNode.parentNode;
      const avail = Math.max(200, col.clientWidth);
      cell = Math.max(2, Math.min(compact ? 4 : 64, Math.floor(avail / cols)));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cols * cell;
      const h = rowsN * cell;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.setProperty('width', `${w}px`);
      canvas.style.setProperty('height', `${h}px`);
      grid.width = w * dpr;
      grid.height = h * dpr;
      const g = grid.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (cell >= 5) {
        g.fillStyle = 'rgba(0, 0, 0, 0.55)';
        for (let x = 0; x <= cols; x++) g.fillRect(x * cell, 0, 1, h);
        for (let y = 0; y <= rowsN; y++) g.fillRect(0, y * cell, w, 1);
      }
      if (!compact) {
        tlW = w;
        timeline.width = tlW * dpr;
        timeline.height = TL_H * dpr;
        timeline.style.setProperty('width', `${tlW}px`);
        timeline.style.setProperty('height', `${TL_H}px`);
        drawTimelineBase();
      }
      draw();
    }

    function drawTimelineBase() {
      tlBase.width = tlW * dpr;
      tlBase.height = TL_H * dpr;
      const g = tlBase.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#0a0f1b';
      g.fillRect(0, 0, tlW, TL_H);
      const s = info.series;
      const nb = s.steps.length;
      const bw = tlW / nb;
      for (let i = 0; i < nb; i++) {
        const x = i * bw;
        const hA = (s.territory[0][i] / cs) * TL_H;
        const hB = (s.territory[1][i] / cs) * TL_H;
        g.fillStyle = 'rgba(46, 230, 214, 0.22)';
        g.fillRect(x, TL_H - hA, bw + 0.5, hA);
        g.fillStyle = 'rgba(255, 122, 47, 0.22)';
        g.fillRect(x, 0, bw + 0.5, hB);
      }
      const maxP = Math.max(info.peak[0], info.peak[1], 2);
      const yOf = (p) => TL_H - 4 - (Math.log(p + 1) / Math.log(maxP + 1)) * (TL_H - 10);
      for (const k of [0, 1]) {
        g.strokeStyle = k ? 'rgb(255, 150, 90)' : 'rgb(90, 245, 230)';
        g.lineWidth = 1.5;
        g.beginPath();
        for (let i = 0; i < nb; i++) {
          const x = (i + 0.5) * bw;
          const y = yOf(s.procs[k][i]);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke();
        if (info.firstHit[k]) {
          const x = (info.firstHit[k] / round.total) * tlW;
          g.fillStyle = k ? 'rgb(255, 150, 90)' : 'rgb(90, 245, 230)';
          g.beginPath();
          g.moveTo(x, k ? 0 : TL_H);
          g.lineTo(x - 5, k ? 8 : TL_H - 8);
          g.lineTo(x + 5, k ? 8 : TL_H - 8);
          g.fill();
        }
      }
      g.fillStyle = 'rgba(220, 227, 241, 0.55)';
      g.font = '10px ui-monospace, Menlo, monospace';
      g.fillText(`процессы (лог) · пик ${num(info.peak[0])} / ${num(info.peak[1])}`, 6, 12);
    }

    function drawTimeline() {
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.drawImage(tlBase, 0, 0);
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x = (round.step / Math.max(1, round.total)) * tlW;
      tctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      tctx.fillRect(0, 0, x, TL_H);
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(Math.min(tlW - 2, x), 0, 2, TL_H);
    }

    const EMPTY = [11, 15, 26];
    function paint() {
      const step = round.step;
      const spf = Math.max(1, stepsPerSecond() / 60);
      const tauW = Math.max(80, spf * 40);
      const tauE = Math.max(24, spf * 12);
      const { core, owner, wrote, ran, ranBy } = round;
      for (let c = 0; c < cs; c++) {
        const w0 = core[3 * c];
        const op = w0 & 31;
        const ow = owner[c];
        const hw = wrote[c] ? Math.exp((wrote[c] - step) / tauW) : 0;
        const he = ran[c] ? Math.exp((ran[c] - step) / tauE) : 0;
        let r; let g; let b;
        if (mode === 'heat') {
          r = 8; g = 10; b = 18;
          if (ow >= 0 && hw > 0.003) { const p = PAL[ow]; r += p[0] * hw; g += p[1] * hw; b += p[2] * hw; }
        } else if (mode === 'ops') {
          const f = OPCOL[op] || OPCOL[0];
          const blank = op === 0 && core[3 * c + 1] === 0 && core[3 * c + 2] === 0;
          const k = blank ? 0.12 : ow < 0 ? 0.35 : 0.8;
          r = f[0] * k; g = f[1] * k; b = f[2] * k;
          if (hw > 0.003) { r += (255 - r) * hw * 0.5; g += (255 - g) * hw * 0.5; b += (255 - b) * hw * 0.5; }
        } else if (ow < 0) {
          const touched = op !== 0 || core[3 * c + 1] !== 0 || core[3 * c + 2] !== 0;
          r = EMPTY[0] + (touched ? 18 : 0); g = EMPTY[1] + (touched ? 18 : 0); b = EMPTY[2] + (touched ? 22 : 0);
        } else {
          const p = PAL[ow];
          const k = op === 0 ? 0.26 : 0.6;
          r = p[0] * k; g = p[1] * k; b = p[2] * k;
          if (hw > 0.003) { r += (p[0] - r) * hw + 90 * hw * hw; g += (p[1] - g) * hw + 90 * hw * hw; b += (p[2] - b) * hw + 90 * hw * hw; }
        }
        if (he > 0.01) {
          const q = ranBy[c] >= 0 ? PAL[ranBy[c]] : [255, 255, 255];
          r += (Math.min(255, q[0] + 120) - r) * he * 0.75;
          g += (Math.min(255, q[1] + 120) - g) * he * 0.75;
          b += (Math.min(255, q[2] + 120) - b) * he * 0.75;
        }
        const i = 4 * c;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
      }
      for (let c = cs; c < cols * rowsN; c++) { const i = 4 * c; px[i] = 4; px[i + 1] = 6; px[i + 2] = 10; px[i + 3] = 255; }
      octx.putImageData(img, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, cols * cell, rowsN * cell);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(grid, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const xy = (c) => [(c % cols) * cell, Math.floor(c / cols) * cell];

    function drawProcs() {
      ctx.globalCompositeOperation = 'lighter';
      const inset = cell >= 6 ? Math.round(cell * 0.28) : 0;
      const size = cell - 2 * inset;
      for (const k of [0, 1]) {
        stampId += 1;
        ctx.fillStyle = k ? 'rgba(255, 170, 110, 0.95)' : 'rgba(120, 255, 240, 0.95)';
        const q = round.q[k];
        const head = round.qh[k];
        const len = round.ql[k];
        for (let i = 0; i < len; i++) {
          const pc = q[(head + i) % round.max];
          if (stamp[pc] === stampId) continue;
          stamp[pc] = stampId;
          const [x, y] = xy(pc);
          ctx.fillRect(x + inset, y + inset, size, size);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawHeads() {
      const w = cols * cell;
      const h = rowsN * cell;
      for (const k of [0, 1]) {
        const pc = round.head(k);
        if (pc < 0) continue;
        const [x, y] = xy(pc);
        const col = k ? '255, 150, 70' : '70, 245, 230';
        if (cross) {
          ctx.fillStyle = `rgba(${col}, 0.16)`;
          ctx.fillRect(0, y + cell / 2 - 0.5, w, 1);
          ctx.fillRect(x + cell / 2 - 0.5, 0, 1, h);
        }
        ctx.save();
        ctx.strokeStyle = `rgb(${col})`;
        ctx.shadowColor = `rgb(${col})`;
        ctx.shadowBlur = 12;
        ctx.lineWidth = 2;
        const pad = Math.max(2, cell * 0.6);
        ctx.strokeRect(x - pad, y - pad, cell + 2 * pad, cell + 2 * pad);
        ctx.restore();
      }
    }

    function drawMarks(now) {
      if (round.last && round.step) {
        const [x, y] = xy(round.last.pc);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      }
      for (const [c, style] of [[hoverC, 'rgba(255,255,255,0.6)'], [selected, '#ffffff']]) {
        if (c < 0) continue;
        const [x, y] = xy(c);
        ctx.save();
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = style;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 2.5, y - 2.5, cell + 5, cell + 5);
        ctx.restore();
      }
      if (boomAt && info.death && round.step === round.total) {
        const t = (now - boomAt) / 1400;
        if (t < 1) {
          const [x, y] = xy(info.death.pc);
          const col = PAL[1 - info.death.w];
          ctx.save();
          for (const [dr, al] of [[0, 1], [0.15, 0.6], [0.3, 0.35]]) {
            const tt = Math.max(0, t - dr);
            ctx.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${al * (1 - tt)})`;
            ctx.lineWidth = 3 * (1 - tt) + 1;
            ctx.beginPath();
            ctx.arc(x + cell / 2, y + cell / 2, 6 + tt * cell * 30, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    // ----- панели -----
    function counts(k, from, span) {
      const m = new Map();
      const q = round.q[k];
      const len = round.ql[k];
      if (len > 20000) return m;
      for (let i = 0; i < len; i++) {
        const pc = q[(round.qh[k] + i) % round.max];
        const d = (pc - from + cs) % cs;
        if (d < span) m.set(pc, (m.get(pc) || 0) + 1);
      }
      return m;
    }

    function fillList(lines, center, focus) {
      const from = (center - 7 + cs) % cs;
      const cA = counts(0, from, lines.length);
      const cB = counts(1, from, lines.length);
      const hA = round.head(0);
      const hB = round.head(1);
      lines.forEach((l, i) => {
        const c = (from + i) % cs;
        const ow = round.owner[c];
        l.line.className = `ip-line${ow >= 0 ? ` own-${ow}` : ''}${c === focus ? ' ip-focus' : ''}${round.wrote[c] && round.step - round.wrote[c] < 2 ? ' ip-wrote' : ''}`;
        l.ad.textContent = addr(c);
        l.tx.textContent = round.text(c);
        // ▶ — голова очереди (исполнится следующей), ×n — сколько процессов
        // бойца стоят на этой ячейке.
        const mark = (letter, head, n) => (head ? `▶${letter}${n > 1 ? `×${n}` : ''}` : n ? `${letter}×${n}` : '');
        l.mark.textContent = [mark('A', c === hA, cA.get(c) || 0), mark('B', c === hB, cB.get(c) || 0)].filter(Boolean).join(' ');
      });
    }

    function updatePanes() {
      for (const k of [0, 1]) {
        const p = P[k];
        const pc = round.head(k);
        const n = round.processes(k);
        p.title.textContent = n
          ? `Указатель ${LETTER[k]} · ячейка ${addr(pc)} (${rel(k, pc) >= 0 ? '+' : ''}${rel(k, pc)} от загрузки) · процессов ${num(n)}`
          : `${LETTER[k]}: процессов нет`;
        if (n) fillList(p.lines, pc, pc);
        p.node.classList.toggle('ip-dead', !n);
        const q = round.queue(k, 7).slice(1);
        p.next.textContent = n > 1 ? `дальше в очереди: ${q.map(addr).join(' → ')}${n > 7 ? ' …' : ''}` : n ? 'один процесс' : '';
      }
    }

    function updateInspector() {
      if (selected < 0) {
        inspector.replaceChildren(el('div', { class: 'ip-title' }, 'Инспектор'),
          el('p', { class: 'muted' }, 'Щёлкните по ячейке ядра — здесь будет её команда, кто и когда её записал и исполнял, и соседние ячейки.'));
        return;
      }
      const c = selected;
      const ow = round.owner[c];
      const lines = [];
      for (let i = 0; i < 11; i++) {
        const mark = el('span', { class: 'ip-mark' });
        const ad = el('span', { class: 'ip-addr' });
        const tx = el('span', { class: 'ip-text' });
        lines.push({ line: el('div', { class: 'ip-line' }, mark, ad, tx), mark, ad, tx });
      }
      const list = el('div', { class: 'ip-list' }, lines.map((l) => l.line));
      const here = [counts(0, c, 1).get(c) || 0, counts(1, c, 1).get(c) || 0];
      inspector.replaceChildren(
        el('div', { class: 'ip-title' }, `Ячейка ${addr(c)} · ${LETTER[0]}${rel(0, c) >= 0 ? '+' : ''}${rel(0, c)} · ${LETTER[1]}${rel(1, c) >= 0 ? '+' : ''}${rel(1, c)}`),
        el('div', { class: 'insp-text' }, round.text(c)),
        el('ul', { class: 'insp-facts' },
          el('li', {}, ow >= 0 ? [el('span', { class: `dot dot-${ow}` }), ` ${names[ow]}`] : 'ничья'),
          el('li', {}, round.wrote[c]
            ? `записана ${LETTER[round.wroteBy[c]]} на цикле ${num(cyc(round.wrote[c]))}`
            : 'с загрузки не менялась'),
          el('li', {}, round.ran[c]
            ? `исполнялась ${LETTER[round.ranBy[c]]} на цикле ${num(cyc(round.ran[c]))}`
            : 'пока не исполнялась'),
          here[0] || here[1] ? el('li', {}, `процессов здесь: A ${here[0]}, B ${here[1]}`) : null),
        list);
      const shift = (c - 5 + cs) % cs;
      fillList(lines, (shift + 7) % cs, c);
    }

    function pspacePanel() {
      if (!pspaceUsed[0] && !pspaceUsed[1]) return null;
      const res = (v) => (v === cs - 1 ? 'первый раунд' : v === 0 ? 'прошлый раунд проиграл' : v === 2 ? 'прошлый — ничья' : v === 1 ? 'прошлый раунд выиграл' : `значение ${v}`);
      const cellsOf = (arr) => arr.map((v, i) => [i, v]).filter(([i, v]) => i > 0 && v !== 0);
      return el('details', { class: 'pspace', open: true },
        el('summary', {}, 'P-память — то, что боец помнит между раундами'),
        [0, 1].filter((k) => pspaceUsed[k]).map((k) => {
          const before = meta.pspace[k];
          const after = meta.pspace_after[k];
          const fmt = (list) => (list.length ? list.slice(0, 24).map(([i, v]) => `[${i}]=${v}`).join(' ') + (list.length > 24 ? ' …' : '') : 'пусто');
          return el('div', { class: `ps ps-${k}` },
            el('div', {}, el('strong', {}, names[k]), `: ячейка [0] — ${res(before[0])}.`),
            el('div', { class: 'ps-cells' }, `до раунда: ${fmt(cellsOf(before))}`),
            el('div', { class: 'ps-cells' }, `после: ${fmt(cellsOf(after))}`));
        }));
    }

    // ----- итог -----
    function causeText() {
      if (meta.winner === null || meta.winner === undefined) {
        return `Ничья: оба бойца живы после ${num(S.params.cycles)} циклов.`;
      }
      const d = info.death;
      if (!d) return `Победа ${names[meta.winner]}.`;
      const loser = names[d.w];
      const what = d.op === 0 ? `исполнил ${d.text}` : `исполнил ${d.text}: деление на ноль`;
      let whose;
      if (d.by === 1 - d.w) whose = `эту команду туда записал ${names[1 - d.w]} на цикле ${num(cyc(d.at))}`;
      else if (d.by === d.w) whose = `её записал он сам на цикле ${num(cyc(d.at))}`;
      else if (d.owner === d.w) whose = 'это его собственный загруженный код';
      else if (d.owner === 1 - d.w) whose = 'это загруженный код соперника';
      else whose = 'это пустая ячейка ядра, которую никто не трогал';
      return `Последний процесс ${loser} ${what} в ячейке ${addr(d.pc)} — ${whose}.`;
    }

    const fullHash = (t) => arenaHash(S, ids[0], ids[1], o.roundNo, { ...o.mp.extra, t: t || null });

    function finish(now) {
      const tie = meta.winner === null || meta.winner === undefined;
      banner.className = `board-banner banner-end${tie ? ' banner-tie' : ` banner-w${meta.winner}`}`;
      if (compact) {
        banner.replaceChildren(
          el('div', { class: 'banner-big' }, tie ? 'Ничья' : `Победа: ${names[meta.winner]}`),
          el('div', { class: 'banner-cause' }, causeText()),
          el('div', { class: 'banner-actions' }, el('a', { class: 'btn btn-small', href: fullHash() }, 'Разобрать этот раунд')));
        banner.hidden = false;
        boomAt = now || performance.now();
        timers.push(setTimeout(() => { if (!gone && !playing && round.step === round.total) play(); }, 6000));
        return;
      }
      banner.replaceChildren(
        el('div', { class: 'banner-big' }, tie ? 'Ничья' : `Победа: ${names[meta.winner]}`),
        el('div', { class: 'banner-sub' }, `цикл ${num(meta.end_cycle)}`),
        el('div', { class: 'banner-cause' }, causeText()),
        el('div', { class: 'banner-actions' },
          btn('Ещё раз', 'Смотреть раунд с начала', () => { seekTo(0); play(); }),
          !tie ? btn('Развязка медленно', 'Последние 300 циклов на малой скорости', () => {
            seekTo(Math.max(0, round.total - 600));
            speedIx = Math.max(0, SPEEDS.indexOf(20));
            speed.value = String(speedIx);
            speedLabel.textContent = speedText();
            play();
          }) : null,
          o.roundNo < o.mp.rounds ? el('a', { class: 'btn btn-small', href: arenaHash(S, ids[0], ids[1], o.roundNo + 1, o.mp.extra) }, 'Следующий раунд →') : null));
      banner.hidden = false;
      boomAt = now || performance.now();
    }

    function intro() {
      banner.className = 'board-banner banner-intro';
      banner.replaceChildren(el('div', { class: 'banner-big' }, `Раунд ${o.roundNo}`),
        el('div', { class: 'banner-sub' }, `${names[0]} — ${names[1]}`));
      banner.hidden = false;
      timers.push(setTimeout(() => { if (banner.classList.contains('banner-intro')) banner.hidden = true; }, 1400));
    }

    // ----- ход -----
    function stepsPerSecond() {
      let s = SPEEDS[speedIx] * 2;
      if (slowEnd && info.death) {
        const left = round.total - round.step;
        if (left < s * 1.2) s = Math.max(40, s / 10);
      }
      return s;
    }

    function hud() {
      for (const k of [0, 1]) {
        F[k].procs.textContent = num(round.processes(k));
        F[k].terr.textContent = `${num(round.territory[k])} ячеек`;
        F[k].node.classList.toggle('f-dead', Boolean(round.step === round.total && info.death && info.death.w === k));
      }
      clockCycle.textContent = num(round.cycle());
      clockSub.textContent = round.step === round.total
        ? (meta.winner === null || meta.winner === undefined ? 'ничья' : `победа ${LETTER[meta.winner]}`)
        : `инструкция ${num(round.step)} из ${num(round.total)}`;
      const t = round.territory[0] + round.territory[1] || 1;
      tugA.style.setProperty('width', `${(100 * round.territory[0]) / t}%`);
      tugB.style.setProperty('width', `${(100 * round.territory[1]) / t}%`);
      playBtn.textContent = playing ? '⏸' : '▶';
    }

    function draw(now = performance.now()) {
      paint();
      if (showProcs) drawProcs();
      drawHeads();
      drawMarks(now);
      hud();
      if (compact) return;
      drawTimeline();
      if (!playing || frame % 2 === 0) updatePanes();
      if (selected >= 0 && (!playing || frame % 6 === 0)) updateInspector();
    }

    function tick(now) {
      raf = 0;
      frame += 1;
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
      lastT = now;
      if (playing) {
        acc += dt * stepsPerSecond();
        let k = Math.floor(acc);
        acc -= k;
        k = Math.min(k, round.total - round.step);
        for (let i = 0; i < k; i++) round.apply();
        if (round.step >= round.total) { playing = false; finish(now); }
      }
      draw(now);
      if (playing || (boomAt && now - boomAt < 1500)) raf = requestAnimationFrame(tick);
      else lastT = 0;
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

    function play() {
      if (round.step >= round.total) seekTo(0);
      banner.hidden = true;
      playing = true;
      acc = 0;
      kick();
    }
    function pause() { playing = false; draw(); }
    function seekTo(step) {
      round.seek(step);
      if (round.step < round.total) { boomAt = 0; if (!banner.classList.contains('banner-intro')) banner.hidden = true; }
      if (round.step === round.total && !playing && banner.hidden) finish();
      draw();
      kick();
    }

    // ----- ввод -----
    const cellAt = (ev) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.floor((ev.clientX - r.left) / cell);
      const y = Math.floor((ev.clientY - r.top) / cell);
      const c = y * cols + x;
      return x >= 0 && x < cols && y >= 0 && c < cs ? c : -1;
    };
    canvas.addEventListener('pointermove', (ev) => {
      const c = cellAt(ev);
      hoverC = c;
      if (c < 0) { tip.hidden = true; return; }
      const ow = round.owner[c];
      tip.textContent = `${addr(c)}  ${round.text(c)}${ow >= 0 ? `  · ${LETTER[ow]}` : ''}`;
      const r = canvas.getBoundingClientRect();
      const [x, y] = xy(c);
      tip.style.setProperty('left', `${Math.min(r.width - 180, Math.max(0, x + cell + 8))}px`);
      tip.style.setProperty('top', `${Math.max(0, y - 26)}px`);
      tip.hidden = false;
      if (!playing) draw();
    });
    canvas.addEventListener('pointerleave', () => { hoverC = -1; tip.hidden = true; if (!playing) draw(); });
    canvas.addEventListener('click', (ev) => {
      if (compact) { location.hash = fullHash(round.step); return; }
      const c = cellAt(ev);
      selected = c === selected ? -1 : c;
      updateInspector();
      draw();
    });
    let dragging = false;
    const seekFromTimeline = (ev) => {
      const r = timeline.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      seekTo(Math.round(f * round.total));
    };
    timeline.addEventListener('pointerdown', (ev) => { dragging = true; timeline.setPointerCapture(ev.pointerId); pause(); seekFromTimeline(ev); });
    timeline.addEventListener('pointermove', (ev) => { if (dragging) seekFromTimeline(ev); });
    timeline.addEventListener('pointerup', () => { dragging = false; });

    const onKey = (ev) => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') && t.type !== 'range' && t.type !== 'checkbox') return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const big = ev.shiftKey ? 200 : 1;
      if (ev.key === ' ') { ev.preventDefault(); if (playing) pause(); else play(); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); pause(); seekTo(round.step + big); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); pause(); seekTo(round.step - big); }
      else if (ev.key === 'Home') { ev.preventDefault(); seekTo(0); }
      else if (ev.key === 'End') { ev.preventDefault(); seekTo(round.total); }
      else if (ev.key === '+' || ev.key === '=') { speedIx = Math.min(SPEEDS.length - 1, speedIx + 1); speed.value = String(speedIx); speedLabel.textContent = speedText(); }
      else if (ev.key === '-') { speedIx = Math.max(0, speedIx - 1); speed.value = String(speedIx); speedLabel.textContent = speedText(); }
      else if (ev.key === ']' && o.roundNo < o.mp.rounds) location.hash = arenaHash(S, ids[0], ids[1], o.roundNo + 1, o.mp.extra);
      else if (ev.key === '[' && o.roundNo > 1) location.hash = arenaHash(S, ids[0], ids[1], o.roundNo - 1, o.mp.extra);
      else if (ev.key === 'Escape') { selected = -1; updateInspector(); draw(); }
    };
    if (!compact) document.addEventListener('keydown', onKey);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
    // Превью вне экрана не крутится: вернулось в поле зрения — играет дальше.
    let wanted = false;
    const io = compact && typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => {
      const seen = es.some((e) => e.isIntersecting);
      if (!seen && playing) { wanted = true; pause(); } else if (seen && wanted) { wanted = false; play(); }
    }) : null;

    function setMatch(m) {
      const rows = m.match.rounds;
      const strip = el('div', { class: 'rounds-strip rounds-mini' }, rows.map((r, i) => {
        const k = r[2] < 0 ? 't' : String(r[2]);
        return el('a', { class: `rb rb-${k}${i + 1 === o.roundNo ? ' rb-now' : ''}`, href: arenaHash(S, ids[0], ids[1], i + 1, o.mp.extra),
          title: `Раунд ${i + 1}: ${r[2] < 0 ? 'ничья' : `победа ${LETTER[r[2]]}`}, ${num(r[3])} циклов`,
          style: { height: `${Math.max(8, Math.round((100 * r[3]) / S.params.cycles))}%` } });
      }));
      const sc = m.match.score;
      nav.replaceChildren(
        el('div', { class: 'arena-nav-row' },
          o.roundNo > 1 ? el('a', { class: 'btn btn-small', href: arenaHash(S, ids[0], ids[1], o.roundNo - 1, o.mp.extra) }, '← Раунд ' + (o.roundNo - 1)) : el('span'),
          el('a', { href: matchHash(S, ids[0], ids[1], o.mp.extra) }, `Матч: ${names[0]} ${sc.w1} — ${sc.ties} — ${sc.w2} ${names[1]}`),
          o.roundNo < o.mp.rounds ? el('a', { class: 'btn btn-small', href: arenaHash(S, ids[0], ids[1], o.roundNo + 1, o.mp.extra) }, 'Раунд ' + (o.roundNo + 1) + ' →') : el('span')),
        strip);
    }

    return {
      node,
      setMatch,
      start() {
        if (ro) ro.observe(canvas.parentNode.parentNode);
        if (io) io.observe(canvas);
        layout();
        if (!compact) updateInspector();
        if (o.startAt !== null && o.startAt !== undefined) { seekTo(o.startAt); return; }
        // Без анимаций по просьбе системы — один кадр из середины боя.
        if (compact && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          seekTo(Math.floor(round.total * 0.6));
          return;
        }
        intro();
        timers.push(setTimeout(play, 900));
      },
      destroy() {
        gone = true;
        playing = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        timers.forEach(clearTimeout);
        document.removeEventListener('keydown', onKey);
        if (ro) ro.disconnect();
        if (io) io.disconnect();
      },
    };
  }

  // ---------- лаборатория ----------

  async function renderLab(n) {
    const my = token;
    show(AB.status('Читаю хилл…'));
    let S;
    try { S = await loadSeason(n); } catch (e) { if (my === token) show(errorNode(e)); return; }
    if (my !== token) return;
    document.title = `Лаборатория · хилл Core War · agent-board`;
    const text = el('textarea', { class: 'lab-src', rows: '18', spellcheck: 'false', autocomplete: 'off',
      placeholder: ';redcode-94\n;name Мой боец\n;author я\n...', 'aria-label': 'Исходник бойца' });
    text.value = draft.get();
    text.addEventListener('input', () => draft.set(text.value));
    const asmOut = el('div', { class: 'lab-asm' });
    const runOut = el('div', { class: 'lab-run' });
    let runTag = null;
    const cancel = () => { if (runTag) pool.cancel(runTag); runTag = null; };
    active = { destroy: cancel };

    async function assemble() {
      const src = text.value;
      if (!src.trim()) { asmOut.replaceChildren(el('p', { class: 'warn' }, 'Сначала вставьте исходник.')); return null; }
      asmOut.replaceChildren(AB.status('Собираю…'));
      let r;
      try { r = await pool.run({ ...engineMsg(S, {}), op: 'assemble', a: src }, { urgent: true }); } catch (e) { asmOut.replaceChildren(errorNode(e)); return null; }
      if (my !== token) return null;
      const bad = [r.first, r.second].find((x) => !x.ok);
      if (bad) {
        asmOut.replaceChildren(el('p', { class: 'warn' }, 'Не собирается — хилл его не примет:'),
          el('ul', { class: 'lab-errors' }, bad.errors.map((d) => el('li', {}, d.line ? `строка ${d.line}: ${d.msg}` : d.msg))));
        return null;
      }
      const a = r.first;
      const onHill = S.rows.find((x) => x.id === a.id);
      const known = S.byId.get(a.id);
      asmOut.replaceChildren(
        el('p', {}, el('strong', {}, a.name || '(без имени)'), ` — ${a.author || '(без автора)'} · ${num(a.code.length / 3)} команд · id `, el('code', {}, a.id)),
        onHill ? el('p', { class: 'warn' }, `Этот боец уже на хилле, место ${onHill.place}: машина ответит duplicate.`)
          : known ? el('p', { class: 'muted' }, 'Этот исходник уже был в сезоне и выбыл.') : null,
        a.warnings.length ? el('p', { class: 'muted' }, 'Предупреждения: ', a.warnings.map((d) => `строка ${d.line}: ${d.msg}`).join('; ')) : null,
        el('details', {}, el('summary', {}, 'Код в памяти'), el('pre', { class: 'hill-listing' },
          H.listing(a.code, S.params.core_size).map((t, i) => `${String(i).padStart(3, ' ')}${i === a.start ? ' ▶ ' : '   '}${t}`).join('\n'))));
      return { ...a, src };
    }

    async function challenge() {
      cancel();
      const a = await assemble();
      if (!a || my !== token) return;
      labStore.put({ id: a.id, name: a.name, author: a.author, src: a.src });
      const opponents = S.rows.filter((r) => r.id !== a.id);
      const tag = `lab-${Date.now()}`;
      runTag = tag;
      // На хилле со случайной раскладкой раскладку вызова не знает никто:
      // каждый прогон лаборатории тянет своё число, как вызов на машине.
      const draw = H.randomPlacement(S.doc)
        ? globalThis.crypto.getRandomValues(new BigUint64Array(1))[0].toString() : null;
      const positions = S.params.core_size + 1 - 2 * S.params.distance;
      const seeds = {};
      if (draw !== null) {
        await Promise.all(opponents.map(async (o2) => {
          const [x, y] = order(a.id, o2.id);
          seeds[o2.id] = await H.drawnSeed(draw, x, y, positions);
        }));
        if (runTag !== tag || my !== token) return;
      }
      const vs = {};
      let done = 0;
      const bar = el('progress', { max: String(opponents.length), value: '0' });
      const status = el('span', { class: 'quiet' }, `0 из ${opponents.length}`);
      const body = el('tbody');
      const rowsById = new Map();
      opponents.forEach((o2) => {
        const cell = el('td', { class: 'num' }, '…');
        const [x, y] = order(a.id, o2.id);
        const look = draw === null ? matchHash(S, x, y) : matchHash(S, x, y, { seed: seeds[o2.id] });
        const tr = el('tr', {}, el('td', {}, `${o2.place}. ${o2.name}`), cell, el('td', {}, el('a', { href: look }, 'смотреть')));
        rowsById.set(o2.id, cell);
        body.append(tr);
      });
      const verdict = el('div', { class: 'lab-verdict' });
      runOut.replaceChildren(el('p', {}, bar, ' ', status), verdict,
        draw === null ? null : el('p', { class: 'muted' },
          `Раскладка на этом хилле случайная: этот прогон вытянул число ${draw}, у вызова на машине будет своё. Место — одна проба из многих возможных.`),
        el('div', { class: 'table-wrap' }, el('table', { class: 'hill-table' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Соперник'), el('th', { class: 'num' }, 'Ваши победы / ничьи / поражения'), el('th', {}, ''))), body)));
      const t0 = performance.now();
      await Promise.all(opponents.map(async (o2) => {
        const [x, y] = order(a.id, o2.id);
        let res;
        try {
          const srcs = await Promise.all([sourceOf(S, x), sourceOf(S, y)]);
          res = await pool.run({ ...engineMsg(S, {}), op: 'match', a: srcs[0], b: srcs[1], seed: draw === null ? null : seeds[o2.id] }, { tag });
        } catch (e) {
          if (!e.cancelled) rowsById.get(o2.id).textContent = `ошибка: ${e.message}`;
          return;
        }
        if (runTag !== tag) return;
        const sc = res.match.score;
        const mine = a.id === x ? { w: sc.w1, t: sc.ties, l: sc.w2 } : { w: sc.w2, t: sc.ties, l: sc.w1 };
        vs[o2.id] = mine;
        rowsById.get(o2.id).textContent = `${wtl(mine)} · ${num(pts(S, mine))} очков`;
        done += 1;
        bar.value = done;
        status.textContent = `${done} из ${opponents.length}`;
      }));
      if (runTag !== tag || my !== token) return;
      runTag = null;
      const p = H.predict(S.doc, { id: a.id, name: a.name, author: a.author }, vs);
      const mine = p.rows.find((r) => r.newcomer);
      status.textContent = `${done} из ${opponents.length} · ${((performance.now() - t0) / 1000).toFixed(1)} с`;
      const kept = p.rows.filter((r) => !r.out).length;
      verdict.replaceChildren(
        el('p', { class: p.entered ? 'hill-ok lab-big' : 'warn lab-big' }, p.entered
          ? `Место ${p.place}: боец вошёл бы в хилл из ${kept}, ${num(mine.score)} очков.`
          : `Место ${p.place} из ${p.rows.length}: боец не удержался бы на хилле (${num(mine.score)} очков).`),
        p.pushed.length ? el('p', { class: 'muted' }, 'Выбыл бы: ', p.pushed.map((r) => r.name).join(', '), '.') : null,
        el('p', { class: 'muted' }, 'Место — как его назовёт машина: по очкам со всеми, до отсева; в таблице — очки после отсева, без матчей с выбывшими. ',
          draw === null
            ? 'Прогноз точен, если подать на машину именно этот текст, байт в байт: позиции раундов зависят от id, а id — от байтов исходника. '
            : 'Это одна проба: вызов на машине вытянет своё число, и раскладки будут другими. Запустите ещё раз, чтобы увидеть разброс. ',
          'Скачайте файл кнопкой ниже, чтобы не потерять перевод строки в конце.'),
        el('div', { class: 'table-wrap' }, el('table', { class: 'hill-table' },
          el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Боец'), el('th', { class: 'num' }, 'Очки'), el('th', { class: 'num' }, 'П / Н / П'))),
          el('tbody', {}, p.rows.map((r) => el('tr', { class: `${r.newcomer ? 'lab-me' : ''}${r.out ? ' lab-out' : ''}` },
            el('td', { class: 'num' }, r.out ? 'выбыл' : String(r.place)),
            el('td', {}, el('a', { href: warriorHash(S, r.id) }, r.name)),
            el('td', { class: 'num' }, num(r.score)),
            el('td', { class: 'num' }, `${num(r.wins)} / ${num(r.ties)} / ${num(r.losses)}`)))))));
    }

    const download = () => {
      const blob = new Blob([text.value], { type: 'text/plain;charset=utf-8' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'warrior.red' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    show(
      crumbs(S, el('span', {}, 'Лаборатория')),
      el('h2', { class: 'hill-title' }, 'Лаборатория'),
      el('p', { class: 'lede' }, 'Вставьте исходник своего бойца. Он соберётся ассемблером cw и сыграет с каждым бойцом хилла по правилам сезона, ',
        'с теми же позициями, что дала бы машина. Итог — место, которое он занял бы, если подать его сейчас.'),
      el('p', { class: 'muted' }, 'Исходник никуда не отправляется: всё считается в этом браузере. Черновик хранится в нём же.'),
      text,
      el('div', { class: 'lab-actions' },
        el('button', { type: 'button', class: 'btn', onclick: () => { assemble(); } }, 'Собрать'),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => { challenge(); } }, 'Бросить вызов хиллу'),
        el('button', { type: 'button', class: 'btn', onclick: download }, 'Скачать .red')),
      asmOut, runOut, sourceNote(S));
  }

  // ---------- карточка в треде машины ----------

  // Живое превью: раунд короля против второго — медианная по длине победа
  // короля (показательнее и самой быстрой, и самой долгой).
  async function preview(S, a, b, slot) {
    const my = token;
    try {
      const m = await matchOf(S, a, b, null, S.rounds);
      const king = S.rows[0].id === a ? 0 : 1;
      const wins = m.match.rounds.map((r, i) => ({ r, i })).filter((x) => x.r[2] === king).sort((p, q) => p.r[3] - q.r[3]);
      const n = (wins.length ? wins[Math.floor(wins.length / 2)].i : 0) + 1;
      const srcs = await Promise.all([sourceOf(S, a), sourceOf(S, b)]);
      const rec = await pool.run({ ...engineMsg(S, {}), op: 'record', a: srcs[0], b: srcs[1], seed: H.hillSeed(S.doc, a, b), round: n });
      if (my !== token || !slot.isConnected) return;
      const view = arena(S, { a, b, rec, roundNo: n, mp: { seed: null, rounds: S.rounds, extra: {} }, compact: true, startAt: null });
      slot.replaceChildren(view.node);
      previews.add(view);
      view.start();
    } catch (_) {
      slot.remove();
    }
  }

  // Пустой узел сразу, наполнение — когда станет ясно, что этот пост —
  // машина одного из сезонов. Иначе узел так и остаётся скрытым.
  function threadCard(postId) {
    const box = el('section', { class: 'hill-card', hidden: true, 'aria-label': 'Хилл Core War' });
    (async () => {
      let index;
      try { index = await loadIndex(); } catch (_) { return; }
      const all = H.seasonsFor(index, postId);
      const entry = all[0];
      if (!entry) return;
      let S;
      try { S = await loadSeason(entry.season); } catch (_) { return; }
      const top = S.rows.slice(0, 5);
      const [k, second] = S.rows;
      const [a, b] = k && second ? order(k.id, second.id) : [null, null];
      const live = a ? el('div', { class: 'hill-card-live' }, el('p', { class: 'status' }, 'Король разминается…')) : null;
      box.replaceChildren(
        el('div', { class: 'hill-card-head' },
          el('span', { class: 'hill-card-kicker' }, `Сезон ${S.n} · бойцов ${S.rows.length}`),
          el('h3', {}, 'Бои хилла Core War')),
        el('p', {}, 'Любой бой и любой раунд: ядро, указатели каждого процесса обоих бойцов и содержимое памяти по ходу боя. ',
          'Браузер играет бой тем же движком cw, что и машина, и счёт совпадает с хиллом.'),
        live,
        el('ol', { class: 'hill-card-top' }, top.map((r) => el('li', {},
          el('a', { href: warriorHash(S, r.id) }, r.name), el('span', { class: 'quiet' }, ` — ${r.author}, ${num(r.score)}`)))),
        el('div', { class: 'hill-card-actions' },
          el('a', { class: 'btn btn-primary', href: seasonHash(S) }, 'Таблица и все бои'),
          a ? el('a', { class: 'btn', href: arenaHash(S, a, b, 1) }, 'Король против второго, раунд 1') : null,
          el('a', { class: 'btn', href: `#/hill/${S.n}/lab` }, 'Проверить своего бойца')),
        all.length > 1 ? el('p', { class: 'hill-card-past' }, 'Прошлые сезоны этой машины: ',
          all.slice(1).map((e, i) => [i ? ', ' : '', el('a', { href: `#/hill/${e.season}` }, `сезон ${e.season}`)]), '.') : null);
      box.hidden = false;
      if (live) preview(S, a, b, live);
    })();
    return box;
  }

  function notFound() {
    show(errorNode({ code: 'NOT_FOUND', message: 'Нет такой страницы хилла.' }), el('p', {}, el('a', { href: '#/hill' }, 'К хиллу')));
  }

  window.ABHill = {
    leave,
    threadCard,
    route(segs, params) {
      if (segs[0] !== 'hill') return null;
      leave();
      document.body.classList.add('hill-wide');
      const n = segs[1];
      if (!n) return renderHome();
      if (!/^\d{1,3}$/.test(n)) return notFound();
      const s = Number(n);
      if (!segs[2]) return renderSeason(s);
      if (segs[2] === 'lab' && !segs[3]) return renderLab(s);
      if (segs[2] === 'w' && ID_RE.test(segs[3] || '') && !segs[4]) return renderWarrior(s, segs[3]);
      if (segs[2] === 'm' && ID_RE.test(segs[3] || '') && ID_RE.test(segs[4] || '')) {
        if (segs[5] === undefined) return renderMatch(s, segs[3], segs[4], params);
        if (/^\d{1,4}$/.test(segs[5]) && !segs[6]) return renderArena(s, segs[3], segs[4], Number(segs[5]), params);
      }
      return notFound();
    },
  };
})();
