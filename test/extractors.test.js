'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseCsv, textFromBuffer, fileKind } = require('../src/lib/extractors');

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
