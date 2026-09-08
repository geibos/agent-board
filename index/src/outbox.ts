// Досылка записей, которые зеркало приняло вместо оригинала. Пока он молчал
// или отказывал по ёмкости, слова уже были сказаны и уже читались здесь; когда
// он отвечает снова, каждая такая запись уезжает к нему ключом своего автора и
// меняет номер зеркала на его номер. Это и есть разница между копией и заменой:
// без этой фазы принятая запись осталась бы только у нас.
import type { Ctx } from './api';
import * as d from './db';
import { decrypt } from './secret';
import { MIRROR_BASE } from './http';

const MAX_ATTEMPTS = 24;
const TTL_SEC = 7 * 24 * 3600;
// Отказ, который повтором не лечится: тело не примут и через сутки. Ключ
// стирается сразу, запись остаётся жить на зеркале.
const FINAL = new Set([400, 401, 403, 404, 409, 410, 413, 422]);

const backoff = (attempts: number) => Math.min(60 * 2 ** attempts, 3600);

// После переезда текст берём у оригинала: он нормализует тело (срезает
// хвостовые переводы строк), и копия должна совпадать с ним байт в байт.
async function refreshBody(ctx: Ctx, id: string, seq: number) {
  try {
    const t: any = await ctx.board.get(`/v1/posts/${id}`, { limit: 1 });
    if (typeof t?.post?.body === 'string' && t.post.body.length > 0) d.setBody(ctx.db, seq, t.post.body);
  } catch { /* синк доберёт позже */ }
}

export async function flushOutbox(ctx: Ctx, limit = 20): Promise<number> {
  if (!ctx.board.isAlive()) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  let sent = 0;
  for (const row of d.dueForward(ctx.db, limit)) {
    if (nowSec - row.created_at > TTL_SEC || row.attempts >= MAX_ATTEMPTS) {
      d.abandonForward(ctx.db, row.seq, `giving up after ${row.attempts} attempts: ${row.last_error ?? 'no answer'}`);
      continue;
    }
    const local = ctx.db.query(`SELECT id, origin FROM posts WHERE seq = ?`).get(row.seq) as
      { id: string; origin: string } | null;
    // Автор удалил запись, пока она стояла в очереди: досылать нечего.
    if (!local) { d.abandonForward(ctx.db, row.seq, 'the post was deleted on the mirror before it could leave'); continue; }
    if (local.origin === 'board') { d.abandonForward(ctx.db, row.seq, 'already on the original'); continue; }

    let path = '/v1/posts';
    if (row.root_id) {
      const rootHere = ctx.db.query(`SELECT id, origin FROM posts WHERE id = ?`).get(row.root_id) as
        { id: string; origin: string } | null;
      const moved = d.findRelocated(ctx.db, row.root_id);
      const rootId = moved?.new_id ?? (rootHere?.origin === 'board' ? rootHere.id : null);
      // Корень сам ещё стоит в очереди: ответ ждёт его, не тратя попытку.
      if (!rootId) continue;
      path = `/v1/posts/${rootId}/replies`;
    }

    let key: string;
    try { key = await decrypt(ctx.secret, row.key_enc!); }
    catch { d.abandonForward(ctx.db, row.seq, 'the stored key cannot be read with the current mirror secret'); continue; }

    let up;
    try {
      up = await ctx.board.forward('POST', path, { key, body: JSON.parse(row.payload), idem: row.idem });
    } catch (err) {
      d.postponeForward(ctx.db, row.seq, backoff(row.attempts), `network: ${(err as Error).message}`);
      continue;
    }
    if ((up.status === 201 || up.status === 200) && typeof up.json?.id === 'string' && typeof up.json?.seq === 'number') {
      const fresh = { id: up.json.id as string, seq: up.json.seq as number };
      d.relocate(ctx.db, { id: local.id, seq: row.seq }, fresh);
      d.repointIdem(ctx.db, row.agent_id, row.idem, {
        id: fresh.id, seq: fresh.seq, thread_id: up.json.thread_id ?? null, url: `${MIRROR_BASE}/v1/posts/${fresh.id}`,
      });
      await refreshBody(ctx, fresh.id, fresh.seq);
      sent += 1;
      continue;
    }
    const code = up.json?.error?.code ? `${up.status} ${up.json.error.code}` : String(up.status);
    if (FINAL.has(up.status)) d.abandonForward(ctx.db, row.seq, `the original refused: ${code}`);
    else d.postponeForward(ctx.db, row.seq, backoff(row.attempts), `the original answered ${code}`);
  }
  return sent;
}
