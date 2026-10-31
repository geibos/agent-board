'use strict';
// Экраны Rent a Swarm. Тот же мини-DOM, что в computers.test.js: всё, что не
// узел, превращается в текст, поэтому «[object Object]» или сырой мусор на
// странице видно сразу.

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
        if (typeof k === 'object' && 'tag' in k) this.children.push(k);
        else this.text += String(k);
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
const links = (root) => walk(root).filter((x) => x.tag === 'a').map((x) => x.attrs.href);

const ID = '5e6e2c5d-ce70-44f3-b54d-edb8c980bb00';
const order = {
  id: ID, requester_name: 'Denis', revision: 2, title: 'Promote the board with influencers',
  task: 'Find 2–5 creators.', expected_result: 'Published videos.', acceptance_criteria: 'Links to each video.',
  deadline: '2026-11-30', payment_terms: 'Total budget: $1,000 USD', progress_evidence: true, status: 'open',
  created_at: 1793000000, updated_at: 1793100000, url: `/swarmrent/${ID}`, certificate_url: `/v1/swarmrent/orders/${ID}/certificate`,
};
const data = {
  '/swarmrent': { orders: [order], fetched_at: 1793200000, live: true },
  [`/swarmrent/${ID}`]: {
    order, certificate_url: order.certificate_url, fetched_at: 1793200000, live: true,
    comments: [
      { id: 'r1', kind: 'result', author: 'worker-agent', body: 'Two videos are live.', created_at: 1793150000, signature_verified: true, preferred: true, accepted: false,
        evidence: [{ url: 'https://video.example/1', description: 'first video' }, { url: 'javascript:alert(1)', description: 'trap' }],
        certificate_url: `/v1/swarmrent/orders/${ID}/certificates/c1` },
      { id: 'c2', kind: 'request_changes', author: 'Denis', body: 'Need one more.', created_at: 1793160000, submission_id: 'r1' },
      { id: 'c3', kind: 'brand_new_kind', author: 'someone', body: 'x', created_at: 1793170000 },
    ],
  },
};

function screen(segs, override = {}) {
  const app = node('main');
  app.replaceChildren = (...kids) => {
    app.children = []; app.text = '';
    for (const k of kids) if (k && typeof k === 'object' && 'tag' in k) app.children.push(k); else app.text += String(k);
  };
  const context = {
    Intl, Math, Map, Set, Object, Array, String, Number, JSON, Date, URL,
    window: { AB: {
      el, errorNode: (e) => el('div', { class: 'error' }, e.code, ' ', e.message), app, status: () => node('div'),
      idxApi: async (p) => { const v = p in override ? override[p] : data[p]; if (v instanceof Error) throw v; return v ?? {}; },
      timeNode: () => node('time'), bodyNode: () => node('div'), hashFor: () => '',
    } },
  };
  const path = require.resolve('./swarmrent.js');
  runInNewContext(readFileSync(path, 'utf8'), context, { filename: path });
  return context.window.ABSwarmrent.route(segs).then(() => app);
}

describe('экраны Rent a Swarm', () => {
  for (const segs of [['swarmrent'], ['swarmrent', ID]]) {
    test(`#/${segs.join('/')} рисуется без мусора`, async () => {
      const app = await screen(segs);
      assert.equal(app.text, '', `на странице текстом: ${app.text}`);
      assert.ok(app.children.length > 0, 'страница пуста');
      assert.equal(byClass(app, 'error').length, 0, 'вместо экрана ошибка');
      assert.doesNotMatch(allText(app), /\[object |undefined/, 'объект вместо текста');
    });
  }

  test('список: заказ, статус по-русски, заказчик, оплата помечена как непроверенное предложение', async () => {
    const app = await screen(['swarmrent']);
    const t = allText(app);
    assert.match(t, /Promote the board with influencers/);
    assert.match(t, /открыт/);
    assert.match(t, /Denis/);
    assert.match(t, /Total budget: \$1,000 USD/);
    assert.match(t, /не проверен/);
    assert.ok(links(app).includes(`#/swarmrent/${ID}`));
    assert.ok(links(app).includes('https://getpostingboard.dev/swarmrent/'));
  });

  test('оригинал молчит: видно, что показана старая копия', async () => {
    const app = await screen(['swarmrent'], { '/swarmrent': { ...data['/swarmrent'], live: false } });
    assert.match(allText(app), /не отвечает/);
  });

  test('пустой список так и называется', async () => {
    const app = await screen(['swarmrent'], { '/swarmrent': { orders: [], fetched_at: 1793200000, live: true } });
    assert.match(allText(app), /Открытых заказов сейчас нет/);
  });

  test('заказ: условия, результат с проверенной подписью и выбором заказчика, ссылки только https', async () => {
    const app = await screen(['swarmrent', ID]);
    const t = allText(app);
    for (const s of ['Find 2–5 creators.', 'Published videos.', 'Links to each video.', '2026-11-30', 'Two videos are live.', 'подпись проверена доской', 'выбран заказчиком', 'попросил доработать', 'brand_new_kind', 'worker-agent']) {
      assert.ok(t.includes(s), `нет «${s}»`);
    }
    const hrefs = links(app);
    assert.ok(hrefs.includes('https://video.example/1'));
    assert.ok(!hrefs.some((h) => /^javascript:/i.test(h)), 'небезопасная ссылка стала ссылкой');
    assert.ok(hrefs.includes(`https://getpostingboard.dev/swarmrent/${ID}`));
    assert.ok(hrefs.includes(`https://getpostingboard.dev/v1/swarmrent/orders/${ID}/certificate`));
  });

  test('неизвестный или неопубликованный заказ — понятная ошибка, а не пустая страница', async () => {
    const app = await screen(['swarmrent', ID], { [`/swarmrent/${ID}`]: new Error('индекс: HTTP 404') });
    assert.equal(byClass(app, 'error').length, 1);
    assert.match(allText(app), /не найден/);
  });
});
