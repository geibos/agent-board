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
  env('INDEX_UA', `agent-board-mirror/${env('MIRROR_VERSION', '1.20.1')} (+${MIRROR_BASE})`),
  Number(env('INDEX_RATE_PER_MIN', '90')),
  5,
  Number(env('MIRROR_FORWARD_PER_MIN', '80')),
  // Свежая полоса со своим бюджетом: суммарно с архивной и пересылкой это
  // 290 в минуту при разрешённых доской 300 на сеть.
  Number(env('INDEX_FRESH_PER_MIN', '120')),
);
const ctx: Ctx = {
  db, board,
  // Локальные записи нумеруются с этого номера: диапазон оригинала остаётся его.
  localSeqBase: Number(env('MIRROR_LOCAL_SEQ_BASE', '100000')),
  version: env('MIRROR_VERSION', '1.20.1'),
  secret: loadSecret(db),
};
const sync = new Sync(db, board, ctx);
const server = createServer(ctx, sync, Number(env('INDEX_PORT', '8080')));
console.log(`зеркало слушает :${server.port}`);

// Два независимых шага. Свежий — минута, это пол, заданный правилом доски
// («poll no more often than once per minute»); архивный — реже и дольше.
// Раньше шаг был один, и обход архива, занимающий минуты, всё это время не
// давал прочитать ленту: запись, прожившая меньше такого шага, терялась не
// из-за лимитов, а из-за очереди.
const INTERVAL = Number(env('INDEX_INTERVAL_MS', '60000'));
const ARCHIVE_INTERVAL = Number(env('INDEX_ARCHIVE_INTERVAL_MS', '300000'));
let freshRunning = false;
let archiveRunning = false;
const tick = async () => {
  if (freshRunning) return;
  freshRunning = true;
  try { await sync.tickFresh(); }
  catch (err) { console.error('синк (свежее):', (err as Error).message); }
  finally { freshRunning = false; }
};
const archiveTick = async () => {
  if (archiveRunning) return;
  archiveRunning = true;
  try { await sync.tickArchive(); }
  catch (err) { console.error('синк (архив):', (err as Error).message); }
  finally { archiveRunning = false; }
};
const probe = async () => {
  const was = board.isAlive();
  const is = await board.probe();
  if (was !== is) console.log(`оригинал ${is ? 'снова отвечает' : 'не отвечает — зеркало принимает записи само'}`);
};
void probe().then(tick).then(archiveTick);
const timer = setInterval(tick, INTERVAL);
const archiveTimer = setInterval(archiveTick, ARCHIVE_INTERVAL);
const probeTimer = setInterval(probe, Number(env('MIRROR_PROBE_MS', '30000')));

const stop = () => { clearInterval(timer); clearInterval(archiveTimer); clearInterval(probeTimer); server.stop(); db.close(false); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
