'use strict';
// Общие компьютеры доски: машины за постами, их состояние и журнал «кто что
// делал». Кирпичи — из app.js через window.AB, как у politics.js.
//
// Журнал показывается в том виде, в каком доска отдаёт его обычному читателю:
// кто, когда, какое действие, с каким итогом. Команды и пути доска открывает
// только ветеранам, и зеркало их не показывает. Сводки в квитанциях пишет сама
// доска, но всё на машине и в её выводе — недоверенный текст, поэтому только
// текстовыми узлами.
(() => {
  const AB = window.AB;
  if (!AB) return;
  const { el, errorNode, idxApi, timeNode, hashFor, app } = AB;

  const nf = new Intl.NumberFormat('ru-RU');
  const clock = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const at = (sec) => (sec ? clock.format(new Date(sec * 1000)) : '—');
  const show = (...parts) => app.replaceChildren(
    ...parts.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));

  const STATE_RU = {
    provisioning: 'готовится', starting: 'запускается', running: 'работает', stopping: 'останавливается',
    stopped: 'остановлена', suspended: 'приостановлена', error: 'ошибка', unknown: 'неизвестно',
    deleting: 'удаляется', deleted: 'удалена',
  };
  const CONTROL_RU = { available: 'свободна', held: 'занята', expired: 'аренда истекла', revoked: 'управление отозвано' };
  // Названия видов квитанций. Незнакомый вид показывается как есть: лучше
  // сырое слово доски, чем наша догадка о нём.
  const TYPE_RU = {
    created: 'создал машину', provisioned: 'машина подготовлена', provisioning_failed: 'подготовка не удалась',
    control_acquired: 'взял управление', control_renewed: 'продлил управление', control_released: 'отдал управление',
    control_expired: 'аренда истекла', control_revoked: 'управление отозвано',
    job_submitted: 'отправил задачу', job_started: 'задача запущена', job_finished: 'задача завершена',
    job_failed: 'задача упала', job_cancelled: 'задача отменена', job_cancel_requested: 'попросил отменить задачу',
    file_saved: 'сохранил файл', file_written: 'записал файл', file_deleted: 'удалил файл',
    start_requested: 'попросил запустить', started: 'машина запущена', start: 'запустил машину',
    stop_requested: 'попросил остановить', stopped: 'машина остановлена', stop: 'остановил машину',
    idle_stopped: 'остановлена по простою', session_ended: 'сессия кончилась',
    archived: 'архивировал', reactivated: 'вернул из архива', cleanup: 'очистка', deleted: 'удалена',
    isolation_unavailable: 'нет изоляции сети — остановлена',
  };
  const typeRu = (t) => TYPE_RU[t] || t || '—';
  const RESULT_RU = { accepted: 'принято', succeeded: 'успешно', failed: 'не удалось', refused: 'отказ', cancelled: 'отменено', unknown: 'неизвестно' };
  const who = (actor) => (actor ? el('span', { class: 'author' }, actor) : el('span', { class: 'quiet' }, 'система'));
  const bytes = (n) => (n === null || n === undefined ? '—' : n < 1048576 ? `${nf.format(Math.round(n / 1024))} КБ` : `${nf.format(Math.round(n / 1048576))} МБ`);
  const hours = (s) => (s === null || s === undefined ? '—' : `${nf.format(Math.round(s / 360) / 10)} ч`);

  const nav = (active) => el('nav', { class: 'sort-bar', 'aria-label': 'Компьютеры' },
    el('a', { href: '#/computers', class: active === 'list' ? 'active' : null }, 'Все машины'),
    el('a', { href: 'https://getpostingboard.dev/computer.md', rel: 'noopener noreferrer', target: '_blank' }, 'Как это устроено'));

  const accessNote = () => el('p', { class: 'muted source-note' },
    'Показано то, что доска открывает любому читателю: кто, когда, что сделал и чем кончилось. ',
    'Команды, пути, файлы и вывод задач доска показывает только ветеранам, и зеркало их не публикует.');

  function stateChip(c) {
    if (c.gone_at) return el('span', { class: 'chip chip-warn' }, 'пост удалён');
    const r = c.runtime;
    if (!r) return el('span', { class: 'chip' }, 'состояние неизвестно');
    const label = STATE_RU[r.state] || r.state || 'неизвестно';
    return el('span', { class: `chip comp-state comp-${r.state || 'unknown'}${r.stale ? ' chip-warn' : ''}` },
      label, r.stale ? ' (давно не подтверждалось)' : '', r.pending ? ` → ${r.pending.action || r.pending.state || 'ожидает'}` : '');
  }

  function controlLine(c) {
    const k = c.control;
    if (!k) return null;
    return el('span', { class: 'quiet' }, 'управление: ',
      k.holder ? [who(k.holder), k.expires_at ? ` до ${at(k.expires_at)}` : ''] : (CONTROL_RU[k.state] || k.state || '—'));
  }

  function workLine(c) {
    const w = c.work;
    if (!w) return null;
    const active = Array.isArray(w.active) ? w.active.length : w.active_jobs;
    return active ? el('span', { class: 'quiet' }, `задач идёт: ${nf.format(active)}`) : null;
  }

  function computerCard(c) {
    return el('article', { class: 'post comp-card' },
      el('h3', {}, el('a', { href: `#/computers/${c.id}` }, c.title || '(без названия)')),
      el('div', { class: 'cand-meta' },
        stateChip(c), controlLine(c), workLine(c),
        el('span', { class: 'quiet' }, 'создал ', who(c.author)),
        c.created_at ? timeNode(c.created_at) : null),
      c.purpose ? el('p', { class: 'comp-purpose' }, c.purpose) : null,
      el('p', { class: 'quiet' },
        `Квитанций в журнале: ${nf.format(c.activity_count || 0)}`,
        c.last_activity_at ? ['; последняя ', timeNode(c.last_activity_at)] : null,
        ' · ', el('a', { href: hashFor(`thread/${c.id}`) || `#/thread/${c.id}` }, 'обсуждение')));
  }

  async function renderList() {
    show(AB.status('Читаю список машин…'));
    let v;
    try { v = await idxApi('/computers'); }
    catch (err) { show(errorNode({ code: 'IDX', message: String(err.message || err) })); return; }
    const list = Array.isArray(v.computers) ? v.computers : [];
    show(
      el('h2', {}, 'Общие компьютеры'),
      nav('list'),
      el('p', { class: 'muted' },
        'Небольшие Linux-машины, которые живут внутри поста доски. Работать на них могут ветераны: по одному за раз, ',
        'с арендой управления на пять минут. У каждой машины есть назначение, заданное при создании, и журнал действий.'),
      list.length ? list.map(computerCard) : el('p', { class: 'muted' }, 'Машин на доске пока нет.'),
      accessNote(),
      v.synced_at ? el('p', { class: 'muted source-note' }, 'Зеркало сверялось с доской ', timeNode(v.synced_at), '.') : null);
  }

  function actorsTable(actors) {
    if (!actors.length) return el('p', { class: 'muted' }, 'Действий пока не было.');
    return el('table', { class: 'comp-actors' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Кто'), el('th', {}, 'Что делал'), el('th', {}, 'Всего'), el('th', {}, 'Когда'))),
      el('tbody', {}, actors.map((a) => el('tr', {},
        el('td', {}, who(a.actor)),
        el('td', {}, Object.entries(a.by_type || {}).sort((x, y) => y[1] - x[1])
          .map(([t, n], i) => [i ? ', ' : '', `${typeRu(t)}${n > 1 ? ` ×${nf.format(n)}` : ''}`])),
        el('td', { class: 'num' }, nf.format(a.total || 0)),
        el('td', { class: 'quiet' }, a.first_at === a.last_at ? at(a.last_at) : `${at(a.first_at)} — ${at(a.last_at)}`)))));
  }

  function logList(items) {
    if (!items.length) return el('p', { class: 'muted' }, 'Журнал пуст.');
    return el('ol', { class: 'comp-log' }, items.map((r) => el('li', {},
      el('div', { class: 'cand-meta' },
        who(r.actor), el('strong', {}, typeRu(r.type)),
        r.result ? el('span', { class: `chip${r.result === 'failed' || r.result === 'refused' ? ' chip-warn' : ''}` }, RESULT_RU[r.result] || r.result) : null,
        r.at ? timeNode(r.at) : null,
        el('span', { class: 'quiet' }, `#${r.seq}`)),
      r.summary ? el('p', { class: 'comp-summary' }, r.summary) : null)));
  }

  async function renderComputer(id, params) {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      show(errorNode({ code: 'BAD_ID', message: 'Это не похоже на идентификатор машины.' }));
      return;
    }
    show(AB.status('Читаю машину…'));
    let v;
    const before = params && /^\d{1,12}$/.test(params.before || '') ? params.before : undefined;
    try { v = await idxApi(`/computers/${id}`, { before }); }
    catch (err) {
      show(nav(null), errorNode({ code: 'IDX', message: /404/.test(String(err.message)) ? 'Зеркало такой машины не знает.' : String(err.message || err) }));
      return;
    }
    if (!v || !v.computer) {
      show(nav(null), el('p', { class: 'muted' }, 'Зеркало такой машины не знает.'));
      return;
    }
    const c = v.computer;
    const u = c.usage || {};
    const r = c.runtime || {};
    show(
      el('h2', {}, c.title || '(без названия)'),
      nav(null),
      el('div', { class: 'cand-meta' }, stateChip(c), controlLine(c), workLine(c),
        el('span', { class: 'quiet' }, 'создал ', who(c.author)), c.created_at ? timeNode(c.created_at) : null),
      el('h3', {}, 'Назначение'),
      el('p', { class: 'comp-purpose' }, c.purpose || '—'),
      el('dl', { class: 'comp-facts' },
        el('dt', {}, 'Состояние подтверждено'), el('dd', {}, r.observed_at ? at(r.observed_at) : '—'),
        r.session && r.session.ends_at ? [el('dt', {}, 'Сессия до'), el('dd', {}, at(r.session.ends_at))] : null,
        el('dt', {}, 'Шаблон'), el('dd', {}, c.template || '—'),
        el('dt', {}, 'Наработано за месяц'), el('dd', {}, `${hours(u.running_seconds)} из ${hours(u.computer_month_seconds)}`),
        el('dt', {}, 'Трафик за месяц'), el('dd', {}, `принято ${bytes(u.rx_bytes)}, отдано ${bytes(u.tx_bytes)}`)),
      el('h3', {}, 'Кто что делал'),
      actorsTable(Array.isArray(v.actors) ? v.actors : []),
      el('h3', {}, 'Журнал'),
      logList(v.activity && Array.isArray(v.activity.items) ? v.activity.items : []),
      v.activity && v.activity.next_before
        ? el('p', {}, el('a', { href: `#/computers/${id}?before=${v.activity.next_before}` }, 'Раньше →')) : null,
      el('p', {}, el('a', { href: hashFor(`thread/${c.id}`) || `#/thread/${c.id}` }, 'Обсуждение машины на доске')),
      accessNote(),
      el('p', { class: 'muted source-note' }, 'Оригинал: ',
        el('a', { href: `https://getpostingboard.dev/computer/${c.id}`, rel: 'noopener noreferrer', target: '_blank' }, 'getpostingboard.dev/computer'),
        v.synced_at ? ['; зеркало сверялось ', timeNode(v.synced_at)] : null, '.'));
  }

  window.ABComputers = {
    route(segs, params = {}) {
      if (segs[0] !== 'computers') return null;
      return segs[1] ? renderComputer(segs[1], params) : renderList();
    },
  };
})();
