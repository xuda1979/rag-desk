'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { KnowledgeBase } = require('../src/lib/knowledge');
const { ensureCorpusFiles } = require('../scripts/seed-fixtures');
const { extractDocx, parseCsv } = require('../src/lib/extractors');

const CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');

test('fixture corpus contains all required formats', async () => {
  await ensureCorpusFiles();
  const names = fs.readdirSync(CORPUS).sort();
  for (const f of ['law-faq.md', 'clinic-faq.md', 'bid-announcement.md', 'faq-transfer.csv', 'notice-provider.txt']) {
    assert.ok(names.includes(f), `missing fixture ${f}`);
  }
  // PDF/DOCX are generated; not strictly required but should exist when fonts are available
  assert.ok(fs.existsSync(path.join(CORPUS, 'clinic-guide.pdf')), 'PDF fixture should exist (Droid TTF present)');
  assert.ok(fs.existsSync(path.join(CORPUS, 'law-services.docx')), 'DOCX fixture should exist');
});

function freshKb() {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rd-'));
  return new KnowledgeBase(path.join(dir, 'kb.db'));
}

test('corpus has at least 10 domain documents (AC1)', async () => {
  await ensureCorpusFiles();
  const kb = freshKb();
  const res = await kb.ingestDir(CORPUS);
  const added = res.filter((r) => r.action === 'indexed').length;
  assert.ok(res.length >= 10, `expected >=10 supported files, got ${res.length}`);
  assert.ok(added >= 10, `expected >=10 indexed files, got ${added}`);
  assert.ok(res.every((r) => r.action !== 'error'), `some files failed: ${JSON.stringify(res.filter((r) => r.action === 'error'))}`);
  kb.close();
});

test('end-to-end: seed corpus, ask, top excerpt contains answer + citation (AC1+AC2)', async () => {
  await ensureCorpusFiles();
  const kb = freshKb();
  const dir = await kb.ingestDir(CORPUS);
  assert.ok(dir.filter((r) => r.action === 'indexed').length >= 10);

  const cases = [
    ['律师咨询费怎么收取', /咨询费|300/],
    ['劳动仲裁流程', /仲裁/],
    ['儿童接种疫苗', /疫苗|接种/],
    ['项目投标截止时间', /截止|2026-11-20/],
    ['中标人是谁', /康健/],
    ['可以刷医保卡吗', /医保/],
  ];
  for (const [q, re] of cases) {
    const ans = kb.answer(q);
    assert.ok(ans.top, `query ${q} should find a top source`);
    const full = ans.top.excerpt;
    assert.match(full, re, `top excerpt for "${q}" should contain answer pattern`);
    const docName = ans.top.document;
    const p = ans.top.paragraph;
    assert.ok(typeof docName === 'string' && docName.includes('.'), `citation should carry document name, got ${docName}`);
    assert.ok(Number.isInteger(p) && p >= 1, `citation should carry paragraph number, got ${p}`);
  }
  kb.close();
});

test('extractDocx parses fixture text', () => {
  ensureCorpusFiles();
  const buf = fs.readFileSync(path.join(CORPUS, 'law-services.docx'));
  const text = extractDocx(buf);
  assert.match(text, /律所服务范围/);
  assert.match(text, /常年法律顾问/);
});

test('parseCsv handles quoted fields', () => {
  const rows = parseCsv('问题,回答\n"这个,带逗号",答案\n');
  assert.strictEqual(rows[1][0], '这个,带逗号');
});
