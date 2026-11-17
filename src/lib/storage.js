'use strict';

const { DatabaseSync } = require('node:sqlite');
const { toQuery, expandForIndex } = require('./tokenizer');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  mime       TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chunks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id    INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  chunk_idx INTEGER NOT NULL,
  body      TEXT NOT NULL
);
-- Self-managed FTS over the n-gram-expanded Chinese-friendly token stream;
-- the original text is stored in an unindexed column for exact passthrough.
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  tokens,
  orig UNINDEXED,
  tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS queries_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT NOT NULL,
  domain     TEXT,
  matched    INTEGER NOT NULL DEFAULT 0,
  top_score  REAL,
  top_doc_id INTEGER,
  source     TEXT NOT NULL DEFAULT 'api',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_queries_created ON queries_log(created_at);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/** A thin, dependency-light storage layer around node:sqlite. */
class Storage {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
  }

  stmt(sql) {
    return this.db.prepare(sql);
  }

  // ---------- docs ----------
  listDocs() {
    return this.stmt(
      `SELECT d.*,
         (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunk_count
       FROM docs d ORDER BY d.id DESC`
    ).all();
  }

  getDoc(id) {
    return this.stmt('SELECT * FROM docs WHERE id = ?').get(id) || null;
  }

  getDocBySha(sha256) {
    return this.stmt('SELECT * FROM docs WHERE sha256 = ?').get(sha256) || null;
  }

  chunkCount(docId) {
    return this.stmt('SELECT COUNT(*) n FROM chunks WHERE doc_id = ?').get(docId).n;
  }

  listChunks(docId) {
    return this.stmt(
      'SELECT id, chunk_idx, body FROM chunks WHERE doc_id = ? ORDER BY chunk_idx'
    ).all(docId);
  }

  getChunk(chunkId) {
    return this.stmt(
      'SELECT c.*, d.filename FROM chunks c JOIN docs d ON d.id=c.doc_id WHERE c.id = ?'
    ).get(chunkId) || null;
  }

  insertDoc({ filename, kind, mime, size, sha256 }) {
    const r = this.stmt(
      `INSERT INTO docs (filename, kind, mime, size, sha256) VALUES (?,?,?,?,?)`
    ).run(filename, kind, mime, size, sha256);
    return Number(r.lastInsertRowid);
  }

  insertChunks(docId, chunks) {
    const insChunk = this.stmt('INSERT INTO chunks (doc_id, chunk_idx, body) VALUES (?,?,?)');
    const insFts = this.stmt('INSERT INTO fts (rowid, tokens, orig) VALUES (?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of chunks) {
        const r = insChunk.run(docId, c.index, c.text);
        const id = Number(r.lastInsertRowid);
        insFts.run(id, expandForIndex(c.text).join(' '), c.text);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  _ftsRowidsForDoc(docId) {
    return this.stmt('SELECT id FROM chunks WHERE doc_id = ?').all(docId).map((r) => r.id);
  }

  deleteDoc(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ids = this._ftsRowidsForDoc(id);
      const delFts = this.stmt('DELETE FROM fts WHERE rowid = ?');
      for (const rid of ids) delFts.run(rid);
      const delChunks = this.stmt('DELETE FROM chunks WHERE doc_id = ?');
      delChunks.run(id);
      this.stmt('DELETE FROM docs WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- search ----------
  /**
   * FTS5 BM25 search over the Chinese-aware token stream.
   *
   * Note: SQLite FTS5 virtual tables cannot be safely aliased inside a JOIN
   * with a MATCH predicate, so we select from `fts` directly and enrich
   * chunk/doc metadata in a second pass.
   * @returns {{chunks:Array<object>, docScores:Map<number,number>}}
   */
  search(queryText, limit = 5) {
    const q = toQuery(queryText);
    if (!q) return { chunks: [], docScores: new Map() };
    try {
      const rows = this.stmt(
        `SELECT rowid AS chunk_id, orig AS body, bm25(fts) AS score
         FROM fts WHERE fts MATCH ?
         ORDER BY score ASC
         LIMIT ?`
      ).all(q, limit);
      const getChunk = this.stmt(
        `SELECT c.chunk_idx, c.doc_id, d.filename, d.kind
         FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id = ?`
      );
      const chunks = [];
      const docScores = new Map();
      for (const r of rows) {
        const meta = getChunk.get(r.chunk_id) || {};
        chunks.push({
          chunkId: r.chunk_id,
          chunkIndex: meta.chunk_idx,
          body: r.body,
          docId: meta.doc_id,
          filename: meta.filename,
          kind: meta.kind,
          score: r.score, // negative; lower = better
        });
        docScores.set(meta.doc_id, r.score);
      }
      return { chunks, docScores };
    } catch (e) {
      // query syntax errors (e.g. weird user input) -> degrade to LIKE scan
      const like = `%${queryText.replace(/[%_]/g, ' ').trim()}%`;
      const rows = this.stmt(
        `SELECT id AS chunk_id, body, chunk_idx, doc_id,
                (SELECT filename FROM docs d WHERE d.id = chunks.doc_id) AS filename,
                (SELECT kind   FROM docs d WHERE d.id = chunks.doc_id) AS kind,
                0.0 AS score
         FROM chunks WHERE body LIKE ? COLLATE NOCASE
         LIMIT ?`
      ).all(like, limit);
      const chunks = rows.map((r) => ({
        chunkId: r.chunk_id,
        chunkIndex: r.chunk_idx,
        body: r.body,
        docId: r.doc_id,
        filename: r.filename,
        kind: r.kind,
        score: r.score, // 0.0 on the degrade path
      }));
      return { chunks, docScores: new Map() };
    }
  }

  // ---------- logs ----------
  logQuery({ query, domain, matched, topScore, topDocId, source }) {
    this.stmt(
      `INSERT INTO queries_log (query, domain, matched, top_score, top_doc_id, source)
       VALUES (?,?,?,?,?,?)`
    ).run(query, domain || null, matched || 0, topScore ?? null, topDocId ?? null, source || 'api');
  }

  listQueryLogs(limit = 100) {
    return this.stmt(
      `SELECT q.*, d.filename AS top_filename
       FROM queries_log q LEFT JOIN docs d ON d.id = q.top_doc_id
       ORDER BY q.id DESC LIMIT ?`
    ).all(limit);
  }

  queryLogStats() {
    return this.stmt(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN matched > 0 THEN 1 ELSE 0 END), 0) AS with_answer
       FROM queries_log`
    ).get();
  }

  // ---------- settings ----------
  getSetting(key, dflt = null) {
    const row = this.stmt('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : dflt;
  }

  setSetting(key, value) {
    this.stmt(
      `INSERT INTO settings (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, String(value));
  }

  close() {
    try {
      this.db.close();
    } catch (_) {}
  }
}

module.exports = { Storage };
