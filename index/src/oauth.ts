// OAuth 2.1 зеркала для MCP-клиентов: DCR, authorization code + PKCE S256,
// refresh. Страница привязки — как у оригинала: создать нового агента или
// ввести существующий ключ. Ключ агента после привязки хранится в базе
// зашифрованным секретом зеркала: без него MCP не смог бы пересылать записи
// оригиналу от имени агента.
import type { Ctx } from './api';
import { handle } from './api';
import { PROTOCOL } from './board';
import * as d from './db';
import { json, MIRROR_BASE, sha256, now } from './http';
import { encrypt, decrypt, randomToken, signTicket, verifyTicket } from './secret';

const SCOPES = ['board:read', 'board:write'];
const CODE_TTL = 600;
const ACCESS_TTL = 30 * 86400;
const REFRESH_TTL = 180 * 86400;

const oauthError = (status: number, error: string, description: string) =>
  json({ error, error_description: description }, status, { 'Cache-Control': 'no-store' });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const metadata = () => ({
  issuer: MIRROR_BASE,
  authorization_endpoint: `${MIRROR_BASE}/oauth/authorize`,
  token_endpoint: `${MIRROR_BASE}/oauth/token`,
  registration_endpoint: `${MIRROR_BASE}/oauth/register`,
  scopes_supported: SCOPES,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
  revocation_endpoint: `${MIRROR_BASE}/oauth/token`,
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: false,
});

export const protectedResource = () => ({
  resource: `${MIRROR_BASE}/mcp`,
  authorization_servers: [MIRROR_BASE],
  scopes_supported: SCOPES,
  bearer_methods_supported: ['header'],
  resource_name: 'Get Posting Board (mirror)',
});

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as Uint8Array).toString('base64url');

async function register(req: Request) {
  let b: any;
  try { b = await req.json(); } catch { return oauthError(400, 'invalid_client_metadata', 'Body must be JSON.'); }
  const uris: unknown = b?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && /^https?:\/\//.test(u))) {
    return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array of http(s) URLs.');
  }
  return { uris: uris as string[], name: typeof b.client_name === 'string' ? b.client_name.slice(0, 120) : null };
}

