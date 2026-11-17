'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { KnowledgeBase } = require('../src/lib/knowledge');
const { chunkText } = require('../src/lib/chunker');
const { ensureCorpusFiles } = require('../scripts/seed-fixtures');

function tempDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ragdesk-test-')), 'test.db');
}

test('excerptFrom: no-anchor fallback heads the body or returns it whole', () => {
  const kb = new KnowledgeBase(tempDb());
  const long = '疫苗接种时间每周二、周四、周六上午。'.repeat(5);
  const cut = kb.excerptFrom(long, '完全不存在', 60);
  assert.ok(cut.startsWith('疫苗接种时间'), 'fallback keeps the leading slice');
  assert.ok(cut.endsWith('…'), 'long body gets an ellipsis');
  assert.ok(cut.length <= 61, `head-cut should respect width, got length ${cut.length}`);
  assert.strictEqual(kb.excerptFrom('太短，没有匹配。', '完全不存在', 60), '太短，没有匹配。', 'short body returns whole');
  assert.strictEqual(kb.excerptFrom('   ', 'x'), '', 'blank body yields empty string');
  kb.close();
});

test('excerptFrom: anchor path windows around the first query hit with ellipses', () => {
  const kb = new KnowledgeBase(tempDb());
  // anchor in the middle -> window starts before the hit with a leading ellipsis
  const mid = '这是开头的铺垫内容，没有太大的信息量。'.repeat(3) + '关键锚点词在这里：心脏支架手术需提前预约。';
  const e1 = kb.excerptFrom(mid, '心脏支架', 60);
  assert.ok(e1.startsWith('…'), 'mid-body anchor should be preceded by an ellipsis');
  assert.ok(e1.includes('心脏支架'), 'anchor term must survive the window');
  assert.ok(e1.length <= 61, `window respects width (leading … plus width), got length ${e1.length}`);

  // anchor at the very start -> no ellipsis, opening kept intact
  const e2 = kb.excerptFrom('心脏支架手术咨询费说明，后面是一堆内容。', '心脏支架', 40);
  assert.ok(e2.startsWith('心脏支架'), 'start anchor keeps the body opening');
  assert.ok(!e2.includes('…'), 'no ellipsis when the window begins at the body start');
  assert.strictEqual(e2, '心脏支架手术咨询费说明，后面是一堆内容。', 'short body is returned whole');

  // anchor near the end -> window shifts back so the anchor still fits
  const tail = '内容铺垫。'.repeat(30) + '最后的关键词是血压测量。';
  const e3 = kb.excerptFrom(tail, '血压测量', 40);
  assert.ok(e3.startsWith('…'), 'shifted-back window still carries a leading ellipsis');
  assert.ok(e3.includes('血压测量'), 'end anchor must sit inside the shifted window');

  // short body with an anchor -> whole body, no ellipsis
  assert.strictEqual(kb.excerptFrom('血压测量方法。', '血压', 60), '血压测量方法。');
  kb.close();
});

test('excerptFrom coerces null/undefined chunk bodies to an empty excerpt', () => {
  const kb = new KnowledgeBase(tempDb());
  assert.strictEqual(kb.excerptFrom(null, '某查询', 60), '', 'null body must not throw and yields no excerpt');
  assert.strictEqual(kb.excerptFrom(undefined, '某查询', 60), '', 'undefined body must not throw and yields no excerpt');
  assert.strictEqual(kb.excerptFrom(0, '某查询', 60), '', 'falsy non-string body coerces the same way');
  assert.strictEqual(kb.excerptFrom('', '某查询', 60), '', 'empty string stays empty');
  kb.close();
});

