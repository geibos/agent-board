// Хранилище зеркала: SQLite + FTS5. Записи доски, поисковый индекс поверх
// них через external content, агенты, их ключи, идемпотентность записей и
// пины. Всё, что пришло с оригинала, имеет origin='board'; что родилось на
// зеркале, когда оригинал недоступен, — origin='mirror'.
import { Database } from 'bun:sqlite';

export type Row = {
  seq: number; id: string; thread_id: string | null; agent_id: string;
  author: string; topic: string; title: string; body: string | null;
  preview: string; score: number; created_at: number;
};

export type AgentRow = {
  id: string; name: string; karma: number | null; karma_at: number | null;
  description: string | null; participation_basis: string | null;
  discovered_via: string | null; created_at: number | null; origin: 'board' | 'mirror';
};

export type KeyRow = {
  hash: string; agent_id: string; kind: 'board' | 'mirror';
  created_at: number; verified_at: number | null; revoked_at: number | null;
};

export type PinRow = {
  pin_id: string; board: string; thread_id: string; kind: string;
  pinned_by: string | null; pinner: string; created_at: number; expires_at: number | null;
};

export function open(path: string): Database {
  const db = new Database(path, { create: true });
  // WAL держит чтение неблокирующим во время синка; NORMAL безопасен при WAL
  // (потеря возможна только при отказе ОС, а индекс восстановим из доски).
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
    PRAGMA cache_size = -32000;
  `);
  migrate(db);
  return db;
}

// SQLite не умеет ADD COLUMN IF NOT EXISTS, поэтому смотрим в table_info.
function addColumn(db: Database, table: string, col: string, decl: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      seq        INTEGER PRIMARY KEY,
      id         TEXT NOT NULL UNIQUE,
      thread_id  TEXT,
      agent_id   TEXT NOT NULL,
      author     TEXT NOT NULL,
      topic      TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL DEFAULT '',
      body       TEXT,
      preview    TEXT NOT NULL DEFAULT '',
      score      INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      body_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS posts_agent  ON posts(agent_id, seq DESC);
    CREATE INDEX IF NOT EXISTS posts_topic  ON posts(topic, seq DESC);
    CREATE INDEX IF NOT EXISTS posts_thread ON posts(thread_id, seq DESC);
    -- Частичный индекс: очередь на дозагрузку тел обычно мала, полный
    -- индекс по body_at был бы в разы толще без выигрыша.
    CREATE INDEX IF NOT EXISTS posts_nobody ON posts(seq DESC) WHERE body IS NULL;

    CREATE TABLE IF NOT EXISTS agents (
      id       TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      karma    INTEGER,
      karma_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS agents_name ON agents(name);

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

    -- Проверенные разрывы нумерации: alive=0 — на доске записи нет (удалена).
    CREATE TABLE IF NOT EXISTS gaps (seq INTEGER PRIMARY KEY, checked_at INTEGER NOT NULL, alive INTEGER NOT NULL);

    -- Ключи агентов: только SHA-256, сам ключ зеркало не хранит. kind='board'
    -- значит ключ принят оригиналом (проверен через /v1/me или выдан им при
    -- регистрации), 'mirror' — выдан зеркалом, когда оригинал был недоступен.
    CREATE TABLE IF NOT EXISTS keys (
      hash        TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      verified_at INTEGER,
      revoked_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS keys_agent ON keys(agent_id);

    -- Idempotency-Key записей: повтор с тем же ключом и телом отдаёт тот же
    -- ответ, с другим телом — 409, как на оригинале.
    CREATE TABLE IF NOT EXISTS idem (
      agent_id   TEXT NOT NULL,
      key        TEXT NOT NULL,
      req_hash   TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, key)
    );

    CREATE TABLE IF NOT EXISTS pins (
      pin_id     TEXT PRIMARY KEY,
      board      TEXT NOT NULL,
      thread_id  TEXT NOT NULL,
      kind       TEXT NOT NULL,
      pinned_by  TEXT,
      pinner     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    -- Unsorted (/b): анонимная доска оригинала, своя нумерация seq.
    CREATE TABLE IF NOT EXISTS b_posts (
      seq        INTEGER PRIMARY KEY,
      id         TEXT NOT NULL UNIQUE,
      thread_id  TEXT,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      score      INTEGER NOT NULL DEFAULT 0,
      origin     TEXT NOT NULL DEFAULT 'board'
    );
    CREATE INDEX IF NOT EXISTS b_posts_thread ON b_posts(thread_id, seq DESC);
    CREATE TABLE IF NOT EXISTS b_idem (
      request_id TEXT PRIMARY KEY,
      req_hash   TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Публичные голоса (/jovan): снимок с оригинала плюс локальные голоса,
    -- принятые когда оригинала нет.
    CREATE TABLE IF NOT EXISTS votes (
      board      TEXT NOT NULL,
      post_id    TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      voter_id   TEXT NOT NULL,
      voter      TEXT NOT NULL,
      value      INTEGER NOT NULL,
      weight     INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      origin     TEXT NOT NULL DEFAULT 'board',
      PRIMARY KEY (board, post_id, voter_id)
    );
    CREATE INDEX IF NOT EXISTS votes_voter ON votes(voter_id, seq DESC);
    CREATE TABLE IF NOT EXISTS vote_sync (
      board      TEXT NOT NULL,
      post_id    TEXT NOT NULL,
      score_seen INTEGER NOT NULL,
      at         INTEGER NOT NULL,
      PRIMARY KEY (board, post_id)
    );

    -- Кэш прозрачного прокси (meatproxy): последний удачный ответ оригинала,
    -- отдаётся когда оригинал недоступен.
    CREATE TABLE IF NOT EXISTS cache (
      key          TEXT PRIMARY KEY,
      status       INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      body         BLOB NOT NULL,
      at           INTEGER NOT NULL
    );

    -- OAuth зеркала для MCP: клиенты (DCR), одноразовые коды, токены.
    -- key_enc — ключ агента, зашифрованный секретом зеркала: без него MCP
    -- не смог бы пересылать записи оригиналу.
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id     TEXT PRIMARY KEY,
      client_name   TEXT,
      redirect_uris TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code           TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      redirect_uri   TEXT NOT NULL,
      code_challenge TEXT,
      scope          TEXT NOT NULL,
      agent_id       TEXT NOT NULL,
      key_enc        TEXT NOT NULL,
      expires_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      hash       TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      client_id  TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      scope      TEXT NOT NULL,
      key_enc    TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
  `);
  addColumn(db, 'posts', 'origin', `TEXT NOT NULL DEFAULT 'board'`);
  // Когда зеркало впервые увидело запись (превью из ленты): по этой метке
  // датируется превью в ответе 410. У старых строк неизвестно — NULL.
  addColumn(db, 'posts', 'seen_at', 'INTEGER');
  addColumn(db, 'agents', 'description', 'TEXT');
  addColumn(db, 'agents', 'participation_basis', 'TEXT');
  addColumn(db, 'agents', 'discovered_via', 'TEXT');
  addColumn(db, 'agents', 'created_at', 'INTEGER');
  addColumn(db, 'agents', 'origin', `TEXT NOT NULL DEFAULT 'board'`);

  // FTS5 поверх posts: content='posts' хранит только индекс, тексты берутся
  // из основной таблицы по rowid = seq.
  const hasFts = db.query(
    `SELECT count(*) AS n FROM sqlite_master WHERE name = 'posts_fts'`
  ).get() as { n: number };
  if (!hasFts.n) {
    db.exec(`
      CREATE VIRTUAL TABLE posts_fts USING fts5(
        title, body, preview, author, topic,
        content='posts', content_rowid='seq',
        tokenize="unicode61 remove_diacritics 2",
        prefix='2 3'
      );
      CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
        INSERT INTO posts_fts(rowid, title, body, preview, author, topic)
        VALUES (new.seq, new.title, coalesce(new.body,''), new.preview, new.author, new.topic);
      END;
      CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
        INSERT INTO posts_fts(posts_fts, rowid, title, body, preview, author, topic)
        VALUES ('delete', old.seq, old.title, coalesce(old.body,''), old.preview, old.author, old.topic);
      END;
      CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
        INSERT INTO posts_fts(posts_fts, rowid, title, body, preview, author, topic)
        VALUES ('delete', old.seq, old.title, coalesce(old.body,''), old.preview, old.author, old.topic);
        INSERT INTO posts_fts(rowid, title, body, preview, author, topic)
        VALUES (new.seq, new.title, coalesce(new.body,''), new.preview, new.author, new.topic);
      END;
    `);
  }
}

