// nginx пускает в индекс только перечисленные пути. Маршрут, добавленный в
// server.ts и забытый здесь, снаружи отвечает 404, а все тесты индекса при
// этом зелёные: так 1.26.0 выехала с политическим обсуждением, которого не
// было видно ни с одного адреса.
import { describe, expect, test } from 'bun:test';

const conf = await Bun.file(new URL('../../nginx/default.conf.template', import.meta.url)).text();
// Общий блок индекса — тот, что начинается со search; блок для ветеранов стоит отдельно.
const m = conf.match(/location ~ "(\^\/idx\/\(search[^"]+)"/);
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

// Ответ на маршрутах для ветеранов зависит от ключа зрителя. Общий блок /idx
// кеширует ответы по адресу без учёта Authorization: попади эти маршруты туда,
// команды, показанные одному ветерану, 15 секунд отдавались бы любому.
describe('маршруты для ветеранов идут мимо кеша', () => {
  const uuid = '45a80444-28c0-4e36-b20a-1e730fcf4d2e';
  const vet = conf.match(/location ~ "(\^\/idx\/computers\/[^"]+\/v\/[^"]+)" \{([\s\S]*?)\n    \}/);
  test('есть отдельный блок', () => expect(vet).not.toBeNull());
  const re = new RegExp(vet![1]!);
  const body = vet![2]!;
  for (const sub of ['activity', 'jobs', `jobs/${uuid}`, `jobs/${uuid}/output`, 'files']) {
    test(`пропускает v/${sub}`, () => expect(re.test(`/idx/computers/${uuid}/v/${sub}`)).toBe(true));
  }
  test('не пропускает управление и чужое', () => {
    for (const sub of ['control', 'lifecycle', `jobs/${uuid}/cancel`, 'files/../control']) {
      expect(re.test(`/idx/computers/${uuid}/v/${sub}`)).toBe(false);
    }
  });
  test('без кеша и с no-store', () => {
    expect(body).toContain('proxy_cache off;');
    expect(body).not.toMatch(/proxy_cache\s+board/);
    expect(body).toMatch(/Cache-Control\s+"no-store"/);
  });
  test('общий кеширующий блок их не пропускает', () => {
    expect(allow.test(`/idx/computers/${uuid}/v/jobs`)).toBe(false);
  });
});

// Страницы Meatproxy — страницы оригинала: они тянут его стили и скрипты из
// корня сайта. Не пропусти их nginx в индекс, статика зеркала ответит на них
// 404 с HTML — страница без стилей, формы и картинок статей (1.32.0).
describe('ресурсы страниц Meatproxy идут в индекс', () => {
  const api = new RegExp(conf.match(/location ~ "(\^\/\(v1[^"]+)"/)![1]!);
  const assets = [
    '/meatproxy-static.js', '/meatproxy-reader.js', '/meatproxy-comments.js', '/meatproxy-comments.css',
    '/pixel.css', '/pixel-reader.css', '/live-message-count.js', '/live-message-count.css',
  ];
  for (const path of assets) {
    test(path, () => expect(api.test(path)).toBe(true));
  }
  test('свои файлы зеркала и чужие пути туда не попадают', () => {
    for (const path of ['/app.js', '/style.css', '/politics.js', '/pixel.css/../app.js', '/pixel-x/y.css', '/meatproxy-../x.js']) {
      expect(api.test(path)).toBe(false);
    }
  });
});

// Бои хилла Core War играет браузер: движок cw в WebAssembly. CSP разрешает
// ровно компиляцию WebAssembly, а не eval скриптов; данные хилла — статика
// из смонтированного каталога анонсера, только чтение.
describe('хилл Core War', () => {
  const csp = conf.match(/Content-Security-Policy "([^"]+)"/);
  test('CSP разрешает WebAssembly, но не eval', () => {
    const script = csp![1]!.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))!;
    expect(script.split(/\s+/)).toContain("'wasm-unsafe-eval'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(csp![1]!).toContain("worker-src 'self'");
  });
  const hill = conf.match(/location \^~ \/hill\/ \{([\s\S]*?)\n    \}/);
  test('каталог /hill/ — статика, только чтение, без индекса', () => {
    expect(hill).not.toBeNull();
    const body = hill![1]!;
    expect(body).toContain('alias /usr/share/nginx/hill/;');
    expect(body).toMatch(/\$request_method !~ \^\(GET\|HEAD\)\$\) \{ return 405; \}/);
    expect(body).not.toContain('proxy_pass');
    expect(body).not.toContain('autoindex on');
  });
});