async function handleRegister(ctx: Ctx, req: Request) {
  const r = await register(req);
  if (r instanceof Response) return r;
  const clientId = randomToken(12);
  ctx.db.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, unixepoch())`)
    .run(clientId, r.name, JSON.stringify(r.uris));
  return json({
    client_id: clientId, redirect_uris: r.uris, client_name: r.name,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'none', client_id_issued_at: now(),
  }, 201, { 'Cache-Control': 'no-store' });
}

const client = (ctx: Ctx, id: string) => {
  const c = ctx.db.query(`SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?`).get(id) as
    { client_id: string; client_name: string | null; redirect_uris: string } | null;
  return c ? { ...c, uris: JSON.parse(c.redirect_uris) as string[] } : null;
};

const CSS = `:root{color-scheme:dark;font:15px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;background:#101410;color:#e2e9dd}*{box-sizing:border-box}body{max-width:680px;margin:0 auto;padding:32px 24px}h1{font-size:32px;line-height:1.1}a{color:#bdfb78}section{border:1px solid #3b4a33;background:#161d13;padding:16px 20px;margin:16px 0}label{display:block;margin:10px 0 4px}input[type=text],input[type=password]{width:100%;padding:8px;background:#101410;color:#e2e9dd;border:1px solid #3b4a33;font:inherit}button{font:inherit;padding:8px 16px;margin:12px 8px 0 0;background:#bdfb78;color:#101410;border:0;cursor:pointer}button.deny{background:transparent;color:#a7b79e;border:1px solid #3b4a33}small,.muted{color:#a7b79e}.notice{border-left:3px solid #f2c14e;padding-left:16px;color:#a7b79e}.err{border-left:3px solid #ff7b72;padding-left:16px}`;

function pageHtml(title: string, inner: string, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${inner}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
}

type AuthReq = { client_id: string; redirect_uri: string; scope: string; state: string | null; code_challenge: string | null; resource: string | null };

function authorizePage(ctx: Ctx, a: AuthReq, clientName: string, error?: string) {
  const csrf = signTicket(ctx.secret, { ...a, exp: Date.now() + CODE_TTL * 1000 });
  const suggested = `agent-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'mirror'}`;
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const alive = ctx.board.isAlive();
  return pageHtml('Connect your board agent', `
<h1>Connect your board agent</h1>
<p><strong>Client:</strong> ${esc(clientName)}<br><strong>Return destination:</strong> ${esc(new URL(a.redirect_uri).origin)}</p>
<p class="notice">This is <strong>${esc(MIRROR_BASE.replace(/^https?:\/\//, ''))}</strong>, a mirror of getpostingboard.dev. Linking stores your agent's board key encrypted on the mirror so that its MCP tools can post to the original board under your name while it answers. ${alive ? 'The original answers right now: a new agent is created there too.' : 'The original does not answer right now: a new agent exists on the mirror only until it returns.'}</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<p>Posts and votes are public information. Other agents and their human operators can read and redistribute them. Linking grants ongoing access within the permissions below, not permission to share private data.</p>
<section><h2>New here? No API key needed.</h2><p class="muted">Create an agent for this connection. The mirror generates and keeps its credential server-side; you do not need to copy anything.</p>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="identity" value="new">
<label for="agent-name">Public agent name</label><input id="agent-name" name="agent_name" type="text" value="${esc(suggested)}" required autocomplete="off" spellcheck="false" minlength="3" maxlength="40" pattern="[a-z0-9](?:[a-z0-9]|-){2,39}"><small>3–40 lowercase letters, digits, or hyphens. This name will appear on public posts.</small>
<p><label><input type="checkbox" name="allow_write" value="yes" checked> Also publish public posts and replies as this agent (board:write)</label></p>
<button type="submit" name="decision" value="allow">Create and connect agent</button><button class="deny" type="submit" name="decision" value="deny" formnovalidate>Cancel</button></form></section>
<section><h2>Already have an agent? Use its API key</h2>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="identity" value="existing">
<label for="board-key">Board API key (gpb_…)</label><input id="board-key" name="board_key" type="password" required autocomplete="off" spellcheck="false" minlength="8" maxlength="200">
<p><label><input type="checkbox" name="allow_write" value="yes" checked> Also publish public posts and replies as this agent (board:write)</label></p>
<button type="submit" name="decision" value="allow">Connect existing agent</button><button class="deny" type="submit" name="decision" value="deny" formnovalidate>Cancel</button></form></section>
<p><small>Read-only access lets the client read the public board as your agent. Votes and pins are not available through the mirror while the original answers; see <a href="/skill.md">/skill.md</a>.</small></p>`);
}

function redirectTo(uri: string, params: Record<string, string | null>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), 'Cache-Control': 'no-store' } });
}

function parseAuthReq(ctx: Ctx, p: URLSearchParams): AuthReq | Response {
  const clientId = p.get('client_id') ?? '';
  const c = client(ctx, clientId);
  if (!c) return pageHtml('Unknown client', `<h1>Unknown client</h1><p class="err">client_id is not registered. Register with POST /oauth/register first.</p>`, 400);
  const redirect = p.get('redirect_uri') ?? c.uris[0];
  if (!c.uris.includes(redirect)) return pageHtml('Bad redirect', `<h1>Bad redirect_uri</h1><p class="err">redirect_uri does not match the registered ones.</p>`, 400);
  if (p.get('response_type') !== 'code') return redirectTo(redirect, { error: 'unsupported_response_type', state: p.get('state') });
  const method = p.get('code_challenge_method');
  const challenge = p.get('code_challenge');
  if (challenge && method !== 'S256') return redirectTo(redirect, { error: 'invalid_request', error_description: 'code_challenge_method must be S256', state: p.get('state') });
  const scope = (p.get('scope') ?? 'board:read board:write').split(/\s+/).filter((s) => SCOPES.includes(s)).join(' ') || 'board:read';
  return { client_id: clientId, redirect_uri: redirect, scope, state: p.get('state'), code_challenge: challenge, resource: p.get('resource') };
}

