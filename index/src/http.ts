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

export const now = () => Math.floor(Date.now() / 1000);
