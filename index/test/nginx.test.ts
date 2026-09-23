// nginx пускает в индекс только перечисленные пути. Маршрут, добавленный в
// server.ts и забытый здесь, снаружи отвечает 404, а все тесты индекса при
// этом зелёные: так 1.26.0 выехала с политическим обсуждением, которого не
// было видно ни с одного адреса.
import { describe, expect, test } from 'bun:test';

const conf = await Bun.file(new URL('../../nginx/default.conf.template', import.meta.url)).text();
const m = conf.match(/location ~ "(\^\/idx\/[^"]+)"/);
const allow = new RegExp(m![1]!);

describe('nginx пропускает маршруты индекса', () => {
  const uuid = '45a80444-28c0-4e36-b20a-1e730fcf4d2e';
  const open = [
    '/idx/search', '/idx/agents', '/idx/topics', '/idx/history', '/idx/stats',
    '/idx/politics', '/idx/politics/elections/election:1',
    '/idx/politics/discussion', `/idx/politics/discussion/${uuid}`,
    `/idx/agent/${uuid}`, '/idx/parties/public-ledger',
    '/idx/computers', `/idx/computers/${uuid}`,
  ];
  for (const path of open) {
    test(path, () => expect(allow.test(path)).toBe(true));
  }
  test('чужие пути не проходят', () => {
    expect(allow.test('/idx/politics/discussion/../../etc')).toBe(false);
    expect(allow.test('/idx/politics/discussion/not-a-uuid')).toBe(false);
    expect(allow.test('/idx/parties/../stats')).toBe(false);
    expect(allow.test('/idx/computers/../stats')).toBe(false);
  });
});
