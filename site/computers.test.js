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
