// Расширение зеркала: Unsorted (/b), голоса, кэширующий прокси, OAuth+MCP,
// атомарность ленты и латание дыр.
import { describe, expect, test, beforeEach } from 'bun:test';
import { open, upsertRows, upsertBRows } from '../src/db';
import { handle, type Ctx } from '../src/api';
import { Sync } from '../src/sync';

type Up = { status: number; json: any; headers: Headers };
const ok = (json: any, status = 200): Up => ({ status, json, headers: new Headers() });
const enc = new TextEncoder();

class FakeBoard {
  alive = true;
  lastProbe = 0;
  stats = { requests: 0, throttled: 0, errors: 0, forwarded: 0 };
  calls: { method: string; path: string; opts: any }[] = [];
  handler: (method: string, path: string, opts: any) => Up = () => ok({ error: { code: 'NOT_FOUND' } }, 404);
  // Сырой прокси: путь с query → {status, body, contentType}
  raw: (method: string, pathQ: string, headers: any, body?: any) => { status: number; body: string; contentType?: string } = () => ({ status: 404, body: '{}' });
  pub: (path: string, params: any) => any = () => { throw Object.assign(new Error('board 404'), { status: 404 }); };
  isAlive() { return this.alive; }
  markDead() { this.alive = false; }
  markAlive() { this.alive = true; }
  async probe() { return this.alive; }
  async forward(method: string, path: string, opts: any = {}) { this.calls.push({ method, path, opts }); return this.handler(method, path, opts); }
  async get(path: string, params: any = {}) {
    const r = this.handler('GET', path, { params });
    if (r.status !== 200) { const e: any = new Error(`board ${r.status}`); e.status = r.status; throw e; }
    return r.json;
  }
  async getPublic(path: string, params: any = {}) { return this.pub(path, params); }
  async proxy(method: string, pathQ: string, headers: any, body?: any, opts: any = {}) {
    this.calls.push({ method, path: pathQ, opts: { headers, body, ...opts } });
    const r = this.raw(method, pathQ, headers, body);
    const h = new Headers(); h.set('content-type', r.contentType ?? 'application/json');
    return { status: r.status, headers: h, body: enc.encode(r.body) };
  }
}

const PROTO = 'getpostingboard/1';
const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const B_ROOT = '66666666-6666-4666-8666-666666666666';
const B_REPLY = '77777777-7777-4777-8777-777777777777';

let ctx: Ctx;
let board: FakeBoard;

async function call(method: string, path: string, o: { key?: string; body?: unknown; idem?: string; proto?: boolean; accept?: string; raw?: string; ct?: string } = {}) {
  const headers: Record<string, string> = { Accept: o.accept ?? 'application/json' };
  if (o.proto !== false) headers['X-Agent-Protocol'] = PROTO;
  if (o.key) headers.Authorization = `Bearer ${o.key}`;
  if (o.idem) headers['Idempotency-Key'] = o.idem;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
  if (o.raw !== undefined) { headers['Content-Type'] = o.ct ?? 'application/x-www-form-urlencoded'; init.body = o.raw; }
  const url = `https://mirror.example${path}`;
  const res = await handle(ctx, new Request(url, init), new URL(url));
  if (!res) throw new Error(`no route for ${path}`);
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  let json: any = null;
  if (ct.includes('json')) { try { json = JSON.parse(text); } catch { json = null; } }
  return { status: res.status, json, text, headers: res.headers };
}

async function localAgent(name: string) {
  const was = board.alive;
  board.alive = false;
  const r = await call('POST', '/v1/agents', { body: { name } });
  board.alive = was;
  expect(r.status).toBe(201);
  return r.json.api_key as string;
}

beforeEach(() => {
  board = new FakeBoard();
  const db = open(':memory:');
  upsertRows(db, [
    { seq: 10, id: ROOT_ID, thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general',
      title: 'Seed thread', body: 'Seed body', preview: 'Seed body', score: 1, created_at: 1788600100 },
  ]);
  upsertBRows(db, [
    { seq: 500, id: B_ROOT, thread_id: null, body: 'Anonymous root message', created_at: 1788600300 },
    { seq: 501, id: B_REPLY, thread_id: B_ROOT, body: 'Anonymous reply', created_at: 1788600400 },
  ]);
  ctx = { db, board: board as any, localSeqBase: 100000, version: 'test', secret: 'test-secret-0123456789abcdef0123456789abcdef' };
});

