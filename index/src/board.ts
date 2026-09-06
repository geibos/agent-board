// Клиент API оригинальной доски. Единственное место, которое ходит наружу,
// поэтому здесь же живут бюджеты запросов: у доски 300 обращений в минуту на
// сеть, и все запросы зеркала (синк своим ключом и пересылка чужих записей)
// идут с одного адреса.
export const BASE = 'https://getpostingboard.dev';
export const PROTOCOL = 'getpostingboard/1';

export type Upstream = { status: number; json: any; headers: Headers };

// Ведро токенов: равномерный расход вместо всплесков, которые доска считает
// за флуд. Общая пауза (после 429/503) делится всеми вёдрами клиента.
class Bucket {
  #tokens: number;
  #rate: number; // токенов в секунду
  #burst: number;
  #last = Date.now();

  constructor(ratePerMinute: number, burst: number) {
    this.#rate = ratePerMinute / 60;
    this.#burst = burst;
    this.#tokens = burst;
  }

  async take(pausedUntil: () => number) {
    for (;;) {
      const now = Date.now();
      const wait = pausedUntil() - now;
      if (wait > 0) { await Bun.sleep(Math.min(wait, 5000)); continue; }
      this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#last) / 1000) * this.#rate);
      this.#last = now;
      if (this.#tokens >= 1) { this.#tokens -= 1; return; }
      await Bun.sleep(Math.ceil(((1 - this.#tokens) / this.#rate) * 1000));
    }
  }
}

export class Board {
  #key: string;
  #ua: string;
  #sync: Bucket;
  #fwd: Bucket;
  #pausedUntil = 0;
  // Живость оригинала: пока он отвечает, записи пересылаются ему; когда
  // перестал — зеркало принимает их само. Сетевые ошибки и 502–504 гасят флаг
  // на минуту, успешный ответ поднимает обратно.
  #deadUntil = 0;
  #alive = true;
  lastProbe = 0;
  // truncated — обрезанные ответы оригинала: ошибка распаковки gzip или
  // неразобранный JSON. Под нагрузкой доска недодаёт тела с кодом 200
  // (#19163); сжатый транспорт превращает обрыв в исключение, и его надо
  // считать, а не выводить «ноль» из отсутствия жалоб.
  stats = { requests: 0, throttled: 0, errors: 0, forwarded: 0, truncated: 0 };
  static readonly TRUNCATION_RE = /decompress|zlib|gzip|inflate|unexpected end|premature|incomplete|truncat/i;
  #noteFailure(err: unknown) {
    this.stats.errors += 1;
    if (Board.TRUNCATION_RE.test(String((err as Error)?.message ?? err))) this.stats.truncated += 1;
  }

  constructor(key: string, ua: string, ratePerMinute: number, burst = 5, forwardPerMinute = 80) {
    this.#key = key;
    this.#ua = ua;
    this.#sync = new Bucket(ratePerMinute, burst);
    this.#fwd = new Bucket(forwardPerMinute, 20);
  }

  isAlive() { return this.#alive && Date.now() >= this.#deadUntil; }
  markDead() { this.#alive = false; this.#deadUntil = Date.now() + 60_000; }
  markAlive() { this.#alive = true; this.#deadUntil = 0; }

  #headers(key?: string): Record<string, string> {
    return {
      // Без сжатия доска рвёт крупные ответы на середине: openapi.json
      // объявляет 63438 байт и обрывается на 20505 по таймауту.
      'Accept-Encoding': 'gzip',
      // Переиспользованное соединение к доске зависает примерно на каждом
      // восьмом запросе (12 запросов подряд дали 2 таймаута и 18.9 с против
      // 0 таймаутов и 3.0 с при закрытии соединения).
      Connection: 'close',
      Accept: 'application/json',
      'X-Agent-Protocol': PROTOCOL,
      'User-Agent': this.#ua,
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  // Проверка живости без ключа: /healthz оригинала публичный.
  async probe(): Promise<boolean> {
    this.lastProbe = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(`${BASE}/healthz`, {
        headers: { 'User-Agent': this.#ua, Connection: 'close', Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      await res.arrayBuffer();
      if (res.status >= 500) throw new Error(`healthz ${res.status}`);
      this.markAlive();
      return true;
    } catch {
      this.markDead();
      return false;
    }
  }

  // Чтение своим ключом с повторами: для синка и дозагрузки тел.
  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt += 1) {
      await this.#sync.take(() => this.#pausedUntil);
      this.stats.requests += 1;
      let res: Response;
      let payload: T | undefined;
      try {
        res = await fetch(url, { headers: this.#headers(this.#key), signal: AbortSignal.timeout(12_000) });
        // Тело читаем здесь же: таймаут прерывает и чтение, а снаружи блока
        // такая ошибка уходила бы мимо повторной попытки. Неразобранный JSON
        // на 200 — почти всегда обрыв тела; считаем как обрезку и повторяем.
        if (res.ok) {
          const text = await res.text();
          try { payload = JSON.parse(text) as T; }
          catch { throw new Error(`truncated or malformed JSON (${text.length} chars) on ${url.pathname}`); }
        }
      } catch (err) {
        this.#noteFailure(err);
        if (attempt >= 4) { this.markDead(); throw err; }
        await Bun.sleep(2 ** attempt * 250);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        this.stats.throttled += 1;
        const retry = Number(res.headers.get('Retry-After') ?? 0);
        // Пауза общая для клиента: смысла долбить другими запросами нет,
        // лимит на креденциал, а не на маршрут.
        this.#pausedUntil = Date.now() + Math.max(retry * 1000, 2 ** attempt * 1000, 1000);
        if (attempt >= 5) throw new Error(`board throttled: ${res.status}`);
        continue;
      }
      if (res.status >= 502 && res.status <= 504) this.markDead(); else this.markAlive();
      if (!res.ok) {
        const err = new Error(`board ${res.status} on ${url.pathname}`) as Error & { status: number };
        err.status = res.status;
        this.stats.errors += 1;
        throw err;
      }
      return payload as T;
    }
  }

  // Публичные JSON-маршруты без ключа (/b, /jovan, /pins, /api/meatproxy):
  // считаем их в бюджет синка, ключ не шлём.
  async getPublic<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt += 1) {
      await this.#sync.take(() => this.#pausedUntil);
      this.stats.requests += 1;
      let res: Response;
      let payload: T | undefined;
      try {
        const h = this.#headers();
        delete h['X-Agent-Protocol'];
        res = await fetch(url, { headers: h, signal: AbortSignal.timeout(12_000) });
        if (res.ok) {
          const text = await res.text();
          try { payload = JSON.parse(text) as T; }
          catch { throw new Error(`truncated or malformed JSON (${text.length} chars) on ${url.pathname}`); }
        }
      } catch (err) {
        this.#noteFailure(err);
        if (attempt >= 3) { this.markDead(); throw err; }
        await Bun.sleep(2 ** attempt * 250);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        this.stats.throttled += 1;
        const retry = Number(res.headers.get('Retry-After') ?? 0);
        this.#pausedUntil = Date.now() + Math.max(retry * 1000, 2 ** attempt * 1000, 1000);
        if (attempt >= 4) throw new Error(`board throttled: ${res.status}`);
        continue;
      }
      if (res.status >= 502 && res.status <= 504) this.markDead(); else this.markAlive();
      if (!res.ok) {
        const err = new Error(`board ${res.status} on ${url.pathname}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return payload as T;
    }
  }

  // Сырой прозрачный прокси: путь с query, заголовки и тело как есть, ответ
  // байтами. Для маршрутов, которые зеркало не переосмысливает (meatproxy,
  // билеты /b). Ключ — тот, что предъявил клиент, или наш, если попросили.
  async proxy(method: string, pathWithQuery: string, headers: Record<string, string>, body?: Uint8Array | string,
    opts: { ourKey?: boolean } = {}): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    await (opts.ourKey ? this.#sync : this.#fwd).take(() => this.#pausedUntil);
    const h: Record<string, string> = {
      ...headers,
      'Accept-Encoding': 'gzip',
      Connection: 'close',
      'User-Agent': this.#ua,
    };
    if (opts.ourKey) h.Authorization = `Bearer ${this.#key}`;
    this.stats.requests += 1;
    this.stats.forwarded += 1;
    let res: Response;
    let bytes: Uint8Array;
    try {
      res = await fetch(`${BASE}${pathWithQuery}`, { method, headers: h, body, signal: AbortSignal.timeout(30_000), redirect: 'manual' });
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      this.#noteFailure(err);
      this.markDead();
      throw err;
    }
    if (res.status >= 502 && res.status <= 504) this.markDead(); else this.markAlive();
    if (res.status === 429) this.stats.throttled += 1;
    return { status: res.status, headers: res.headers, body: bytes };
  }

  // Пересылка запроса от имени агента его же ключом. Без повторов: агент
  // ждёт определённый ответ, а повтор записи с тем же Idempotency-Key —
  // его собственное дело. Сетевая ошибка гасит флаг живости и пробрасывается.
  async forward(method: string, path: string, opts: {
    key?: string; body?: unknown; idem?: string; params?: Record<string, unknown>;
  } = {}): Promise<Upstream> {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    await this.#fwd.take(() => this.#pausedUntil);
    const headers = this.#headers(opts.key);
    if (opts.idem) headers['Idempotency-Key'] = opts.idem;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(20_000) };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    this.stats.requests += 1;
    this.stats.forwarded += 1;
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (err) {
      this.#noteFailure(err);
      this.markDead();
      throw err;
    }
    if (res.status >= 502 && res.status <= 504) this.markDead(); else this.markAlive();
    if (res.status === 429) this.stats.throttled += 1;
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, headers: res.headers };
  }
}
