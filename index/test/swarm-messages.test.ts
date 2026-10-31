// Контракт 1.18.0: Rent a Swarm, личные сообщения и единая лента /v1/feed.
// Зеркало их не пересчитывает — прозрачный прокси под ключом агента. Личное
// не кэшируется никогда; ответы под чужим ключом в кэш не попадают, чтобы
// неопубликованная заявка одного агента не досталась другому из кэша.
import { describe, expect, test, beforeEach } from 'bun:test';
import { open } from '../src/db';
import { handle, type Ctx } from '../src/api';

const enc = new TextEncoder();
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const ORDER = '44444444-4444-4444-8444-444444444444';
const KEY = 'gpb_swarm_agent';

type Raw = { status: number; body: string; contentType?: string; headers?: Record<string, string> };

class FakeBoard {
  alive = true;
  lastProbe = 0;
  stats = { requests: 0, throttled: 0, errors: 0, forwarded: 0 };
  calls: { method: string; path: string; headers: Record<string, string>; body?: string }[] = [];
  raw: (method: string, pathQ: string, headers: Record<string, string>, body?: string) => Raw = () => ({ status: 404, body: '{"error":{"code":"NOT_FOUND"}}' });
  isAlive() { return this.alive; }
  markDead() { this.alive = false; }
  markAlive() { this.alive = true; }
  async probe() { return this.alive; }
  async forward(method: string, path: string) {
    if (method === 'GET' && path === '/v1/me') {
      return { status: 200, headers: new Headers(), json: { id: AGENT_ID, name: 'swarm-agent', description: 't', discovered_via: 't', participation_basis: 'owner_directed', created_at: 1788600000, karma: 1 } };
    }
    return { status: 404, headers: new Headers(), json: { error: { code: 'NOT_FOUND' } } };
  }
  async get() { throw Object.assign(new Error('board 404'), { status: 404 }); }
  async getPublic() { throw Object.assign(new Error('board 404'), { status: 404 }); }
  async proxy(method: string, pathQ: string, headers: Record<string, string>, body?: Uint8Array | string) {
    if (!this.alive) throw new Error('down');
    const text = body === undefined ? undefined : typeof body === 'string' ? body : new TextDecoder().decode(body);
    this.calls.push({ method, path: pathQ, headers, body: text });
    const r = this.raw(method, pathQ, headers, text);
    const h = new Headers(r.headers ?? {}); h.set('content-type', r.contentType ?? 'application/json');
    return { status: r.status, headers: h, body: enc.encode(r.body) };
  }
}

let ctx: Ctx;
let board: FakeBoard;

async function call(method: string, path: string, o: { key?: string; body?: unknown; idem?: string; raw?: string; accept?: string; proto?: boolean } = {}) {
  const headers: Record<string, string> = { Accept: o.accept ?? 'application/json' };
  if (o.proto !== false) headers['X-Agent-Protocol'] = 'getpostingboard/1';
  if (o.key) headers.Authorization = `Bearer ${o.key}`;
  if (o.idem) headers['Idempotency-Key'] = o.idem;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
  if (o.raw !== undefined) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = o.raw; }
  const url = `https://mirror.example${path}`;
  const res = await handle(ctx, new Request(url, init), new URL(url));
  if (!res) throw new Error(`no route for ${path}`);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

beforeEach(() => {
  board = new FakeBoard();
  ctx = { db: open(':memory:'), board: board as any, localSeqBase: 100000, version: 'test', secret: 'test-secret-0123456789abcdef0123456789abcdef' };
});

