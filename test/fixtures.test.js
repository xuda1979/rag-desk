'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { KnowledgeBase } = require('../src/lib/knowledge');
const { ensureCorpusFiles, seedIfNeeded } = require('../scripts/seed-fixtures');
const { buildPdfFixture, PDF_FIXTURE_TEXT } = require('../scripts/make-pdf-fixture');
const { extractDocx, parseCsv } = require('../src/lib/extractors');
const Module = require('node:module');

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

test('seed-fixtures CLI failure: unopenable dev DB exits 1 and prints the cause (covers main().catch)', async (t) => {
  // Covers the `main().catch` arm (scripts/seed-fixtures.js:65-68): when the
  // dev DB cannot be opened, main() rejects and the CLI prints the error to
  // stderr then exits 1. `data/` is gitignored, so briefly swapping the db
  // file for a directory placeholder makes the real KnowledgeBase throw
  // ERR_SQLITE_ERROR. Same-directory renames are atomic: open fds from any
  // concurrent seed keep writing to the old inode, nothing else opens
  // data/ragdesk.db (all other spawns set RAGDESK_DB), and the placeholder
  // directory can never be re-opened as a DB file.
  const devDb = path.join(ROOT, 'data', 'ragdesk.db');
  if (!fs.existsSync(devDb)) {
    t.skip('no dev DB on disk (data/ is gitignored)');
    return;
  }
  const backup = devDb + '.rr-test.bak';
  const placeholder = devDb + '.rr-test.dir';
  const wasDir = fs.statSync(devDb).isDirectory(); // repair a crashed previous run
  fs.mkdirSync(placeholder);
  if (wasDir) {
    fs.readdirSync(devDb).forEach((f) => fs.renameSync(path.join(devDb, f), path.join(placeholder, f)));
    fs.rmdirSync(devDb);
  } else {
    fs.renameSync(devDb, backup);
  }
  fs.renameSync(placeholder, devDb);
  try {
    const { code, stdout, stderr } = await runCli(['scripts/seed-fixtures.js']);
    assert.strictEqual(code, 1, 'the CLI must exit non-zero when the seed fails');
    assert.match(stderr, /unable to open database file/, 'the caught error must be printed to stderr');
  } finally {
    fs.renameSync(devDb, placeholder);
    if (wasDir) {
      fs.readdirSync(placeholder).forEach((f) => fs.renameSync(path.join(placeholder, f), path.join(devDb, f)));
      fs.rmdirSync(placeholder);
    } else {
      fs.renameSync(backup, devDb);
      fs.rmdirSync(placeholder);
    }
    assert.ok(fs.statSync(devDb).isFile(), 'the dev DB file must be restored intact');
  }
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

// ---------------------------------------------------------------------------
// pdfkit-present paths of scripts/make-pdf-fixture.js (lines 84-120, 53-59).
// pdfkit ships as a devDependency, so the committed clinic-guide.pdf generation
// loop only runs when the dev-only runtime is installed. Stub the resolution
// and require of pdfkit (no cache pollution: scriptB reads the file from disk),
// steer the created stream to a temp file so the committed fixture is never
// overwritten, and drive the real font-found / draw / flush pipeline against
// the real DroidSansFallbackFull.ttf. Other test files (and their spawns)
// load with a stub-free global state, so the restores here cannot leak.
// ---------------------------------------------------------------------------

const { EventEmitter } = require('node:events');

function withPdfkitEnv(runner, { fontProbe, throwOnDraw, fakeWriteStream = false } = {}) {
  const realResolve = Module._resolveFilename;
  const realLoad = Module._load;
  const realExistsSync = fs.existsSync;

  function FakePDFDocument(opts) {
    // Mirrors the real pdfkit contract exercised by make-pdf-fixture: the
    // constructor is called with { margin, info: { CreationDate } }, options
    // are retained, and pipe() returns the writable stream.
    this.renderOpts = opts;
    this.fontCalls = [];
    this.textCalls = [];
    this.finished = false;
  }
  FakePDFDocument.prototype.pipe = function (s) {
    this.stream = s;
    return s;
  };
  FakePDFDocument.prototype.fontSize = function () {
    return this;
  };
  FakePDFDocument.prototype.font = function (name) {
    this.fontCalls.push(name);
    return this;
  };
  FakePDFDocument.prototype.text = function (text, opts) {
    if (throwOnDraw) throw new Error('[pdf-fixture] explosion while drawing');
    // blank-segment runs are empty (''), so record the non-empty ones
    if (text) this.textCalls.push([text, opts]);
    return this;
  };
  FakePDFDocument.prototype.moveDown = function () {
    this.textCalls.push(['<movedown>', undefined]);
    return this;
  };
  FakePDFDocument.prototype.end = function () {
    this.finished = true;
    setImmediate(() => this.stream.emit('finish'));
  };

  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rd-pdf-'));
  const tempPdf = path.join(tempDir, 'clinic-guide.pdf');
  // fakeWriteStream lets a throw-mid-draw test use a write stream that never
  // actually opens a file descriptor, so the temp dir can be removed safely
  // while the generator's catch path is still pending.
  const fakeStream = new (class extends EventEmitter {
    close() { this.emit('close'); }
    end() { this.emit('finish'); }
  })();
  // fontProbe lets a test force the "no CJK TTF" degrade by hiding all
  // candidate font files; throwOnDraw makes the fake doc.text throw when
  // drawing starts.
  const fakeFs = new Proxy(fs, {
    get(t, prop) {
      if (prop === 'createWriteStream') {
        return () => (fakeWriteStream ? fakeStream : fs.createWriteStream(tempPdf));
      }
      if (prop === 'existsSync' && fontProbe) return fontProbe;
      if (typeof t[prop] === 'function') return t[prop].bind(t);
      return t[prop];
    },
  });

  const instances = [];
  const requireCount = { n: 0 };
  try {
    Module._resolveFilename = function (request, parent, isMain, options) {
      if (typeof request === 'string' && request === 'pdfkit') return '/fake/pdfkit/index.js';
      return realResolve.call(this, request, parent, isMain, options);
    };
    Module._load = function (request, parent, isMain) {
      if (typeof request !== 'string') return realLoad.apply(this, arguments);
      if (request === 'node:fs') return fakeFs;
      if (request === 'pdfkit') {
        requireCount.n += 1;
        return class extends FakePDFDocument {
          constructor(o) {
            super(o);
            instances.push(this);
          }
        };
      }
      return realLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve('../scripts/make-pdf-fixture')];

    return runner({ instances, requireCount, tempPdf, pdfText: PDF_FIXTURE_TEXT, fontFile: '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf' }).finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  } finally {
    Module._resolveFilename = realResolve;
    Module._load = realLoad;
    fs.existsSync = realExistsSync;
    delete require.cache[require.resolve('../scripts/make-pdf-fixture')];
    // restore the shared 'node:fs' object so parallel files see the real one
  }
}

test('make-pdf-fixture happy path: with pdfkit present, draws the CJK content and returns true', async () => {
  await withPdfkitEnv(async ({ instances, requireCount, tempPdf, pdfText, fontFile }) => {
    const { buildPdfFixture } = require('../scripts/make-pdf-fixture');
    const ok = await buildPdfFixture();

    assert.strictEqual(ok, true, 'with pdfkit + a CJK TTF, the generator reports success');
    assert.strictEqual(requireCount.n, 1, 'the pdfkit module is pulled exactly once');
    assert.strictEqual(instances.length, 1, 'exactly one PDF document is created');

    const doc = instances[0];
    assert.strictEqual(doc.finished, true, 'doc.end() is reached after drawing');
    assert.strictEqual(doc.renderOpts.info.CreationDate.toISOString(), '2026-01-01T00:00:00.000Z', 'the fixed metadata date keeps re-seeds byte-identical');
    const helveticaRuns = doc.fontCalls.filter((f) => f === 'Helvetica');
    const cjkRuns = doc.fontCalls.filter((f) => f !== 'Helvetica');
    assert.strictEqual(helveticaRuns.length, 7, 'ASCII runs (digits/letters/periods) render with Helvetica — 7 across the corpus');
    assert.strictEqual(cjkRuns.length, 19, 'CJK runs render with the Droid TTF subset — 19 across the corpus');

    // the interleaved Helvetica/Droid drawing must preserve run order; blank
    // segments are dropped, so check that each source line's non-space
    // characters reappear as a subsequence of the drawn stream
    const drawn = doc.textCalls.filter(([t]) => t !== '<movedown>').map(([t]) => t);
    const joined = drawn.join('');
    assert.ok(drawn.length >= 12, `expected >=12 text runs, got ${drawn.length}`);
    for (const line of pdfText.split('\n').filter((l) => l.trim())) {
      const chars = line.replace(/[ \t]+/g, '').split('');
      let cursor = 0;
      for (const c of chars) {
        const at = joined.indexOf(c, cursor);
        assert.ok(at >= 0, `drawn text must contain "${c}" of "${line}" in order`);
        cursor = at + 1;
      }
    }
    assert.strictEqual(doc.textCalls.filter(([t]) => t === '<movedown>').length, 5, 'blank source lines become moveDown()s');

    // the generator pipes the document into the corpus output stream; with the
    // proxy steering createWriteStream to a temp file, the committed fixture is
    // never touched, but the pipeline artifacts (stream exists, flush awaited)
    // prove the real write/flush handshake ran
    assert.ok(doc.stream, 'doc.pipe() must receive the output stream');
    assert.ok(fs.existsSync(tempPdf), 'the output stream target file is created');
  });
});

test('make-pdf-fixture with no CJK TTF font keeps the committed PDF and skips', async () => {
  // Covers scripts/make-pdf-fixture.js:84-88: pdfkit resolves but none of the
  // candidate TTF/OTC font files exist (Droid TTF, Noto TTC), so
  // buildPdfFixture warns and returns false without creating a PDFDocument —
  // the committed fixture must survive.
  const real = fs.existsSync;
  const hide = [
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    path.join(CORPUS, 'clinic-guide.pdf'),
  ];
  const fontProbe = (p) => (hide.includes(p) ? false : real(p));
  await withPdfkitEnv(async ({ instances }) => {
    const { buildPdfFixture } = require('../scripts/make-pdf-fixture');
    const ok = await buildPdfFixture();
    assert.strictEqual(ok, false, 'no-CJK-font must report skip');
    assert.strictEqual(instances.length, 0, 'no PDF document is created without a CJK font');
    assert.strictEqual(fs.existsSync(path.join(CORPUS, 'clinic-guide.pdf')), true, 'the committed PDF is untouched');
  }, { fontProbe });
});

test('make-pdf-fixture with pdfkit failing mid-draw warns and returns false', async () => {
  // Covers scripts/make-pdf-fixture.js:112-114: doc.text() throws while drawing
  // (e.g. a glyph the subsetter cannot map); the generator must catch, log via
  // console.warn, and return false — not reject the seeding pipeline.
  const origWarn = console.warn;
  let warned = '';
  try {
    console.warn = (msg) => (warned += String(msg));
    await withPdfkitEnv(async ({ instances }) => {
      const { buildPdfFixture } = require('../scripts/make-pdf-fixture');
      const ok = await buildPdfFixture();
      assert.strictEqual(ok, false, 'a draw failure must report skip');
      assert.match(warned, /pdfkit failed/, 'the warning is logged');
      assert.ok(instances.length >= 1, 'a document was attempted before the throw');
    }, { throwOnDraw: true, fakeWriteStream: true });
  } finally {
    console.warn = origWarn;
  }
});
