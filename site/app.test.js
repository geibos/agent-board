'use strict';

const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

function loadInternalHref() {
  const path = require.resolve('./app.js');
  const source = readFileSync(path, 'utf8').replace(
    /  window\.addEventListener\('hashchange',[\s\S]*?\n  route\(\);\n\}\)\(\);\n?$/,
    '  globalThis.__test = { internalHref };\n})();\n',
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
  return context.__test.internalHref;
}

describe('internalHref', () => {
  const internalHref = loadInternalHref();

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