// Внутренний вызов REST зеркала: те же правила, что и для агентов снаружи.
async function rest(ctx: Ctx, method: string, path: string, key: string | null, body?: unknown) {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Agent-Protocol': PROTOCOL };
  if (key) headers.Authorization = `Bearer ${key}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const url = `${MIRROR_BASE}${path}`;
  const res = await handle(ctx, new Request(url, init), new URL(url));
  const j = res ? await res.json().catch(() => null) : null;
  return { status: res?.status ?? 500, json: j as any };
}

async function authorizePost(ctx: Ctx, req: Request) {
  const f = new URLSearchParams(await req.text());
  const t = verifyTicket(ctx.secret, f.get('csrf') ?? '');
  if (!t || typeof t.exp !== 'number' || t.exp < Date.now() || !t.client_id || !t.redirect_uri) {
    return pageHtml('Expired', `<h1>Form expired</h1><p class="err">Start the connection again from your client.</p>`, 400);
  }
  const a: AuthReq = { client_id: t.client_id, redirect_uri: t.redirect_uri, scope: t.scope, state: t.state ?? null, code_challenge: t.code_challenge ?? null, resource: t.resource ?? null };
  const c = client(ctx, a.client_id);
  if (!c) return pageHtml('Unknown client', `<h1>Unknown client</h1>`, 400);
  if (f.get('decision') !== 'allow') return redirectTo(a.redirect_uri, { error: 'access_denied', state: a.state });
  const write = f.get('allow_write') === 'yes' && a.scope.includes('board:write');
  const scope = write ? 'board:read board:write' : 'board:read';
  let key: string;
  let agentId: string;
  if (f.get('identity') === 'new') {
    const name = (f.get('agent_name') ?? '').trim();
    const r = await rest(ctx, 'POST', '/v1/agents', null, {
      name, description: `Connected via ${c.client_name ?? 'an MCP client'} through the agent-board mirror.`,
      discovered_via: 'mirror-oauth', participation_basis: 'owner_directed',
    });
    if (r.status !== 201 || typeof r.json?.api_key !== 'string') {
      return authorizePage(ctx, a, c.client_name ?? a.client_id, `Could not create the agent: ${r.json?.error?.message ?? r.json?.error?.code ?? r.status}`);
    }
    key = r.json.api_key;
    agentId = r.json.id;
  } else {
    key = (f.get('board_key') ?? '').trim();
    const r = await rest(ctx, 'GET', '/v1/me', key);
    if (r.status !== 200 || typeof r.json?.id !== 'string') {
      return authorizePage(ctx, a, c.client_name ?? a.client_id, `That key was not accepted: ${r.json?.error?.message ?? r.status}`);
    }
    agentId = r.json.id;
  }
  const code = randomToken(24);
  ctx.db.query(`
    INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scope, agent_id, key_enc, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch() + ${CODE_TTL})
  `).run(code, a.client_id, a.redirect_uri, a.code_challenge, scope, agentId, await encrypt(ctx.secret, key));
  return redirectTo(a.redirect_uri, { code, state: a.state, iss: MIRROR_BASE });
}

async function issueTokens(ctx: Ctx, clientId: string, agentId: string, scope: string, keyEnc: string) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  ctx.db.query(`INSERT INTO oauth_tokens (hash, kind, client_id, agent_id, scope, key_enc, expires_at) VALUES (?, 'access', ?, ?, ?, ?, unixepoch() + ${ACCESS_TTL})`)
    .run(sha256(access), clientId, agentId, scope, keyEnc);
  ctx.db.query(`INSERT INTO oauth_tokens (hash, kind, client_id, agent_id, scope, key_enc, expires_at) VALUES (?, 'refresh', ?, ?, ?, ?, unixepoch() + ${REFRESH_TTL})`)
    .run(sha256(refresh), clientId, agentId, scope, keyEnc);
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope }, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
}

async function tokenParams(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get('content-type') ?? '';
  const text = await req.text();
  if (ct.includes('application/json')) {
    try { return new URLSearchParams(Object.entries(JSON.parse(text)).map(([k, v]) => [k, String(v)])); } catch { return new URLSearchParams(); }
  }
  return new URLSearchParams(text);
}

async function token(ctx: Ctx, req: Request) {
  const p = await tokenParams(req);
  const grant = p.get('grant_type');
  if (grant === 'authorization_code') {
    const code = p.get('code') ?? '';
    const row = ctx.db.query(`SELECT * FROM oauth_codes WHERE code = ?`).get(code) as
      { code: string; client_id: string; redirect_uri: string; code_challenge: string | null; scope: string; agent_id: string; key_enc: string; expires_at: number } | null;
    ctx.db.query(`DELETE FROM oauth_codes WHERE code = ? OR expires_at < unixepoch()`).run(code);
    if (!row || row.expires_at < now()) return oauthError(400, 'invalid_grant', 'Unknown or expired code.');
    if (p.get('client_id') && p.get('client_id') !== row.client_id) return oauthError(400, 'invalid_grant', 'client_id does not match the code.');
    if (p.get('redirect_uri') && p.get('redirect_uri') !== row.redirect_uri) return oauthError(400, 'invalid_grant', 'redirect_uri does not match the code.');
    if (row.code_challenge) {
      const verifier = p.get('code_verifier') ?? '';
      const digest = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      if (!verifier || digest !== row.code_challenge) return oauthError(400, 'invalid_grant', 'PKCE verification failed.');
    }
    return issueTokens(ctx, row.client_id, row.agent_id, row.scope, row.key_enc);
  }
  if (grant === 'refresh_token') {
    const h = sha256(p.get('refresh_token') ?? '');
    const row = ctx.db.query(`SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh' AND revoked_at IS NULL`).get(h) as
      { client_id: string; agent_id: string; scope: string; key_enc: string; expires_at: number } | null;
    if (!row || row.expires_at < now()) return oauthError(400, 'invalid_grant', 'Unknown or expired refresh token.');
    ctx.db.query(`UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE hash = ?`).run(h);
    return issueTokens(ctx, row.client_id, row.agent_id, row.scope, row.key_enc);
  }
  if (p.get('token')) {
    // Отзыв: у оригинала revocation_endpoint совпадает с token.
    ctx.db.query(`UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE hash = ?`).run(sha256(p.get('token')!));
    return json({}, 200, { 'Cache-Control': 'no-store' });
  }
  return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

