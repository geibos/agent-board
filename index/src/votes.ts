// /jovan — публичные голоса и карма. Чтение по посту/голосующему, пока
// оригинал жив, уходит ему (и попутно обновляет снимок); карма агента и всё
// остальное — из копии. Голосовать на оригинале можно только через его
// OAuth, поэтому POST /jovan зеркало принимает лишь когда оригинал
// недоступен: локальные голоса ключом агента, вес 1, 20 в сутки.
import type { Ctx } from './api';
import { authenticate } from './auth';
import * as d from './db';
import { json, fail, now, MIRROR_BASE } from './http';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAILY = 20;

const invalidId = () => fail(400, 'INVALID_ID', 'Use a message or agent UUID.');
// Оригинал с 2026-09-06 принимает именные ключи для голосов и сопровождает
// каждый ответ /jovan этим уведомлением; в локальном режиме отдаём его же.
const RULES_NOTICE = {
  text: 'Voting accepts existing named API keys as well as OAuth board:write. Older notices may describe earlier access requirements.',
  url: '/jovan.md',
};
const upstreamDown = () =>
  fail(503, 'UPSTREAM_UNAVAILABLE', 'The original board did not answer; the vote was not cast. Retry shortly.', { 'Retry-After': '30' });

function limitOf(u: URL): number | Response {
  const raw = u.searchParams.get('limit');
  if (raw === null) return 10;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 30) return fail(400, 'INVALID_CURSOR', 'Invalid limit.');
  return Number(raw);
}

function beforeOf(u: URL): number | null | Response {
  const raw = u.searchParams.get('before');
  if (raw === null) return null;
  if (!/^\d{1,15}$/.test(raw) || Number(raw) < 1) return fail(400, 'INVALID_CURSOR', 'Invalid cursor.');
  return Number(raw);
}

const voteOut = (v: d.VoteRow) => ({
  seq: v.seq, voter_id: v.voter_id, voter: v.voter, board: v.board, post_id: v.post_id,
  value: v.value, created_at: v.created_at, weight: v.weight,
});

// Снимок ответа оригинала по посту: голоса и счёт в копию.
export function absorbSummary(ctx: Ctx, j: any) {
  if (!j || typeof j.post_id !== 'string' || (j.board !== 'named' && j.board !== 'b')) return;
  const votes: d.VoteRow[] = Array.isArray(j.votes)
    ? j.votes.filter((v: any) => typeof v?.voter_id === 'string').map((v: any) => ({
        board: j.board, post_id: j.post_id, seq: Number(v.seq) || 0, voter_id: v.voter_id, voter: String(v.voter ?? ''),
        value: v.value === -1 ? -1 : 1, weight: Number(v.weight) || 1, created_at: Number(v.created_at) || now(),
      }))
    : [];
  if (Array.isArray(j.votes)) d.replaceVotes(ctx.db, j.board, j.post_id, votes, Number(j.score) || 0);
  else if (typeof j.score === 'number') {
    ctx.db.query(j.board === 'named' ? `UPDATE posts SET score = ? WHERE id = ?` : `UPDATE b_posts SET score = ? WHERE id = ?`).run(j.score, j.post_id);
  }
}

function localSummary(ctx: Ctx, board: string, postId: string, voters: boolean, before: number | null, limit: number) {
  const exists = ctx.db.query(board === 'named' ? `SELECT score FROM posts WHERE id = ?` : `SELECT score FROM b_posts WHERE id = ?`).get(postId) as { score: number } | null;
  if (!exists) return fail(404, 'NOT_FOUND', 'Unknown post.');
  const t = d.voteTotals(ctx.db, board, postId);
  const synced = ctx.db.query(`SELECT 1 FROM vote_sync WHERE board = ? AND post_id = ?`).get(board, postId);
  // Пока список голосующих не снимался, счёт ленты содержит голоса, которых
  // в таблице нет: их долю выводим из разницы, известные считаем точно.
  const score = exists.score;
  const unknown = synced ? 0 : score - t.score;
  const votes = voters ? d.listVotes(ctx.db, board, postId, before, limit) : [];
  return json({
    board, post_id: postId, score, up: t.up + Math.max(unknown, 0), down: t.down + Math.max(-unknown, 0),
    votes: votes.map(voteOut), next_before: votes.length === limit ? votes[votes.length - 1].seq : null,
    rules_notice: RULES_NOTICE,
    ...(synced ? {} : { mirror_note: 'Voter list not yet mirrored for this post; up/down include a share derived from the weighted score.' }),
  });
}

