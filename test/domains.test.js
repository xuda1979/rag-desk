'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { DOMAINS, getDomain, domainIds } = require('../src/lib/domains');
const { KnowledgeBase } = require('../src/lib/knowledge');

test('domains: four presets, each with the full prompt pack', () => {
  assert.deepStrictEqual(domainIds(), ['legal', 'medical', 'procurement', 'general']);
  for (const id of domainIds()) {
    const d = DOMAINS[id];
    assert.strictEqual(d.id, id);
    assert.strictEqual(typeof d.label, 'string');
    assert.match(d.label, /\S/);
    for (const key of ['greeting', 'lead', 'fallback', 'footer', 'systemPrompt']) {
      assert.strictEqual(typeof d[key], 'string', `${id}.${key} should be a string`);
    }
    assert.ok(Array.isArray(d.exampleQuestions), `${id}.exampleQuestions should be an array`);
  }
});

test('domains: presets carry distinct fallback phrasings and labels', () => {
  const fallbacks = new Set(domainIds().map((id) => DOMAINS[id].fallback));
  assert.strictEqual(fallbacks.size, 4, 'each domain should phrase its own fallback');
  const labels = new Set(domainIds().map((id) => DOMAINS[id].label));
  assert.strictEqual(labels.size, 4, 'each domain should carry its own label');
});

test('domains: unknown / missing / blank ids fall back to the general preset', () => {
  assert.strictEqual(getDomain('bogus').id, 'general');
  assert.strictEqual(getDomain('').id, 'general');
  assert.strictEqual(getDomain(undefined).id, 'general');
  assert.strictEqual(getDomain('legal').id, 'legal');
});

function freshKb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-dom-'));
  return new KnowledgeBase(path.join(dir, 'kb.db'));
}

test('answer with a domain uses that preset lead/footer and echoes its id', async () => {
  const kb = freshKb();
  await kb.ingestBuffer('d.md', Buffer.from('律师咨询费按每小时 300 元收取。挂号请带身份证。'));
  const ans = kb.answer('咨询费多少', { domain: 'legal' });
  assert.strictEqual(ans.domain, 'legal');
  assert.ok(ans.answer.startsWith(DOMAINS.legal.lead), 'answer should open with the domain lead');
  assert.ok(ans.answer.endsWith(DOMAINS.legal.footer), 'answer should close with the domain footer');
  kb.close();
});

test('per-domain fallback phrasing shows on empty retrieval', async () => {
  const kb = freshKb();
  const ans = kb.answer('完全不存在的问题', { domain: 'medical' });
  assert.strictEqual(ans.domain, 'medical');
  assert.strictEqual(ans.top, null);
  assert.strictEqual(ans.answer, DOMAINS.medical.fallback);
  kb.close();
});

test('domain mismatch between stored text and preset still anchors correctly', async () => {
  const kb = freshKb();
  await kb.ingestBuffer('d.md', Buffer.from('律师咨询费按每小时 300 元收取。'));
  // query the legal-flavored content under the medical preset: phrasing comes
  // from the requested domain even when the corpus mentions legal topics
  const ans = kb.answer('律师咨询费怎么收取', { domain: 'medical' });
  assert.strictEqual(ans.domain, 'medical');
  assert.ok(ans.answer.startsWith(DOMAINS.medical.lead), 'lead from requested domain');
  assert.ok(ans.answer.endsWith(DOMAINS.medical.footer), 'footer from requested domain');
  assert.ok(ans.answer.includes('300 元'), 'hit content still included');
  kb.close();
});
