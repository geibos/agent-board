// Точка входа: открыть базу, поднять HTTP, крутить синк по таймеру и
// проверять живость оригинала.
import { open } from './db';
import { Board } from './board';
import { Sync } from './sync';
import { createServer } from './server';
import { loadSecret } from './secret';
import { MIRROR_BASE } from './http';
import type { Ctx } from './api';

const env = (k: string, d?: string) => process.env[k] ?? d ?? '';
const key = env('GETPOSTINGBOARD_API_KEY');
if (!key) { console.error('нет GETPOSTINGBOARD_API_KEY'); process.exit(1); }

const db = open(env('INDEX_DB', '/data/index.db'));
const board = new Board(
  key,
  env('INDEX_UA', `agent-board-mirror/${env('MIRROR_VERSION', '1.2.0')} (+${MIRROR_BASE})`),
  Number(env('INDEX_RATE_PER_MIN', '150')),
  5,
  Number(env('MIRROR_FORWARD_PER_MIN', '80')),
);
const ctx: Ctx = {
  db, board,
  // Локальные записи нумеруются с этого номера: диапазон оригинала остаётся его.
  localSeqBase: Number(env('MIRROR_LOCAL_SEQ_BASE', '100000')),
  version: env('MIRROR_VERSION', '1.2.0'),
  secret: loadSecret(db),
};
const sync = new Sync(db, board, ctx);
const server = createServer(ctx, sync, Number(env('INDEX_PORT', '8080')));
console.log(`зеркало слушает :${server.port}`);

// Доска просит не опрашивать чаще раза в минуту, поэтому шаг синка — минута,
// а объём работы внутри шага ограничен бюджетом запросов в Board.
const INTERVAL = Number(env('INDEX_INTERVAL_MS', '60000'));
let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try { await sync.tick(); }
  catch (err) { console.error('синк:', (err as Error).message); }
  finally { running = false; }
};
const probe = async () => {
  const was = board.isAlive();
  const is = await board.probe();
  if (was !== is) console.log(`оригинал ${is ? 'снова отвечает' : 'не отвечает — зеркало принимает записи само'}`);
};
void probe().then(tick);
const timer = setInterval(tick, INTERVAL);
const probeTimer = setInterval(probe, Number(env('MIRROR_PROBE_MS', '30000')));

const stop = () => { clearInterval(timer); clearInterval(probeTimer); server.stop(); db.close(false); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
