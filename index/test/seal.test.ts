// Каждый JSON-ответ: Content-Length при любой кодировке и отпечаток
// несжатого текста. Сжатие делает сервис, поэтому длина не теряется.
import { describe, expect, test } from 'bun:test';
import { acceptsGzip, json, seal } from '../src/http';

const req = (ae?: string) => new Request('https://mirror.example/v1/posts', { headers: ae ? { 'Accept-Encoding': ae } : {} });
const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex');
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

describe('seal', () => {
  test('identity JSON carries Content-Length of the body and a digest of the body', async () => {
    const res = await seal(req(), json({ items: [1, 2, 3] }));
    const body = await bytes(res);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBe(String(body.byteLength));
    expect(res.headers.get('x-body-sha256')).toBe(sha(body));
    expect(res.headers.get('repr-digest')).toBe(`sha-256=:${Buffer.from(sha(body), 'hex').toString('base64')}:`);
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  test('gzip when asked: length of the compressed bytes, digest of the uncompressed text', async () => {
    const plain = await bytes(json({ items: 'x'.repeat(2000) }));
    const res = await seal(req('gzip, deflate, br'), json({ items: 'x'.repeat(2000) }));
    const body = await bytes(res);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('content-length')).toBe(String(body.byteLength));
    expect(body.byteLength).toBeLessThan(plain.byteLength);
    expect(new Uint8Array(Bun.gunzipSync(body))).toEqual(plain);
    expect(res.headers.get('x-body-sha256')).toBe(sha(plain));
  });

  test('a cut-off gzip body fails to decode instead of parsing as a shorter document', async () => {
    const res = await seal(req('gzip'), json({ items: Array.from({ length: 200 }, (_, i) => ({ i, body: 'text '.repeat(20) })) }));
    const body = await bytes(res);
    expect(() => Bun.gunzipSync(body.slice(0, Math.floor(body.byteLength * 0.9)))).toThrow();
    expect(() => Bun.gunzipSync(body.slice(0, body.byteLength - 1))).toThrow();
  });

  test('accept-encoding parsing: q=0 and unrelated codings mean identity', () => {
    expect(acceptsGzip(req('gzip;q=0, identity'))).toBe(false);
    expect(acceptsGzip(req('br'))).toBe(false);
    expect(acceptsGzip(req())).toBe(false);
    expect(acceptsGzip(req('*'))).toBe(true);
    expect(acceptsGzip(req('GZIP'))).toBe(true);
    expect(acceptsGzip(req('deflate, gzip;q=0.5'))).toBe(true);
  });

  test('non-JSON and already encoded responses pass through untouched', async () => {
    const text = new Response('hello', { headers: { 'Content-Type': 'text/plain' } });
    expect(await seal(req('gzip'), text)).toBe(text);
    const encoded = new Response(Bun.gzipSync('{}'), { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } });
    expect(await seal(req('gzip'), encoded)).toBe(encoded);
  });

  test('status and the original headers survive', async () => {
    const res = await seal(req('gzip'), json({ error: { code: 'X', message: 'y' } }, 404, { 'X-Post-Status': 'absent' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('x-post-status')).toBe('absent');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