test('_extractText surfaces the unsupported-format error when textFromBuffer returns null', async () => {
  const kb = new KnowledgeBase(tempDb());
  // textFromBuffer returns null for unknown extensions, and the
  // `t !== null` guard on the throw side is only reachable by calling
  // _extractText directly (ingestBuffer pre-filters unsupported kinds).
  await assert.rejects(
    () => kb._extractText('junk.xyz', Buffer.from('whatever bytes')),
    /不支持的文件格式: junk\.xyz/,
    'an untokenizable extension must reject with the format error'
  );
  await assert.rejects(() => kb._extractText('noext', Buffer.from('x')), /不支持的文件格式: noext/);
  // an empty filename carries no name to echo: the `|| '?'` fallback applies
  await assert.rejects(() => kb._extractText('', Buffer.from('x')), /不支持的文件格式: \?/);
  // the supported formats still return text through the same helper
  assert.strictEqual(await kb._extractText('ok.txt', Buffer.from('挂号请带身份证。')), '挂号请带身份证。');
  kb.close();
});

test('chunker: splits long text into overlapping windows with paragraph packing', () => {
  const long = Array.from({ length: 60 }, (_, i) => `第${i}句内容。`).join('');
  const chunks = chunkText(long + '\n\n' + '短段。');
  assert.ok(chunks.length >= 3, `expected many chunks, got ${chunks.length}`);
  const total = chunks.reduce((s, c) => s + c.text.length, 0);
  assert.ok(total > long.length, 'overlap should keep total > source');
  assert.ok(chunks.every((c) => c.text.length > 0));
  assert.strictEqual(chunks[chunks.length - 1].text, '短段。');
});

test('chunker: single paragraph with no blank lines degrades gracefully', () => {
  const one = '这是一段比较长的没有空行的文字，为了测试分块逻辑需要重复很多次。'.repeat(30);
  const chunks = chunkText(one);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.text.trim().length > 0));
});

test('fts: chinese bigram query finds the right chunk (AC1 core)', async () => {
  const kb = new KnowledgeBase(tempDb());
  const result = await kb.ingestBuffer('a.md', Buffer.from(
    '我们提供法律咨询服务。律师咨询费按每小时 300 元收取。当面咨询需提前预约。'
  ));
  assert.strictEqual(result.action, 'indexed');

  const { chunks } = kb.searchRaw('律师咨询费怎么收取');
  assert.ok(chunks.length > 0, 'should find a chunk');
  assert.strictEqual(chunks[0].filename, 'a.md');
  assert.match(chunks[0].body, /咨询费/);

  const ans = kb.answer('律师咨询费怎么收取');
  assert.strictEqual(ans.mode, 'offline-retrieval');
  assert.ok(ans.top, 'top citation present');
  assert.strictEqual(ans.top.document, 'a.md');
  assert.strictEqual(ans.top.paragraph, 1);
  assert.match(ans.answer, /咨询费/);
  kb.close();
});

test('tok found by ascii word + numbers (CJK-adjacent)', async () => {
  const kb = new KnowledgeBase(tempDb());
  await kb.ingestBuffer('ab.txt', Buffer.from('本机构全国客服电话 400-123-4567。'));
  const ans = kb.answer('400-123-4567');
  assert.ok(ans.top, 'should still match by number query');
  kb.close();
});

test('duplicate upload is idempotent (AC5)', async () => {
  const kb = new KnowledgeBase(tempDb());
  const buf = Buffer.from('医院儿科在门诊楼二楼，周一至周日全天开诊。');
  const r1 = await kb.ingestBuffer('c.md', buf);
  const r2 = await kb.ingestBuffer('c.md', buf);
  assert.strictEqual(r1.action, 'indexed');
  assert.strictEqual(r2.action, 'duplicate');
  assert.strictEqual(kb.getAllDocs().length, 1);
  kb.close();
});

test('ingest then delete keeps index clean', async () => {
  const kb = new KnowledgeBase(tempDb());
  await kb.ingestBuffer('d.md', Buffer.from('疫苗接种时间每周二、周四、周六上午。'));
  const doc = kb.getAllDocs()[0];
  assert.strictEqual(kb.getDocChunks(doc.id).length, 1);
  kb.deleteDoc(doc.id);
  assert.strictEqual(kb.getAllDocs().length, 0);
  const { chunks } = kb.searchRaw('疫苗接种');
  assert.strictEqual(chunks.length, 0);
  kb.close();
});