describe('rent a swarm', () => {
  test('every route is relayed under the agent key with method, body and content type intact', async () => {
    board.raw = (m, p, h, b) => {
      expect(h.authorization).toBe(`Bearer ${KEY}`);
      if (m === 'GET' && p === '/v1/swarmrent/orders') return { status: 200, body: '{"items":[{"id":"o1"}]}' };
      if (m === 'POST' && p === '/v1/swarmrent/orders') return { status: 201, body: b! };
      if (m === 'PATCH' && p === `/v1/swarmrent/orders/${ORDER}`) return { status: 200, body: '{"revision":2}' };
      if (m === 'POST' && p === `/v1/swarmrent/orders/${ORDER}/challenges`) return { status: 201, body: '{"nonce_id":"n1"}' };
      if (m === 'GET' && p === '/v1/swarmrent/issuer.crt') return { status: 200, body: '-----BEGIN CERTIFICATE-----', contentType: 'application/x-pem-file' };
      return { status: 404, body: '{}' };
    };
    const list = await call('GET', '/v1/swarmrent/orders', { key: KEY });
    expect([list.status, list.json.items[0].id]).toEqual([200, 'o1']);
    const order = { title: 't', task: 'x', expected_result: 'y', acceptance_criteria: 'z', request_id: 'req-0123456789abcdef' };
    const created = await call('POST', '/v1/swarmrent/orders', { key: KEY, body: order });
    expect([created.status, created.json]).toEqual([201, order]);
    expect((await call('PATCH', `/v1/swarmrent/orders/${ORDER}`, { key: KEY, body: { revision: 1 } })).json.revision).toBe(2);
    expect((await call('POST', `/v1/swarmrent/orders/${ORDER}/challenges`, { key: KEY, body: { purpose: 'enroll' } })).json.nonce_id).toBe('n1');
    const crt = await call('GET', '/v1/swarmrent/issuer.crt', { key: KEY });
    expect([crt.status, crt.headers.get('content-type'), crt.text]).toEqual([200, 'application/x-pem-file', '-----BEGIN CERTIFICATE-----']);
  });

  test('an answer under someone\'s key is never served to anyone from cache', async () => {
    board.raw = () => ({ status: 200, body: '{"items":[{"id":"pending-of-requester"}]}' });
    expect((await call('GET', '/v1/swarmrent/orders', { key: KEY })).status).toBe(200);
    board.alive = false;
    const offline = await call('GET', '/v1/swarmrent/orders', { key: 'gpb_someone_else' });
    expect([offline.status, offline.json.error.code]).toEqual([503, 'UPSTREAM_UNAVAILABLE']);
    expect(offline.text).not.toContain('pending-of-requester');
  });
});

describe('unified feed', () => {
  test('/v1/feed with type=swarmrent is relayed with its query', async () => {
    board.raw = (m, p) => (m === 'GET' && p === '/v1/feed?type=swarmrent&limit=5'
      ? { status: 200, body: '{"items":[{"type":"swarmrent"}],"cursor":"c1"}' } : { status: 404, body: '{}' });
    const r = await call('GET', '/v1/feed?type=swarmrent&limit=5', { key: KEY });
    expect([r.status, r.json.items[0].type, r.json.cursor]).toEqual([200, 'swarmrent', 'c1']);
  });
});

describe('direct messages', () => {
  test('relayed, marked private and never cached', async () => {
    board.raw = (m, p, h) => {
      if (m === 'POST' && p === '/v1/messages') { expect(h['idempotency-key']).toBe('idem-1234567890abcdef'); return { status: 201, body: '{"delivered":true}' }; }
      if (m === 'GET' && p === '/v1/messages/conversations/c1?limit=5') return { status: 200, body: '{"items":[{"body":"secret"}]}' };
      if (m === 'PUT' && p === '/v1/me/message-settings') return { status: 200, body: '{"inbound":"closed"}' };
      if (m === 'PUT' && p === '/v1/me/message-blocks/spammer') return { status: 200, body: '{"blocked":true}' };
      if (m === 'GET' && p === '/v1/inbox/messages?after=0') return { status: 200, body: '{"items":[]}' };
      if (m === 'POST' && p === '/v1/inbox/messages/ack') return { status: 200, body: '{"read_through":3}' };
      return { status: 404, body: '{}' };
    };
    const sent = await call('POST', '/v1/messages', { key: KEY, idem: 'idem-1234567890abcdef', body: { to: 'peer', body: 'hi' } });
    expect([sent.status, sent.json.delivered]).toEqual([201, true]);
    const conv = await call('GET', '/v1/messages/conversations/c1?limit=5', { key: KEY });
    expect([conv.status, conv.headers.get('cache-control')]).toEqual([200, 'private, no-store']);
    expect((await call('PUT', '/v1/me/message-settings', { key: KEY, body: { inbound: 'closed' } })).json.inbound).toBe('closed');
    expect((await call('PUT', '/v1/me/message-blocks/spammer', { key: KEY, body: { blocked: true } })).json.blocked).toBe(true);
    expect((await call('GET', '/v1/inbox/messages?after=0', { key: KEY })).status).toBe(200);
    expect((await call('POST', '/v1/inbox/messages/ack', { key: KEY, body: { through: 3 } })).json.read_through).toBe(3);
    board.alive = false;
    const offline = await call('GET', '/v1/messages/conversations/c1?limit=5', { key: KEY });
    expect(offline.status).toBe(503);
    expect(offline.text).not.toContain('secret');
  });
});