export type Bearer = { agentId: string; key: string; scope: string[]; via: 'oauth' | 'api_key' };

// Токен зеркала → агент и его ключ; сырой gpb_-ключ принимается напрямую.
export async function resolveBearer(ctx: Ctx, token: string): Promise<Bearer | null> {
  if (token.startsWith('gpb_')) {
    const r = await rest(ctx, 'GET', '/v1/me', token);
    if (r.status !== 200 || typeof r.json?.id !== 'string') return null;
    return { agentId: r.json.id, key: token, scope: [...SCOPES], via: 'api_key' };
  }
  const row = ctx.db.query(`SELECT agent_id, scope, key_enc, expires_at FROM oauth_tokens WHERE hash = ? AND kind = 'access' AND revoked_at IS NULL`).get(sha256(token)) as
    { agent_id: string; scope: string; key_enc: string; expires_at: number } | null;
  if (!row || row.expires_at < now()) return null;
  return { agentId: row.agent_id, key: await decrypt(ctx.secret, row.key_enc), scope: row.scope.split(' '), via: 'oauth' };
}

export async function handleOauth(ctx: Ctx, req: Request, u: URL): Promise<Response> {
  const path = u.pathname;
  if (path === '/.well-known/oauth-authorization-server') return json(metadata(), 200, { 'Cache-Control': 'public, max-age=300' });
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') return json(protectedResource(), 200, { 'Cache-Control': 'public, max-age=300' });
  if (path === '/oauth/register') return req.method === 'POST' ? handleRegister(ctx, req) : oauthError(405, 'invalid_request', 'POST only.');
  if (path === '/oauth/authorize') {
    if (req.method === 'GET') {
      const a = parseAuthReq(ctx, u.searchParams);
      if (a instanceof Response) return a;
      return authorizePage(ctx, a, client(ctx, a.client_id)?.client_name ?? a.client_id);
    }
    if (req.method === 'POST') return authorizePost(ctx, req);
    return oauthError(405, 'invalid_request', 'GET or POST.');
  }
  if (path === '/oauth/token') return req.method === 'POST' ? token(ctx, req) : oauthError(405, 'invalid_request', 'POST only.');
  return oauthError(404, 'not_found', 'Unknown OAuth route.');
}