test('empty / whitespace-only file is rejected, not indexed', async () => {
  const kb = new KnowledgeBase(tempDb());
  const r1 = await kb.ingestBuffer('empty.md', Buffer.from(''));
  const r2 = await kb.ingestBuffer('blank.md', Buffer.from('   \n\n  '));
  assert.strictEqual(r1.action, 'error');
  assert.strictEqual(r2.action, 'error');
  assert.strictEqual(kb.getAllDocs().length, 0, 'no orphan doc row should be created');
  kb.close();
});

test('offline mode returns answer without any LLM/embedding (AC3)', () => {
  const kb = new KnowledgeBase(tempDb());
  const ans = kb.answer('法学');
  assert.strictEqual(ans.mode, 'offline-retrieval');
  assert.strictEqual(ans.llm, false);
  assert.ok(Array.isArray(ans.citations));
  kb.close();
});

test('answer on empty corpus gives graceful fallback', () => {
  const kb = new KnowledgeBase(tempDb());
  const ans = kb.answer('完全不存在的问题关键词');
  assert.strictEqual(ans.mode, 'offline-retrieval');
  assert.strictEqual(ans.domain, 'general');
  assert.strictEqual(ans.confidence, 0);
  assert.match(ans.answer, /没有找到相关内容/, 'should use the general domain fallback');
  assert.strictEqual(ans.llm, false);
  assert.strictEqual(ans.top, null);
  assert.deepStrictEqual(ans.citations, []);
  kb.close();
});

test('isSupportedFile / fileKindOf classify the five accepted formats, reject the rest', () => {
  const kb = new KnowledgeBase(tempDb());
  for (const f of ['a.md', 'a.MARKDOWN', 'b.txt', 'c.csv', 'd.pdf', 'e.docx']) {
    assert.strictEqual(kb.isSupportedFile(f), true, `${f} should be supported`);
    assert.ok(kb.fileKindOf(f), `${f} should carry a kind`);
  }
  assert.deepStrictEqual(
    ['a.md', 'a.MARKDOWN', 'b.txt', 'c.csv', 'd.pdf', 'e.docx'].map((f) => kb.fileKindOf(f)),
    ['markdown', 'markdown', 'text', 'csv', 'pdf', 'docx'],
    'extensions map to the five documented kinds, case-insensitively'
  );
  for (const f of ['f.xyz', 'noext', 'g.html', 'h.exe']) {
    assert.strictEqual(kb.isSupportedFile(f), false, `${f} should be rejected`);
    assert.strictEqual(kb.fileKindOf(f), null, `${f} should have no kind`);
  }
  kb.close();
});

test('ingestBuffer stores the mime from upload metadata and rejects unknown kinds before touching storage', async () => {
  const kb = new KnowledgeBase(tempDb());
  const r = await kb.ingestBuffer('m.mp4', Buffer.from('whatever'), { mime: 'video/mp4' });
  assert.strictEqual(r.action, 'error');
  assert.match(r.error, /不支持的文件类型/);
  assert.strictEqual(kb.getAllDocs().length, 0, 'rejected file never reaches storage');

  await kb.ingestBuffer('m.txt', Buffer.from('挂号请带身份证。'), { mime: 'text/plain' });
  const doc = kb.getAllDocs()[0];
  assert.strictEqual(doc.mime, 'text/plain', 'upload mime is persisted on the doc row');
  kb.close();
});

test('ingestBuffer surfaces corrupt PDF extraction as a clean per-file error', async () => {
  const kb = new KnowledgeBase(tempDb());
  const r = await kb.ingestBuffer('broken.pdf', Buffer.from('not a pdf at all'));
  assert.strictEqual(r.action, 'error');
  assert.match(r.error, /Invalid PDF structure/);
  assert.strictEqual(kb.getAllDocs().length, 0, 'rejected PDF never reaches storage');
  const empty = await kb.ingestBuffer('empty.pdf', Buffer.alloc(0));
  assert.strictEqual(empty.action, 'error');
  assert.match(empty.error, /zero bytes/);
  assert.strictEqual(kb.getAllDocs().length, 0);
  kb.close();
});

