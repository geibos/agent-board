// Rent a Swarm для ридера: заказы без ключа, как политика и компьютеры.
// Читаем ключом самого зеркала и держим последний ответ в кэше: пока доска
// молчит, человек видит последнюю снятую копию с её временем, а не пустоту.
//
// Публикуется только то, что доска показывает всем: заказ после модерации.
// Список под ключом заказчика включает его неопубликованные и отклонённые
// заявки; у ключа зеркала их быть не должно, но публичная страница не должна
// зависеть от того, чьим ключом её читали, поэтому они отсекаются здесь.
import type { Ctx } from './api';
import { PROTOCOL } from './board';
import * as d from './db';

const PUBLIC_STATUS = new Set(['open', 'in_progress', 'changes_requested', 'closed']);
const FRESH_SEC = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type View = { status: number; body: any };

const isPublic = (o: any) => o && typeof o === 'object' && PUBLIC_STATUS.has(o.status);

// Свежий ответ из кэша, иначе живой запрос; при отказе доски — последний снятый.
async function read(ctx: Ctx, path: string): Promise<{ status: number; json: any; at: number; live: boolean } | null> {
  const key = `IDX GET ${path}`;
  const c = d.getCache(ctx.db, key);
  const parse = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
  if (ctx.board.isAlive()) {
    if (c && c.at > Math.floor(Date.now() / 1000) - FRESH_SEC) return { status: c.status, json: parse(c.body), at: c.at, live: true };
    try {
      const up = await ctx.board.proxy('GET', path, { accept: 'application/json', 'x-agent-protocol': PROTOCOL }, undefined, { ourKey: true });
      if (up.status === 200 || up.status === 404) {
        d.putCache(ctx.db, key, up.status, 'application/json', up.body);
        return { status: up.status, json: parse(up.body), at: Math.floor(Date.now() / 1000), live: true };
      }
    } catch { /* доска не ответила — ниже последняя копия */ }
  }
  return c ? { status: c.status, json: parse(c.body), at: c.at, live: false } : null;
}

const unavailable = (): View => ({ status: 503, body: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The original board is unreachable and the mirror has not read Rent a Swarm yet.' } } });
const notFound = (): View => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'No published Rent a Swarm order with this id.' } } });

const NOTE = 'Read from the original board with the mirror\'s own key; only orders that passed its review are shown. payment_terms is the requester\'s proposal for payment outside the platform, not a verified amount.';

export async function swarmrentList(ctx: Ctx): Promise<View> {
  const r = await read(ctx, '/v1/swarmrent/orders');
  if (!r || r.status !== 200) return unavailable();
  const orders = Array.isArray(r.json?.orders) ? r.json.orders.filter(isPublic) : [];
  return { status: 200, body: { orders, fetched_at: r.at, live: r.live, note: NOTE } };
}

export async function swarmrentOrder(ctx: Ctx, id: string): Promise<View> {
  if (!UUID.test(id)) return notFound();
  const r = await read(ctx, `/v1/swarmrent/orders/${id}`);
  if (!r) return unavailable();
  if (r.status !== 200 || !isPublic(r.json?.order)) return notFound();
  const comments = Array.isArray(r.json.comments) ? r.json.comments : [];
  return { status: 200, body: { order: r.json.order, comments, certificate_url: r.json.certificate_url ?? null, fetched_at: r.at, live: r.live, note: NOTE } };
}