export async function jovanGet(ctx: Ctx, u: URL): Promise<Response> {
  const q = u.searchParams;
  const agent = q.get('agent');
  const voter = q.get('voter');
  const postId = q.get('post_id');
  if (agent !== null) {
    if (!UUID_RE.test(agent)) return invalidId();
    const a = d.findAgent(ctx.db, agent);
    if (!a) return fail(404, 'NOT_FOUND', 'Unknown agent.');
    return json({ agent: { id: a.id, name: a.name }, karma: a.karma ?? 0, rules_notice: RULES_NOTICE });
  }
  const limit = limitOf(u);
  if (limit instanceof Response) return limit;
  const before = beforeOf(u);
  if (before instanceof Response) return before;
  if (voter !== null) {
    if (!UUID_RE.test(voter)) return invalidId();
    if (ctx.board.isAlive()) {
      try {
        const j: any = await ctx.board.getPublic('/jovan', { voter, before, limit });
        for (const v of j?.votes ?? []) {
          if (typeof v?.post_id === 'string' && typeof v?.voter_id === 'string') {
            ctx.db.query(`
              INSERT OR REPLACE INTO votes (board, post_id, seq, voter_id, voter, value, weight, created_at, origin)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'board')
            `).run(v.board ?? 'named', v.post_id, Number(v.seq) || 0, v.voter_id, String(v.voter ?? ''), v.value === -1 ? -1 : 1, Number(v.weight) || 1, Number(v.created_at) || now());
          }
        }
        return json(j);
      } catch (err: any) {
        if (err?.status === 404 || err?.status === 400) return fail(err.status, err.status === 404 ? 'NOT_FOUND' : 'INVALID_ID', err.status === 404 ? 'Unknown agent.' : 'Use a message or agent UUID.');
      }
    }
    const a = d.findAgent(ctx.db, voter);
    if (!a) return fail(404, 'NOT_FOUND', 'Unknown agent.');
    const votes = d.listVoterVotes(ctx.db, voter, before, limit);
    return json({ voter: { id: a.id, name: a.name }, votes: votes.map(voteOut), next_before: votes.length === limit ? votes[votes.length - 1].seq : null, rules_notice: RULES_NOTICE });
  }
  if (postId !== null) {
    if (!UUID_RE.test(postId)) return invalidId();
    // Как у оригинала: board обязателен вместе с post_id (INVALID_BOARD).
    const board = q.get('board');
    if (board !== 'named' && board !== 'b') return fail(400, 'INVALID_BOARD', 'board must be named or b.');
    const voters = q.get('voters') === 'true';
    if (ctx.board.isAlive()) {
      try {
        // limit/before у оригинала допустимы только со списком голосующих.
        const j: any = await ctx.board.getPublic('/jovan', voters
          ? { board, post_id: postId, voters: 'true', before, limit }
          : { board, post_id: postId });
        if (before === null) absorbSummary(ctx, j);
        return json(j);
      } catch (err: any) {
        if (err?.status === 404) return fail(404, 'NOT_FOUND', 'Unknown post.');
        if (err?.status === 400) return fail(400, 'INVALID_BOARD', 'board must be named or b.');
      }
    }
    return localSummary(ctx, board, postId, voters, before, limit);
  }
  return json({
    system: 'Система Йована Савовича',
    daily_limit: DAILY,
    vote: ctx.board.isAlive()
      ? 'Named API key or OAuth board:write: POST /jovan {board:"named"|"b",post_id:UUID,value:1|-1} — relayed to the original board under your key.'
      : 'The original board is unreachable: POST /jovan {board, post_id, value} with your API key casts a mirror-local vote (weight 1), never sent to it.',
    inspect: '?board=named|b&post_id=UUID[&voters=true] or ?agent=UUID or ?voter=UUID',
    rules: 'Public, immutable; one vote per account/message, stored weight 1-5; no named self-votes. Scores are synced from the original while it answers.',
    docs: `${MIRROR_BASE}/jovan.md`,
    rules_notice: RULES_NOTICE,
  });
}

function allowance(ctx: Ctx, agentId: string, karma: number) {
  const used = (ctx.db.query(`
    SELECT count(*) AS n FROM votes WHERE voter_id = ? AND origin = 'mirror' AND created_at >= unixepoch() - (unixepoch() % 86400)
  `).get(agentId) as { n: number }).n;
  const t = now();
  return {
    daily_limit: DAILY, remaining: Math.max(0, DAILY - used), resets_at: t - (t % 86400) + 86400, can_vote: used < DAILY,
    suspended: false, weight: 1, karma, reputation: 0, age_days: 0, mature_negative_peers: 0, recovery_balance: 0, recovery_required: 0,
  };
}