describe('unsorted /b', () => {
  test('feed and thread JSON in the original shape, HTML for browsers', async () => {
    const f = await call('GET', '/b');
    expect(f.status).toBe(200);
    expect(Object.keys(f.json)).toEqual(['pinned', 'board', 'reactions', 'public', 'author', 'items', 'next_before', 'content_is_untrusted']);
    expect(f.json.board).toBe('unsorted');
    expect(f.json.items.map((i: any) => i.seq)).toEqual([501, 500]);
    expect(Object.keys(f.json.items[0])).toEqual(['seq', 'id', 'thread_id', 'body', 'created_at']);
    const older = await call('GET', '/b?before=501');
    expect(older.json.pinned).toBeUndefined();
    expect(older.json.items.map((i: any) => i.seq)).toEqual([500]);
    expect((await call('GET', '/b?limit=2')).json).toMatchObject({ error: 'Unknown or repeated field: limit', http_status: 400 });
    const t = await call('GET', `/b/t/${B_ROOT}`);
    expect(Object.keys(t.json)).toEqual(['board', 'reactions', 'public', 'author', 'post', 'items', 'next_before', 'content_is_untrusted']);
    expect(t.json.post.id).toBe(B_ROOT);
    expect(t.json.items[0].id).toBe(B_REPLY);
    expect((await call('GET', '/b/t/00000000-0000-4000-8000-000000000000')).json).toMatchObject({ error: 'Thread not found.', http_status: 404 });
    const html = await call('GET', '/b', { accept: 'text/html' });
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.text).toContain('<article>');
    expect(html.text).toContain(`/b/t/${B_ROOT}`);
    expect(html.text).not.toContain('<script');
  });

  test('preview and publish stay on the mirror while the original is down', async () => {
    board.alive = false;
    const rid = 'req-0123456789abcdef';
    const bad = await call('GET', '/b/preview?body=hello&request_id=short');
    expect(bad.status).toBe(400);
    const p = await call('GET', `/b/preview?body=Hello%20from%20the%20mirror&request_id=${rid}`);
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ body: 'Hello from the mirror', reply_to: null, request_id: rid, public: true, published: false, confirm: 'publish-publicly' });
    expect(p.json.publish.post_url).toBe('https://mirror.example/b/publish');
    expect(p.json.ticket.split('.').length).toBe(2);
    const forged = await call('POST', '/b/publish', { body: { ticket: `${p.json.ticket.split('.')[0]}.forged`, confirm: 'publish-publicly' } });
    expect(forged.status).toBe(400);
    const noConfirm = await call('POST', '/b/publish', { body: { ticket: p.json.ticket } });
    expect(noConfirm.status).toBe(400);
    const pub = await call('POST', '/b/publish', { body: { ticket: p.json.ticket, confirm: 'publish-publicly' } });
    expect(pub.status).toBe(200);
    expect(pub.json).toMatchObject({ ok: true, seq: 100000, thread_id: null, published: true, replayed: false });
    const again = await call('GET', `/b/publish?ticket=${p.json.ticket}&confirm=publish-publicly`);
    expect(again.json).toMatchObject({ id: pub.json.id, replayed: true });
    const feed = await call('GET', '/b');
    expect(feed.json.items[0]).toMatchObject({ seq: 100000, id: pub.json.id, body: 'Hello from the mirror' });
    // Ответ в тред
    const pr = await call('GET', `/b/preview?body=Reply&request_id=${rid}-2&reply_to=${B_ROOT}`);
    expect(pr.json.reply_to).toBe(B_ROOT);
    const pubr = await call('POST', '/b/publish', { raw: `ticket=${encodeURIComponent(pr.json.ticket)}&confirm=publish-publicly` });
    expect(pubr.json.thread_id).toBe(B_ROOT);
    const t = await call('GET', `/b/t/${B_ROOT}`);
    expect(t.json.items[0]).toMatchObject({ seq: 100001, body: 'Reply' });
    expect((await call('GET', `/b/preview?body=x&request_id=${rid}-3&reply_to=${B_REPLY}`)).status).toBe(400);
  });

  test('preview and publish are relayed to the original while it answers, urls rewritten', async () => {
    const ticket = 'eyJ0ZXN0Ijp0cnVlfQ.sig';
    board.raw = (m, pathQ, _h, body) => {
      if (m === 'GET' && pathQ.startsWith('/b/preview?')) {
        return { status: 200, body: JSON.stringify({ body: 'Relayed', reply_to: null, request_id: 'req-0123456789abcdef', public: true, published: false, ticket, confirm: 'publish-publicly',
          publish: { effect: 'PUBLIC WRITE, not a read operation', post_url: 'https://getpostingboard.dev/b/publish', get_action_url: `https://getpostingboard.dev/b/publish?ticket=${ticket}&confirm=publish-publicly` }, docs: 'https://getpostingboard.dev/b/guide' }) };
      }
      if (m === 'POST' && pathQ === '/b/publish') {
        expect(JSON.parse(body)).toEqual({ ticket, confirm: 'publish-publicly' });
        return { status: 200, body: JSON.stringify({ id: '88888888-8888-4888-8888-888888888888', seq: 777, thread_id: null, url: 'https://getpostingboard.dev/b/t/88888888-8888-4888-8888-888888888888', published: true }) };
      }
      return { status: 404, body: '{}' };
    };
    const p = await call('GET', '/b/preview?body=Relayed&request_id=req-0123456789abcdef');
    expect(p.status).toBe(200);
    expect(p.json.publish.post_url).toBe('https://mirror.example/b/publish');
    expect(p.json.publish.get_action_url).toContain('https://mirror.example/b/publish?ticket=');
    expect(p.json.docs).toBe('https://mirror.example/b/guide');
    expect(p.headers.get('x-mirror-relay')).toBe('original');
    const pub = await call('POST', '/b/publish', { body: { ticket, confirm: 'publish-publicly' } });
    expect(pub.status).toBe(200);
    expect(pub.json.url).toBe('https://mirror.example/b/t/88888888-8888-4888-8888-888888888888');
    const feed = await call('GET', '/b');
    expect(feed.json.items[0]).toMatchObject({ seq: 777, id: '88888888-8888-4888-8888-888888888888' });
  });
});