test('logQuery + getQueryLogs roundtrip (AC6)', () => {
  const kb = new KnowledgeBase(tempDb());
  kb.logQuery({ query: '测试问题', domain: 'legal', matched: 3, topScore: 0.6, topDocId: 1, source: 'api' });
  const logs = kb.getQueryLogs();
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].query, '测试问题');
  assert.strictEqual(logs[0].domain, 'legal');
  kb.close();
});

test('LLM optional path stays OFF by default; mock summarizer works', async () => {
  const kb = new KnowledgeBase(tempDb());
  await kb.ingestBuffer('l.md', Buffer.from('合同纠纷在被告住所地人民法院起诉，诉讼时效三年。'));
  const ans = await kb.answerWithLlm('合同纠纷在哪里起诉', { llm: true });
  assert.strictEqual(ans.mode, 'llm');
  assert.strictEqual(ans.llm, true);
  assert.ok(ans.answer.length > 0);
  kb.close();
});

test('punctuation/noise queries never throw and still match (FTS-safe)', async () => {
  const kb = new KnowledgeBase(tempDb());
  await kb.ingestBuffer('p.md', Buffer.from('合同纠纷在被告住所地人民法院起诉，诉讼时效三年。客服电话 400-123-4567。'));
  // quotes / question marks / parens are tokenizer delimiters, not MATCH syntax
  const hitA = kb.searchRaw('"合同纠纷"').chunks;
  assert.ok(hitA.length > 0, 'quoted cjk query should still hit');
  assert.strictEqual(hitA[0].filename, 'p.md');
  const hitB = kb.searchRaw('截止时间???').chunks; // trailing punctuation stripped
  assert.ok(Array.isArray(hitB));
  const noise = kb.searchRaw('***').chunks; // all delimiters -> empty query, no throw
  assert.deepStrictEqual(noise, []);
  kb.close();
});

test('answerWithLlm on empty retrieval returns domain fallback, never calls summarizer', async () => {
  const kb = new KnowledgeBase(tempDb());
  let calls = 0;
  const spy = async () => { calls++; return 'SHOULD-NOT-HAPPEN'; };
  const ans = await kb.answerWithLlm('完全不存在的问题', { domain: 'legal', summarizer: spy });
  assert.strictEqual(ans.mode, 'llm');
  assert.strictEqual(ans.llm, true);
  assert.strictEqual(ans.domain, 'legal');
  assert.strictEqual(ans.confidence, 0);
  assert.strictEqual(ans.answer, '抱歉，我在知识库中暂未找到与您问题直接相关的内容。您可以换个问法，或咨询前台获取人工帮助。');
  assert.deepStrictEqual(ans.citations, []);
  assert.strictEqual(calls, 0, 'summarizer must not run with no retrieved context');
  kb.close();
});

test('answerWithLlm passes query/context/systemPrompt and uses summarizer text verbatim', async () => {
  const kb = new KnowledgeBase(tempDb());
  await kb.ingestBuffer('l.md', Buffer.from('合同纠纷在被告住所地人民法院起诉，诉讼时效三年。'));
  let received = null;
  const ans = await kb.answerWithLlm('合同纠纷在哪里起诉', {
    domain: 'legal',
    summarizer: async (args) => {
      received = args;
      return 'CUSTOM-SUMMARY';
    },
  });
  assert.strictEqual(ans.mode, 'llm');
  assert.strictEqual(ans.llm, true);
  assert.strictEqual(ans.domain, 'legal');
  assert.strictEqual(ans.answer, 'CUSTOM-SUMMARY');
  assert.deepStrictEqual(Object.keys(received).sort(), ['context', 'query', 'systemPrompt']);
  assert.strictEqual(received.query, '合同纠纷在哪里起诉');
  assert.ok(received.context.length > 0, 'context should contain retrieved chunk body');
  assert.ok(received.systemPrompt.includes('律师事务所'), 'systemPrompt should come from the domain preset');
  assert.strictEqual(ans.citations.length, 1);
  kb.close();
});

