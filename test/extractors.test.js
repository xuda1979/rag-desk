'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const { parseCsv, textFromBuffer, fileKind, extractPdf, extractDocx } = require('../src/lib/extractors');

test('parseCsv: handles escaped quotes per RFC-4180', () => {
  assert.deepStrictEqual(parseCsv('a,"b""c",d\n'), [['a', 'b"c', 'd']]);
});

test('parseCsv: embedded newlines inside quoted fields are preserved', () => {
  assert.deepStrictEqual(parseCsv('a,"line1\nline2",b\n'), [['a', 'line1\nline2', 'b']]);
});

test('parseCsv: CRLF line endings parse as rows', () => {
  assert.deepStrictEqual(parseCsv('a,b\r\nc,d\r\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('parseCsv: trailing newline does not create an empty row', () => {
  assert.deepStrictEqual(parseCsv('a,b\n'), [['a', 'b']]);
});

test('parseCsv: empty fields and empty input parse without throwing', () => {
  assert.deepStrictEqual(parseCsv(',\n'), [['', '']]);
  assert.deepStrictEqual(parseCsv(''), []);
});

test('parseCsv: null/undefined coerce to empty text, numbers stringify', () => {
  assert.deepStrictEqual(parseCsv(null), [], 'null input yields no rows, not a throw');
  assert.deepStrictEqual(parseCsv(undefined), [], 'undefined input yields no rows');
  assert.deepStrictEqual(parseCsv(42), [['42']], 'non-string input is String()-coerced');
});

test('parseCsv: an unterminated trailing quote runs to EOF and yields the field', () => {
  assert.deepStrictEqual(parseCsv('a,"unterminated'), [['a', 'unterminated']]);
});

test('parseCsv: a lone CR ends the row without consuming the following char', () => {
  assert.deepStrictEqual(parseCsv('a,b\rc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('parseCsv: a final row without a trailing newline is still committed', () => {
  assert.deepStrictEqual(parseCsv('a,b'), [['a', 'b']]);
  assert.deepStrictEqual(parseCsv('a,b\r\nc'), [
    ['a', 'b'],
    ['c'],
  ]);
});

test('textFromBuffer: md/txt/markdown pass through as utf8 (case-insensitive ext)', () => {
  const buf = Buffer.from('hello\n');
  assert.strictEqual(textFromBuffer('a.md', buf), 'hello\n');
  assert.strictEqual(textFromBuffer('a.txt', buf), 'hello\n');
  assert.strictEqual(textFromBuffer('a.MARKDOWN', buf), 'hello\n');
});

test('textFromBuffer: csv rows are tab-joined for FTS indexing', () => {
  const rows = textFromBuffer('a.csv', Buffer.from('x,y\n1,2\n'));
  assert.strictEqual(rows, 'x\ty\n1\t2');
});

test('textFromBuffer: unsupported extensions yield null', () => {
  assert.strictEqual(textFromBuffer('a.pdf', Buffer.from('x')), null);
  assert.strictEqual(textFromBuffer('a.xyz', Buffer.from('x')), null);
});

test('fileKind: maps known extensions case-insensitively, null otherwise', () => {
  assert.strictEqual(fileKind('a.md'), 'markdown');
  assert.strictEqual(fileKind('a.MD'), 'markdown');
  assert.strictEqual(fileKind('a.markdown'), 'markdown');
  assert.strictEqual(fileKind('a.pdf'), 'pdf');
  assert.strictEqual(fileKind('a.DOCX'), 'docx');
  assert.strictEqual(fileKind('a.csv'), 'csv');
  assert.strictEqual(fileKind('a.txt'), 'text');
  assert.strictEqual(fileKind('a.xyz'), null);
  assert.strictEqual(fileKind('noext'), null);
});

test('extractPdf extracts CJK text from the committed PDF fixture', async () => {
  const pdf = path.join(__dirname, '..', 'fixtures', 'corpus', 'clinic-guide.pdf');
  assert.ok(fs.existsSync(pdf), 'PDF fixture should be committed');
  const text = await extractPdf(fs.readFileSync(pdf));
  assert.ok(text.length > 100, `expected a meaningful extraction, got length ${text.length}`);
  assert.match(text, /诊所预约须知/);
  assert.match(text, /预约方式/);
  // glyph-hole runs and page markers are scrubbed, not left as raw control chars
  assert.doesNotMatch(text, /[\u0000\uFFFD]/);
});

test('extractPdf rejects corrupt, truncated and empty input with a clear message', async () => {
  await assert.rejects(() => extractPdf(Buffer.from('not a pdf at all')), /Invalid PDF structure/);
  await assert.rejects(() => extractPdf(Buffer.from('%PDF-1.4\n123')), /Invalid PDF structure/);
  await assert.rejects(() => extractPdf(Buffer.alloc(0)), /zero bytes/);
});

test('extractDocx fails loudly on corrupt or docx-less input', () => {
  const { zipSync, strToU8 } = require('fflate');
  // a valid zip that is missing word/document.xml
  const noDoc = zipSync({ 'word/_rels/document.xml.rels': strToU8('x') });
  assert.throws(() => extractDocx(new Uint8Array(noDoc)), /missing word\/document.xml/);
  // not a zip at all / empty buffer -> fflate rejects
  assert.throws(() => extractDocx(Buffer.from('not a zip at all')), /invalid zip/);
  assert.throws(() => extractDocx(Buffer.alloc(0)), /invalid zip/);
});

test('extractDocx: <w:t> runs with attributes are captured, empty paragraphs are skipped', () => {
  const { zipSync, strToU8 } = require('fflate');
  const xml =
    '<?xml version="1.0"?><w:document><w:body>' +
    '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">带属性 的文本</w:t></w:r></w:p>' +
    '<w:p></w:p>' +
    '<w:p><w:r><w:t>最后</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const buf = zipSync({ 'word/document.xml': strToU8(xml) });
  const text = extractDocx(buf);
  assert.strictEqual(text, '第一段\n带属性 的文本\n最后', 'attribute-bearing <w:t> tags match and paragraphs interleave with \n');
  assert.doesNotMatch(text, /\n\n/, 'the empty <w:p></w:p> contributes no blank line');
  assert.doesNotMatch(text, /<|>/, 'markup must not leak into the extracted text');
});
