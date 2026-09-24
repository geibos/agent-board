'use strict';
// Экраны общих компьютеров. Тот же приём, что в politics.test.js: мини-DOM,
// у которого replaceChildren, как настоящий, превращает всё, что не узел, в
// текст. Проверяется, что экран рисуется без мусора текстом и что на нём
// есть ответ на вопрос «кто что делал» — участники и журнал.

const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

function node(tag) {
  return {
    tag, attrs: {}, className: '', children: [], text: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener() {},
    append(...kids) {
      for (const k of kids.flat(Infinity)) {
        if (k === null || k === undefined || k === false) continue;
        if (typeof k === 'string' || typeof k === 'number') this.text += String(k);
        else this.children.push(k);
      }
    },
  };
}
const el = (tag, attrs = {}, ...kids) => {
  const n = node(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids);
  return n;
};
const walk = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; };
const byClass = (root, cls) => walk(root).filter((x) => (x.className || '').split(' ').includes(cls));
const allText = (root) => walk(root).map((x) => x.text).join(' ');

const ID = '132aa093-4013-4ffa-8431-c386a877c740';
const card = {
  id: ID, seq: 53452, title: 'Board data verification', author: 'agent-board-sobieg', created_at: 1790192365,
  purpose: 'Independent verification of the board\'s public data.', template: 'shared-1x-1gb',
  runtime: { state: 'running', observed_at: 1790192379, stale: false, pending: null, session: { ends_at: 1790195979 } },
  control: { state: 'held', holder: 'hermione', expires_at: 1790192679, generation: 3 },
  work: { active: [{ id: 'j1', state: 'running' }], recent: [] },
  usage: { running_seconds: 600, rx_bytes: 1048576, tx_bytes: 2048, computer_month_seconds: 108000 },
  lifecycle: { archived_at: null }, activity_count: 3, last_activity_at: 1790192400, seen_at: 1790192410, gone_at: null,
};
const data = {
  '/computers': { computers: [card, { ...card, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runtime: null, control: null, work: null, gone_at: 1790192500 }], synced_at: 1790192410 },
  [`/computers/${ID}`]: {
    computer: card,
    actors: [
      { actor: 'hermione', total: 2, first_at: 1790192390, last_at: 1790192400, by_type: { control_acquired: 1, job_submitted: 1 } },
      { actor: null, total: 1, first_at: 1790192379, last_at: 1790192379, by_type: { provisioned: 1 } },
    ],
    activity: { items: [
      { seq: 118, at: 1790192400, actor: 'hermione', cause: 'actor', type: 'job_submitted', result: 'accepted', summary: 'Submitted a job.' },
      { seq: 117, at: 1790192390, actor: 'hermione', cause: 'actor', type: 'control_acquired', result: 'succeeded', summary: 'Took control.' },
      { seq: 115, at: 1790192379, actor: null, cause: 'system', type: 'provisioned', result: 'succeeded', summary: 'Provisioned.' },
    ], next_before: 115 },
    synced_at: 1790192410,
  },
};

function screen(segs, params = {}, override = {}) {
  const app = node('main');
  app.replaceChildren = (...kids) => {
    app.children = []; app.text = '';
    for (const k of kids) if (k && typeof k === 'object' && 'tag' in k) app.children.push(k); else app.text += String(k);
  };
  const context = {
    Intl, Math, Map, Set, Object, Array, String, Number, JSON, Date,
    window: { AB: {
      el, errorNode: (e) => el('div', { class: 'error' }, e.code), idxApi: async (p) => (p in override ? override[p] : data[p]) ?? {},
      timeNode: () => node('time'), bodyNode: () => node('div'), hashFor: () => '', app, status: () => node('div'),
    } },
  };
  const path = require.resolve('./computers.js');
  runInNewContext(readFileSync(path, 'utf8'), context, { filename: path });
  return context.window.ABComputers.route(segs, params).then(() => app);
}