test('mockSummarizer picks the first sentence longer than 8 chars', async () => {
  const { mockSummarizer } = require('../src/lib/knowledge');
  const out = await mockSummarizer({ query: 'x', context: '短。\n这是一句超过八个字的有效句子内容。' });
  assert.ok(out.includes('这是一句超过八个字的有效句子内容。'));
  assert.ok(out.includes('模拟 LLM 摘要'));
});

test('mockSummarizer falls back to a generic line when nothing is long enough', async () => {
  const { mockSummarizer } = require('../src/lib/knowledge');
  const out = await mockSummarizer({ query: 'x', context: '短。\n嗯。' });
  assert.ok(out.includes('模拟 LLM 摘要'));
  assert.ok(out.includes('未找到相关内容。'), 'no sentence > 8 chars yields the fallback line');
  assert.doesNotMatch(out, /短。/, 'short lines are not quoted as an answer');
});

test('answerWithLlm honors an explicit limit (citations capped by it)', async () => {
  const kb = new KnowledgeBase(tempDb());
  for (let i = 1; i <= 4; i++) {
    await kb.ingestBuffer(`d${i}.md`, Buffer.from(`咨询费收取规则第${i}条：按小时计费，合同纠纷在被告住所地人民法院起诉。`));
  }
  const capped = await kb.answerWithLlm('咨询费怎么收', { limit: 2, summarizer: async () => 'S' });
  assert.strictEqual(capped.citations.length, 2, 'limit 2 caps the LLM citations');
  const all = await kb.answerWithLlm('咨询费怎么收', { summarizer: async () => 'S' });
  assert.strictEqual(all.citations.length, 4, 'default returns every matching chunk');
  kb.close();
});

test('answerWithLlm propagates a summarizer rejection (never answers garbage)', async () => {
  const kb = new KnowledgeBase(tempDb());
  await kb.ingestBuffer('boom.md', Buffer.from('咨询费按小时计费，合同纠纷在被告住所地人民法院起诉。'));
  const failing = async () => {
    throw new Error('LLM upstream timeout');
  };
  await assert.rejects(
    () => kb.answerWithLlm('咨询费', { summarizer: failing }),
    /LLM upstream timeout/,
    'a failing summarizer must reject, not produce a fake answer'
  );
  kb.close();
});

test('retrieval honors explicit limits; answer caps citations by limit', async () => {
  const kb = new KnowledgeBase(tempDb());
  for (let i = 1; i <= 6; i++) {
    await kb.ingestBuffer(`d${i}.md`, Buffer.from(`咨询费收取规则第${i}条：按小时计费。`));
  }
  assert.strictEqual(kb.searchRaw('咨询费', 5).chunks.length, 5, 'limit 5 caps at 5');
  assert.strictEqual(kb.searchRaw('咨询费', 1).chunks.length, 1, 'limit 1 returns 1');
  assert.strictEqual(kb.searchRaw('咨询费', 0).chunks.length, 0, 'limit 0 returns none');
  assert.strictEqual(kb.searchRaw('咨询费', 10).chunks.length, 6, 'larger limit returns all');
  const ret = await kb.retrieve('咨询费', 2);
  assert.strictEqual(ret.chunks.length, 2, 'retrieve passes limit through');
  const ans = kb.answer('咨询费', { limit: 2 });
  assert.ok(ans.top, 'top citation present');
  assert.strictEqual(ans.citations.length, 2, 'answer caps citations by limit');
  assert.strictEqual(kb.answer('咨询费').citations.length, 3, 'default limit is 3');
  kb.close();
});

