'use strict';

/**
 * Generate a CJK-capable PDF fixture for testing/ingestion.
 *
 * pdfkit needs a TTF (not TTC) font to subset; we look for the Droid
 * Sans Fallback TTF commonly shipped on Debian/Ubuntu. When no CJK-capable
 * TTF is found we skip PDF fixture generation (PDF ingest is unit-tested
 * separately) and log a warning.
 *
 * Matching the glyph coverage of the Droid fallback font (no ASCII digits),
 * we draw each line as interleaved runs: ASCII segments (digits, letters,
 * `-`, `.`, `:`) use the built-in Helvetica font (WinAnsi, extracted
 * losslessly by pdf-parse), CJK segments use the embedded Droid subset
 * (mapped via ToUnicode). This keeps phone numbers, times and amounts
 * readable in extracted text instead of being collapsed to placeholder
 * (U+0000 / `.notdef`) glyphs.
 */
const path = require('node:path');
const fs = require('node:fs');

const CANDIDATE_FONTS = [
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', // pdfkit can't subset ttc, fallback only
];

const CONTENT = `诊所预约须知

一、预约方式
患者可通过电话、微信小程序或门诊大厅自助机预约，可预约未来 7 天内号源。
预约成功后请按短信提示提前 30 分钟到院取号。

二、就诊所需材料
首次就诊请携带身份证与医保卡，在门诊一层收费窗口建档。
复诊患者持就诊卡即可在自助挂号机办理。

三、退号与变更
如需退号，请在预约就诊时间前 2 小时办理，逾期视为爽约，累计爽约 3 次将
暂停预约资格 30 天。

四、客服电话
诊所客服热线：010-66554433，服务时间 8:00-20:00。
`;

/** A run of characters that can be rendered with a Latin/base font. */
const ASCII_RUN = /[A-Za-z0-9][A-Za-z0-9 .:\-%]*/;

/**
 * Split a line into alternating CJK / ASCII segments, preserving order.
 * @param {string} line
 * @returns {Array<{ascii: boolean, text: string}>}
 */
function splitRuns(line) {
  return line.split(/([A-Za-z0-9][A-Za-z0-9 .:\-%]*)/).map((seg, i) => ({
    ascii: /^[A-Za-z0-9 .:\-%]+$/.test(seg) && /[A-Za-z0-9]/.test(seg),
    text: seg,
    last: i === 0, // placeholder; caller computes last
  }));
}

async function buildPdfFixture() {
  const outDir = path.join(__dirname, '..', 'fixtures', 'corpus');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'clinic-guide.pdf');

  // The fixture binaries are committed under fixtures/corpus, so a missing
  // generator runtime (pdfkit is a devDependency omitted from prod images) or
  // missing CJK font is non-fatal: keep whatever binary already exists.
  const hasPdfkit = (() => {
    try {
      require.resolve('pdfkit');
      return true;
    } catch (_) {
      return false;
    }
  })();
  if (!hasPdfkit) {
    if (!fs.existsSync(outPath)) {
      throw new Error('[pdf-fixture] pdfkit unavailable (devDependency) and no committed clinic-guide.pdf exists');
    }
    console.warn('[pdf-fixture] pdfkit unavailable; keeping committed clinic-guide.pdf');
    return false;
  }
  const font = CANDIDATE_FONTS.find((f) => fs.existsSync(f));
  if (!font) {
    console.warn('[pdf-fixture] no CJK TTF font found; keeping committed clinic-guide.pdf');
    return false;
  }

  const PDFDocument = require('pdfkit'); // devDependency, build tool only
  // Fixed metadata keeps the generated PDF byte-identical across runs so
  // re-seeding stays idempotent (the /ID is MD5(info + CreationDate)).
  const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
  const doc = new PDFDocument({ margin: 50, info: { CreationDate: FIXED_DATE } });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);
  try {
    doc.fontSize(12);
    for (const line of CONTENT.split('\n')) {
      if (!line.trim()) {
        doc.moveDown();
        continue;
      }
      const runs = splitRuns(line);
      runs.forEach((run, i) => {
        doc.font(run.ascii ? 'Helvetica' : font);
        doc.text(run.text, { continued: i < runs.length - 1 });
      });
    }
    doc.end();
  } catch (e) {
    console.warn('[pdf-fixture] pdfkit failed:', e.message);
    return false;
  }
  // Await flush so callers (ensureCorpusFiles/seeding) never read a partial file.
  await new Promise((resolve) => {
    stream.on('finish', resolve);
    stream.on('error', resolve);
  });
  return true;
}

module.exports = { buildPdfFixture, PDF_FIXTURE_TEXT: CONTENT };
if (require.main === module) {
  buildPdfFixture().then((ok) => console.log(ok ? 'PDF fixture written' : 'PDF fixture skipped'));
}
