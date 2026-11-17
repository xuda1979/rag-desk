'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { KnowledgeBase } = require('../src/lib/knowledge');
const { ensureCorpusFiles, seedIfNeeded } = require('../scripts/seed-fixtures');
const { buildPdfFixture } = require('../scripts/make-pdf-fixture');
const { extractDocx, parseCsv } = require('../src/lib/extractors');

const CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const ROOT = path.join(__dirname, '..');

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
      cwd: ROOT,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('fixture corpus contains all required formats', async () => {
  await ensureCorpusFiles();
  const names = fs.readdirSync(CORPUS).sort();
  for (const f of ['law-faq.md', 'clinic-faq.md', 'bid-announcement.md', 'faq-transfer.csv', 'notice-provider.txt']) {
    assert.ok(names.includes(f), `missing fixture ${f}`);
  }
  // PDF/DOCX are generated; DOCX is required, PDF generation is best-effort
  // (skipped when pdfkit or a CJK-capable TTF font is unavailable), so the PDF
  // is only asserted when the generator actually ran.
  assert.ok(fs.existsSync(path.join(CORPUS, 'law-services.docx')), 'DOCX fixture should exist');
  const pdfGenerated = await buildPdfFixture();
  if (pdfGenerated) {
    assert.ok(fs.existsSync(path.join(CORPUS, 'clinic-guide.pdf')), 'PDF fixture should exist (Droid TTF present)');
  }
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

test('parseCsv strips a UTF-8 BOM', () => {
  const bom = Buffer.from('EFBBBF', 'hex').toString('utf8'); // as Excel writes Chinese CSVs
  const rows = parseCsv(bom + '问题,回答\n挂号需要带什么,带身份证\n');
  assert.strictEqual(rows[0][0], '问题', 'BOM must not leak into the first field');
  assert.strictEqual(rows[0][1], '回答');
  assert.strictEqual(rows[1][0], '挂号需要带什么');
});

test('seedIfNeeded returns added/skipped and is idempotent by sha256', async () => {
  await ensureCorpusFiles();
  const kb = freshKb();

  const first = await seedIfNeeded(kb, { force: false });
  assert.ok(first.added >= 10, `expected >=10 added on first seed, got ${first.added}`);
  assert.strictEqual(first.skipped, 0, 'nothing is skipped on a fresh KB');

  const docCount = kb.getAllDocs().length;
  const second = await seedIfNeeded(kb, { force: false });
  assert.strictEqual(second.added, 0, 're-seeding identical content adds nothing');
  assert.strictEqual(second.skipped, first.added, 'unchanged files are skipped by sha');
  assert.strictEqual(kb.getAllDocs().length, docCount, 'no duplicate docs after re-seed');

  // force only bypasses the sha pre-check; ingestBuffer still dedups identical
  // content (duplicate action), so unchanged files are skipped rather than re-added
  const forced = await seedIfNeeded(kb, { force: true });
  assert.strictEqual(forced.added, 0, 'force with unchanged content must not re-index');
  assert.strictEqual(forced.skipped, first.added);
  assert.strictEqual(kb.getAllDocs().length, docCount);
  kb.close();
});

test('seed-fixtures CLI entrypoint runs the seed to completion (exit 0 with added/skipped counts)', async () => {
  // Covers the `require.main === module` arm (scripts/seed-fixtures.js:64):
  // main() writes only the gitignored data/ragdesk.db dev database, and the
  // sha256 pre-check makes a re-seed against unchanged files report added=0,
  // so running the real script never mutates git-tracked files.
  const { code, stdout, stderr } = await runCli(['scripts/seed-fixtures.js']);
  assert.strictEqual(code, 0, `seed CLI should exit cleanly, stderr: ${stderr}`);
  assert.match(stdout, /\[seed\] added=\d+ skipped=\d+/, 'main() must print the seeding tally');
});

test('make-pdf-fixture CLI entrypoint prints a skip decision and exits 0', async () => {
  // Covers the pdfkit-absent CLI arm (scripts/make-pdf-fixture.js:124): with
  // the dev-only generator missing (this environment), buildPdfFixture returns
  // false and main prints "PDF fixture skipped" without rewriting the file.
  const { code, stdout, stderr } = await runCli(['scripts/make-pdf-fixture.js']);
  assert.strictEqual(code, 0, `pdf CLI should exit cleanly, stderr: ${stderr}`);
  assert.match(stdout, /PDF fixture (skipped|written)/, 'CLI must report its decision');
  assert.ok(fs.existsSync(path.join(CORPUS, 'clinic-guide.pdf')), 'committed PDF must survive');
});

test('make-pdf-fixture throws when pdfkit is absent and no committed PDF exists', async () => {
  // Covers the throw arm scripts/make-pdf-fixture.js:78: buildPdfFixture looks
  // up fs.existsSync on the shared 'node:fs' object at call time, so aliasing
  // it to hide only clinic-guide.pdf drives the `!fs.existsSync(outPath)`
  // branch without touching the real file (safe under parallel test files).
  const real = fs.existsSync;
  const outPath = path.join(CORPUS, 'clinic-guide.pdf');
  try {
    fs.existsSync = (p) => (p === outPath ? false : real(p));
    await assert.rejects(() => buildPdfFixture(), /pdfkit unavailable/);
  } finally {
    fs.existsSync = real;
    assert.ok(real(outPath), 'the committed PDF is still intact after the probe');
  }
});