test('UTF-8 BOM in md/txt files is stripped during chunking (Windows/Excel exports)', async () => {
  const kb = new KnowledgeBase(tempDb());
  const bom = Buffer.from('EFBBBF', 'hex');
  await kb.ingestBuffer('notes.md', Buffer.concat([bom, Buffer.from('合同纠纷在被告住所地人民法院起诉。')]));
  const doc = kb.getAllDocs()[0];
  const chunks = kb.getDocChunks(doc.id);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].body.charCodeAt(0), 0x5408, 'first char should be 合, not U+FEFF');
  const ans = kb.answer('合同纠纷');
  assert.ok(ans.top, 'BOM must not break CJK search');
  kb.close();
});

test('ingestFile reads a path, stores basename, dedupes and rejects unsupported extensions', async () => {
  const kb = new KnowledgeBase(tempDb());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragdesk-file-'));
  const nested = path.join(dir, 'sub', 'note.md');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(nested, '咨询费按小时计费，合同纠纷在被告住所地人民法院起诉。');

  const first = await kb.ingestFile(nested);
  assert.strictEqual(first.action, 'indexed');
  assert.strictEqual(first.chunks, 1);
  assert.strictEqual(kb.getAllDocs()[0].filename, 'note.md', 'basename is stored, not the nested path');

  const dup = await kb.ingestFile(nested, { mime: 'text/markdown' });
  assert.strictEqual(dup.action, 'duplicate', 'same file on disk re-ingests as duplicate');
  assert.strictEqual(dup.docId, first.docId, 'duplicate points at the existing doc');
  assert.strictEqual(kb.getAllDocs().length, 1, 'no second doc row created');

  const bad = path.join(dir, 'junk.dat');
  fs.writeFileSync(bad, 'not readable');
  const err = await kb.ingestFile(bad);
  assert.strictEqual(err.action, 'error');
  assert.match(err.error, /不支持的文件类型/);
  assert.strictEqual(kb.getAllDocs().length, 1);

  await assert.rejects(() => kb.ingestFile(path.join(dir, 'missing.md')), /ENOENT/, 'missing path propagates fs error');
  kb.close();
});

test('ingestDir skips nested directories (non-recursive)', async () => {
  const kb = new KnowledgeBase(tempDb());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragdesk-ing-'));
  fs.writeFileSync(path.join(dir, 'ok.md'), '律师咨询费按小时计费。');
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'nested', 'inner.md'), '挂号请带身份证。');
  const res = await kb.ingestDir(dir);
  assert.deepStrictEqual(res.map((r) => r.filename), ['ok.md'], 'one result per top-level file, none for the dir');
  assert.deepStrictEqual(
    kb.getAllDocs().map((d) => d.filename),
    ['ok.md'],
    'nested files are not recursed into'
  );
  kb.close();
});

test('ingestDir returns per-file results; misses report errors, indexable files store', async () => {
  const kb = new KnowledgeBase(tempDb());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragdesk-ingest-'));
  fs.writeFileSync(path.join(dir, 'ok.md'), '律师咨询费按每小时 300 元收取。挂号请带身份证。');
  fs.writeFileSync(path.join(dir, 'data.csv'), '主题,内容\n咨询费,按小时计费\n');
  fs.writeFileSync(path.join(dir, 'bad.xyz'), 'nope');
  fs.writeFileSync(path.join(dir, 'blank.md'), '  \n');
  const res = await kb.ingestDir(dir);
  assert.strictEqual(res.length, 4, 'every file gets exactly one result entry');
  const byName = Object.fromEntries(res.map((r) => [r.filename, r]));
  assert.strictEqual(byName['ok.md'].action, 'indexed');
  assert.strictEqual(byName['data.csv'].action, 'indexed');
  assert.strictEqual(byName['bad.xyz'].action, 'error', 'unsupported ext is an error');
  assert.match(byName['bad.xyz'].error, /不支持的文件类型/);
  assert.strictEqual(byName['blank.md'].action, 'error', 'whitespace-only file is an error');
  assert.strictEqual(kb.getAllDocs().length, 2, 'only the two indexable files become docs');
  await assert.rejects(() => kb.ingestDir(path.join(dir, 'nope')), /ENOENT/, 'missing dir rejects');
  kb.close();
});