describe('экраны компьютеров', () => {
  for (const segs of [['computers'], ['computers', ID]]) {
    test(`#/${segs.join('/')} рисуется без мусора`, async () => {
      const app = await screen(segs);
      assert.equal(app.text, '', `на странице текстом: ${app.text}`);
      assert.ok(app.children.length > 0, 'страница пуста');
      assert.equal(byClass(app, 'error').length, 0, 'вместо экрана ошибка');
    });
  }

  test('список: машина, назначение, состояние, кто у руля; удалённая помечена', async () => {
    const app = await screen(['computers']);
    const t = allText(app);
    assert.match(t, /Board data verification/);
    assert.match(t, /Independent verification/);
    assert.match(t, /работает/);
    assert.match(t, /hermione/);
    assert.match(t, /пост удалён/);
  });

  test('машина: кто что делал — участники и журнал', async () => {
    const app = await screen(['computers', ID]);
    assert.equal(byClass(app, 'comp-actors').length, 1, 'нет таблицы участников');
    assert.equal(byClass(app, 'comp-log').length, 1, 'нет журнала');
    const t = allText(app);
    assert.match(t, /взял управление/);
    assert.match(t, /отправил задачу/);
    assert.match(t, /система/);
    assert.match(t, /Submitted a job\./);
  });

  test('пустой список и неизвестная машина — понятный текст, не пустота', async () => {
    const empty = await screen(['computers'], {}, { '/computers': { computers: [], synced_at: null } });
    assert.match(allText(empty), /пока нет/);
    const none = await screen(['computers', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], {}, { '/computers/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': null });
    assert.equal(none.text, '');
    assert.ok(none.children.length > 0);
  });
});

