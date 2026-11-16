'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { KnowledgeBase } = require('../src/lib/knowledge');
const { buildPdfFixture } = require('./make-pdf-fixture');
const { buildDocxFixture } = require('./make-docx-fixture');
const { CORPUS_FILES } = require('./fixture-content');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'corpus');

/**
 * Generate the Chinese domain fixture corpus (also used by tests):
 * outputs markdown/txt/csv fixtures plus generated pdf/docx fixtures.
 *
 * PDF/DOCX generators are build-time tools (pdfkit is a devDependency).
 * Their output is committed under fixtures/corpus, so when the generator
 * can't run (production image, missing font, missing devDeps) we keep the
 * existing committed binaries — ingestion must not depend on dev-only tools.
 */
async function ensureCorpusFiles() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  for (const [name, content] of Object.entries(CORPUS_FILES)) {
    fs.writeFileSync(path.join(FIXTURES, name), content, 'utf8');
  }

  await buildPdfFixture();
  await buildDocxFixture();
}

/** Seed fixtures into the knowledge base (idempotent by sha256). */
async function seedIfNeeded(kb, { force = false } = {}) {
  await ensureCorpusFiles();
  const files = fs.readdirSync(FIXTURES).filter((f) => kb.isSupportedFile(f));
  let added = 0;
  let skipped = 0;
  for (const f of files) {
    const full = path.join(FIXTURES, f);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (!force && kb.storage.getDocBySha(hash)) {
      skipped += 1;
      continue;
    }
    const res = await kb.ingestFile(full);
    if (res.action === 'indexed') added += 1;
    else skipped += 1;
  }
  return { added, skipped };
}

async function main() {
  const dbPath = path.join(ROOT, 'data', 'ragdesk.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const kb = new KnowledgeBase(dbPath);
  await ensureCorpusFiles();
  const res = await seedIfNeeded(kb, { force: false });
  console.log(`[seed] added=${res.added} skipped=${res.skipped}`);
  kb.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { seedIfNeeded, ensureCorpusFiles };
