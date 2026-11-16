'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  normalize,
  toQuery,
  ngrams,
  expandForIndex,
  stripPageMarkers,
} = require('../src/lib/tokenizer');
const { KnowledgeBase, confidenceScore } = require('../src/lib/knowledge');

test('normalize lowercases latin, collapses whitespace, trims', () => {
  assert.strictEqual(normalize('  AI  客服 '), 'ai 客服');
  assert.strictEqual(normalize('400-123-4567'), '400-123-4567');
  assert.strictEqual(normalize(''), '');
});

test('ngrams: overlapping bigrams; single char kept whole', () => {
  assert.deepStrictEqual(ngrams('律师咨询费', 2), ['律师', '师咨', '咨询', '询费']);
  assert.deepStrictEqual(ngrams('律', 2), ['律']);
  assert.deepStrictEqual(ngrams(''), []);
});

test('toQuery: CJK run becomes OR-group of quoted bigrams (comment-documented format)', () => {
  assert.strictEqual(
    toQuery('律师咨询费怎么收取'),
    '("律师" OR "师咨" OR "咨询" OR "询费" OR "费怎" OR "怎么" OR "么收" OR "收取")'
  );
});

test('toQuery: ascii runs keep AND semantics (each token quoted)', () => {
  assert.strictEqual(toQuery('400-123-4567'), '"400" "123" "4567"');
  assert.strictEqual(toQuery('疫苗 2 月'), '("疫苗") "2" "月"');
});

test('toQuery: punctuation-only input yields empty query, never throws', () => {
  assert.strictEqual(toQuery('***'), '');
  assert.strictEqual(toQuery('??'), '');
  assert.strictEqual(toQuery('"合同纠纷"'), '("合同" OR "同纠" OR "纠纷")');
});

test('expandForIndex flattens CJK to bigrams and keeps ascii words', () => {
  assert.deepStrictEqual(expandForIndex('法律 400-123'), ['法律', '400', '123']);
});

test('stripPageMarkers removes pdf-parse "N of M" trailers', () => {
  assert.strictEqual(stripPageMarkers('正文内容\n-- 2 of 5 --'), '正文内容');
  assert.strictEqual(stripPageMarkers('-- 10 of 10 --'), '');
});

function freshKb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-tok-'));
  return new KnowledgeBase(path.join(dir, 'kb.db'));
}

test('excerptFrom anchors at the first query term and clips to width', () => {
  const kb = freshKb();
  const body =
    '我们提供法律咨询服务，涵盖合同审查、劳动仲裁、刑事辩护等业务。' +
    '律师咨询费按每小时 300 元收取，初次咨询免费半小时。' +
    '当面咨询需提前电话预约 400-123-4567。';
  const ex = kb.excerptFrom(body, '律师咨询费怎么收取', 60);
  assert.ok(ex.includes('律师咨询费按每小时 300 元收取'), 'should anchor at 律师咨询费');
  assert.ok(ex.startsWith('…'), 'leading ellipsis when cut mid-chunk');
  assert.ok(ex.length <= 62, `clipped to ~width, got ${ex.length}`);
  assert.ok(ex.includes('400-1'), 'keeps surrounding context');
  kb.close();
});

test('excerptFrom returns the tail cut when the anchor is near the end', () => {
  const kb = freshKb();
  const body = '挂号请携带身份证。门诊时间周一至周五上午 8:00-12:00，下午 14:00-17:30。儿科电话预约 400-123-4567。';
  const ex = kb.excerptFrom(body, '预约', 40);
  assert.ok(ex.includes('电话预约 400-123-4567'), 'anchor found near end');
  assert.ok(!ex.endsWith('…'), 'no trailing ellipsis when reaching body end');
  kb.close();
});

test('confidenceScore: single hit caps at 1; gap between top-1 and top-2 lifts confidence', () => {
  assert.strictEqual(confidenceScore({ score: -3.2 }, [{ score: -3.2 }]), 1);
  const gap = confidenceScore({ score: -2 }, [{ score: -2 }, { score: -1.8 }]);
  assert.ok(gap > 0.6 && gap < 0.75, `gap should boost confidence, got ${gap}`);
  assert.ok(confidenceScore({ score: 0 }, [{ score: 0 }, { score: 0 }]) >= 0.4, 'never below floor');
  assert.strictEqual(confidenceScore(null, []), 0, 'no chunks -> 0');
});