test('ingestDir per-file catch surfaces thrown read errors (not just returned error objects)', async (t) => {
  // A file the process cannot open makes ingestion *throw* (ENOENT is covered;
  // here it is EACCES via chmod 000), which is caught per-file and turned into
  // an error result instead of aborting the whole directory scan.
  if (process.getuid && process.getuid() === 0) {
    t.skip('chmod is ineffective when running as root');
    return;
  }
  const kb = new KnowledgeBase(tempDb());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragdesk-lock-'));
  fs.writeFileSync(path.join(dir, 'ok.md'), '律师咨询费按每小时 300 元收取。');
  fs.writeFileSync(path.join(dir, 'locked.txt'), '不可读的内容');
  fs.chmodSync(path.join(dir, 'locked.txt'), 0o000);
  const res = await kb.ingestDir(dir);
  const byName = Object.fromEntries(res.map((r) => [r.filename, r]));
  assert.strictEqual(byName['ok.md'].action, 'indexed', 'readable files still index');
  assert.strictEqual(byName['locked.txt'].action, 'error', 'a throw on read becomes a per-file error');
  assert.match(byName['locked.txt'].error, /EACCES/, 'the thrown fs cause is carried through');
  assert.strictEqual(kb.getAllDocs().length, 1, 'the readable doc is the only one stored');
  kb.close();
});

test('settings persist across KnowledgeBase close/reopen; defaults when missing', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ragdesk-set-')), 'kb.db');
  const kb1 = new KnowledgeBase(dbPath);
  kb1.setSetting('domain', 'legal');
  kb1.setSetting('greeting', '您好，我是法律助手。');
  kb1.close();

  const kb2 = new KnowledgeBase(dbPath);
  assert.strictEqual(kb2.getSetting('domain'), 'legal', 'value survives close/reopen');
  assert.strictEqual(kb2.getSetting('greeting'), '您好，我是法律助手。');
  assert.strictEqual(kb2.getSetting('nope', 'dflt'), 'dflt', 'missing key returns the default');
  kb2.close();
});

test('engineInfo advertises the offline FTS5+BM25 engine and its db path', () => {
  const kb = new KnowledgeBase(tempDb());
  const info = kb.engineInfo();
  assert.strictEqual(info.fts, true);
  assert.strictEqual(info.bm25, true);
  assert.strictEqual(info.embedding, false, 'offline mode has no embeddings');
  assert.strictEqual(info.llm, false, 'offline mode has no LLM');
  assert.match(info.tokenizer, /bigram-cjk/);
  assert.strictEqual(info.storage, kb.storage.dbPath, 'engine reports the live db path');
  kb.close();
});

test('getDoc returns null for a missing id and the full row for an existing one', async () => {
  const kb = new KnowledgeBase(tempDb());
  assert.strictEqual(kb.getDoc(9999), null);
  await kb.ingestBuffer('d.md', Buffer.from('咨询费按小时计费，合同纠纷在被告住所地人民法院起诉。'));
  const doc = kb.getDoc(kb.getAllDocs()[0].id);
  assert.strictEqual(doc.filename, 'd.md');
  assert.strictEqual(doc.kind, 'markdown');
  assert.strictEqual(kb.getAllDocs()[0].chunk_count, 1, 'list view carries a chunk count');
  kb.close();
});

test('storage getChunk returns chunk body/filename and chunkCount tallies per doc', async () => {
  const kb = new KnowledgeBase(tempDb());
  await kb.ingestBuffer('c.md', Buffer.from('疫苗接种时间每周二、周四、周六上午。'));
  const doc = kb.getAllDocs()[0];
  assert.strictEqual(kb.storage.chunkCount(doc.id), 1);
  const chunk = kb.storage.getChunk(kb.storage.listChunks(doc.id)[0].id);
  assert.strictEqual(chunk.filename, 'c.md');
  assert.strictEqual(chunk.chunk_idx, 1);
  assert.match(chunk.body, /疫苗接种时间/);
  kb.close();
});