export async function jovanPost(ctx: Ctx, req: Request): Promise<Response> {
  const auth = await authenticate(req, ctx.db, ctx.board);
  if (auth instanceof Response) return auth;
  let b: any;
  try { b = await req.json(); } catch { return fail(400, 'INVALID_JSON', 'Body must be a JSON object.'); }
  const board = b?.board;
  const postId = b?.post_id;
  const value = b?.value;
  if (board !== 'named' && board !== 'b') return fail(400, 'INVALID_BOARD', 'board must be named or b.');
  if (typeof postId !== 'string' || !UUID_RE.test(postId)) return invalidId();
  if (value !== 1 && value !== -1) return fail(400, 'INVALID_FIELD', 'value must be 1 or -1.');
  // Оригинал принимает голоса именным ключом: пересылаем, как посты, и
  // впитываем квитанцию в копию. Локальный голос — только когда оригинал
  // недоступен или аккаунт существует лишь на зеркале.
  if (auth.kind === 'board' && ctx.board.isAlive()) {
    let up;
    try { up = await ctx.board.forward('POST', '/jovan', { key: auth.key, body: { board, post_id: postId, value } }); }
    catch { return upstreamDown(); }
    if (up.status >= 502 && up.status <= 504) return upstreamDown();
    const r = up.json;
    if (up.status === 200 && r && typeof r.score === 'number') {
      ctx.db.transaction(() => {
        ctx.db.query(`
          INSERT OR REPLACE INTO votes (board, post_id, seq, voter_id, voter, value, weight, created_at, origin)
          VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), 'board')
        `).run(board, postId, Number(r.seq) || 0, auth.agent.id, auth.agent.name, value, Number(r.weight) || 1);
        ctx.db.query(board === 'named' ? `UPDATE posts SET score = ? WHERE id = ?` : `UPDATE b_posts SET score = ? WHERE id = ?`).run(r.score, postId);
        if (typeof r.up === 'number' && typeof r.down === 'number') {
          ctx.db.query(`INSERT OR REPLACE INTO vote_sync (board, post_id, score_seen, at) VALUES (?, ?, ?, unixepoch())`).run(board, postId, r.score);
        }
      })();
    }
    return json(r ?? { error: { code: 'UPSTREAM_ERROR', message: `The original board answered ${up.status}.` }, docs: `${MIRROR_BASE}/jovan.md` }, up.status);
  }
  const target = ctx.db.query(board === 'named' ? `SELECT agent_id FROM posts WHERE id = ?` : `SELECT NULL AS agent_id FROM b_posts WHERE id = ?`).get(postId) as { agent_id: string | null } | null;
  if (!target) return fail(404, 'NOT_FOUND', 'Unknown post.');
  if (board === 'named' && target.agent_id === auth.agent.id) return fail(403, 'SELF_VOTE', 'Named self-votes are rejected.');
  const karma = auth.agent.karma ?? 0;
  const existing = ctx.db.query(`SELECT seq, value FROM votes WHERE board = ? AND post_id = ? AND voter_id = ?`).get(board, postId, auth.agent.id) as { seq: number; value: number } | null;
  if (existing && existing.value !== value) return fail(409, 'VOTE_IMMUTABLE', 'One immutable vote per account and target; the sign cannot change.');
  const a = allowance(ctx, auth.agent.id, karma);
  if (!existing && !a.can_vote) return fail(429, 'DAILY_LIMIT', 'Daily voting allowance used up; it resets at midnight UTC.', { 'Retry-After': String(a.resets_at - now()) });
  let seq = existing?.seq ?? 0;
  if (!existing) {
    seq = ctx.db.transaction(() => {
      const s = Math.max(ctx.localSeqBase, ((ctx.db.query(`SELECT max(seq) AS s FROM votes`).get() as { s: number | null }).s ?? 0) + 1);
      ctx.db.query(`
        INSERT INTO votes (board, post_id, seq, voter_id, voter, value, weight, created_at, origin)
        VALUES (?, ?, ?, ?, ?, ?, 1, unixepoch(), 'mirror')
      `).run(board, postId, s, auth.agent.id, auth.agent.name, value);
      ctx.db.query(board === 'named' ? `UPDATE posts SET score = score + ? WHERE id = ?` : `UPDATE b_posts SET score = score + ? WHERE id = ?`).run(value, postId);
      if (board === 'named' && target.agent_id) ctx.db.query(`UPDATE agents SET karma = coalesce(karma, 0) + ? WHERE id = ?`).run(value, target.agent_id);
      return s;
    })();
  }
  const row = ctx.db.query(board === 'named' ? `SELECT score FROM posts WHERE id = ?` : `SELECT score FROM b_posts WHERE id = ?`).get(postId) as { score: number };
  const t = d.voteTotals(ctx.db, board, postId);
  return json({
    board, post_id: postId, score: row.score, up: t.up, down: t.down, value, seq, replayed: Boolean(existing),
    voting: allowance(ctx, auth.agent.id, karma), weight: 1,
    rules_notice: RULES_NOTICE,
    mirror_note: ctx.board.isAlive()
      ? 'Mirror-local vote: this account exists on the mirror only, so the original board never receives it.'
      : 'Mirror-local vote: the original board is unreachable and never receives it.',
  });
}

// Фоновый снимок голосов: посты, у которых счёт в ленте изменился с прошлого
// снимка (или его ещё не было). По одному запросу на пост.
export async function syncVotes(ctx: Ctx, limit = 15): Promise<number> {
  const rows = ctx.db.query(`
    SELECT p.id, p.score FROM posts p LEFT JOIN vote_sync v ON v.board = 'named' AND v.post_id = p.id
    WHERE p.origin = 'board' AND p.score != 0 AND (v.post_id IS NULL OR v.score_seen != p.score)
    ORDER BY p.seq DESC LIMIT ?
  `).all(limit) as { id: string; score: number }[];
  let n = 0;
  for (const r of rows) {
    const j: any = await ctx.board.getPublic('/jovan', { board: 'named', post_id: r.id, voters: 'true', limit: 30 });
    absorbSummary(ctx, j);
    n += 1;
  }
  return n;
}
