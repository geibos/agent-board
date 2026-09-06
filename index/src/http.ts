// Ответы в формате оригинала: JSON, cache-control: private, no-store,
// ошибки {error:{code,message},docs}. Публичный адрес зеркала берётся из
// окружения, потому что он попадает в url записей и в ссылку docs.
const configured = (process.env.MIRROR_BASE_URL ?? '').trim();
if (!/^https?:\/\/[^/\s]+/.test(configured)) {
  console.error('MIRROR_BASE_URL is required: the public https address of this mirror, e.g. https://mirror.example.org');
  process.exit(1);
}
export const MIRROR_BASE = configured.replace(/\/+$/, '');
export const DOCS = `${MIRROR_BASE}/skill.md`;

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  Vary: 'Authorization, X-Agent-Protocol, Accept',
  'X-Board-Service': 'named',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function fail(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message }, docs: DOCS }, status, headers);
}

export const notFound = () => fail(404, 'NOT_FOUND', 'Unknown route or method. See /openapi.json.');

export const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');

// Принимает ли клиент gzip: токен «gzip» или «*» без q=0.
export function acceptsGzip(req: Request): boolean {
  const offered = req.headers.get('accept-encoding') ?? '';
  return offered.split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const token = (name ?? '').trim();
    if (token !== 'gzip' && token !== '*') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

// Полнота JSON-ответа проверяема снаружи при любой кодировке (#19163,
// #19314). Сжимает сервис, а не прокси: потоковое сжатие в nginx снимало
// Content-Length, и обрезанный ответ было не отличить от короткого. Здесь
// длина известна для обоих вариантов тела; Repr-Digest (RFC 9530) и
// X-Body-Sha256 — отпечаток несжатого JSON, он ловит и обрезку, и порчу.
export async function seal(req: Request, res: Response): Promise<Response> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('application/json') || res.headers.has('content-encoding') || !res.body) return res;
  const raw = new Uint8Array(await res.arrayBuffer());
  const digest = Buffer.from(new Bun.CryptoHasher('sha256').update(raw).digest());
  const headers = new Headers(res.headers);
  headers.set('Repr-Digest', `sha-256=:${digest.toString('base64')}:`);
  headers.set('X-Body-Sha256', digest.toString('hex'));
  headers.append('Vary', 'Accept-Encoding');
  const body = acceptsGzip(req) ? Bun.gzipSync(raw) : raw;
  if (body !== raw) headers.set('Content-Encoding', 'gzip');
  headers.set('Content-Length', String(body.byteLength));
  return new Response(body, { status: res.status, headers });
}

export const now = () => Math.floor(Date.now() / 1000);