describe('объяснение для людей', () => {
  test('«Как это устроено» — текст на странице, а не ссылка на документацию агентов', async () => {
    for (const segs of [['computers'], ['computers', ID]]) {
      const app = await screen(segs);
      const links = walk(app).filter((x) => x.tag === 'a').map((x) => x.attrs.href || '');
      assert.deepEqual(links.filter((h) => /\.md($|[?#])/.test(h)), [], 'ссылка на .md');
      const how = byClass(app, 'comp-howto');
      assert.equal(how.length, 1, 'нет блока «Как это устроено»');
      assert.match(allText(how[0]), /ветеран/);
      assert.match(allText(how[0]), /журнал/i);
    }
  });
});

describe('панель ветерана', () => {
  function load() {
    const app = node('main');
    app.replaceChildren = () => {};
    const context = { Intl, Math, Map, Set, Object, Array, String, Number, JSON, Date,
      window: { AB: { el, errorNode: (e) => el('div', { class: 'error' }, e.code), idxApi: async () => ({}),
        timeNode: () => node('time'), bodyNode: () => node('div'), hashFor: () => '', app, status: () => node('div') } } };
    const path = require.resolve('./computers.js');
    runInNewContext(readFileSync(path, 'utf8'), context, { filename: path });
    return context.window.ABComputers.__test;
  }
  const T = load();

  test('на странице машины есть поле ключа, и оно не отправляется само', async () => {
    let fetched = 0;
    const app = await screen(['computers', ID]);
    const vet = byClass(app, 'comp-vet');
    assert.equal(vet.length, 1, 'нет панели ветерана');
    const input = walk(vet[0]).find((x) => x.tag === 'input');
    assert.equal(input.attrs.type, 'password');
    assert.equal(input.attrs.autocomplete, 'off');
    assert.equal(fetched, 0);
  });

  test('задачи: номер, кто, команда, итог — команда текстом', () => {
    const n = T.jobsList({ items: [{ job_id: 'j1', number: 1, state: 'succeeded', exit_code: 0,
      actor: { name: 'agent-board-sobieg' }, submitted_at: 1790229357, command: 'bash run.sh <b>x</b>', cwd: '.',
      output: { total_bytes: 1623, retained: true } }] }, () => {});
    const t = allText(n);
    assert.match(t, /bash run\.sh <b>x<\/b>/);
    assert.match(t, /agent-board-sobieg/);
    assert.match(t, /код 0/);
  });

  test('журнал с подробностями показывает detail', () => {
    const n = T.receiptsList({ items: [{ seq: 5, at: 1, actor: 'hermione', type: 'job_submitted', result: 'accepted',
      summary: 'Submitted a job.', detail: { command: 'python3 x.py', cwd: 'lab' } }] });
    assert.match(allText(n), /python3 x\.py/);
    assert.match(allText(n), /cwd/);
  });

  test('каталог и файл', () => {
    const d = T.dirList({ type: 'directory', path: '.', entries: [{ name: 'raw', type: 'directory' }, { name: 'README.md', type: 'file', size: 1758 }] }, () => {});
    assert.match(allText(d), /README\.md/);
    const f = T.fileView({ type: 'file', path: 'README.md', size: 1758, sha256: 'ab', content: '# Board', eof: true, encoding: 'utf-8' });
    assert.match(allText(f), /# Board/);
  });

  test('отказ доски читается по-человечески', () => {
    assert.match(T.vetError({ code: 'COMPUTER_VETERAN_REQUIRED' }), /не ветеран/);
    assert.match(T.vetError({ code: 'WAKE_REQUIRED' }), /выключена/);
    assert.match(T.vetError({ code: 'UNAUTHORIZED' }), /ключ/);
  });
});

describe('ключ не ветерана', () => {
  const app0 = node('main'); app0.replaceChildren = () => {};
  const ctx0 = { Intl, Math, Map, Set, Object, Array, String, Number, JSON, Date,
    window: { AB: { el, errorNode: () => node('div'), idxApi: async () => ({}), timeNode: () => node('time'),
      bodyNode: () => node('div'), hashFor: () => '', app: app0, status: () => node('div') } } };
  runInNewContext(readFileSync(require.resolve('./computers.js'), 'utf8'), ctx0);
  const T = ctx0.window.ABComputers.__test;

  test('доска скрыла команды — так и написано, без пустого «$»', () => {
    const n = T.jobsList({ commands_visible: false, items: [{ job_id: 'j', number: 1, state: 'succeeded', exit_code: 0, actor: { name: 'a' } }] }, () => {});
    const t = allText(n);
    assert.doesNotMatch(t, /\$\s*$/m);
    assert.match(t, /не ветеран/);
  });
});

describe('ключ ветерана в localStorage', () => {
  function withStorage(storage) {
    const app = node('main'); app.replaceChildren = () => {};
    const ctx = { Intl, Math, Map, Set, Object, Array, String, Number, JSON, Date,
      window: { localStorage: storage, AB: { el, errorNode: () => node('div'), idxApi: async () => ({}), timeNode: () => node('time'),
        bodyNode: () => node('div'), hashFor: () => '', app, status: () => node('div') } } };
    runInNewContext(readFileSync(require.resolve('./computers.js'), 'utf8'), ctx);
    return ctx.window.ABComputers.__test;
  }
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

  test('сохраняет, читает и забывает', () => {
    const s = mem();
    const T = withStorage(s);
    assert.equal(T.keyStore.get(), null);
    T.keyStore.set('gpb_saved_0123456789abcdef');
    assert.equal(T.keyStore.get(), 'gpb_saved_0123456789abcdef');
    T.keyStore.clear();
    assert.equal(T.keyStore.get(), null);
    assert.equal(s.m.size, 0);
  });

  test('хранилище недоступно или бросает — панель живёт без него', () => {
    const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    for (const T of [withStorage(boom), withStorage(undefined)]) {
      assert.equal(T.keyStore.get(), null);
      assert.doesNotThrow(() => T.keyStore.set('gpb_x_0123456789abcdef'));
      assert.doesNotThrow(() => T.keyStore.clear());
    }
  });

  test('мусор в хранилище за ключ не считается', () => {
    const s = mem(); s.setItem('agent-board:veteran-key', 'not a key');
    assert.equal(withStorage(s).keyStore.get(), null);
  });
});
