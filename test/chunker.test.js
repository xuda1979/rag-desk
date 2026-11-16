'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { chunkText } = require('../src/lib/chunker');

test('chunker: empty / whitespace-only input yields no chunks', () => {
  assert.deepStrictEqual(chunkText(''), []);
  assert.deepStrictEqual(chunkText('   \n\n  '), []);
  assert.deepStrictEqual(chunkText(null), []);
});

test('chunker: small paragraphs pack into one chunk joined with newlines', () => {
  const chunks = chunkText('第一段。\n第二段。\n第三段哦。', { window: 30 });
  assert.strictEqual(chunks.length, 1);
  assert.deepStrictEqual(chunks, [{ index: 1, text: '第一段。\n第二段。\n第三段哦。' }]);
});

test('chunker: paragraphs that exceed the window spill into the next chunk', () => {
  const chunks = chunkText('短段。\n' + '长'.repeat(20) + '\n收尾。', { window: 12 });
  assert.ok(chunks.length >= 2, 'oversized para should be split apart');
  assert.ok(chunks.every((c) => c.text.length > 0));
  assert.strictEqual(chunks[chunks.length - 1].text, '收尾。');
});

test('chunker: oversized para cut at sentence boundary carries overlap back', () => {
  const src = '甲。'.repeat(3) + '这里是句号边界应该在这里被切开的地方。' + '乙。'.repeat(3);
  const chunks = chunkText(src, { window: 24, overlap: 4 });
  assert.strictEqual(chunks.length, 2);
  // cut lands after the first sentence-ending 。 inside the window
  assert.strictEqual(chunks[0].text, '甲。甲。甲。这里是句号边界应该在这里被切开的地方');
  // the cut position minus overlap carries the tail of chunk1 into chunk2
  assert.strictEqual(chunks[1].text, '开的地方。乙。乙。乙。');
  const overlap = chunks[0].text.slice(-4);
  assert.strictEqual(overlap, '开的地方');
  assert.ok(chunks[1].text.startsWith(overlap), 'chunk2 must re-include the overlap');
});

test('chunker: sentence-boundary rule only when break is past half the window', () => {
  // the only 。 is at index 1 (far before half of 24), so the cut falls at the
  // window edge: 42 chars - 24 window leaves a 22-char tail (no overlap chars
  // '的地方' present, but the 4-char overlap still shifts the tail start)
  const src = '句。' + '字'.repeat(40);
  const chunks = chunkText(src, { window: 24, overlap: 4 });
  assert.strictEqual(chunks[0].text, '句。' + '字'.repeat(22));
  assert.strictEqual(chunks[1].text, '字'.repeat(22));
});

test('chunker: single run without newlines degrades to whole-text windows', () => {
  const one = '没有空行时整段按窗口切割保留重叠。'.repeat(3);
  const chunks = chunkText(one, { window: 15, overlap: 3 });
  assert.ok(chunks.length >= 3, `expected many windows, got ${chunks.length}`);
  assert.strictEqual(chunks[0].index, 1, 'indexes start at 1');
  const last = chunks[chunks.length - 1];
  assert.strictEqual(last.index, chunks.length, 'indexes are sequential to the end');
  assert.ok(
    chunks[1].text.startsWith(chunks[0].text.slice(-3)),
    'overlap chars carried into the next window'
  );
  assert.ok(chunks.every((c) => c.text.length > 0));
});

test('chunker: packed chunks get sequential 1-based index numbers', () => {
  const chunks = chunkText('一。\n二。\n三。\n四。\n五。\n六。', { window: 10 });
  assert.deepStrictEqual(
    chunks.map((c) => [c.index, c.text]),
    [
      [1, '一。\n二。\n三。'],
      [2, '四。\n五。\n六。'],
    ]
  );
});