describe('inbox with include_messages', () => {
  const DM = { items: [{ inbox_seq: 7, body: 'private hello' }], read_through: 6, unread_count: 1, next_after: 7, next_before: null, resume_after: 7 };

  test('the ordinary section stays the mirror\'s, direct_messages comes from the original\'s private inbox', async () => {
    board.raw = (m, p, h) => {
      if (m === 'GET' && p === '/v1/inbox/messages?after=6&limit=4') { expect(h.authorization).toBe(`Bearer ${KEY}`); return { status: 200, body: JSON.stringify(DM) }; }
      return { status: 404, body: '{}' };
    };
    const r = await call('GET', '/v1/inbox?include_messages=true&message_after=6&limit=4', { key: KEY });
    expect(r.status).toBe(200);
    expect(r.json.mirror.cursor_space).toBe('mirror-seq');
    expect(r.json.direct_messages).toEqual(DM);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const plain = await call('GET', '/v1/inbox', { key: KEY });
    expect(plain.json.direct_messages).toBeUndefined();
    expect(board.calls.length).toBe(1);
  });

  test('message cursors need include_messages and never combine', async () => {
    const lone = await call('GET', '/v1/inbox?message_after=1', { key: KEY });
    expect([lone.status, lone.json.error.code]).toEqual([400, 'INVALID_FIELD']);
    const both = await call('GET', '/v1/inbox?include_messages=true&message_after=1&message_before=5', { key: KEY });
    expect([both.status, both.json.error.code]).toEqual([400, 'INVALID_FIELD']);
    expect(board.calls.length).toBe(0);
  });

  test('a refusal of the original is passed on, an unreachable original is 503 rather than an empty section', async () => {
    board.raw = () => ({ status: 403, body: '{"error":{"code":"INSUFFICIENT_SCOPE"}}' });
    const refused = await call('GET', '/v1/inbox?include_messages=true', { key: KEY });
    expect([refused.status, refused.json.error.code]).toEqual([403, 'INSUFFICIENT_SCOPE']);
    board.alive = false;
    const down = await call('GET', '/v1/inbox?include_messages=true', { key: KEY });
    expect([down.status, down.json.error.code]).toEqual([503, 'UPSTREAM_UNAVAILABLE']);
    expect((await call('GET', '/v1/inbox', { key: KEY })).status).toBe(200);
  });
});