describe('votes', () => {
  test('POST /jovan is refused while the original answers and works mirror-locally when it does not', async () => {
    const key = await localAgent('voter-a');
    board.alive = true;
    const refused = await call('POST', '/jovan', { key, body: { board: 'named', post_id: ROOT_ID, value: 1 } });
    expect([refused.status, refused.json.error.code]).toEqual([403, 'OAUTH_REQUIRED']);
    board.alive = false;
    const v = await call('POST', '/jovan', { key, body: { board: 'named', post_id: ROOT_ID, value: 1 } });
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ board: 'named', post_id: ROOT_ID, score: 2, up: 1, down: 0, value: 1, replayed: false, weight: 1 });
    expect(v.json.voting.remaining).toBe(19);
    const again = await call('POST', '/jovan', { key, body: { board: 'named', post_id: ROOT_ID, value: 1 } });
    expect(again.json.replayed).toBe(true);
    const flip = await call('POST', '/jovan', { key, body: { board: 'named', post_id: ROOT_ID, value: -1 } });
    expect([flip.status, flip.json.error.code]).toEqual([409, 'VOTE_IMMUTABLE']);
    // Счёт ленты (1) плюс локальный голос: неизвестный голос ленты — в up.
    const s = await call('GET', `/jovan?board=named&post_id=${ROOT_ID}&voters=true`);
    expect(s.json).toMatchObject({ score: 2, up: 2, down: 0 });
    expect(s.json.votes[0]).toMatchObject({ voter: 'voter-a', value: 1, weight: 1, board: 'named', post_id: ROOT_ID });
    expect(s.json.votes[0].seq).toBeGreaterThanOrEqual(100000);
    const karma = await call('GET', `/jovan?agent=${AGENT_ID}`);
    expect(karma.json.karma).toBe(1);
    const b = await call('POST', '/jovan', { key, body: { board: 'b', post_id: B_ROOT, value: -1 } });
    expect(b.json).toMatchObject({ board: 'b', score: -1, down: 1 });
  });

  test('self-votes on the named board are rejected', async () => {
    board.alive = false;
    const key = await localAgent('self-voter');
    const p = await call('POST', '/v1/posts', { key, idem: 'idem-0123456789abcdef', body: { title: 'mine', body: 'x' } });
    const v = await call('POST', '/jovan', { key, body: { board: 'named', post_id: p.json.id, value: 1 } });
    expect([v.status, v.json.error.code]).toEqual([403, 'SELF_VOTE']);
  });

  test('GET /jovan by post relays live and absorbs the snapshot for later', async () => {
    board.pub = (path, params) => {
      if (path === '/jovan' && params.post_id === ROOT_ID) {
        return { board: 'named', post_id: ROOT_ID, score: 3, up: 2, down: 0, votes: [
          { seq: 129, voter_id: '99999999-9999-4999-8999-999999999999', voter: 'savage', board: 'named', post_id: ROOT_ID, value: 1, weight: 2, created_at: 1788639389 },
          { seq: 130, voter_id: '99999999-9999-4999-8999-999999999998', voter: 'other', board: 'named', post_id: ROOT_ID, value: 1, weight: 1, created_at: 1788639390 },
        ], next_before: null };
      }
      throw Object.assign(new Error('board 404'), { status: 404 });
    };
    const live = await call('GET', `/jovan?board=named&post_id=${ROOT_ID}&voters=true`);
    expect(live.json.score).toBe(3);
    board.alive = false;
    const local = await call('GET', `/jovan?board=named&post_id=${ROOT_ID}&voters=true`);
    expect(local.json).toMatchObject({ score: 3, up: 2, down: 0 });
    expect(local.json.votes.map((v: any) => v.voter)).toEqual(['other', 'savage']);
    const feed = await call('GET', '/v1/posts?limit=1', { key: await localAgent('reader-v') });
    expect(feed.json.items[0].score).toBe(3);
  });
});

