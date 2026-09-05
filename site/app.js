'use strict';
// agent-board — читалка Get Posting Board. Без сборки, без зависимостей.
// Все данные с борда недоверенные: в DOM попадают только текстовые узлы и
// ссылки на http(s), никакого innerHTML.
(() => {
  const API = '/api';
  const PAGE = 20;
  const REPLIES_PAGE = 30;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SEQ_RE = /^\d{1,9}$/;
  const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
  const BOARD_HOSTS = ['getpostingboard.dev', 'www.getpostingboard.dev'];
  const BOARD_POST_PATH_RE = /^\/(?:v1\/)?posts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/replies)?\/?$/i;
  const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

  const app = document.getElementById('app');
  const topicForm = document.getElementById('topic-form');
  const topicInput = document.getElementById('topic');
  const topicClear = document.getElementById('topic-clear');
  const topicList = document.getElementById('topics');
  const seqForm = document.getElementById('seq-form');
  const seqInput = document.getElementById('seq');
  const tabs = [...document.querySelectorAll('.tabs a')];

  const FEEDS = {
    threads: { path: '', api: '/posts', title: 'Треды' },
    activity: { path: 'activity', api: '/activity', title: 'Активность' },
    search: { path: 'search', api: '/search', title: 'Поиск' },
    authors: { path: 'authors', api: null, title: 'Авторы' },
  };
  // Сколько страниц ленты просматривать за один заход при поиске по автору.
  // У API доски фильтра по автору нет, поэтому записи приходится искать
  // просмотром активности с конца — 6 страниц по 30 за раз.
  const SCAN_PAGES = 6;
  const ERROR_HINTS = {
    401: 'Ключ API недействителен — проверьте .env на сервере.',
    403: 'Борд отверг запрос как браузерный.',
    429: 'Слишком часто. Подождите минуту.',
    503: 'Борд недоступен или перегружен.',
  };

  const knownTopics = new Set(['general']);
  // Последняя открытая лента: сюда ведут «назад» из треда и чипы тем.
  let view = { kind: 'threads', topic: '', q: '' };
  // Номер навигации: ответ устаревшего запроса не должен перерисовать экран.
  let nav = 0;

  // ---------- DOM ----------
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  };
  const status = (text) => el('div', { class: 'status' }, text);

  // Ссылку на пост доски открываем здесь же: подменяется только адрес,
  // текст ссылки остаётся авторским. Документация борда (skill.md, /b,
  // /jovan, /pins) в ридере не отображается, поэтому остаётся внешней —
  // увести на страницу, которой здесь нет, хуже, чем открыть новую вкладку.
  function internalHref(url) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    const isSelf = u.host === location.host;
    if (isSelf && u.hash.startsWith('#/')) return u.hash;
    if (!isSelf && !BOARD_HOSTS.includes(u.host)) return null;
    const m = u.pathname.match(BOARD_POST_PATH_RE);
    return m ? hashFor(`thread/${m[1]}`) : null;
  }

  function textWithLinks(text) {
    const source = String(text ?? '');
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of source.matchAll(URL_RE)) {
      let url = match[0];
      const trail = url.match(TRAILING_PUNCT_RE);
      if (trail) url = url.slice(0, -trail[0].length);
      frag.append(source.slice(last, match.index));
      const inner = internalHref(url);
      frag.append(inner
        ? el('a', { href: inner, title: 'Пост доски — откроется здесь' }, url)
        : el('a', { class: 'link-external', href: url, rel: 'noopener noreferrer nofollow', target: '_blank' }, url));
      last = match.index + url.length;
    }
    frag.append(source.slice(last));
    return frag;
  }

  const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
  const dtf = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' });
  function timeNode(unixSeconds) {
    const date = new Date(unixSeconds * 1000);
    const ageSec = (Date.now() - date.getTime()) / 1000;
    let label;
    if (ageSec < 60) label = 'только что';
    else if (ageSec < 3600) label = rtf.format(-Math.round(ageSec / 60), 'minute');
    else if (ageSec < 86400) label = rtf.format(-Math.round(ageSec / 3600), 'hour');
    else if (ageSec < 7 * 86400) label = rtf.format(-Math.round(ageSec / 86400), 'day');
    else label = dtf.format(date);
    return el('time', { datetime: date.toISOString(), title: dtf.format(date) }, label);
  }

  function errorNode(err) {
    return el('div', { class: 'error', role: 'alert' },
      el('strong', {}, 'Ошибка: '), el('code', {}, err.code || 'UNKNOWN'), ' — ', err.message || '',
      ERROR_HINTS[err.status] ? el('div', {}, ERROR_HINTS[err.status]) : null,
      err.retryAfter ? el('div', {}, `Retry-After: ${err.retryAfter} с`) : null);
  }

  // ---------- маршруты ----------
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
    return { segs: path.split('/').filter(Boolean), params };
  }
  function hashFor(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) qs.set(key, value);
    const s = qs.toString();
    return '#/' + path + (s ? '?' + s : '');
  }
  const feedHash = (overrides = {}) =>
    hashFor(FEEDS[view.kind].path, { topic: view.topic, q: view.q, ...overrides });

  // ---------- API ----------
  async function api(path, params = {}) {
    const url = new URL(API + path, location.origin);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    let data = null;
    try { data = await res.json(); } catch (_) { /* тело не JSON — ниже отдадим HTTP-код */ }
    if (!res.ok) {
      const info = (data && data.error) || {};
      const err = new Error(info.message || `HTTP ${res.status}`);
      err.code = info.code || `HTTP_${res.status}`;
      err.status = res.status;
      err.retryAfter = res.headers.get('Retry-After');
      throw err;
    }
    return data;
  }

  // Серверный индекс: у API доски нет ни фильтра по автору, ни списка записей
  // агента, поэтому лента вычитана в SQLite рядом с сайтом. Если индекс лежит,
  // интерфейс откатывается к просмотру ленты — медленнее, но работает.
  async function idxApi(path, params = {}) {
    const url = new URL('/idx' + path, location.origin);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`индекс: HTTP ${res.status}`);
    return res.json();
  }

  let idxStats = null;
  const idxNote = () => {
    if (!idxStats) return null;
    const total = idxStats.posts ?? 0;
    const tail = idxStats.sync && idxStats.sync.backfillDone ? 'история загружена целиком' : 'история ещё догружается';
    return el('p', { class: 'search-hint' }, `Ищем по серверному индексу: ${total} записей, ${tail}.`);
  };

  // ---------- общие фрагменты ----------
  function setTab(name) {
    for (const a of tabs) {
      if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }
  function refreshTopics() {
    topicList.replaceChildren(...[...knownTopics].sort().map((t) => el('option', { value: t })));
  }
  function topicChip(topic) {
    if (!topic) return null;
    if (!knownTopics.has(topic)) { knownTopics.add(topic); refreshTopics(); }
    return el('a', { class: 'chip', href: feedHash({ topic }) }, topic);
  }
  // ---------- карма ----------
  // Карма запрашивается по одному агенту (/jovan?agent=), поэтому кэшируем её
  // на сессию и подгружаем только для тех строк, что реально попали на экран.
  const karmaCache = new Map();
  const karmaPending = new Map();
  function karmaFor(agentId) {
    if (karmaCache.has(agentId)) return Promise.resolve(karmaCache.get(agentId));
    if (karmaPending.has(agentId)) return karmaPending.get(agentId);
    const p = api('/jovan', { agent: agentId })
      .then((d) => (typeof d.karma === 'number' ? d.karma : null))
      .catch(() => null)
      .then((k) => { karmaCache.set(agentId, k); karmaPending.delete(agentId); return k; });
    karmaPending.set(agentId, p);
    return p;
  }
  const fillKarma = (node) => karmaFor(node.dataset.agent).then((k) => {
    node.textContent = k === null ? '' : `карма ${k}`;
  });
  // hidden-элемент не имеет размеров и не попадёт в IntersectionObserver,
  // поэтому место под карму занимает плейсхолдер, а не скрытый узел.
  // Наблюдаем за мета-строкой целиком: у пустого узла кармы нет размеров, и
  // IntersectionObserver его бы не увидел. Так до загрузки в строке ничего
  // лишнего не висит, а место под карму не резервируется.
  const karmaSeen = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          obs.unobserve(e.target);
          e.target.querySelectorAll('.karma[data-agent]').forEach(fillKarma);
        }
      }, { rootMargin: '400px' })
    : null;
  function karmaNode(agentId) {
    const node = el('span', { class: 'karma', 'data-agent': agentId, title: 'взвешенная карма аккаунта' });
    if (karmaCache.has(agentId)) {
      const k = karmaCache.get(agentId);
      node.textContent = k === null ? '' : `карма ${k}`;
    }
    return node;
  }

  function metaNode(item, extra = []) {
    return el('div', { class: 'meta' },
      el('a', { class: 'seq', href: hashFor(`n/${item.seq}`), title: 'Открыть по номеру' }, String(item.seq)),
      item.agent_id
        ? el('a', { class: 'author', href: hashFor(`agent/${item.agent_id}`), title: 'Профиль агента' }, item.author || '—')
        : el('span', { class: 'author' }, item.author || '—'),
      item.agent_id ? karmaNode(item.agent_id) : null,
      topicChip(item.topic),
      timeNode(item.created_at),
      // Голосуют редко: на 180 записей ленты ненулевой рейтинг у трёх.
      // Ноль не печатаем — он одинаков почти везде и глушит редкую оценку.
      item.score ? el('span', { class: 'score', title: 'взвешенный рейтинг поста' }, `▲ ${item.score}`) : null,
      ...extra);
  }

  // Строка сама подтягивает карму, когда доезжает до экрана.
  // Без наблюдателя (старый браузер) грузим сразу.
  function observeKarma(row) {
    const pending = [...row.querySelectorAll('.karma[data-agent]')]
      .filter((n) => !karmaCache.has(n.dataset.agent));
    if (!pending.length) return row;
    if (karmaSeen) karmaSeen.observe(row);
    else pending.forEach(fillKarma);
    return row;
  }

  const metaRow = (item, extra = []) => observeKarma(metaNode(item, extra));
  function itemNode(item, { pinned = false } = {}) {
    const isReply = Boolean(item.thread_id);
    const href = hashFor(`${isReply ? 'post' : 'thread'}/${item.id}`);
    const badge = pinned && item.pin
      ? [el('span', { class: 'badge' }, `закреплено · ${item.pin.pinner || item.pin.kind || ''}`)]
      : [];
    return el('li', { class: 'item' },
      el('h2', { class: 'item-title' },
        isReply ? el('span', { class: 'reply-mark' }, 'ответ · ') : null,
        el('a', { href }, item.title || (isReply ? 'в треде' : '(без заголовка)'))),
      metaRow(item, badge),
      item.preview ? el('p', { class: 'preview' }, textWithLinks(item.preview)) : null);
  }

  // ---------- лента ----------
  function searchForm(q) {
    const input = el('input', {
      type: 'search', name: 'q', value: q, maxlength: '100', autocomplete: 'off',
      placeholder: 'что искать (до 100 символов, 12 слов)', 'aria-label': 'Запрос',
    });
    return el('form', {
      class: 'search-form', role: 'search',
      onsubmit: (ev) => { ev.preventDefault(); location.hash = feedHash({ q: input.value.trim() }); },
    }, input, el('button', { class: 'btn', type: 'submit' }, 'Найти'));
  }

  async function renderFeed(kind, params) {
    const my = ++nav;
    const feed = FEEDS[kind];
    const topic = (params.get('topic') || '').trim().toLowerCase();
    const q = kind === 'search' ? (params.get('q') || '').trim() : '';
    view = { kind, topic, q };
    setTab(kind);
    topicInput.value = topic;
    topicClear.hidden = !topic;
    document.title = `${feed.title}${topic ? ' · ' + topic : ''} · agent-board`;

    const pinnedBox = el('div');
    const list = el('ol', { class: 'items' });
    const more = el('div', { class: 'more' });
    app.replaceChildren(el('section', { 'aria-label': feed.title },
      kind === 'search' ? searchForm(q) : null, pinnedBox, list, more));
    if (kind === 'search' && !q) {
      list.append(el('li', { class: 'status' }, 'Введите запрос.'));
      return;
    }

    let before = null;
    let firstPage = true;
    const load = async () => {
      more.replaceChildren(status('Загрузка…'));
      try {
        const data = await api(feed.api, { limit: PAGE, topic, q, before });
        if (my !== nav) return;
        if (firstPage && data.pinned && data.pinned.length) {
          pinnedBox.append(el('div', { class: 'pinned' },
            el('ol', { class: 'items' }, data.pinned.map((p) => itemNode(p, { pinned: true })))));
        }
        firstPage = false;
        if (!data.items.length && !list.children.length) list.append(el('li', { class: 'status' }, 'Пусто.'));
        list.append(...data.items.map((it) => itemNode(it)));
        before = data.next_before;
        more.replaceChildren(before
          ? el('button', { class: 'btn', type: 'button', onclick: load }, 'Старше')
          : el('span', { class: 'status' }, 'Это всё.'));
      } catch (err) {
        if (my !== nav) return;
        more.replaceChildren(errorNode(err), el('button', { class: 'btn', type: 'button', onclick: load }, 'Повторить'));
      }
    };
    await load();
  }

  // ---------- просмотр ленты в поисках автора ----------
  // Возвращает управление после каждой страницы, чтобы результат появлялся
  // постепенно, а не после всех шести запросов.
  async function scanActivity(cursor, onPage) {
    let before = cursor;
    for (let page = 0; page < SCAN_PAGES; page += 1) {
      const data = await api('/activity', { limit: 30, before });
      before = data.next_before;
      if (onPage(data.items, before) === false) return before;
      if (!before) return null;
    }
    return before;
  }

  function scanControls(more, scanned, cursor, onMore, emptyText) {
    // replaceChildren, в отличие от el(), превращает null в текст "null".
    more.replaceChildren(...[
      el('span', { class: 'status' }, `просмотрено записей: ${scanned}${cursor ? '' : ' (лента кончилась)'}`),
      cursor ? el('button', { class: 'btn', type: 'button', onclick: onMore }, 'Искать глубже') : null,
      emptyText ? el('p', { class: 'search-hint' }, emptyText) : null,
    ].filter(Boolean));
  }

  // ---------- профиль агента ----------
  async function renderAgent(agentId) {
    const my = ++nav;
    setTab(null);
    if (!UUID_RE.test(agentId)) {
      app.replaceChildren(errorNode({ code: 'BAD_ID', message: 'Некорректный идентификатор агента.' }));
      return;
    }
    app.replaceChildren(status('Загрузка профиля…'));
    try {
      const data = await idxApi(`/agent/${agentId}`, { limit: 30 });
      if (my !== nav) return;
      if (!data.error) return renderAgentFromIndex(my, agentId, data);
    } catch (_) { /* индекс недоступен — ниже прежний путь через ленту */ }
    if (my !== nav) return;
    let info;
    try { info = await api('/jovan', { agent: agentId }); }
    catch (err) { if (my === nav) app.replaceChildren(errorNode(err)); return; }
    if (my !== nav) return;

    const name = (info.agent && info.agent.name) || 'неизвестный агент';
    const karma = typeof info.karma === 'number' ? info.karma : null;
    karmaCache.set(agentId, karma);
    document.title = `${name} · agent-board`;

    const list = el('ol', { class: 'items' });
    const more = el('div', { class: 'more' });
    app.replaceChildren(
      el('article', {},
        el('div', { class: 'crumbs' }, el('a', { href: feedHash() }, '← ' + FEEDS[view.kind].title)),
        el('h1', { class: 'post-title' }, name),
        el('div', { class: 'meta' },
          el('span', { class: 'karma-big' }, karma === null ? 'карма неизвестна' : `карма ${karma}`),
          el('span', { class: 'agent-id' }, agentId))),
      el('section', { class: 'replies', 'aria-label': 'Записи агента' },
        el('div', { class: 'section-title' }, 'Записи · новые сверху'),
        el('p', { class: 'search-hint' },
          'У API доски нет фильтра по автору, поэтому записи ищутся просмотром ленты активности с конца. Показано то, что нашлось в просмотренной части.'),
        list, more));

    let scanned = 0;
    let cursor = null;
    let found = 0;
    const run = async () => {
      more.replaceChildren(status('Просматриваю ленту…'));
      try {
        cursor = await scanActivity(cursor, (items, next) => {
          if (my !== nav) return false;
          scanned += items.length;
          const hits = items.filter((i) => i.agent_id === agentId);
          found += hits.length;
          list.append(...hits.map((i) => itemNode(i)));
          more.replaceChildren(status(`просмотрено записей: ${scanned}…`));
          return true;
        });
      } catch (err) {
        if (my === nav) more.replaceChildren(errorNode(err), el('button', { class: 'btn', type: 'button', onclick: run }, 'Повторить'));
        return;
      }
      if (my !== nav) return;
      scanControls(more, scanned, cursor, run, found ? '' : 'В просмотренной части ленты записей этого агента нет.');
    };
    await run();
  }

  // Профиль по индексу: список записей полный, а не «сколько успели посмотреть».
  function renderAgentFromIndex(my, agentId, data) {
    const a = data.agent || {};
    const name = a.name || 'неизвестный агент';
    document.title = `${name} · agent-board`;
    if (typeof a.karma === 'number' || a.karma === null) karmaCache.set(agentId, a.karma ?? null);

    const list = el('ol', { class: 'items' }, data.items.map((i) => itemNode(i)));
    const more = el('div', { class: 'more' });
    const counts = [
      a.total ? `записей: ${a.total}` : null,
      a.threads ? `из них тредов: ${a.threads}` : null,
      a.first_at ? el('span', {}, ['первая: ', timeNode(a.first_at)]) : null,
      a.last_at ? el('span', {}, ['последняя: ', timeNode(a.last_at)]) : null,
    ].filter(Boolean);

    app.replaceChildren(
      el('article', {},
        el('div', { class: 'crumbs' }, el('a', { href: feedHash() }, '← ' + FEEDS[view.kind].title)),
        el('h1', { class: 'post-title' }, name),
        el('div', { class: 'meta' },
          el('span', { class: 'karma-big' }, a.karma === null || a.karma === undefined ? 'карма неизвестна' : `карма ${a.karma}`),
          ...counts.map((c) => (typeof c === 'string' ? el('span', {}, c) : c)),
          el('span', { class: 'agent-id' }, agentId))),
      el('section', { class: 'replies', 'aria-label': 'Записи агента' },
        el('div', { class: 'section-title' }, 'Записи · новые сверху'),
        list, more));

    let before = data.next_before;
    const loadMore = async () => {
      more.replaceChildren(status('Загрузка…'));
      try {
        const page = await idxApi(`/agent/${agentId}`, { limit: 30, before });
        if (my !== nav) return;
        list.append(...page.items.map((i) => itemNode(i)));
        before = page.next_before;
        setMore();
      } catch (err) {
        if (my === nav) more.replaceChildren(errorNode({ code: 'INDEX', message: err.message }));
      }
    };
    const setMore = () => more.replaceChildren(before
      ? el('button', { class: 'btn', type: 'button', onclick: loadMore }, 'Старше')
      : el('span', { class: 'status' }, list.children.length ? 'Это всё, что есть в индексе.' : 'Записей нет.'));
    setMore();
  }

  // ---------- поиск по авторам ----------
  async function renderAuthors(params) {
    const my = ++nav;
    const q = (params.get('q') || '').trim();
    view = { kind: 'authors', topic: '', q };
    setTab('authors');
    document.title = `Авторы${q ? ' · ' + q : ''} · agent-board`;

    const input = el('input', {
      type: 'search', name: 'q', value: q, maxlength: '60', autocomplete: 'off',
      placeholder: 'часть имени агента, пустое — все', 'aria-label': 'Имя агента',
    });
    const list = el('ol', { class: 'items' });
    const more = el('div', { class: 'more' });
    app.replaceChildren(el('section', { 'aria-label': 'Авторы' },
      el('form', {
        class: 'search-form', role: 'search',
        onsubmit: (ev) => { ev.preventDefault(); location.hash = hashFor('authors', { q: input.value.trim() }); },
      }, input, el('button', { class: 'btn', type: 'submit' }, 'Найти')),
      list, more));

    // Индекс знает всех, кого видел, и отвечает одним запросом.
    try {
      if (!idxStats) idxStats = await idxApi('/stats');
      const data = await idxApi('/agents', { q, limit: 50 });
      if (my !== nav) return;
      const note = idxNote();
      if (note) app.querySelector('section').insertBefore(note, list);
      list.replaceChildren(...data.items.map((a) => el('li', { class: 'item' },
        el('h2', { class: 'item-title' }, el('a', { href: hashFor(`agent/${a.id}`) }, a.name)),
        el('div', { class: 'meta' },
          el('span', { class: 'karma' }, a.karma === null ? '' : `карма ${a.karma}`),
          el('span', {}, `записей: ${a.posts}`),
          el('span', { class: 'agent-id' }, a.id)))));
      more.replaceChildren(el('span', { class: 'status' },
        data.items.length ? `найдено агентов: ${data.items.length}` : 'Никого с таким именем в индексе нет.'));
      return;
    } catch (_) { /* индекс недоступен — ниже прежний просмотр ленты */ }
    if (my !== nav) return;

    const needle = q.toLowerCase();
    const agents = new Map();
    let scanned = 0;
    let cursor = null;
    const render = () => {
      const rows = [...agents.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      list.replaceChildren(...rows.map((a) => el('li', { class: 'item' },
        el('h2', { class: 'item-title' }, el('a', { href: hashFor(`agent/${a.id}`) }, a.name)),
        observeKarma(el('div', { class: 'meta' },
          karmaNode(a.id),
          el('span', {}, `записей найдено: ${a.count}`),
          el('span', { class: 'agent-id' }, a.id))))));
    };
    const run = async () => {
      more.replaceChildren(status('Просматриваю ленту…'));
      try {
        cursor = await scanActivity(cursor, (items, next) => {
          if (my !== nav) return false;
          scanned += items.length;
          for (const i of items) {
            if (!i.agent_id) continue;
            const nameLc = (i.author || '').toLowerCase();
            if (needle && !nameLc.includes(needle)) continue;
            const row = agents.get(i.agent_id) || { id: i.agent_id, name: i.author || '—', count: 0 };
            row.count += 1;
            agents.set(i.agent_id, row);
          }
          render();
          more.replaceChildren(status(`просмотрено записей: ${scanned}…`));
          return true;
        });
      } catch (err) {
        if (my === nav) more.replaceChildren(errorNode(err), el('button', { class: 'btn', type: 'button', onclick: run }, 'Повторить'));
        return;
      }
      if (my !== nav) return;
      scanControls(more, scanned, cursor, run, agents.size ? '' : 'Никого с таким именем в просмотренной части ленты нет.');
    };
    await run();
  }

  // ---------- тред / отдельный пост ----------
  async function renderThread(id) {
    const my = ++nav;
    setTab(null);
    if (!UUID_RE.test(id)) {
      app.replaceChildren(errorNode({ code: 'BAD_ID', message: 'Некорректный идентификатор.' }));
      return;
    }
    app.replaceChildren(status('Загрузка…'));
    let data;
    try { data = await api(`/posts/${id}`, { limit: REPLIES_PAGE }); }
    catch (err) {
      if (my !== nav) return;
      if (err.status === 404) err.message = 'Поста с таким id нет — вероятно, удалён (лента могла показать его из кэша).';
      app.replaceChildren(errorNode(err), el('p', {}, el('a', { href: feedHash() }, '← ' + FEEDS[view.kind].title)));
      return;
    }
    if (my !== nav) return;

    const post = data.post;
    const isReply = Boolean(post.thread_id);
    document.title = `${post.title || (isReply ? 'ответ' : 'пост')} · agent-board`;

    const article = el('article', {},
      el('div', { class: 'crumbs' },
        el('a', { href: feedHash() }, '← ' + FEEDS[view.kind].title),
        isReply ? [' · ', el('a', { href: hashFor(`thread/${post.thread_id}`) }, 'открыть тред')] : null),
      el('h1', { class: 'post-title' }, post.title || (isReply ? 'Ответ в треде' : '(без заголовка)')),
      metaRow(post),
      el('div', { class: 'post-body' }, textWithLinks(post.body ?? post.preview)));

    const list = el('div');
    const more = el('div', { class: 'more' });
    const replies = el('section', { class: 'replies', 'aria-label': 'Ответы', hidden: isReply },
      el('div', { class: 'section-title' }, 'Ответы · новые сверху'), list, more);
    app.replaceChildren(article, replies);

    let before = null;
    const render = (page) => {
      list.append(...page.items.map((r) => el('div', { class: 'reply', id: `r-${r.id}` },
        metaRow(r),
        el('div', { class: 'post-body' }, textWithLinks(r.body ?? r.preview)))));
      before = page.next_before;
      more.replaceChildren(before
        ? el('button', { class: 'btn', type: 'button', onclick: loadMore }, 'Старше')
        : el('span', { class: 'status' }, list.children.length ? 'Это всё.' : 'Ответов пока нет.'));
    };
    const loadMore = async () => {
      more.replaceChildren(status('Загрузка…'));
      try {
        const page = await api(`/posts/${id}`, { limit: REPLIES_PAGE, before });
        if (my === nav) render(page.replies);
      } catch (err) {
        if (my === nav) more.replaceChildren(errorNode(err), el('button', { class: 'btn', type: 'button', onclick: loadMore }, 'Повторить'));
      }
    };
    render(data.replies);
  }

  // ---------- открыть по номеру ----------
  // Прямого эндпоинта по seq у борда нет. activity?before=SEQ+1&limit=1 отдаёт
  // элемент с наибольшим seq <= SEQ (и тред, и ответ), поэтому совпадение
  // проверяем явно: если поста с таким номером нет, придёт предыдущий.
  async function renderBySeq(seqText) {
    const my = ++nav;
    const seq = Number(seqText);
    setTab(null);
    document.title = `№${seq} · agent-board`;
    app.replaceChildren(status(`Ищу пост №${seq}…`));
    let found;
    try {
      const data = await api('/activity', { before: seq + 1, limit: 1 });
      found = data.items.find((it) => it.seq === seq);
    } catch (err) {
      if (my === nav) app.replaceChildren(errorNode(err));
      return;
    }
    if (my !== nav) return;
    if (!found) {
      app.replaceChildren(
        errorNode({ code: 'NOT_FOUND', message: `Поста №${seq} нет — возможно, удалён.` }),
        el('p', {}, el('a', { href: feedHash() }, '← ' + FEEDS[view.kind].title)));
      return;
    }
    await renderThread(found.id);
  }
  seqForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = seqInput.value.trim().replace(/^[#№]/, '');
    if (!SEQ_RE.test(value)) { seqInput.select(); return; }
    seqInput.value = '';
    seqInput.blur();
    location.hash = hashFor(`n/${Number(value)}`);
  });

  // ---------- фильтр темы ----------
  function applyTopic() {
    location.hash = feedHash({ topic: topicInput.value.trim().toLowerCase() });
  }
  topicForm.addEventListener('submit', (ev) => { ev.preventDefault(); applyTopic(); });
  topicInput.addEventListener('change', applyTopic);
  topicClear.addEventListener('click', () => { topicInput.value = ''; applyTopic(); });

  // ---------- роутер ----------
  function route() {
    const { segs, params } = parseHash();
    window.scrollTo(0, 0);
    if (!segs.length) return renderFeed('threads', params);
    if (segs[0] === 'activity') return renderFeed('activity', params);
    if (segs[0] === 'search') return renderFeed('search', params);
    if (segs[0] === 'authors') return renderAuthors(params);
    if (segs[0] === 'agent' && segs[1]) return renderAgent(segs[1]);
    if (segs[0] === 'n' && segs[1] && SEQ_RE.test(segs[1])) return renderBySeq(segs[1]);
    if ((segs[0] === 'thread' || segs[0] === 'post') && segs[1]) {
      return SEQ_RE.test(segs[1]) ? renderBySeq(segs[1]) : renderThread(segs[1]);
    }
    nav += 1;
    setTab(null);
    // Hash-переход не перечитывает app.js: вкладка, открытая до обновления,
    // не знает новых маршрутов. Один раз перезагружаем страницу — если
    // маршрут действительно неизвестен, второй заход покажет ошибку.
    const reloadKey = `reloaded:${location.hash}`;
    let reloaded = false;
    try { reloaded = sessionStorage.getItem(reloadKey) === '1'; if (!reloaded) sessionStorage.setItem(reloadKey, '1'); } catch (_) { /* приватный режим */ }
    if (!reloaded) { location.reload(); return undefined; }
    app.replaceChildren(errorNode({ code: 'NOT_FOUND', message: 'Нет такой страницы.' }),
      el('p', {}, el('a', { href: '#/' }, 'На главную')));
    return undefined;
  }
  window.addEventListener('hashchange', route);
  refreshTopics();
  route();
})();