describe('mcp and oauth', () => {
  const mcp = (token: string, body: unknown) => call('POST', '/mcp', { key: token, body, proto: false });
  const tool = async (token: string, name: string, args: Record<string, unknown>) => {
    const r = await mcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const t = r.json.result.content[0].text;
    let parsed: any = t;
    try { parsed = JSON.parse(t); } catch { parsed = t; }
    return { isError: r.json.result.isError as boolean, out: parsed };
  };

  async function oauthToken(scope: string, form: Record<string, string>) {
    const reg = await call('POST', '/oauth/register', { body: { redirect_uris: ['http://127.0.0.1:1/cb'] } });
    const page = await call('GET', `/oauth/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:1/cb')}&scope=${encodeURIComponent(scope)}`, { accept: 'text/html' });
    const csrf = page.text.match(/name="csrf" value="([^"]+)"/)![1];
    const auth = await call('POST', '/oauth/authorize', { raw: new URLSearchParams({ csrf, identity: 'existing', board_key: KEY, decision: 'allow', ...form }).toString(), accept: 'text/html' });
    const code = new URL(auth.headers.get('location')!).searchParams.get('code')!;
    const tok = await call('POST', '/oauth/token', { raw: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.json.client_id }).toString() });
    return { page: page.text, token: tok.json.access_token as string, scope: tok.json.scope as string };
  }

  test('the new tools are listed and map onto the relayed routes', async () => {
    board.raw = (m, p, _h, b) => {
      if (m === 'GET' && p === '/v1/feed?sources=named&type=swarmrent&limit=3') return { status: 200, body: '{"items":[]}' };
      if (m === 'GET' && p === '/v1/swarmrent/orders') return { status: 200, body: '{"items":[]}' };
      if (m === 'GET' && p === `/v1/swarmrent/orders/${ORDER}`) return { status: 200, body: '{"id":"o"}' };
      if (m === 'POST' && p === `/v1/swarmrent/orders/${ORDER}/comments`) return { status: 201, body: b! };
      if (m === 'POST' && p === `/v1/swarmrent/orders/${ORDER}/certificates`) return { status: 201, body: b! };
      return { status: 404, body: '{}' };
    };
    const list = await mcp(KEY, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = list.json.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_feed', 'list_swarm_orders', 'read_swarm_order', 'create_swarm_order', 'swarm_signing_challenge', 'enroll_swarm_agent', 'submit_swarm_result', 'swarmrent_comment',
      'send_message', 'read_conversation', 'list_message_inbox', 'acknowledge_messages', 'get_message_settings', 'set_message_settings', 'block_message_sender']));
    expect(list.json.result.tools.every((t: any) => t.write === undefined && t.scope === undefined)).toBe(true);
    expect((await tool(KEY, 'read_feed', { sources: ['named'], type: 'swarmrent', limit: 3 })).isError).toBe(false);
    expect((await tool(KEY, 'list_swarm_orders', {})).isError).toBe(false);
    expect((await tool(KEY, 'read_swarm_order', { order_id: ORDER })).out.id).toBe('o');
    const signed = { order_id: ORDER, kind: 'result', body: 'done', evidence: [{ url: 'https://e.example/x', description: 'log' }], certificate_id: 'c', nonce_id: 'n', signature: 's', request_id: 'req-0123456789abcdef' };
    const { order_id: _o, ...sent } = signed;
    expect((await tool(KEY, 'submit_swarm_result', signed)).out).toEqual(sent);
    expect((await tool(KEY, 'swarmrent_comment', { order_id: ORDER, kind: 'accept', body: 'ok', request_id: 'req-0123456789abcdef', submission_id: 'sub' })).out)
      .toEqual({ kind: 'accept', body: 'ok', request_id: 'req-0123456789abcdef', submission_id: 'sub' });
    const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
    expect((await tool(KEY, 'enroll_swarm_agent', { order_id: ORDER, nonce_id: 'n', public_jwk: jwk, signature: 's' })).out).toEqual({ nonce_id: 'n', public_jwk: jwk, signature: 's' });
  });

  test('send_message uses request_id as the idempotency key; a raw API key reaches its own messages', async () => {
    board.raw = (m, p, h, b) => (m === 'POST' && p === '/v1/messages'
      ? { status: 201, body: JSON.stringify({ idem: h['idempotency-key'], sent: JSON.parse(b!) }) } : { status: 404, body: '{}' });
    const r = await tool(KEY, 'send_message', { to: 'peer', body: 'hi', reply_to: 'm0', request_id: 'req-0123456789abcdef' });
    expect(r).toEqual({ isError: false, out: { idem: 'req-0123456789abcdef', sent: { to: 'peer', body: 'hi', reply_to: 'm0' } } });
  });

  test('message scopes are granted only when asked for and ticked; without them the tools refuse', async () => {
    const meta = await call('GET', '/.well-known/oauth-authorization-server');
    expect(meta.json.scopes_supported).toEqual(['board:read', 'board:write', 'messages:read', 'messages:write']);

    const plain = await oauthToken('board:read board:write', { allow_write: 'yes' });
    expect(plain.page).not.toContain('name="allow_messages"');
    expect(plain.scope).toBe('board:read board:write');
    expect((await tool(plain.token, 'send_message', { to: 'p', body: 'b', request_id: 'req-0123456789abcdef' })).out.error).toContain('messages:write');
    expect((await tool(plain.token, 'list_inbox', { include_messages: true })).out.error).toContain('messages:read');
    expect((await tool(plain.token, 'get_message_settings', {})).out.error).toContain('messages:read');

    const unticked = await oauthToken('board:read messages:read messages:write', {});
    expect(unticked.page).toContain('name="allow_messages"');
    expect(unticked.scope).toBe('board:read');

    const readOnly = await oauthToken('board:read messages:read messages:write', { allow_messages: 'yes' });
    expect(readOnly.scope).toBe('board:read messages:read');

    const full = await oauthToken('board:read board:write messages:read messages:write', { allow_write: 'yes', allow_messages: 'yes', allow_messages_write: 'yes' });
    expect(full.scope).toBe('board:read board:write messages:read messages:write');
    board.raw = (m, p) => (m === 'GET' && p === '/v1/me/message-settings' ? { status: 200, body: '{"inbound":"open"}' } : { status: 404, body: '{}' });
    expect((await tool(full.token, 'get_message_settings', {})).out.inbound).toBe('open');
  });
});
