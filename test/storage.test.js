'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { Storage } = require('../src/lib/storage');

function tempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragdesk-storage-'));
  return { st: new Storage(path.join(dir, 'test.db')), dir };
}

test('storage: insertDoc + insertChunks + metadata roundtrip', () => {
  const { st } = tempStorage();
  const docId = st.insertDoc({ filename: 'a.md', kind: 'markdown', mime: 'text/markdown', size: 12, sha256: 'abc123' });
  st.insertChunks(docId, [
    { index: 1, text: '律师咨询费按每小时 300 元收取。' },
    { index: 2, text: '当面咨询需提前预约。' },
  ]);
  assert.strictEqual(st.getDoc(docId).filename, 'a.md');
  assert.deepStrictEqual(
    st.listChunks(docId).map((c) => [c.chunk_idx, c.body]),
    [
      [1, '律师咨询费按每小时 300 元收取。'],
      [2, '当面咨询需提前预约。'],
    ]
  );
  assert.strictEqual(st.chunkCount(docId), 2);
  assert.strictEqual(st.getChunk(1).filename, 'a.md', 'getChunk enriches doc metadata');
  assert.strictEqual(st.getChunk(999), null);
  assert.strictEqual(st.listDocs()[0].chunk_count, 2, 'listDocs aggregates chunk_count');
  st.close();
});

test('storage: missing doc lookups return null, not throw', () => {
  const { st } = tempStorage();
  assert.strictEqual(st.getDoc(999), null);
  assert.strictEqual(st.getDocBySha('deadbeef'), null);
  st.close();
});

test('storage: deleteDoc on a missing id is a no-op', () => {
  const { st } = tempStorage();
  assert.doesNotThrow(() => st.deleteDoc(999));
  st.close();
});

test('storage: FTS search finds CJK hits, respects limit, empty query yields none', () => {
  const { st } = tempStorage();
  const docId = st.insertDoc({ filename: 'a.md', kind: 'markdown', mime: null, size: 30, sha256: 's1' });
  st.insertChunks(docId, [
    { index: 1, text: '律师咨询费按每小时 300 元收取。' },
    { index: 2, text: '挂号请带身份证，儿科在门诊楼二楼。' },
  ]);
  const h = st.search('咨询费');
  assert.strictEqual(h.chunks.length, 1, 'should find exactly the matching chunk');
  assert.strictEqual(h.chunks[0].filename, 'a.md');
  assert.strictEqual(h.chunks[0].chunkIndex, 1);
  assert.ok(h.chunks[0].score <= 0, 'bm25 score is negative, lower is better');
  assert.ok(h.docScores.has(docId));
  assert.strictEqual(st.search('咨询费', 1).chunks.length, 1, 'limit honored');
  assert.strictEqual(st.search('咨询费', 0).chunks.length, 0, 'limit 0 returns none');
  assert.strictEqual(st.search('').chunks.length, 0, 'empty query is a no-op');
  assert.strictEqual(st.search('   ').chunks.length, 0, 'whitespace query is a no-op');
  assert.strictEqual(st.search('完全不存在').chunks.length, 0, 'no hit -> no chunks');
  assert.strictEqual(st.search('完全不存在').docScores.size, 0, 'no hit -> no doc scores');
  st.close();
});

test('storage: query log roundtrip, LEFT JOIN nulls and stats counts', () => {
  const { st } = tempStorage();
  st.logQuery({ query: 'q1', domain: 'legal', matched: 2, topScore: -5, topDocId: 777, source: 'api' });
  st.logQuery({ query: 'q2', source: 'widget' });
  st.logQuery({ query: 'q3' });
  const logs = st.listQueryLogs();
  assert.strictEqual(logs.length, 3, 'ordered by newest first');
  assert.strictEqual(logs[0].query, 'q3');
  assert.strictEqual(logs[0].domain, null, 'missing domain stores null');
  assert.strictEqual(logs[0].matched, 0, 'missing matched defaults to 0');
  assert.strictEqual(logs[1].top_filename, null, 'orphan top_doc_id LEFT JOINs to null, no throw');
  assert.deepStrictEqual(
    { ...st.queryLogStats() },
    { total: 3, with_answer: 1 },
    'with_answer counts only matched > 0'
  );
  st.close();
});