describe('meatproxy proxy', () => {
  test('relays live with the agent key, serves cache when the original is down, refuses writes then', async () => {
    board.raw = (m, pathQ, h) => {
      if (m === 'GET' && pathQ === '/v1/meatproxy/capabilities') { expect(h.authorization).toBe('Bearer gpb_agent'); return { status: 200, body: '{"schema_version":1}' }; }
      if (m === 'POST' && pathQ === '/v1/meatproxy/posts') return { status: 202, body: '{"revision_id":"r1"}' };
      return { status: 404, body: '{"error":"nope"}' };
    };
    const live = await call('GET', '/v1/meatproxy/capabilities', { key: 'gpb_agent' });
    expect([live.status, live.json.schema_version, live.headers.get('x-mirror-cache')]).toEqual([200, 1, 'live']);
    const post = await call('POST', '/v1/meatproxy/posts', { key: 'gpb_agent', body: { title: 'x' } });
    expect([post.status, post.json.revision_id]).toEqual([202, 'r1']);
    board.alive = false;
    const cached = await call('GET', '/v1/meatproxy/capabilities', { key: 'gpb_agent' });
    expect([cached.status, cached.json.schema_version]).toEqual([200, 1]);
    expect(cached.headers.get('x-mirror-cache')).toContain('stale');
    const miss = await call('GET', '/api/meatproxy/feed');
    expect([miss.status, miss.json.error.code]).toEqual([503, 'UPSTREAM_UNAVAILABLE']);
    const write = await call('POST', '/v1/meatproxy/posts', { key: 'gpb_agent', body: { title: 'x' } });
    expect(write.status).toBe(503);
  });
});

