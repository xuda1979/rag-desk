'use strict';

/**
 * Generate a small DOCX fixture from scratch (Office Open XML).
 *
 * The produced XML uses the minimal WordprocessingML body required by our
 * parser (extractors.extractDocx reads <w:t> run texts). `fflate` is a
 * runtime dependency (also used by extractors), so this always works; when it
 * is somehow unavailable we keep the committed fixture binary.
 */
const path = require('node:path');
const fs = require('node:fs');

function buildDocxFixture() {
  const outDir = path.join(__dirname, '..', 'fixtures', 'corpus');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'law-services.docx');

  const paragraphs = [
    '律所服务范围',
    '本所主要提供企业常年法律顾问、合同审查、劳动争议代理与民事诉讼服务。',
    '常年法律顾问服务费为每年人民币 30,000 元起，具体以合同约定为准。',
    '争议解决业务实行风险代理，代理费不超过执行回款金额的 30%。',
  ];

  const body = paragraphs
    .map(
      (p, i) =>
        `<w:p><w:pPr><w:pStyle w:val="${i === 0 ? 'Title' : 'Normal'}"/></w:pPr>` +
        `<w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`
    )
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;

  const { zipSync, strToU8 } = require('fflate'); // runtime dependency
  // Deterministic archive: fixed mtime keeps the fixture byte-identical across
  // runs so re-seeding stays idempotent (sha256 dedupe relies on it). fflate
  // interprets the timestamp in local time, so use a fixed local Date.
  const opts = { mtime: new Date(1980, 0, 1) };
  const uint8 = zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypesXml()),
      '_rels/.rels': strToU8(relsXml()),
      'word/document.xml': strToU8(xml),
    },
    opts
  );
  fs.writeFileSync(outPath, Buffer.from(uint8));
  return true;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
}

function relsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildDocxFixture, DOCX_FIXTURE_TEXT: paragraphs(), escapeXml };
function paragraphs() {
  return [
    '律所服务范围',
    '本所主要提供企业常年法律顾问、合同审查、劳动争议代理与民事诉讼服务。',
    '常年法律顾问服务费为每年人民币 30,000 元起，具体以合同约定为准。',
    '争议解决业务实行风险代理，代理费不超过执行回款金额的 30%。',
  ].join('\n');
}