test('storage: insertChunks rolls back every table when a mid-batch statement fails — no partial chunks, no fts rows', () => {
  const { st } = tempStorage();
  const docId = st.insertDoc({ filename: 'a.md', kind: 'markdown', mime: null, size: 6, sha256: 's1' });
  // A duplicate (doc_id, chunk_idx) violates the unique constraint on the second
  // statement, forcing the BEGIN IMMEDIATE ... ROLLBACK path in insertChunks.
  st.stmt('CREATE UNIQUE INDEX uq_chunk ON chunks(doc_id, chunk_idx)').run();
  assert.throws(
    () => st.insertChunks(docId, [
      { index: 1, text: '律师咨询费按每小时 300 元收取。' },
      { index: 1, text: '同一索引，约束冲突。' },
    ]),
    /UNIQUE constraint failed/,
    'the mid-batch failure must propagate'
  );
  assert.strictEqual(st.chunkCount(docId), 0, 'the committed first chunk is rolled back, not left behind');
  assert.strictEqual(st.listChunks(docId).length, 0, 'chunks table holds nothing for the doc');
  assert.strictEqual(st.search('咨询费').chunks.length, 0, 'fts holds no orphaned rows from the aborted batch');
  assert.ok(st.getDoc(docId), 'the doc row itself survives the failed chunk write');
  // the connection stays usable and a corrected batch commits normally
  st.insertChunks(docId, [{ index: 2, text: '挂号请带身份证。' }]);
  assert.strictEqual(st.chunkCount(docId), 1, 'a valid batch inserts after the rollback');
  assert.strictEqual(st.search('挂号').chunks[0].chunkIndex, 2);
  st.close();
});

test('storage: deleteDoc is atomic — a mid-transaction failure rolls back chunks and fts so nothing half-deletes', () => {
  const { st } = tempStorage();
  const docId = st.insertDoc({ filename: 'b.md', kind: 'markdown', mime: null, size: 6, sha256: 's2' });
  st.insertChunks(docId, [{ index: 1, text: '咨询费按小时计费，合同纠纷在被告住所地起诉。' }]);
  // A BEFORE DELETE trigger raising ABORT makes the docs delete statement fail
  // after the fts/chunks deletes already ran, exercising the ROLLBACK path.
  st.db.exec("CREATE TRIGGER trg_block_del BEFORE DELETE ON docs BEGIN SELECT RAISE(ABORT, 'delete blocked'); END");
  assert.throws(() => st.deleteDoc(docId), /delete blocked/);
  assert.strictEqual(st.chunkCount(docId), 1, 'chunks delete is rolled back');
  assert.ok(st.getDoc(docId), 'doc row delete is rolled back');
  assert.strictEqual(st.search('咨询费').chunks.length, 1, 'fts delete is rolled back');
  // without the abort, the same delete cleans all three consistently
  st.db.exec('DROP TRIGGER trg_block_del');
  st.deleteDoc(docId);
  assert.strictEqual(st.listDocs().length, 0);
  assert.strictEqual(st.chunkCount(docId), 0);
  assert.strictEqual(st.search('咨询费').chunks.length, 0);
  st.close();
});

test('storage: settings upsert is idempotent per key', () => {
  const { st } = tempStorage();
  st.setSetting('theme', 'dark');
  st.setSetting('theme', 'light');
  assert.strictEqual(st.getSetting('theme'), 'light');
  st.setSetting('n', 42);
  assert.strictEqual(st.getSetting('n'), '42', 'values are stored as strings');
  assert.strictEqual(st.getSetting('missing', 'dflt'), 'dflt');
  st.close();
});