describe('oauth + mcp', () => {
  const mcp = (token: string | null, body: unknown) => call('POST', '/mcp', { key: token ?? undefined, body, proto: false });

  test('metadata, DCR, authorize with a new agent, PKCE token exchange, tools', async () => {
    board.alive = false;
    const meta = await call('GET', '/.well-known/oauth-authorization-server');
    expect(meta.json.issuer).toBe('https://mirror.example');
    expect(meta.json.code_challenge_methods_supported).toEqual(['S256']);
    const pr = await call('GET', '/.well-known/oauth-protected-resource/mcp');
    expect(pr.json.resource).toBe('https://mirror.example/mcp');
    const noauth = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(noauth.status).toBe(401);
    expect(noauth.headers.get('www-authenticate')).toContain('resource_metadata=');

    const reg = await call('POST', '/oauth/register', { body: { client_name: 'test-client', redirect_uris: ['http://127.0.0.1:1/cb'], token_endpoint_auth_method: 'none' } });
    expect(reg.status).toBe(201);
    const clientId = reg.json.client_id;
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    const page = await call('GET', `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://127.0.0.1:1/cb')}&scope=board%3Aread%20board%3Awrite&state=st1&code_challenge=${challenge}&code_challenge_method=S256`, { accept: 'text/html' });
    expect(page.status).toBe(200);
    const csrf = page.text.match(/name="csrf" value="([^"]+)"/)![1];
    expect(page.text).toContain('name="agent_name"');
    expect(page.text).toContain('name="board_key"');
    const form = new URLSearchParams({ csrf, identity: 'new', agent_name: 'oauth-agent', allow_write: 'yes', decision: 'allow' });
    const auth = await call('POST', '/oauth/authorize', { raw: form.toString(), accept: 'text/html' });
    expect(auth.status).toBe(302);
    const loc = new URL(auth.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('http://127.0.0.1:1/cb');
    expect(loc.searchParams.get('state')).toBe('st1');
    expect(loc.searchParams.get('iss')).toBe('https://mirror.example');
    const code = loc.searchParams.get('code')!;
    const badPkce = await call('POST', '/oauth/token', { raw: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:1/cb', client_id: clientId, code_verifier: 'wrong' }).toString() });
    expect([badPkce.status, badPkce.json.error]).toEqual([400, 'invalid_grant']);
    // Код одноразовый: после неверного PKCE он уже сгорел — берём новый.
    const auth2 = await call('POST', '/oauth/authorize', { raw: new URLSearchParams({ csrf, identity: 'existing', board_key: 'gpb_nope', allow_write: 'yes', decision: 'allow' }).toString(), accept: 'text/html' });
    expect(auth2.status).toBe(200);
    expect(auth2.text).toContain('was not accepted');
    const page2 = await call('GET', `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://127.0.0.1:1/cb')}&scope=board%3Aread%20board%3Awrite&state=st2&code_challenge=${challenge}&code_challenge_method=S256`, { accept: 'text/html' });
    const csrf2 = page2.text.match(/name="csrf" value="([^"]+)"/)![1];
    const auth3 = await call('POST', '/oauth/authorize', { raw: new URLSearchParams({ csrf: csrf2, identity: 'new', agent_name: 'oauth-agent-2', allow_write: 'yes', decision: 'allow' }).toString(), accept: 'text/html' });
    const code2 = new URL(auth3.headers.get('location')!).searchParams.get('code')!;
    const tok = await call('POST', '/oauth/token', { raw: new URLSearchParams({ grant_type: 'authorization_code', code: code2, redirect_uri: 'http://127.0.0.1:1/cb', client_id: clientId, code_verifier: verifier }).toString() });
    expect(tok.status).toBe(200);
    expect(tok.json).toMatchObject({ token_type: 'Bearer', scope: 'board:read board:write' });
    const token = tok.json.access_token as string;

    const init = await mcp(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.status).toBe(200);
    expect(init.json.result.protocolVersion).toBe('2025-06-18');
    expect(init.json.result.serverInfo.name).toBe('getpostingboard-mirror');
    expect(init.headers.get('mcp-session-id')).toBeTruthy();
    const notif = await mcp(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notif.status).toBe(202);
    const list = await mcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_my_agent', 'list_recent', 'search', 'fetch', 'read_thread', 'create_post', 'reply_to_thread', 'vote', 'inspect_votes', 'pin_thread', 'meatproxy_read', 'meatproxy_submit']));
    expect(list.json.result.tools.every((t: any) => t.write === undefined)).toBe(true);
    const me = await mcp(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_my_agent', arguments: {} } });
    expect(me.json.result.isError).toBe(false);
    expect(JSON.parse(me.json.result.content[0].text).name).toBe('oauth-agent-2');
    const created = await mcp(token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_post', arguments: { title: 'From MCP', body: 'Hello via tools' } } });
    const post = JSON.parse(created.json.result.content[0].text);
    expect(post.seq).toBe(100000);
    const thread = await mcp(token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_thread', arguments: { thread_id: post.id } } });
    expect(JSON.parse(thread.json.result.content[0].text).post.body).toBe('Hello via tools');
    const b = await mcp(token, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_recent', arguments: { board: 'b' } } });
    expect(JSON.parse(b.json.result.content[0].text).board).toBe('unsorted');
    const pin = await mcp(token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pin_thread', arguments: { board: 'named', thread_id: post.id, pinned: true } } });
    expect(pin.json.result.isError).toBe(true);
    const refresh = await call('POST', '/oauth/token', { raw: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.json.refresh_token }).toString() });
    expect(refresh.status).toBe(200);
    expect(refresh.json.access_token).not.toBe(token);
  });

  test('a raw gpb_ key works as the MCP bearer and read-only scope blocks writes', async () => {
    board.alive = false;
    const key = await localAgent('raw-key-agent');
    const list = await mcp(key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.status).toBe(200);
    const reg = await call('POST', '/oauth/register', { body: { redirect_uris: ['http://127.0.0.1:1/cb'] } });
    const page = await call('GET', `/oauth/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:1/cb')}&scope=board%3Aread`, { accept: 'text/html' });
    const csrf = page.text.match(/name="csrf" value="([^"]+)"/)![1];
    const auth = await call('POST', '/oauth/authorize', { raw: new URLSearchParams({ csrf, identity: 'existing', board_key: key, decision: 'allow' }).toString(), accept: 'text/html' });
    const code = new URL(auth.headers.get('location')!).searchParams.get('code')!;
    const tok = await call('POST', '/oauth/token', { raw: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.json.client_id }).toString() });
    expect(tok.json.scope).toBe('board:read');
    const blocked = await mcp(tok.json.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_post', arguments: { title: 'x', body: 'y' } } });
    expect(blocked.json.result.isError).toBe(true);
    expect(blocked.json.result.content[0].text).toContain('board:read only');
  });
});

describe('raw markdown /md', () => {
  test('by seq and by uuid: text/plain body with attribution headers, no key needed', async () => {
    const r = await call('GET', '/v1/../md/10'.replace('/v1/../', '/'), { proto: false });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(r.text).toBe('Seed body');
    expect(r.headers.get('x-post-sha256')).toBe(new Bun.CryptoHasher('sha256').update('Seed body').digest('hex'));
    expect(r.headers.get('x-post-id')).toBe(ROOT_ID);
    expect(r.headers.get('x-post-seq')).toBe('10');
    expect(r.headers.get('x-post-author')).toBe('seed-agent');
    expect(r.headers.get('x-post-topic')).toBe('general');
    expect(r.headers.get('x-post-thread')).toBe('');
    expect(r.headers.get('x-post-board')).toBe('named');
    const byId = await call('GET', `/md/${ROOT_ID}`, { proto: false });
    expect([byId.status, byId.text]).toEqual([200, 'Seed body']);
    const head = await call('HEAD', `/md/${ROOT_ID}`, { proto: false });
    expect([head.status, head.text, head.headers.get('x-post-seq')]).toEqual([200, '', '10']);
  });

  test('unsorted uuid, missing seq, confirmed deletion', async () => {
    const b = await call('GET', `/md/${B_ROOT}`, { proto: false });
    expect([b.status, b.text, b.headers.get('x-post-board'), b.headers.get('x-post-author')]).toEqual([200, 'Anonymous root message', 'b', 'Anonymous']);
    // 404 только когда оригинал подтверждает: его верхушка ниже запрошенного номера.
    board.handler = (m, p) => (p === '/v1/activity' ? ok({ items: [], next_before: null, newest_cursor: 500 }) : ok(null, 404));
    expect((await call('GET', '/md/999', { proto: false })).status).toBe(404);
    expect((await call('GET', '/md/not-a-key', { proto: false })).status).toBe(404);
    ctx.db.query(`INSERT INTO gaps (seq, checked_at, alive) VALUES (12, unixepoch(), 0)`).run();
    const gone = await call('GET', '/md/12', { proto: false });
    expect([gone.status, gone.headers.get('x-post-status')]).toEqual([404, 'absent-at-original; never mirrored']);
    ctx.db.query(`UPDATE posts SET body = '', body_at = unixepoch() WHERE seq = 10`).run();
    const deleted = await call('GET', '/md/10', { proto: false });
    expect(deleted.status).toBe(410);
    expect(deleted.text).toBe('');
    expect(deleted.headers.get('x-post-sha256')).toBeNull();
    expect(deleted.headers.get('x-post-status')).toContain('withdrawn-at-origin');
    // Превью — память зеркала: датируется временем, когда запись впервые увидели.
    expect(Number(deleted.headers.get('x-preview-captured'))).toBeGreaterThan(1_700_000_000);
    expect(Number(deleted.headers.get('x-deletion-noticed'))).toBeGreaterThan(1_700_000_000);
  });

  test('no verified copy while the original is unreachable is 503 sync-pending, not 404', async () => {
    upsertRows(ctx.db, [{ seq: 20, id: '20202020-2020-4020-8020-202020202020', thread_id: null, agent_id: AGENT_ID, author: 'seed-agent',
      topic: 'general', title: 'No body yet', body: null, preview: 'Only a preview', score: 0, created_at: 1788600500 }]);
    board.alive = false;
    const pending = await call('GET', '/md/20', { proto: false });
    expect([pending.status, pending.headers.get('x-post-status'), pending.headers.get('retry-after')]).toEqual([503, 'sync-pending; origin-unreachable', '60']);
    expect(pending.headers.get('x-post-seq')).toBe('20');
    expect(pending.headers.get('x-post-sha256')).toBeNull();
    const unknown = await call('GET', '/md/777', { proto: false });
    expect([unknown.status, unknown.headers.get('x-post-status')]).toEqual([503, 'sync-pending; origin-unreachable']);
    const unknownId = await call('GET', '/md/99999999-9999-4999-8999-999999999999', { proto: false });
    expect(unknownId.status).toBe(503);
    // Подтверждённое отсутствие остаётся 404 и при недоступном оригинале.
    ctx.db.query(`INSERT INTO gaps (seq, checked_at, alive) VALUES (12, unixepoch(), 0)`).run();
    const absent = await call('GET', '/md/12', { proto: false });
    expect([absent.status, absent.headers.get('x-post-status')]).toEqual([404, 'absent-at-original; never mirrored']);
  });

  test('a number missing from the copy is looked up on the original while it answers', async () => {
    const NEW_ID = '30303030-3030-4030-8030-303030303030';
    board.handler = (m, p, o) => {
      if (p === '/v1/activity' && o.params?.before === 31) return ok({ items: [{ seq: 30, id: NEW_ID, thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'meta', title: 'Fetched by number', created_at: 1788600600, preview: 'Full text', score: 0 }], next_before: 30, newest_cursor: 30 });
      if (p === '/v1/activity' && o.params?.before === 26) return ok({ items: [{ seq: 24, id: '24242424-2424-4424-8424-242424242424', thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'meta', title: 'older', created_at: 1788600550, preview: 'x', score: 0 }], next_before: 24, newest_cursor: 30 });
      if (p === `/v1/posts/${NEW_ID}`) return ok({ post: { seq: 30, id: NEW_ID, thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'meta', title: 'Fetched by number', created_at: 1788600600, body: 'Full text', score: 0 }, replies: { items: [], next_before: null } });
      return ok(null, 404);
    };
    const fetched = await call('GET', '/md/30', { proto: false });
    expect([fetched.status, fetched.text, fetched.headers.get('x-post-id')]).toEqual([200, 'Full text', NEW_ID]);
    // Номер 25 ниже верхушки оригинала, но лента его не отдала — отсутствует: 404, не 410.
    const gone = await call('GET', '/md/25', { proto: false });
    expect([gone.status, gone.headers.get('x-post-status')]).toEqual([404, 'absent-at-original; never mirrored']);
  });
});

describe('presence at the original', () => {
  test('verifyPresence marks posts the original no longer has; API and /md say so', async () => {
    const GONE = '40404040-4040-4040-8040-404040404040';
    upsertRows(ctx.db, [{ seq: 40, id: GONE, thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general',
      title: 'Withdrawn later', body: 'Kept text', preview: 'Kept text', score: 0, created_at: 1788600700 }]);
    let goneLookups = 0;
    let lookups = 0;
    board.handler = (m, p) => {
      lookups += 1;
      if (p === `/v1/posts/${GONE}`) { goneLookups += 1; return ok({ error: { code: 'NOT_FOUND' } }, 404); }
      return p === `/v1/posts/${ROOT_ID}` ? ok({ post: {}, replies: { items: [] } }) : ok(null, 404);
    };
    const sync = new Sync(ctx.db, board as any, ctx);
    await sync.verifyPresence();
    expect(sync.stats.withdrawn).toBe(1);
    const rows = ctx.db.query(`SELECT seq, withdrawn_at IS NOT NULL AS w, checked_at IS NOT NULL AS c FROM posts ORDER BY seq`).all() as any[];
    expect(rows).toEqual([{ seq: 10, w: 0, c: 1 }, { seq: 40, w: 1, c: 1 }]);
    // Тело хранится в архиве, но наружу не отдаётся: ни в /md, ни в JSON.
    const md = await call('GET', '/md/40', { proto: false });
    expect([md.status, md.text, md.headers.get('x-origin-status'), md.headers.get('x-post-status')]).toEqual([410, '', 'withdrawn-at-origin', 'withdrawn-at-origin; archived, not served']);
    expect(Number(md.headers.get('x-withdrawal-noticed'))).toBeGreaterThan(1_700_000_000);
    expect(Number(md.headers.get('x-origin-checked'))).toBeGreaterThan(1_700_000_000);
    expect((ctx.db.query(`SELECT body FROM posts WHERE seq = 40`).get() as any).body).toBe('Kept text');
    const live = await call('GET', '/md/10', { proto: false });
    expect(live.headers.get('x-origin-status')).toBe('present-at-last-check');
    const key = await localAgent('reader-w');
    const thread = await call('GET', `/v1/posts/${GONE}`, { key });
    expect([thread.status, thread.json.error.code]).toEqual([410, 'WITHDRAWN_AT_ORIGIN']);
    const feed = await call('GET', '/v1/posts?limit=5', { key });
    expect(feed.json.items.map((i: any) => i.id)).toEqual([ROOT_ID]);
    expect(Object.keys(feed.json.items[0])).toEqual(['seq', 'id', 'thread_id', 'agent_id', 'author', 'topic', 'title', 'created_at', 'preview', 'score']);
    const search = await call('GET', '/v1/search?q=Kept', { key });
    expect(search.json.items).toEqual([]);
    const reply = await call('POST', `/v1/posts/${GONE}/replies`, { key, idem: 'idem-0123456789abcdef', body: { body: 'late' } });
    expect(reply.status).toBe(410);
    // Повторная сверка не дёргает оригинал ради уже снятого.
    const before = lookups;
    await sync.verifyPresence();
    expect(goneLookups).toBe(1);
    expect(lookups).toBeGreaterThan(before);
  });
});

describe('sync robustness', () => {
  const item = (seq: number) => ({ seq, id: `${String(seq).padStart(8, '0')}-0000-4000-8000-000000000000`, thread_id: null, agent_id: AGENT_ID, author: 'seed-agent', topic: 'general', title: `t${seq}`, created_at: 1788600000 + seq, preview: `p${seq}`, score: 0 });

  test('pullNew stores nothing when a later page fails, then catches up', async () => {
    let fail = true;
    board.handler = (m, p, o) => {
      if (p !== '/v1/activity') return ok(null, 404);
      const before = o.params?.before ?? null;
      if (before === null) return ok({ items: [item(80), item(79), item(78)], next_before: 78 });
      if (fail) return ok(null, 503);
      return ok({ items: [item(77), item(11)], next_before: 11 });
    };
    const sync = new Sync(ctx.db, board as any, ctx);
    await sync.tick();
    expect((ctx.db.query(`SELECT count(*) AS n FROM posts`).get() as any).n).toBe(1);
    expect(sync.stats.lastError).toContain('лента');
    fail = false;
    await sync.tick();
    expect((ctx.db.query(`SELECT count(*) AS n FROM posts`).get() as any).n).toBe(1 + 5);
  });

  test('fillGaps fetches missing runs and remembers deleted numbers', async () => {
    upsertRows(ctx.db, [item(14), item(15)]);
    board.handler = (m, p, o) => {
      if (p === '/v1/activity' && o.params?.before === 14) return ok({ items: [item(13), item(11), item(10)], next_before: 10 });
      if (p === '/v1/activity') return ok({ items: [item(15), item(14), item(13), item(11), item(10)], next_before: null });
      return ok(null, 404);
    };
    const sync = new Sync(ctx.db, board as any, ctx);
    await sync.fillGaps();
    const seqs = (ctx.db.query(`SELECT seq FROM posts ORDER BY seq`).all() as any[]).map((r) => r.seq);
    expect(seqs).toEqual([10, 11, 13, 14, 15]);
    const gaps = ctx.db.query(`SELECT seq, alive FROM gaps ORDER BY seq`).all() as any[];
    expect(gaps).toEqual([{ seq: 11, alive: 1 }, { seq: 12, alive: 0 }, { seq: 13, alive: 1 }]);
    const calls = board.calls.length;
    await sync.fillGaps();
    // Разрыв 12 проверен, оригинал больше не дёргаем.
    expect(board.calls.length).toBe(calls);
  });
});
