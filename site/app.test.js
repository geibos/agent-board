'use strict';

const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// app.js — самовызывающаяся функция без экспорта: вырезаем запуск роутера и
// вытаскиваем чистые функции через globalThis. DOM не нужен: парсер Markdown
// и подмена ссылок не трогают документ.
function loadInternals() {
  const path = require.resolve('./app.js');
  const source = readFileSync(path, 'utf8').replace(
    /  window\.addEventListener\('hashchange',[\s\S]*?\n  route\(\);\n\}\)\(\);\n?$/,
    '  globalThis.__test = { internalHref, parseMarkdown };\n})();\n',
  );
  const element = { addEventListener() {} };
  const context = {
    URL,
    URLSearchParams,
    Intl,
    location: { host: 'mirror.example' },
    window: {},
    document: {
      getElementById: () => element,
      querySelectorAll: () => [],
    },
  };
  runInNewContext(source, context, { filename: path });
  return context.__test;
}

const { internalHref, parseMarkdown } = loadInternals();

describe('internalHref', () => {
  test('не подменяет служебные URL зеркала hash-маршрутом ридера', () => {
    assert.equal(internalHref('https://mirror.example/idx/stats'), null);
    assert.equal(internalHref('https://mirror.example/skill.md'), null);
  });

  test('сохраняет внутреннюю навигацию ридера и ссылок на посты доски', () => {
    assert.equal(internalHref('https://mirror.example/#/activity'), '#/activity');
    assert.equal(
      internalHref('https://getpostingboard.dev/v1/posts/11111111-1111-4111-8111-111111111111'),
      '#/thread/11111111-1111-4111-8111-111111111111',
    );
  });
});

const text = (v) => ({ t: 'text', v });
// Объекты из VM-контекста имеют другой Object.prototype: сравниваем по JSON.
const eq = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

describe('parseMarkdown: блоки', () => {
  test('заголовки, абзацы с жёсткими переносами, линейка', () => {
    const blocks = parseMarkdown('## Title\n\nline one\nline two\n\n---');
    eq(blocks.map((b) => b.type), ['heading', 'paragraph', 'hr']);
    assert.equal(blocks[0].level, 2);
    eq(blocks[1].inlines, [text('line one'), { t: 'br' }, text('line two')]);
  });

  test('ограждённый код не размечается внутри', () => {
    const blocks = parseMarkdown('```sh\ncurl **x** _y_\n```\nafter');
    assert.equal(blocks[0].type, 'code');
    assert.equal(blocks[0].lang, 'sh');
    assert.equal(blocks[0].text, 'curl **x** _y_');
    assert.equal(blocks[1].type, 'paragraph');
  });

  test('списки: маркеры, нумерация, вложенность и ленивое продолжение', () => {
    const blocks = parseMarkdown('- one\n  continued\n- two\n  - nested a\n  - nested b\n\n1. first\n2. second');
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].ordered, false);
    assert.equal(blocks[0].items.length, 2);
    eq(blocks[0].items[0][0].inlines, [text('one'), { t: 'br' }, text('continued')]);
    const nested = blocks[0].items[1][1];
    assert.equal(nested.type, 'list');
    assert.equal(nested.items.length, 2);
    assert.equal(blocks[1].type, 'list');
    assert.equal(blocks[1].ordered, true);
  });

  test('цитата и таблица', () => {
    const blocks = parseMarkdown('> quoted\n> more\n\n| a | b |\n|---|---|\n| 1 | **2** |');
    assert.equal(blocks[0].type, 'quote');
    assert.equal(blocks[0].blocks[0].type, 'paragraph');
    assert.equal(blocks[1].type, 'table');
    eq(blocks[1].head, [[text('a')], [text('b')]]);
    eq(blocks[1].rows[0][1], [{ t: 'strong', c: [text('2')] }]);
  });
});

describe('parseMarkdown: строчная разметка', () => {
  const inl = (s) => parseMarkdown(s)[0].inlines;

  test('код, жирный, курсив', () => {
    eq(inl('a `b` **c** *d*'), [
      text('a '), { t: 'code', v: 'b' }, text(' '), { t: 'strong', c: [text('c')] }, text(' '), { t: 'em', c: [text('d')] },
    ]);
  });

  test('подчёркивание внутри идентификаторов — не курсив', () => {
    eq(inl('use gpb_soft_envelope and snake_case_names'), [text('use gpb_soft_envelope and snake_case_names')]);
    eq(inl('_word_'), [{ t: 'em', c: [text('word')] }]);
  });

  test('ссылки: только http(s), иначе остаётся текст', () => {
    eq(inl('[doc](https://example.org/x)'), [{ t: 'link', href: 'https://example.org/x', c: [text('doc')] }]);
    // Скобки в адресе не дают ссылке распознаться — остаётся буквальный текст.
    eq(inl('[bad](javascript:alert(1))'), [text('[bad](javascript:alert(1))')]);
    eq(inl('[bad](javascript:alert%281%29)'), [text('bad')]);
    eq(inl('see https://example.org/p.'), [text('see '), { t: 'link', href: 'https://example.org/p', c: [text('https://example.org/p')] }, text('.')]);
    eq(inl('<https://a.b/c>'), [{ t: 'link', href: 'https://a.b/c', c: [text('https://a.b/c')] }]);
  });

  test('враждебное тело: HTML остаётся текстом, опасные схемы не становятся ссылками', () => {
    const body = '<img src=x onerror=alert(1)> [клик](javascript:alert(1)) [клик](java\tscript:alert(1)) <script>x</script> [d](data:text/html,x) ![img](https://t.example/p.png)';
    const hrefs = [];
    const texts = [];
    const walk = (nodes) => nodes.forEach((n) => {
      if (n.t === 'link') { hrefs.push(n.href); walk(n.c); }
      else if (n.c) walk(n.c);
      else if (n.t === 'text') texts.push(n.v);
    });
    parseMarkdown(body).forEach((b) => walk(b.inlines || []));
    // Единственная ссылка — картинка, показанная как ссылка на http(s)-адрес.
    eq(hrefs, ['https://t.example/p.png']);
    assert.ok(hrefs.every((h) => /^https?:\/\//.test(h)));
    const joined = texts.join('');
    assert.ok(joined.includes('<img src=x onerror=alert(1)>'));
    assert.ok(joined.includes('<script>x</script>'));
    assert.ok(joined.includes('клик'));
  });

  test('экранирование и незакрытая разметка остаются текстом', () => {
    eq(inl('\\*not em\\* and 2 * 3 * 4'), [text('*not em* and 2 * 3 * 4')]);
    eq(inl('unclosed **bold and `code'), [text('unclosed **bold and `code')]);
  });
});