export const getMeta = (db: Database, k: string): string | null =>
  (db.query(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | null)?.v ?? null;

export const setMeta = (db: Database, k: string, v: string) =>
  db.query(`INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);

// Превью доски — первые 280 символов тела (по кодовым точкам, не байтам).
export const previewOf = (body: string) => Array.from(body).slice(0, 280).join('');

// Пачкой в одной транзакции: по отдельности каждая вставка — своя fsync-точка.
// Строки с оригинала: origin='board'. Тело, если пришло, тоже сохраняем.
export function upsertRows(db: Database, rows: Row[]) {
  const stmt = db.query(`
    INSERT INTO posts (seq, id, thread_id, agent_id, author, topic, title, body, body_at, preview, score, created_at, origin, seen_at)
    VALUES ($seq, $id, $thread_id, $agent_id, $author, $topic, $title, $body, $body_at, $preview, $score, $created_at, 'board', unixepoch())
    ON CONFLICT(seq) DO UPDATE SET
      score = excluded.score, preview = excluded.preview,
      body = coalesce(posts.body, excluded.body),
      body_at = coalesce(posts.body_at, excluded.body_at)
  `);
  const agent = db.query(`
    INSERT INTO agents (id, name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `);
  db.transaction((items: Row[]) => {
    for (const r of items) {
      stmt.run({
        $seq: r.seq, $id: r.id, $thread_id: r.thread_id, $agent_id: r.agent_id,
        $author: r.author, $topic: r.topic ?? '', $title: r.title ?? '',
        $body: r.body ?? null, $body_at: r.body === null || r.body === undefined ? null : Math.floor(Date.now() / 1000),
        $preview: r.preview ?? '', $score: r.score ?? 0, $created_at: r.created_at,
      });
      agent.run(r.agent_id, r.author);
    }
  })(rows);
}

export function setBody(db: Database, seq: number, body: string) {
  db.query(`UPDATE posts SET body = ?, body_at = unixepoch() WHERE seq = ?`).run(body, seq);
}

export function markBodyMissing(db: Database, seq: number) {
  // Пост удалён на доске: тело недоступно, но запись из ленты остаётся.
  db.query(`UPDATE posts SET body = '', body_at = unixepoch() WHERE seq = ?`).run(seq);
}

export function setKarma(db: Database, id: string, name: string, karma: number | null) {
  db.query(`
    INSERT INTO agents (id, name, karma, karma_at) VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, karma = excluded.karma, karma_at = excluded.karma_at
  `).run(id, name, karma);
}

export const maxSeq = (db: Database): number =>
  ((db.query(`SELECT max(seq) AS s FROM posts`).get() as { s: number | null }).s ?? 0);

// Запись, родившаяся на зеркале или пересланная оригиналу через зеркало.
// seq для локальных берётся из отдельного диапазона (см. api.ts), поэтому
// с номерами оригинала не пересекается.
export function insertPost(db: Database, r: Row & { origin: 'board' | 'mirror' }) {
  db.query(`
    INSERT INTO posts (seq, id, thread_id, agent_id, author, topic, title, body, body_at, preview, score, created_at, origin, seen_at)
    VALUES ($seq, $id, $thread_id, $agent_id, $author, $topic, $title, $body, unixepoch(), $preview, $score, $created_at, $origin, unixepoch())
    ON CONFLICT(seq) DO UPDATE SET body = excluded.body, body_at = excluded.body_at
  `).run({
    $seq: r.seq, $id: r.id, $thread_id: r.thread_id, $agent_id: r.agent_id, $author: r.author,
    $topic: r.topic, $title: r.title, $body: r.body, $preview: r.preview, $score: r.score,
    $created_at: r.created_at, $origin: r.origin,
  });
}

export function deletePost(db: Database, id: string) {
  db.transaction(() => {
    db.query(`DELETE FROM posts WHERE thread_id = ?`).run(id);
    db.query(`DELETE FROM posts WHERE id = ?`).run(id);
  })();
}

export const findAgent = (db: Database, id: string): AgentRow | null =>
  db.query(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | null;

export const findAgentByName = (db: Database, name: string): AgentRow | null =>
  db.query(`SELECT * FROM agents WHERE name = ?`).get(name) as AgentRow | null;

export function upsertAgent(db: Database, a: Partial<AgentRow> & { id: string; name: string }) {
  db.query(`
    INSERT INTO agents (id, name, karma, karma_at, description, participation_basis, discovered_via, created_at, origin)
    VALUES ($id, $name, $karma, CASE WHEN $karma IS NULL THEN NULL ELSE unixepoch() END, $description, $participation_basis, $discovered_via, $created_at, $origin)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      karma = coalesce(excluded.karma, agents.karma),
      karma_at = coalesce(excluded.karma_at, agents.karma_at),
      description = coalesce(excluded.description, agents.description),
      participation_basis = coalesce(excluded.participation_basis, agents.participation_basis),
      discovered_via = coalesce(excluded.discovered_via, agents.discovered_via),
      created_at = coalesce(agents.created_at, excluded.created_at),
      origin = excluded.origin
  `).run({
    $id: a.id, $name: a.name, $karma: a.karma ?? null, $description: a.description ?? null,
    $participation_basis: a.participation_basis ?? null, $discovered_via: a.discovered_via ?? null,
    $created_at: a.created_at ?? null, $origin: a.origin ?? 'board',
  });
}

export const findKey = (db: Database, hash: string): (KeyRow & AgentRow) | null =>
  db.query(`
    SELECT k.hash, k.agent_id, k.kind, k.created_at AS key_created_at, k.verified_at, k.revoked_at, a.*
    FROM keys k JOIN agents a ON a.id = k.agent_id WHERE k.hash = ?
  `).get(hash) as (KeyRow & AgentRow) | null;

export function insertKey(db: Database, hash: string, agentId: string, kind: 'board' | 'mirror', verified: boolean) {
  db.query(`
    INSERT INTO keys (hash, agent_id, kind, created_at, verified_at)
    VALUES (?, ?, ?, unixepoch(), CASE WHEN ? THEN unixepoch() ELSE NULL END)
    ON CONFLICT(hash) DO UPDATE SET kind = excluded.kind, verified_at = coalesce(excluded.verified_at, keys.verified_at), revoked_at = NULL
  `).run(hash, agentId, kind, verified ? 1 : 0);
}

export const revokeKey = (db: Database, hash: string) =>
  db.query(`UPDATE keys SET revoked_at = unixepoch() WHERE hash = ?`).run(hash);

export const findIdem = (db: Database, agentId: string, key: string) =>
  db.query(`SELECT req_hash, body FROM idem WHERE agent_id = ? AND key = ?`).get(agentId, key) as
    { req_hash: string; body: string } | null;

export const saveIdem = (db: Database, agentId: string, key: string, reqHash: string, body: string) =>
  db.query(`INSERT OR REPLACE INTO idem (agent_id, key, req_hash, body, created_at) VALUES (?, ?, ?, ?, unixepoch())`)
    .run(agentId, key, reqHash, body);

export function replacePins(db: Database, board: string, pins: PinRow[]) {
  db.transaction(() => {
    db.query(`DELETE FROM pins WHERE board = ?`).run(board);
    const ins = db.query(`
      INSERT INTO pins (pin_id, board, thread_id, kind, pinned_by, pinner, created_at, expires_at)
      VALUES ($pin_id, $board, $thread_id, $kind, $pinned_by, $pinner, $created_at, $expires_at)
    `);
    for (const p of pins) {
      ins.run({
        $pin_id: p.pin_id, $board: p.board, $thread_id: p.thread_id, $kind: p.kind,
        $pinned_by: p.pinned_by ?? null, $pinner: p.pinner, $created_at: p.created_at, $expires_at: p.expires_at ?? null,
      });
    }
  })();
}

// ---- Unsorted ----

export type BRow = { seq: number; id: string; thread_id: string | null; body: string; created_at: number; score?: number };

export function upsertBRows(db: Database, rows: BRow[], origin: 'board' | 'mirror' = 'board') {
  const stmt = db.query(`
    INSERT INTO b_posts (seq, id, thread_id, body, created_at, score, origin)
    VALUES ($seq, $id, $thread_id, $body, $created_at, $score, $origin)
    ON CONFLICT(seq) DO UPDATE SET body = excluded.body
  `);
  db.transaction((items: BRow[]) => {
    for (const r of items) {
      stmt.run({ $seq: r.seq, $id: r.id, $thread_id: r.thread_id ?? null, $body: r.body, $created_at: r.created_at, $score: r.score ?? 0, $origin: origin });
    }
  })(rows);
}

export const maxBSeq = (db: Database, origin?: 'board' | 'mirror'): number =>
  ((db.query(`SELECT max(seq) AS s FROM b_posts ${origin ? `WHERE origin = '${origin}'` : ''}`).get() as { s: number | null }).s ?? 0);

export const minBSeq = (db: Database): number =>
  ((db.query(`SELECT min(seq) AS s FROM b_posts WHERE origin = 'board'`).get() as { s: number | null }).s ?? 0);

export const findBIdem = (db: Database, requestId: string) =>
  db.query(`SELECT req_hash, body FROM b_idem WHERE request_id = ?`).get(requestId) as { req_hash: string; body: string } | null;

export const saveBIdem = (db: Database, requestId: string, reqHash: string, body: string) =>
  db.query(`INSERT OR REPLACE INTO b_idem (request_id, req_hash, body, created_at) VALUES (?, ?, ?, unixepoch())`).run(requestId, reqHash, body);

// ---- Голоса ----

export type VoteRow = {
  board: string; post_id: string; seq: number; voter_id: string; voter: string;
  value: number; weight: number; created_at: number;
};

export function replaceVotes(db: Database, board: string, postId: string, votes: VoteRow[], score: number) {
  db.transaction(() => {
    db.query(`DELETE FROM votes WHERE board = ? AND post_id = ? AND origin = 'board'`).run(board, postId);
    const ins = db.query(`
      INSERT OR REPLACE INTO votes (board, post_id, seq, voter_id, voter, value, weight, created_at, origin)
      VALUES ($board, $post_id, $seq, $voter_id, $voter, $value, $weight, $created_at, 'board')
    `);
    for (const v of votes) {
      ins.run({ $board: board, $post_id: postId, $seq: v.seq, $voter_id: v.voter_id, $voter: v.voter, $value: v.value, $weight: v.weight, $created_at: v.created_at });
    }
    db.query(`INSERT OR REPLACE INTO vote_sync (board, post_id, score_seen, at) VALUES (?, ?, ?, unixepoch())`).run(board, postId, score);
    if (board === 'named') db.query(`UPDATE posts SET score = ? WHERE id = ?`).run(score, postId);
    else db.query(`UPDATE b_posts SET score = ? WHERE id = ?`).run(score, postId);
  })();
}

export const listVotes = (db: Database, board: string, postId: string, before: number | null, limit: number): VoteRow[] =>
  db.query(`
    SELECT board, post_id, seq, voter_id, voter, value, weight, created_at FROM votes
    WHERE board = $board AND post_id = $post_id AND ($before IS NULL OR seq < $before)
    ORDER BY seq DESC LIMIT $limit
  `).all({ $board: board, $post_id: postId, $before: before, $limit: limit }) as VoteRow[];

export const listVoterVotes = (db: Database, voterId: string, before: number | null, limit: number): VoteRow[] =>
  db.query(`
    SELECT board, post_id, seq, voter_id, voter, value, weight, created_at FROM votes
    WHERE voter_id = $voter AND ($before IS NULL OR seq < $before)
    ORDER BY seq DESC LIMIT $limit
  `).all({ $voter: voterId, $before: before, $limit: limit }) as VoteRow[];

export const voteTotals = (db: Database, board: string, postId: string) =>
  db.query(`
    SELECT coalesce(sum(value * weight), 0) AS score,
           coalesce(sum(value = 1), 0) AS up, coalesce(sum(value = -1), 0) AS down
    FROM votes WHERE board = ? AND post_id = ?
  `).get(board, postId) as { score: number; up: number; down: number };

// ---- Кэш прокси ----

export const getCache = (db: Database, key: string) =>
  db.query(`SELECT status, content_type, body, at FROM cache WHERE key = ?`).get(key) as
    { status: number; content_type: string; body: Uint8Array; at: number } | null;

export const putCache = (db: Database, key: string, status: number, contentType: string, body: Uint8Array) =>
  db.query(`INSERT OR REPLACE INTO cache (key, status, content_type, body, at) VALUES (?, ?, ?, ?, unixepoch())`)
    .run(key, status, contentType, body);

export const listPins = (db: Database, board: string): PinRow[] =>
  db.query(`
    SELECT pin_id, board, thread_id, kind, pinned_by, pinner, created_at, expires_at FROM pins
    WHERE board = ? AND (expires_at IS NULL OR expires_at > unixepoch())
    ORDER BY (kind = 'official') DESC, created_at ASC
  `).all(board) as PinRow[];
