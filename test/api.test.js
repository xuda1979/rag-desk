'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const { KnowledgeBase } = require('../src/lib/knowledge');
const { buildApp } = require('../src/app');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-api-'));
  return path.join(dir, 'app.db');
}

async function startServer(overrides = {}) {
  const kb = new KnowledgeBase(freshDb());
  // Explicitly disable security for these baseline tests so they are immune
  // to a developer/CI environment that has RAGDESK_* vars set.
  const app = buildApp(kb, { adminToken: '', chatToken: '', allowOrigin: '', ...overrides });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  return { kb, server, port };
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http
      .get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { accept: 'application/json' } }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let body = out;
          try {
            body = JSON.parse(out);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      })
      .on('error', reject);
  });
}

test('server-side: /api/chat returns offline answer with citation after ingest', async () => {
  const { kb, server, port } = await startServer();
  await kb.ingestBuffer('q.md', Buffer.from('本诊所工作日 8:00 开门，周六日 9:00 开门。预约电话 010-12345678。'));
  const res = await post(`http://localhost:${port}/api/chat`, { query: '诊所以什么时间开门' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.mode, 'offline-retrieval');
  assert.strictEqual(res.body.llm, false);
  assert.ok(res.body.top && res.body.top.document === 'q.md', 'citation should name the doc');
  assert.match(res.body.answer, /8:00/);
  // chat logs the query (AC6)
  const logs = await get(`http://localhost:${port}/api/admin/logs`);
  assert.strictEqual(logs.body.logs.length, 1);
  assert.strictEqual(logs.body.logs[0].query, '诊所以什么时间开门');
  server.close();
  kb.close();
});

test('server-side: /api/chat 400 on empty query', async () => {
  const { kb, server, port } = await startServer();
  // demo.js always sends a query, but a broken embed/curl could send an empty
  // body or an explicit empty string; both must surface the exact same stable
  // JSON 400 the UIs render, no blank-hit fallback and no HTML.
  try {
    for (const payload of [{}, { query: '' }, { query: '   ' }]) {
      const res = await post(`http://localhost:${port}/api/chat`, payload);
      assert.strictEqual(res.status, 400, `payload ${JSON.stringify(payload)} must 400`);
      assert.deepStrictEqual(res.body, { error: 'query is required' }, 'blank queries share one literal 400 body');
    }
    // nothing was logged for a rejected query
    const stats = await get(`http://localhost:${port}/api/admin/stats`);
    assert.deepStrictEqual(stats.body.stats, { total: 0, with_answer: 0 }, 'rejected queries are not counted');
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: /api/chat rejects whitespace-only queries and trims padded ones', async () => {
  const { kb, server, port } = await startServer();
  try {
    // app.js guards with !String(query).trim(); a whitespace-only string must
    // surface the same stable JSON 400 as a missing query, not an empty hit.
    const blank = await post(`http://localhost:${port}/api/chat`, { query: '   ' });
    assert.strictEqual(blank.status, 400);
    assert.strictEqual(blank.body.error, 'query is required');

    // a padded query is trimmed before answering and logged trimmed, so the
    // demo UI's submitted value round-trips cleanly and logs stay comparable.
    await kb.ingestBuffer('q.md', Buffer.from('本诊所工作日 8:00 开门，周六日 9:00 开门。'));
    const padded = await post(`http://localhost:${port}/api/chat`, { query: '  诊所以什么时间开门  ' });
    assert.strictEqual(padded.status, 200);
    assert.strictEqual(padded.body.query, '诊所以什么时间开门', 'response echoes the trimmed query');
    assert.strictEqual(padded.body.top.document, 'q.md', 'trimmed query still hits the doc');
    const logs = await get(`http://localhost:${port}/api/admin/logs`);
    assert.strictEqual(logs.body.logs.length, 1);
    assert.strictEqual(logs.body.logs[0].query, '诊所以什么时间开门', 'log stores the trimmed query');
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: /api/chat is FTS-safe on the wire — punctuation-laden queries hit, pure-noise queries miss gracefully', async () => {
  const { kb, server, port } = await startServer();
  // Unit tests pin searchRaw() against quotes/noise; this locks the SAME
  // contract through the route. Quotes/parens/question marks are tokenizer
  // delimiters (never FTS5 MATCH syntax), so a quoted CJK query must hit; a
  // query that is ALL punctuation tokenizes to nothing (toQuery -> '' ->
  // empty retrieval), and the route must answer the stable domain fallback
  // miss — never a 400/500. The body is fully deterministic, so it is locked
  // verbatim (same literal shape the full-payload test asserts).
  try {
    await kb.ingestBuffer('p.md', Buffer.from('合同纠纷在被告住所地人民法院起诉，诉讼时效三年。客服电话 400-123-4567。'));

    const quoted = await post(`http://localhost:${port}/api/chat`, { query: '"合同纠纷"' });
    assert.strictEqual(quoted.status, 200, 'a quoted CJK query must be answered, not rejected');
    assert.strictEqual(quoted.body.top.document, 'p.md', 'quotes must be stripped to tokenizer terms, not FTS syntax');
    assert.ok(quoted.body.citations.length >= 1);
    assert.ok(quoted.body.answer.includes(quoted.body.citations[0].excerpt));

    const punct = await post(`http://localhost:${port}/api/chat`, { query: '截止时间???' });
    assert.strictEqual(punct.status, 200, 'trailing punctuation must not 500 the route');

    const noise = await post(`http://localhost:${port}/api/chat`, { query: '***' });
    assert.strictEqual(noise.status, 200, 'an all-punctuation query is a graceful miss, not an error');
    assert.deepStrictEqual(noise.body, {
      answer: '抱歉，知识库中没有找到相关内容。',
      mode: 'offline-retrieval',
      llm: false,
      domain: 'general',
      confidence: 0,
      citations: [],
      top: null,
      query: '***',
    }, 'pure-noise query returns the exact stable fallback miss');
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: /api/chat coerces non-string queries and 400s falsy ones', async () => {
  const { kb, server, port } = await startServer();
  // JSON clients may send numbers/bools for query; the guard tests the raw
  // value's truthiness (falsy -> the exact blank 400) while truthy values are
  // answered and echoed in string form.
  try {
    const num = await post(`http://localhost:${port}/api/chat`, { query: 123 });
    assert.strictEqual(num.status, 200);
    assert.strictEqual(num.body.query, '123', 'numeric query must be answered and echoed as its string form');

    const bool = await post(`http://localhost:${port}/api/chat`, { query: true });
    assert.strictEqual(bool.status, 200);
    assert.strictEqual(bool.body.query, 'true', 'boolean query must be answered and echoed as its string form');

    // falsy non-string values share the exact blank-query 400 (guard is !query)
    for (const payload of [{ query: 0 }, { query: false }, { query: null }]) {
      const res = await post(`http://localhost:${port}/api/chat`, payload);
      assert.strictEqual(res.status, 400, `payload ${JSON.stringify(payload)} must 400`);
      assert.deepStrictEqual(res.body, { error: 'query is required' });
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: /api/chat never 500s on top-level non-object JSON bodies — primitives are parser errors, arrays are blank 400s', async () => {
  const { kb, server, port } = await startServer();
  // express.json() runs in strict mode: a top-level primitive (null/false/0/
  // string/number) is rejected by the PARSER itself with its own 400 message,
  // while a top-level ARRAY passes strict mode and falls through to the route,
  // where the missing query surfaces the shared blank-query 400. Both classes
  // must stay stable JSON 400s (never a destructuring 500), and neither may be
  // logged or counted. The existing malformed-JSON test covers syntax errors
  // ('{bad json'); this locks the strict-mode primitive branch + the array
  // branch that syntax-error tests cannot reach.
  const sendJson = (rawJson, origin) =>
    new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawJson) };
      if (origin) headers.Origin = origin;
      const req = http.request(
        { host: 'localhost', port, path: '/api/chat', method: 'POST', headers },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              body: JSON.parse(out || '{}'),
              acao: r.headers['access-control-allow-origin'],
            })
          );
        }
      );
      req.on('error', reject);
      req.write(rawJson);
      req.end();
    });
  try {
    // 1. top-level primitives are parser-level (strict-mode) rejections
    for (const rawJson of ['null', 'false', '0', '""', '"abc"', '123', 'true']) {
      const r = await sendJson(rawJson, 'https://customer.example');
      assert.strictEqual(r.status, 400, `bare ${rawJson} must be rejected before the route, not 500`);
      assert.match(r.body.error, /Unexpected token/, 'strict-mode primitive rejection surfaces the parser message');
      assert.strictEqual(r.acao, 'https://customer.example', 'CORS header rides on the strict-mode parser error too');
    }
    // 2. top-level arrays pass strict mode and hit the route blank-query guard
    for (const rawJson of ['[]', '[1]', '[{"query":"x"}]']) {
      const r = await sendJson(rawJson);
      assert.strictEqual(r.status, 400, `bare ${rawJson} must 400, not 500`);
      assert.deepStrictEqual(r.body, { error: 'query is required' }, 'array bodies share the exact shared 400 literal');
    }
    // 3. nothing was logged or counted for any rejected body
    const stats = await get(`http://localhost:${port}/api/admin/stats`);
    assert.deepStrictEqual(stats.body.stats, { total: 0, with_answer: 0 }, 'rejected non-object bodies are not counted');
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: /api/chat accepts x-www-form-urlencoded bodies (urlencoded middleware)', async () => {
  // express.urlencoded({ extended: false }) is a common consumer-client
  // encoding (plain form posts); the chat route must parse it exactly like
  // JSON: valid queries answered, blank/empty exact 400s, domain honored.
  const { kb, server, port } = await startServer();
  const form = (payload) =>
    new Promise((resolve, reject) => {
      const u = new URL(`http://localhost:${port}/api/chat`);
      const data = Object.entries(payload)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
        (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  try {
    await kb.ingestBuffer('legal.md', Buffer.from('律师咨询费按每小时 300 元收取，首次咨询免费。'));

    // valid urlencoded query is answered exactly like a JSON one
    const ok = await form({ query: '咨询费怎么收' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.query, '咨询费怎么收');
    assert.ok(ok.body.citations.length > 0, 'urlencoded query must hit the ingested doc');
    assert.match(ok.body.answer, /300/);

    // blank urlencoded query -> the exact shared blank-query 400
    const blank = await form({ query: '   ' });
    assert.strictEqual(blank.status, 400);
    assert.deepStrictEqual(blank.body, { error: 'query is required' });

    // empty urlencoded body (no fields at all) -> same exact 400
    const empty = await form({});
    assert.strictEqual(empty.status, 400);
    assert.deepStrictEqual(empty.body, { error: 'query is required' });

    // domain field is honored through the urlencoded parser too
    const selected = await form({ query: '咨询费怎么收', domain: 'legal' });
    assert.strictEqual(selected.status, 200);
    assert.strictEqual(selected.body.domain, 'legal', 'urlencoded domain must be echoed on the wire');
    assert.ok(selected.body.answer.startsWith('根据律所知识库'), 'urlencoded domain must drive the answer phrasing');
  } finally {
    server.close();
    kb.close();
  }
});

test('non-JSON or absent Content-Type bodies never reach the parser — /api/chat 400s query-is-required instead of reading a false body', async () => {
  const { kb, server, port } = await startServer();
  // Nothing parses body bytes without a JSON/urlencoded Content-Type (express
  // only feeds req.body for the parsers it has registered). A client that posts
  // raw bytes or forgets the header must therefore 400 on the handler's own
  // check rather than silently answering with query from an unpiped buffer; a
  // rewire of the parsers must keep req.body undefined for these, not start
  // scraping text/plain into it.
  const sendRaw = (contentType, bytes) =>
    new Promise((resolve, reject) => {
      const u = new URL(`http://localhost:${port}/api/chat`);
      const headers = { 'Content-Length': bytes.length };
      if (contentType !== null) headers['Content-Type'] = contentType;
      const req = http.request(
        { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
        (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], body: out }));
        }
      );
      req.on('error', reject);
      req.write(bytes);
      req.end();
    });
  try {
    await kb.ingestBuffer('legal.md', Buffer.from('律师咨询费按每小时 300 元收取，首次咨询免费。'));
    const jsonBytes = Buffer.from('{"query":"咨询费怎么收"}');
    const formBytes = Buffer.from('query=%E5%92%A8%E8%AF%A2%E8%B4%B9%E6%80%8E%E4%B9%88%E6%94%B6');

    // no Content-Type header at all: body stays unparsed, handler sees no query
    const noCt = await sendRaw(null, jsonBytes);
    assert.strictEqual(noCt.status, 400);
    assert.deepStrictEqual(JSON.parse(noCt.body), { error: 'query is required' });
    assert.match(noCt.ct, /^application\/json/, 'the handler 400 must itself be JSON');

    // text/plain with JSON-looking bytes: same unparsed 400, never a 200 answer
    const plainJson = await sendRaw('text/plain', jsonBytes);
    assert.strictEqual(plainJson.status, 400);
    assert.deepStrictEqual(JSON.parse(plainJson.body), { error: 'query is required' });

    // text/plain with urlencoded-looking bytes: also unparsed, same 400
    const plainForm = await sendRaw('text/plain', formBytes);
    assert.strictEqual(plainForm.status, 400);
    assert.deepStrictEqual(JSON.parse(plainForm.body), { error: 'query is required' });

    // control: the same query under the real JSON content type answers fine
    const ctrl = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收' });
    assert.strictEqual(ctrl.status, 200);
    assert.strictEqual(ctrl.body.query, '咨询费怎么收');
    assert.ok(ctrl.body.citations.length > 0, 'control JSON query must hit the ingested doc');
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: unknown domain falls back to general preset', async () => {
  const { kb, server, port } = await startServer();
  const unknown = await post(`http://localhost:${port}/api/chat`, { query: 'xyz', domain: 'slackbot' });
  const omitted = await post(`http://localhost:${port}/api/chat`, { query: 'xyz' });
  assert.strictEqual(unknown.status, 200);
  assert.strictEqual(unknown.body.domain, 'general');
  assert.strictEqual(unknown.body.answer, omitted.body.answer, 'same fallback as omitted domain');
  server.close();
  kb.close();
});

test('server-side: /api/chat coerces non-string domain values to general instead of crashing', async () => {
  const { kb, server, port } = await startServer();
  // query and limit already have coercion locks, but domain is the last input
  // dimension: a JSON client may send numbers/bools/objects and the route must
  // reach getDomain() (DOMAINS[id] || general) without a 500. Values that
  // stringify to no known preset degrade to general; the miss phrase must prove
  // the general preset actually drove the answer, not just the echoed id.
  // Empty corpus + ASCII query = deterministic miss.
  try {
    for (const domain of [null, 123, true, {}, [], 0, 'no-such-domain']) {
      const miss = await post(`http://localhost:${port}/api/chat`, { query: 'qqqzzz xxx', domain });
      assert.strictEqual(miss.status, 200, `domain ${JSON.stringify(domain)} must not crash the engine`);
      assert.strictEqual(miss.body.domain, 'general', `domain ${JSON.stringify(domain)} must degrade to general`);
      assert.strictEqual(
        miss.body.answer,
        '抱歉，知识库中没有找到相关内容。',
        `domain ${JSON.stringify(domain)} must phrase with the general fallback`
      );
    }

    // a non-string value that String()-coerces to a real preset id is honored,
    // pinning the DOMAINS[id] lookup (not a typeof guard) as the contract
    const arr = await post(`http://localhost:${port}/api/chat`, { query: 'qqqzzz xxx', domain: ['legal'] });
    assert.strictEqual(arr.status, 200);
    assert.strictEqual(arr.body.domain, 'legal', '["legal"] coerces via String() to the "legal" preset id');
    assert.ok(
      arr.body.answer.startsWith('抱歉，我在知识库中暂未找到'),
      '["legal"] must phrase with the legal fallback, proving the preset was honored'
    );
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: /api/chat domain ids match exactly — no trim, no case-fold; empty/whitespace degrade to general', async () => {
  const { kb, server, port } = await startServer();
  // The coercion test above locks JSON-type degradation; this one pins the
  // LOOKUP semantics: getDomain(id) is an exact-match on the preset id. A
  // "friendlier" client sending "legal "/"LEGAL" must NOT be silently mapped —
  // the demo page sends domainSelect.value verbatim and relies on the echo, so
  // any future trim/lowercase normalization would change the wire contract.
  // Empty corpus + ASCII query = deterministic miss so the domain id and its
  // stringified value are the only variables.
  try {
    const degrade = async (domain, note) => {
      const res = await post(`http://localhost:${port}/api/chat`, { query: 'qqqzzz xxx', domain });
      assert.strictEqual(res.status, 200, note);
      assert.strictEqual(res.body.domain, 'general', `${note}: echoed id must degrade to general`);
      assert.strictEqual(res.body.answer, '抱歉，知识库中没有找到相关内容。', `${note}: must phrase with the general fallback`);
    };
    // whitespace variants prove the id lookup does not trim
    await degrade('', 'empty-string domain must degrade to general');
    await degrade('   ', 'whitespace-only domain must degrade to general');
    await degrade('legal ', 'trailing-space domain must not be trimmed to legal');
    await degrade(' LEGAL', 'leading-space mixed-case must not match legal');
    // a multi-element array String()-coerces to "legal,general" -> no preset
    await degrade(['legal', 'general'], 'multi-element array must degrade (String() join is not a preset id)');
    await degrade(42, 'number 42 must degrade to general');
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: a valid domain selection is honored in the answer phrasing on the wire', async () => {
  const { kb, server, port } = await startServer();
  // demo.js always sends domainSelect.value (default 'general') with every
  // chat request; the server must phrase the answer per the SELECTED preset
  // and echo the id back, not silently force the general preset.
  try {
    await kb.ingestBuffer('legal.md', Buffer.from('律师咨询费按每小时 300 元收取，首次咨询免费。'));
    const selected = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收', domain: 'legal' });
    assert.strictEqual(selected.status, 200);
    assert.ok(selected.body.citations.length > 0, 'query must hit the ingested doc');
    assert.strictEqual(selected.body.domain, 'legal', 'selected domain must be echoed on the wire');
    assert.ok(
      selected.body.answer.startsWith('根据律所知识库'),
      'answer should open with the legal preset lead'
    );

    const general = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收', domain: 'general' });
    assert.strictEqual(general.status, 200);
    assert.strictEqual(general.body.domain, 'general');
    assert.ok(
      general.body.answer.startsWith('以下是知识库中'),
      'general preset must use its own lead, distinct from legal'
    );
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: a chat miss returns the selected domain\'s own fallback phrase on the wire', async () => {
  const { kb, server, port } = await startServer();
  // Each domain preset ships a distinct no-result phrase (src/lib/domains.js).
  // The retrieval-miss path must surface the SELECTED preset's fallback, not
  // always the general one — demo.js sends domainSelect.value on every chat
  // request, so a missed query under a domain page would otherwise leak the
  // generic phrasing. ASCII-only queries tokenize to a Latin run that cannot
  // match the ingested Chinese doc, guaranteeing a miss.
  try {
    await kb.ingestBuffer('legal.md', Buffer.from('律师咨询费按每小时 300 元收取，首次咨询免费。'));
    const cases = [
      ['legal', '抱歉，我在知识库中暂未找到与您问题直接相关的内容。您可以换个问法，或咨询前台获取人工帮助。'],
      ['medical', '很抱歉，目前的知识库中还没有相关内容。您可以致电诊所前台，或描述得更具体一些。'],
      ['procurement', '抱歉，我还没有检索到相关的公告内容。您可以提供项目名称关键词，我再帮您查找。'],
    ];
    for (const [domain, fallback] of cases) {
      const res = await post(`http://localhost:${port}/api/chat`, { query: 'abxqzz', domain });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, {
        answer: fallback,
        mode: 'offline-retrieval',
        llm: false,
        domain,
        confidence: 0,
        citations: [],
        top: null,
        query: 'abxqzz',
      }, `${domain} miss must return its own fallback phrase, not the general one`);
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: a chat HIT is phrased with the selected domain\'s own lead and footer on the wire', async () => {
  const { kb, server, port } = await startServer();
  // demo.js renders the answer verbatim on every chat request, so a hit under a
  // domain page must carry THAT domain's lead/footer, not the general ones.
  // Only the general (and legal lead) phrasing is pinned today; the medical and
  // procurement lead/footer composition has zero wire locks.
  try {
    await kb.ingestBuffer('clinic.md', Buffer.from('本诊所工作日 8:00 开门，周六日 9:00 开门。预约电话 010-1234。'));
    const leads = {
      legal: '根据律所知识库，下面是一段与您问题直接相关的原文片段：',
      medical: '根据诊所资料，以下是与您关心问题相关的原文内容：',
      procurement: '根据发布的公告原文，相关要点如下：',
    };
    const footers = {
      legal: '（以上回答基于律所公开资料整理，如有紧急法律问题请咨询执业律师。）',
      medical: '（以上内容仅供参考，不能替代医生当面诊断。）',
      procurement: '（公告信息以官方发布文件为准。）',
    };
    for (const [domain, lead] of Object.entries(leads)) {
      const res = await post(`http://localhost:${port}/api/chat`, { query: '几点开门', domain });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.domain, domain, 'selected domain must be echoed on the wire');
      assert.ok(res.body.citations.length > 0, `${domain} hit must retrieve the ingested doc`);
      assert.deepStrictEqual(
        res.body,
        kb.answer('几点开门', { domain, limit: 3 }),
        'the route must forward the domain-phrased engine answer unchanged'
      );
      assert.ok(res.body.answer.startsWith(lead), `${domain} hit must open with its own lead, not the general one`);
      assert.ok(
        res.body.answer.includes(footers[domain]),
        `${domain} hit must close with its own footer, not the general one`
      );
      assert.ok(res.body.answer.includes(res.body.citations[0].excerpt), 'answer embeds the cited excerpt');
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: /api/health reports the full offline engine payload', async () => {
  const { kb, server, port } = await startServer();
  try {
    const res = await get(`http://localhost:${port}/api/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      ok: true,
      engine: {
        fts: true,
        bm25: true,
        embedding: false,
        llm: false,
        tokenizer: 'bigram-cjk + unicode61',
        // the live db path, so operators can tell which store the running
        // instance actually serves (locked at the engine level too)
        storage: kb.storage.dbPath,
      },
      domains: ['legal', 'medical', 'procurement', 'general'],
      mode: 'offline',
      llmEnabled: false,
    });
  } finally {
    server.close();
    kb.close();
  }
});

test('server-side: oversized JSON request body maps to 413 JSON error, not HTML', async () => {
  const { kb, server, port } = await startServer();
  const huge = 'x'.repeat(2 * 1024 * 1024 + 100);
  const big = JSON.stringify({ query: huge, domain: 'legal' });
  const res = await new Promise((resolve, reject) => {
    const u = new URL(`http://localhost:${port}/api/chat`);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(big) },
      },
      (resp) => {
        let out = '';
        resp.on('data', (c) => (out += c));
        resp.on('end', () => {
          try {
            resolve({ status: resp.statusCode, body: JSON.parse(out) });
          } catch (_) {
            reject(new Error(`non-JSON body: ${out.slice(0, 80)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(big);
    req.end();
  });
  assert.strictEqual(res.status, 413, 'entity.too.large maps to 413');
  assert.match(res.body.error, /request body too large/);
  server.close();
  kb.close();
});

test('admin upload endpoint indexes a buffered doc (AC5)', async () => {
  const { kb, server, port } = await startServer();
  const boundary = '----rd-b';
  const content = Buffer.from('关于新设备采购的中标通知，中标人蓝天科技公司。');
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="notice.md"\r\nContent-Type: text/markdown\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/admin/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.results[0].action, 'indexed');
  // retrieval against a query on this new doc (AC5: upload -> index -> ask)
  const chat = await post(`http://localhost:${port}/api/chat`, { query: '中标人是谁' });
  assert.strictEqual(chat.body.top.document, 'notice.md');
  server.close();
  kb.close();
});

test('admin chunk listing: /api/admin/docs/:id returns chunks (view index)', async () => {
  const { kb, server, port } = await startServer();
  await kb.ingestBuffer('guide.md', Buffer.from('疫苗接种时间每周二、周四、周六上午，请携带预防接种证提前预约。'));
  const doc = kb.getAllDocs()[0];

  const miss = await get(`http://localhost:${port}/api/admin/docs/9999`);
  assert.strictEqual(miss.status, 404);
  assert.strictEqual(miss.body.error, 'not found', 'missing doc GET must be a JSON 404 with the stable body');

  const res = await get(`http://localhost:${port}/api/admin/docs/${doc.id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.doc.id, doc.id);
  assert.strictEqual(res.body.doc.filename, 'guide.md');
  assert.ok(Array.isArray(res.body.chunks));
  assert.ok(res.body.chunks.length >= 1);
  assert.strictEqual(res.body.chunks[0].chunk_idx, 1);
  assert.match(res.body.chunks[0].body, /疫苗接种/);
  server.close();
  kb.close();
});

test('multi-chunk doc: /api/admin/docs/:id lists chunks with contiguous ascending 1-based indexes', async () => {
  const { kb, server, port } = await startServer();
  try {
    // A single no-newline run longer than the 400-char window yields several
    // overlapping chunks; ordering there is the strongest chunk-listing contract.
    const text = '本诊所工作日八点开门，预约电话零一零八八八八。'.repeat(60);
    await kb.ingestBuffer('long.md', Buffer.from(text));
    const doc = kb.getAllDocs()[0];

    const res = await get(`http://localhost:${port}/api/admin/docs/${doc.id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.doc.filename, 'long.md');
    assert.ok(res.body.chunks.length >= 2, 'expected a genuinely multi-chunk doc');
    assert.deepStrictEqual(
      res.body.chunks.map((c) => c.chunk_idx),
      [...Array(res.body.chunks.length)].map((_, i) => i + 1),
      'chunk indexes must be 1-based, ascending, and gap-free'
    );
    for (const c of res.body.chunks) assert.ok(c.body.length > 0, 'no empty chunk bodies');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload endpoint rejects an empty file (no 0-chunk docs)', async () => {
  const { kb, server, port } = await startServer();
  const boundary = '----rd-empty';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="empty.md"\r\nContent-Type: text/markdown\r\n\r\n`
    ),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/admin/upload',
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      },
      (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.results[0].action, 'error');
  // nothing was persisted
  const docs = await get(`http://localhost:${port}/api/admin/docs`);
  assert.strictEqual(docs.body.docs.length, 0);
  server.close();
  kb.close();
});

test('admin upload of whitespace-only text yields the exact empty-content per-file error', async () => {
  // A supported-extension file whose text is non-empty but trims to zero
  // chunks must produce the 文件内容为空 error (chunkText trims its input).
  // distinct from the truly-empty-buffer case: the extractor hands back a
  // non-empty string here, so only the chunker's trim can reject it.
  const { kb, server, port } = await startServer();
  const boundary = '----rd-ws';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="blank.txt"\r\nContent-Type: text/plain\r\n\r\n  \n \t \n  \r\n`
    ),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    // 200 with a per-file error result, not a 4xx: upload is per-file results
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, [
      { filename: 'blank.txt', action: 'error', error: '文件内容为空，无法索引: blank.txt' },
    ]);
    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.body.docs.length, 0, 'nothing may be persisted for an empty-content upload');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload endpoint reports per-file results for a mixed batch', async () => {
  const { kb, server, port } = await startServer();
  const boundary = '----rd-mix';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="good.md"\r\nContent-Type: text/markdown\r\n\r\n律师咨询费按小时计费。\r\n`
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="bad.xyz"\r\nContent-Type: application/octet-stream\r\n\r\nnope\r\n`
    ),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/admin/upload',
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      },
      (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.results.length, 2, 'one result per uploaded file');
  const byName = Object.fromEntries(res.body.results.map((r) => [r.filename, r]));
  assert.strictEqual(byName['good.md'].action, 'indexed');
  assert.strictEqual(byName['good.md'].docId, 1, 'indexed result carries the stable doc id');
  assert.strictEqual(byName['good.md'].chunks, 1, 'indexed result reports the chunk count admin.js renders');
  assert.strictEqual(byName['bad.xyz'].action, 'error');
  assert.match(byName['bad.xyz'].error, /不支持的文件类型/);
  const docs = await get(`http://localhost:${port}/api/admin/docs`);
  assert.strictEqual(docs.body.docs.length, 1, 'only the indexable file is persisted');
  const ans = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收' });
  assert.strictEqual(ans.body.top.document, 'good.md', 'good file is retrievable after mixed upload');
  server.close();
  kb.close();
});

test('admin upload keeps a UTF-8 Chinese filename from multipart to docs list and chat citation', async () => {
  const { kb, server, port } = await startServer();
  // Chinese-language product: multer must hand the UTF-8 originalname through to
  // storage and back onto the wire without mojibake, in the upload result, the
  // admin docs list, and the chat citation the frontends render.
  const boundary = '----rd-utf8';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="诊所公告.md"\r\nContent-Type: text/markdown\r\n\r\n诊所公告：本周五劳动节放假一天，门诊时间调整为上午八点到十一点，请提前预约。\r\n`
    ),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results[0].filename, '诊所公告.md', 'upload result keeps the UTF-8 filename');
    assert.strictEqual(res.body.results[0].action, 'indexed');
    assert.strictEqual(res.body.results[0].docId, 1);

    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.body.docs[0].filename, '诊所公告.md', 'docs list shows the UTF-8 filename');

    const ans = await post(`http://localhost:${port}/api/chat`, { query: '诊所放假怎么安排' });
    assert.strictEqual(ans.body.top.document, '诊所公告.md', 'chat citation carries the UTF-8 filename');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload endpoint reports duplicate when the same bytes are re-uploaded', async () => {
  const { kb, server, port } = await startServer();
  // admin.js renders action==='duplicate' as 已存在跳过; the dedup keys on the
  // file sha256, so re-uploading the same bytes must report it at the wire.
  const contents = 'nullam_tempus_duopoints 律师事务所收费标准按小时计费，先签合同后服务。';
  const boundary = '----rd-dup';
  const part = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="fee.md"\r\nContent-Type: text/markdown\r\n\r\n${contents}\r\n`
  );
  const firstBody = Buffer.concat([part, Buffer.from(`--${boundary}--\r\n`)]);
  const secondBody = Buffer.concat([part, Buffer.from(`--${boundary}--\r\n`)]);
  try {
    const upload = (body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: 'localhost',
            port,
            path: '/api/admin/upload',
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
          },
          (r) => {
            let out = '';
            r.on('data', (c) => (out += c));
            r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

    const first = await upload(firstBody);
    assert.strictEqual(first.status, 200);
    const r1 = first.body.results[0];
    assert.strictEqual(r1.action, 'indexed');
    assert.strictEqual(typeof r1.docId, 'number');

    const second = await upload(secondBody);
    assert.strictEqual(second.status, 200);
    const r2 = second.body.results[0];
    assert.strictEqual(r2.action, 'duplicate', 're-upload of identical bytes must report duplicate');
    assert.strictEqual(r2.docId, r1.docId, 'duplicate must point at the original doc, not a new one');

    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.body.docs.length, 1, 'repeat upload must not add a second row');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload endpoint ingests PDF/DOCX/CSV fixtures end-to-end', async () => {
  const { kb, server, port } = await startServer();
  const boundary = '----rd-ext';
  const files = [
    ['law-services.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['clinic-guide.pdf', 'application/pdf'],
    ['faq-transfer.csv', 'text/csv'],
  ];
  const parts = files.map(([name, mime]) => {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'corpus', name));
    return Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`
      ),
      buf,
      Buffer.from('\r\n'),
    ]);
  });
  const body = Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/admin/upload',
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      },
      (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => {
          try {
            resolve({ status: r.statusCode, body: JSON.parse(out) });
          } catch (_) {
            reject(new Error(`non-JSON upload response: ${out.slice(0, 80)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.results.length, 3, 'one result per uploaded file');
  for (const r of res.body.results) {
    assert.strictEqual(r.action, 'indexed', `${r.filename} should index`);
  }

  const docs = await get(`http://localhost:${port}/api/admin/docs`);
  assert.strictEqual(docs.body.docs.length, 3, 'all three formats persist to the admin list');

  // each upload is retrievable by a query that only appears in that file
  const csv = await post(`http://localhost:${port}/api/chat`, { query: '工伤认定要什么材料' });
  assert.strictEqual(csv.body.top.document, 'faq-transfer.csv', 'CSV FAQ retrievable after upload');
  const docx = await post(`http://localhost:${port}/api/chat`, { query: '常年法律顾问' });
  assert.strictEqual(docx.body.top.document, 'law-services.docx', 'DOCX retrievable after upload');
  const pdf = await post(`http://localhost:${port}/api/chat`, { query: '预约方式' });
  assert.strictEqual(pdf.body.top.document, 'clinic-guide.pdf', 'PDF retrievable after upload');
  server.close();
  kb.close();
});

test('admin docs list orders newest first by descending id, matching the admin table render', async () => {
  const { kb, server, port } = await startServer();
  try {
    // seed three docs in a known sequence so id order is unambiguous
    await kb.ingestBuffer('a.md', Buffer.from('第一份文档内容。'));
    await kb.ingestBuffer('b.md', Buffer.from('第二份文档内容。'));
    await kb.ingestBuffer('c.md', Buffer.from('第三份文档内容。'));

    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    const names = docs.body.docs.map((d) => d.filename);
    const ids = docs.body.docs.map((d) => d.id);
    assert.strictEqual(docs.body.docs.length, 3);
    assert.deepStrictEqual(ids, [3, 2, 1], 'newest upload first, strongest ordering contract');
    assert.deepStrictEqual(names, ['c.md', 'b.md', 'a.md'], 'admin table renders top-down from this list');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload endpoint rejects an unsupported file type', async () => {
  const { kb, server, port } = await startServer();
  const boundary = '----rd-type';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="malware.exe"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ),
    Buffer.from('MZ this is not a document'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/admin/upload',
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      },
      (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.results[0].action, 'error');
  assert.match(res.body.results[0].error, /不支持的文件类型/);
  // nothing was persisted
  const docs = await get(`http://localhost:${port}/api/admin/docs`);
  assert.strictEqual(docs.body.docs.length, 0);
  server.close();
  kb.close();
});

test('admin upload endpoint rejects more than 20 files with a 400', async () => {
  const { kb, server, port } = await startServer();
  const boundary = '----rd-many';
  const chunks = [];
  for (let i = 0; i < 21; i++) {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="f${i}.txt"\r\nContent-Type: text/plain\r\n\r\nhello ${i}\r\n`
    );
  }
  chunks.push(`--${boundary}--\r\n`);
  const body = Buffer.from(chunks.join(''));
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/admin/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => {
          let parsed = out;
          try {
            parsed = JSON.parse(out);
          } catch (_) {}
          resolve({ status: r.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /max 20/);
  server.close();
  kb.close();
});

test('admin upload reads only the exact "files" multipart field — a wrong field name 400s and indexes nothing', async () => {
  const { kb, server, port } = await startServer();
  // upload.array('files', 20) (src/app.js) is the only wire identity for the
  // file part: every prior multipart test posts name="files" — the same literal
  // the route compares against — so a rename of the field would stay green
  // while admin.js (which appends "files", public/admin.js) and the server
  // silently disagree. multer aborts on the FIRST unexpected field
  // (LIMIT_UNEXPECTED_FILE), which the central handler maps to a stable 400
  // even when the payload is a single perfectly valid document; no bytes may
  // be indexed.
  const postOne = (fieldName) => {
    const boundary = '----rd-field';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="ok.md"\r\nContent-Type: text/markdown\r\n\r\n`),
      Buffer.from('律师咨询费按小时计费，多退少补并开具发票。'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out || '{}') }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };
  try {
    // discriminating wrong names: singular "file" (the natural mistake an
    // integrator would make) and "documents" (a plausible alternative). Each
    // must hit the exact unexpected-field 400 with zero persistence.
    for (const name of ['file', 'documents']) {
      const res = await postOne(name);
      assert.strictEqual(res.status, 400, `field ${JSON.stringify(name)} must 400 on the unexpected-field branch`);
      assert.deepStrictEqual(
        res.body,
        { error: 'too many files (max 20 per upload)' },
        `field ${JSON.stringify(name)} maps to the exact multer message`
      );
      assert.deepStrictEqual(await kb.getAllDocs(), [], `field ${JSON.stringify(name)} must not index anything`);
    }
    // the exact field name still ingests, proving the 400s were about the key
    const ok = await postOne('files');
    assert.strictEqual(ok.status, 200, 'the exact "files" field still ingests');
    assert.strictEqual(ok.body.results[0].action, 'indexed');
    assert.deepStrictEqual((await kb.getAllDocs()).map((d) => d.filename), ['ok.md']);
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload endpoint rejects a file over the 50MB multer cap with the 413 JSON branch', async () => {
  const { kb, server, port } = await startServer();
  const boundary = '----rd-oversize';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="huge.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  // One byte past the 50MB multer limit (src/app.js) so the streaming upload
  // aborts with LIMIT_FILE_SIZE before any ingest can happen.
  const payload = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61);
  const body = Buffer.concat([Buffer.from(head), payload, Buffer.from(tail)]);
  try {
    const res = await new Promise((resolve, reject) => {
      let done = false;
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => {
            done = true;
            let parsed = out;
            try {
              parsed = JSON.parse(out);
            } catch (_) {}
            resolve({ status: r.statusCode, body: parsed });
          });
        }
      );
      // The server aborts the stream mid-upload, so the client socket may
      // reset after the 413 response is already received — never reject then.
      req.on('error', (e) => {
        if (!done) reject(e);
      });
      req.write(body);
      req.end();
    });
    assert.strictEqual(res.status, 413, 'LIMIT_FILE_SIZE maps to 413');
    assert.match(res.body.error, /file too large \(max 50MB\)/);
    assert.deepStrictEqual(kb.getAllDocs(), [], 'no ingest happens for the rejected file');
  } finally {
    server.close();
    kb.close();
  }
});

test('DELETE of a missing document returns 404', async () => {
  const { kb, server, port } = await startServer();
  const res = await new Promise((resolve, reject) => {
    http
      .request({ host: 'localhost', port, path: '/api/admin/docs/99999', method: 'DELETE' }, (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => {
          try {
            resolve({ status: r.statusCode, body: JSON.parse(out) });
          } catch (_) {
            resolve({ status: r.statusCode, body: out });
          }
        });
      })
      .on('error', reject)
      .end();
  });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'not found', 'missing doc DELETE must be a JSON 404 with the stable body');
  server.close();
  kb.close();
});

test('non-numeric doc id returns JSON 404, never a 500', async () => {
  const { kb, server, port } = await startServer();
  await kb.ingestBuffer('id.md', Buffer.from('疫苗接种时间每周二、周四、周六上午。'));
  for (const path of ['/api/admin/docs/abc', '/api/admin/docs/4.5.6']) {
    const res = await get(`http://localhost:${port}${path}`);
    assert.strictEqual(res.status, 404, `${path} must 404`);
    assert.strictEqual(res.body.error, 'not found');
  }
  const del = await new Promise((resolve, reject) => {
    http
      .request({ host: 'localhost', port, path: '/api/admin/docs/abc', method: 'DELETE' }, (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => {
          try {
            resolve({ status: r.statusCode, body: JSON.parse(out) });
          } catch (_) {
            resolve({ status: r.statusCode, body: out });
          }
        });
      })
      .on('error', reject)
      .end();
  });
  assert.strictEqual(del.status, 404, 'DELETE with a non-numeric id must 404, not crash');
  assert.strictEqual(del.body.error, 'not found');
  server.close();
  kb.close();
});

test('wrong method on a known API path returns the stable JSON 404, not HTML', async () => {
  const { kb, server, port } = await startServer();
  try {
    // Routes only register their own verb; any other verb must fall through to
    // the /api catch-all so client-side JSON.parse never hits an HTML page.
    const cases = [
      { method: 'GET', path: '/api/chat' },
      { method: 'PUT', path: '/api/chat' },
      { method: 'POST', path: '/api/domains' },
      { method: 'PATCH', path: '/api/health' },
      { method: 'DELETE', path: '/api/admin/stats' },
      { method: 'POST', path: '/api/admin/docs/1' },
    ];
    for (const c of cases) {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: 'localhost', port, path: c.path, method: c.method },
          (r) => {
            let out = '';
            r.on('data', (ch) => (out += ch));
            r.on('end', () => resolve({ status: r.statusCode, body: out }));
          }
        );
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(res.status, 404, `${c.method} ${c.path} must 404`);
      assert.deepStrictEqual(
        JSON.parse(res.body),
        { error: 'not found' },
        `${c.method} ${c.path} must return the same JSON 404 body as an unknown path`
      );
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('wrong method on a token-gated admin path 401s first — the gate fires before the verb 404; a valid token then lands on the stable JSON 404', async () => {
  const { kb, server, port } = await startServer({ adminToken: 'adm0' });
  // The plain wrong-method test above runs an UNTOKENIZED server, so every verb
  // falls straight through to the /api catch-all. Here the admin gate must
  // instead reject a tokenless wrong-verb probe BEFORE the 404 lookup — the
  // client must see the gate's 401 body, never a leaked not-found body — and a
  // valid token must then fall to the exact JSON 404 an untokenized server
  // returns. A refactor that moves the catch-all ahead of assertAdmin would
  // silently flip these responses to 404.
  const req = (method, reqPath, headers = {}) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: 'localhost', port, path: reqPath, method, headers }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      });
      r.on('error', reject);
      r.end();
    });
  try {
    // every case is a verb the target route does NOT register; POST
    // /api/admin/upload is excluded because it is a real route (its 401-vs-400
    // auth behavior is locked elsewhere).
    const cases = [
      { method: 'POST', path: '/api/admin/docs/1' },
      { method: 'PATCH', path: '/api/admin/stats' },
      { method: 'DELETE', path: '/api/admin/logs' },
      { method: 'PUT', path: '/api/admin/docs' },
      { method: 'GET', path: '/api/admin/upload' },
    ];
    for (const c of cases) {
      const noTok = await req(c.method, c.path);
      assert.strictEqual(noTok.status, 401, `${c.method} ${c.path} without a token must 401 (gate precedes the verb 404)`);
      assert.deepStrictEqual(
        noTok.body,
        { error: 'unauthorized: missing or invalid x-admin-token' },
        `${c.method} ${c.path} must return the gate's 401 body, never the not-found body`
      );
      const withTok = await req(c.method, c.path, { 'x-admin-token': 'adm0' });
      assert.strictEqual(withTok.status, 404, `${c.method} ${c.path} with the token must fall to the stable JSON 404`);
      assert.deepStrictEqual(
        withTok.body,
        { error: 'not found' },
        `${c.method} ${c.path} with the token keeps the same 404 body as an untokenized server`
      );
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('OPTIONS without an Origin is not a preflight — real routes JSON 404, no CORS headers; bare /api prefix 404s as JSON too', async () => {
  const { kb, server, port } = await startServer();
  // The CORS middleware only short-circuits an OPTIONS that CARRIES an Origin
  // (a real browser preflight); a bare OPTIONS from a non-browser client must
  // behave like any other unregistered verb and fall through to the /api JSON
  // catch-all. Existing preflight tests always send Origin and unknown-path
  // tests use /api/nope, so both the no-Origin OPTIONS branch and the bare
  // /api (and trailing-slash) prefix are unasserted on the wire.
  const request = (method, path, origin) =>
    new Promise((resolve, reject) => {
      const headers = origin ? { Origin: origin } : {};
      const r = http.request({ host: 'localhost', port, path, method, headers }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            acao: res.headers['access-control-allow-origin'],
            ct: res.headers['content-type'],
            body: out,
          })
        );
      });
      r.on('error', reject);
      r.end();
    });

  try {
    // sans-Origin OPTIONS on real routes: the JSON 404 fallthrough, no CORS
    for (const p of ['/api/chat', '/api/health', '/api/domains']) {
      const r = await request('OPTIONS', p);
      assert.strictEqual(r.status, 404, `OPTIONS ${p} without Origin must not preflight`);
      assert.strictEqual(r.acao, undefined, `OPTIONS ${p} without Origin must not emit CORS headers`);
      assert.deepStrictEqual(JSON.parse(r.body), { error: 'not found' }, `OPTIONS ${p} without Origin is the stable JSON 404`);
    }
    // contrast: the same OPTIONS with an Origin IS the 204 preflight
    const pre = await request('OPTIONS', '/api/chat', 'https://widget.example');
    assert.strictEqual(pre.status, 204, 'the same OPTIONS with an Origin is the 204 preflight');
    assert.strictEqual(pre.acao, 'https://widget.example');

    // the bare prefix and its trailing-slash variant hit the same catch-all
    for (const p of ['/api', '/api/']) {
      const r = await request('GET', p);
      assert.strictEqual(r.status, 404, `GET ${p} must fall to the API catch-all`);
      assert.match(r.ct, /application\/json/, `GET ${p} must answer JSON, never the HTML error page`);
      assert.deepStrictEqual(JSON.parse(r.body), { error: 'not found' }, `GET ${p} must carry the stable JSON 404 body`);
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('HEAD on JSON API routes mirrors GET headers with zero body — 200s, JSON content-type, exact byte lengths; POST-only/unknown paths still 404 and gated routes still 401', async () => {
  const { kb, server, port } = await startServer({ adminToken: 'adm0' });
  // express answers HEAD by invoking the GET route then stripping the body, so
  // a HEAD probe is the cheapest liveness check a monitoring/health scraper can
  // make. Node http NEVER sends a body for HEAD, so express promises the same
  // Content-Length as the GET would carry — do not let a route-level sendFile
  // or a naive 404 doc change that contract. The wrong-method test above covers
  // other non-existent verbs; HEAD is special because express auto-routes it to
  // GET registrations, so it gets real 200s here where PUT/PATCH would 404.
  const headReq = (reqPath, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port, path: reqPath, method: 'HEAD', headers },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              contentType: r.headers['content-type'],
              contentLength: r.headers['content-length'],
              allowOrigin: r.headers['access-control-allow-origin'],
              body: out,
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
  // GET is the reference for the byte-exact length HEAD promises
  const getBodyLen = (reqPath) =>
    new Promise((resolve, reject) => {
      let out = '';
      http
        .get({ host: 'localhost', port, path: reqPath }, (r) => {
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve(Buffer.byteLength(out)));
        })
        .on('error', reject);
    });
  try {
    // 1. GET routes: HEAD 200 with the JSON content type and the EXACT byte
    // length the real GET would send, but with zero body bytes on the wire.
    for (const reqPath of ['/api/health', '/api/domains']) {
      const route = reqPath === '/api/health' ? 'health' : 'domains';
      const headRes = await headReq(reqPath);
      assert.strictEqual(headRes.status, 200, `HEAD ${reqPath} must 200`);
      assert.strictEqual(headRes.contentType, 'application/json; charset=utf-8', `${route} HEAD keeps the JSON content type`);
      assert.strictEqual(Buffer.byteLength(headRes.body), 0, `${route} HEAD must not leak a body`);
      assert.strictEqual(headRes.contentLength, String(await getBodyLen(reqPath)), `${route} HEAD promises exactly the GET byte length`);
    }
    // 2. HEAD preserves CORS like GET — a widget check that keeps the embeddable
    // page from seeing a false CORS failure on a header-only probe.
    const corsHead = await headReq('/api/health', { Origin: 'https://widget.example' });
    assert.strictEqual(corsHead.status, 200);
    assert.strictEqual(corsHead.allowOrigin, 'https://widget.example', 'HEAD carries the CORS header for cross-origin probes');

    // 3. POST-only route: HEAD falls through to the same JSON 404 as the wrong
    // method case (no body bytes, content-type JSON).
    const chatHead = await headReq('/api/chat');
    assert.strictEqual(chatHead.status, 404, 'HEAD /api/chat (POST-only route) must 404');
    assert.strictEqual(chatHead.contentType, 'application/json; charset=utf-8');
    assert.strictEqual(Buffer.byteLength(chatHead.body), 0);

    // 4. gated routes: HEAD is authorizing before serving — the token gate is
    // still enforced, not bypassed, on header-only probes.
    const adminHead = await headReq('/api/admin/docs');
    assert.strictEqual(adminHead.status, 401, 'HEAD on a token-gated admin route must still 401 without the token');
    assert.strictEqual(Buffer.byteLength(adminHead.body), 0);

    // 5. unknown API path: same JSON 404 as a GET to it.
    const unknownHead = await headReq('/api/nope');
    assert.strictEqual(unknownHead.status, 404, 'HEAD on an unknown API path must 404');
    assert.strictEqual(unknownHead.contentType, 'application/json; charset=utf-8');
    assert.strictEqual(Buffer.byteLength(unknownHead.body), 0);

    // 6. no query logging on a HEAD probe of the chat route (it never reaches
    // the POST handler). This server is token-gated (adm0), so the stats fetch
    // must carry the header like the admin UI would.
    const stats = await new Promise((resolve, reject) => {
      let out = '';
      http
        .get(
          { host: 'localhost', port, path: '/api/admin/stats', headers: { 'x-admin-token': 'adm0' } },
          (r) => {
            r.on('data', (c) => (out += c));
            r.on('end', () => resolve(JSON.parse(out || '{}')));
          }
        )
        .on('error', reject);
    });
    assert.deepStrictEqual(stats.stats, { total: 0, with_answer: 0 }, 'HEAD probes are not logged as queries');
  } finally {
    server.close();
    kb.close();
  }
});

test('DELETE of an existing document removes it from list and search', async () => {
  const { kb, server, port } = await startServer();
  await kb.ingestBuffer('del.md', Buffer.from('疫苗接种时间每周二、周四、周六上午。'));
  const docId = kb.getAllDocs()[0].id;

  const res = await new Promise((resolve, reject) => {
    http
      .request({ host: 'localhost', port, path: `/api/admin/docs/${docId}`, method: 'DELETE' }, (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
      })
      .on('error', reject)
      .end();
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });

  const docs = await get(`http://localhost:${port}/api/admin/docs`);
  assert.strictEqual(docs.body.docs.length, 0, 'doc must leave the admin list');
  assert.strictEqual(kb.searchRaw('疫苗接种').chunks.length, 0, 'deleted content must not be retrievable');
  server.close();
  kb.close();
});

test('deleting a doc keeps its query-log history; the top-doc join degrades to null', async () => {
  const { kb, server, port } = await startServer();
  // queries_log.top_doc_id has no FK, so DELETE must keep the audit trail; the
  // LEFT JOIN then yields a null top_filename the admin table renders as '-'.
  try {
    await kb.ingestBuffer('vet.md', Buffer.from('疫苗接种时间每周二、周四、周六上午。'));
    const docId = kb.getAllDocs()[0].id;
    await post(`http://localhost:${port}/api/chat`, { query: '疫苗接种时间' });

    const before = await get(`http://localhost:${port}/api/admin/logs`);
    assert.strictEqual(before.body.logs.length, 1, 'query logged before deletion');
    assert.strictEqual(before.body.logs[0].top_doc_id, docId);
    assert.strictEqual(before.body.logs[0].top_filename, 'vet.md');

    const del = await new Promise((resolve, reject) => {
      http
        .request({ host: 'localhost', port, path: `/api/admin/docs/${docId}`, method: 'DELETE' }, (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        })
        .on('error', reject)
        .end();
    });
    assert.strictEqual(del.status, 200);

    const after = await get(`http://localhost:${port}/api/admin/logs`);
    assert.strictEqual(after.body.logs.length, 1, 'audit trail survives the doc delete');
    assert.strictEqual(after.body.logs[0].query, '疫苗接种时间');
    assert.strictEqual(after.body.logs[0].top_doc_id, docId, 'dangling id is kept, not rewritten');
    assert.strictEqual(after.body.logs[0].top_filename, null, 'LEFT JOIN yields null so admin.js renders "-"');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/chat tolerates a malformed limit (defaults instead of 500)', async () => {
  const { kb, server, port } = await startServer();
  const ok = await post(`http://localhost:${port}/api/chat`, { query: 'xyz', limit: 'abc' });
  assert.strictEqual(ok.status, 200, 'malformed limit must not crash the endpoint');
  const negative = await post(`http://localhost:${port}/api/chat`, { query: 'xyz', limit: -5 });
  assert.strictEqual(negative.status, 200);
  const huge = await post(`http://localhost:${port}/api/chat`, { query: 'xyz', limit: 1e9 });
  assert.strictEqual(huge.status, 200);
  server.close();
  kb.close();
});

test('/api/chat honors a valid limit (citations capped by the requested count)', async () => {
  const { kb, server, port } = await startServer();
  for (let i = 1; i <= 4; i++) {
    await kb.ingestBuffer(`d${i}.md`, Buffer.from(`咨询费收取规则第${i}条：按小时计费。`));
  }
  const one = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收', limit: 1 });
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.citations.length, 1, 'limit 1 must cap citations to one');
  const two = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收', limit: 2 });
  assert.strictEqual(two.body.citations.length, 2, 'limit 2 must cap citations to two');
  const malformed = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收', limit: 'abc' });
  assert.strictEqual(malformed.body.citations.length, 3, 'malformed limit falls back to the default of 3');
  const zero = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收', limit: 0 });
  assert.strictEqual(zero.body.citations.length, 3, 'limit 0 falls back to the default of 3');
  server.close();
  kb.close();
});

test('/api/chat limit: Number() coercion governs — floors fractions, accepts numeric strings, falsy to default', async () => {
  const { kb, server, port } = await startServer();
  // safeLimit() runs Math.floor(Number(v)): a fractional limit floors toward
  // the citation cap, a numeric string IS a valid limit (URL/query clients send
  // strings), JSON booleans coerce (true->1, false->0->default), and empty/
  // null/whitespace-laden strings fall back to the default of 3. Locking the
  // coercion theorem end-to-end so a tightening to typeof checks stays visible.
  try {
    for (let i = 1; i <= 6; i++) {
      await kb.ingestBuffer(`d${i}.md`, Buffer.from(`咨询费收取规则第${i}条：按小时计费并开具发票。`));
    }
    const citeCount = async (limit) => {
      const res = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收', limit });
      assert.strictEqual(res.status, 200, `limit ${JSON.stringify(limit)} must not 500`);
      return res.body.citations.length;
    };
    assert.strictEqual(await citeCount(2.9), 2, 'fractional limit must floor to 2');
    assert.strictEqual(await citeCount('2'), 2, 'numeric string must be a valid limit');
    assert.strictEqual(await citeCount('2.9'), 2, 'fractional numeric string must floor like a number');
    assert.strictEqual(await citeCount('  3  '), 3, 'whitespace-padded numeric string must trim to 3');
    assert.strictEqual(await citeCount(true), 1, 'true coerces to 1 via Number(true)');
    assert.strictEqual(await citeCount(false), 3, 'false coerces to 0 and falls back to the default');
    assert.strictEqual(await citeCount(''), 3, 'empty string is NaN -> default');
    assert.strictEqual(await citeCount(null), 3, 'null is 0 -> default');
    assert.strictEqual(await citeCount('0'), 3, 'string "0" fails the >=1 guard -> default');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/chat clamps a huge limit to the 1000-citation ceiling', async () => {
  const { kb, server, port } = await startServer();
  // The same safeLimit() that gates /api/admin/logs also caps the chat side;
  // a client looping on limit=1000000 would otherwise pull every FTS match and
  // blow up the response. Exactly 1000 (not the 1005 offers, not the default
  // 3) proves the ceiling fired end-to-end.
  try {
    for (let i = 0; i < 1005; i++) {
      await kb.ingestBuffer(`d${i}.md`, Buffer.from(`咨询费收取第${i}号规则条目：统一按小时计费并开具发票。`));
    }
    const res = await post(`http://localhost:${port}/api/chat`, { query: '咨询费', limit: 1000000 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.citations.length, 1000, 'huge chat limit must clamp to the 1000-citation ceiling');
    assert.ok(res.body.citations.every((c) => c.docId != null));
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/logs tolerates a malformed limit (defaults instead of 500)', async () => {
  const { kb, server, port } = await startServer();
  const ok = await get(`http://localhost:${port}/api/admin/logs?limit=abc`);
  assert.strictEqual(ok.status, 200, 'malformed limit must not crash the endpoint');
  assert.ok(Array.isArray(ok.body.logs));
  const negative = await get(`http://localhost:${port}/api/admin/logs?limit=-5`);
  assert.strictEqual(negative.status, 200);
  server.close();
  kb.close();
});

test('/api/admin/logs honors a valid limit (returns the requested row count)', async () => {
  const { kb, server, port } = await startServer();
  for (let i = 1; i <= 4; i++) {
    await post(`http://localhost:${port}/api/chat`, { query: `问题${i}关于咨询费` });
  }
  const few = await get(`http://localhost:${port}/api/admin/logs?limit=2`);
  assert.strictEqual(few.status, 200);
  assert.strictEqual(few.body.logs.length, 2, 'valid limit trims the logs list');
  const all = await get(`http://localhost:${port}/api/admin/logs`);
  assert.strictEqual(all.body.logs.length, 4, 'default returns every logged query');
  server.close();
  kb.close();
});

test('/api/admin/logs clamps a huge limit to the 1000-row ceiling', async () => {
  const { kb, server, port } = await startServer();
  // safeLimit() caps every valid limit at 1000 rows; the storage layer trusts
  // whatever LIMIT it is handed, so exactly-1000 (not 1005 and not the 100-row
  // default) proves the clamp fired instead of a coincidental ceiling.
  try {
    for (let i = 1; i <= 1005; i++) {
      await kb.logQuery({ query: `问题${i}关于咨询费`, domain: 'general', matched: 0, topScore: null, topDocId: null, source: 'api' });
    }
    const huge = await get(`http://localhost:${port}/api/admin/logs?limit=1000000`);
    assert.strictEqual(huge.status, 200);
    assert.strictEqual(huge.body.logs.length, 1000, 'a valid but huge limit must be clamped to the 1000-row cap');

    const moderate = await get(`http://localhost:${port}/api/admin/logs?limit=999`);
    assert.strictEqual(moderate.body.logs.length, 999, 'limits under the ceiling pass through untouched');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/logs?limit=50 pages the newest 50 rows and the default caps at 100', async () => {
  const { kb, server, port } = await startServer();
  // admin.js loadLogs() always fetches &limit=50, so that exact page size is
  // the contract the admin table actually renders. 101 queries put the server
  // past both the 50-item page and the 100-row default cap.
  try {
    for (let i = 1; i <= 101; i++) {
      const res = await post(`http://localhost:${port}/api/chat`, { query: `问题${i}关于咨询费` });
      assert.strictEqual(res.status, 200);
    }
    const page = await get(`http://localhost:${port}/api/admin/logs?limit=50`);
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.body.logs.length, 50, 'the admin.js page request must return exactly 50 rows');
    assert.deepStrictEqual(
      page.body.logs.map((l) => l.query),
      Array.from({ length: 50 }, (_, i) => `问题${101 - i}关于咨询费`),
      'limit=50 must hand back the newest 50 queries first'
    );
    const full = await get(`http://localhost:${port}/api/admin/logs`);
    assert.strictEqual(full.body.logs.length, 100, 'no limit defaults to a 100-row cap, not the full log');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/logs lists queries newest-first, matching the admin table render order', async () => {
  const { kb, server, port } = await startServer();
  // admin.js appends rows top-down from the wire array; the storage layer
  // orders by q.id DESC, so a second query must appear before the first.
  try {
    await kb.ingestBuffer('clinic.md', Buffer.from('本诊所工作日 8:00 开门，预约电话 010-8888。'));
    const queries = ['最早的查询', '中间的查询', '最新的查询'];
    for (const q of queries) {
      const chat = await post(`http://localhost:${port}/api/chat`, { query: q });
      assert.strictEqual(chat.status, 200);
    }
    const logs = await get(`http://localhost:${port}/api/admin/logs`);
    assert.strictEqual(logs.status, 200);
    assert.deepStrictEqual(
      logs.body.logs.map((l) => l.query),
      [...queries].reverse(),
      'newest query logs first so the admin table reads top-down newest-first'
    );
    const ids = logs.body.logs.map((l) => l.id);
    assert.ok(ids.every((id, i) => i === 0 || ids[i - 1] > id), 'ids must strictly descend');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/logs carries the top-doc filename join for answered queries', async () => {
  const { kb, server, port } = await startServer();
  // the admin table displays top_filename (admin.js); it comes from a LEFT
  // JOIN in the storage layer, so lock the populated path end-to-end.
  await kb.ingestBuffer('clinic.md', Buffer.from('本诊所工作日 8:00 开门，预约电话 010-8888。'));
  const chat = await post(`http://localhost:${port}/api/chat`, { query: '诊所以什么时间开门' });
  assert.strictEqual(chat.status, 200);
  assert.ok(chat.body.citations.length > 0, 'query must hit the ingested doc');

  const logs = await get(`http://localhost:${port}/api/admin/logs`);
  assert.strictEqual(logs.status, 200);
  const row = logs.body.logs[0];
  assert.strictEqual(row.matched, chat.body.citations.length);
  assert.strictEqual(row.top_filename, 'clinic.md', 'answered log must resolve the doc filename');
  assert.strictEqual(row.top_doc_id, chat.body.top.docId);
  assert.ok(typeof row.top_score === 'number');

  // unanswered queries log a null top-doc join, which the UI renders as '-'
  await post(`http://localhost:${port}/api/chat`, { query: '完全不存在的关键词' });
  const missed = await get(`http://localhost:${port}/api/admin/logs`);
  const missRow = missed.body.logs[0];
  assert.strictEqual(missRow.top_filename, null);
  assert.strictEqual(missRow.top_doc_id, null, 'a miss has no top doc id');
  assert.strictEqual(missRow.top_score, null, 'a miss must log null top_score so admin.js renders "-" not "0%"');
  assert.strictEqual(missRow.matched, 0, 'a miss logs zero matched citations');
  server.close();
  kb.close();
});

test('/api/admin/logs rows carry the created_at/query/domain fields the admin table renders', async () => {
  const { kb, server, port } = await startServer();
  // admin.js renders l.created_at, l.query, l.domain, l.matched, l.top_score
  // and l.top_filename per log row; the latter three are locked elsewhere, so
  // pin the remaining three shapes at the wire level. try/finally keeps the
  // server closed on assertion failure so a failing test cannot leak a handle
  // and hang the whole runner.
  try {
    await kb.ingestBuffer('bid.md', Buffer.from('投标截止时间为每周五下午五点，逾期不予受理。'));
    const query = '投标截止时间是什么时候';
    const chat = await post(`http://localhost:${port}/api/chat`, { query, domain: 'procurement' });
    assert.strictEqual(chat.status, 200);
    assert.ok(chat.body.citations.length > 0, 'query must hit the ingested doc');

    const logs = await get(`http://localhost:${port}/api/admin/logs`);
    assert.strictEqual(logs.status, 200);
    assert.strictEqual(logs.body.logs.length, 1);
    const row = logs.body.logs[0];
    assert.strictEqual(typeof row.created_at, 'string');
    assert.ok(row.created_at.length > 0, 'created_at must be a populated timestamp string');
    assert.strictEqual(row.query, query, 'log must carry the exact query the chat endpoint received');
    assert.strictEqual(row.domain, 'procurement', 'log must carry the domain the request selected');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/chat citations carry the docId/document/paragraph/excerpt fields the frontends render', async () => {
  const { kb, server, port } = await startServer();
  // demo.js renders c.document, §c.paragraph and c.excerpt (sliced to 160
  // chars); widget.js renders c.document and §c.paragraph. Lock the wire shape
  // so a storage/answer refactor cannot drop a field the UIs depend on.
  await kb.ingestBuffer(
    'guide.md',
    Buffer.from('疫苗接种时间每周二、周四、周六上午，请携带预防接种证提前预约。儿童接种疫苗前请确认无发烧。')
  );
  const chat = await post(`http://localhost:${port}/api/chat`, { query: '儿童接种疫苗' });
  assert.strictEqual(chat.status, 200);
  assert.ok(chat.body.citations.length >= 1, 'query must hit the ingested doc');
  for (const c of chat.body.citations) {
    assert.strictEqual(typeof c.docId, 'number');
    assert.ok(c.docId > 0);
    assert.strictEqual(typeof c.document, 'string');
    assert.ok(c.document.includes('.'), 'document should carry the filename');
    assert.ok(Number.isInteger(c.paragraph) && c.paragraph >= 1, 'paragraph must be a 1-based integer');
    assert.strictEqual(typeof c.excerpt, 'string');
    assert.ok(c.excerpt.length > 0, 'excerpt must be populated text the demo page renders');
  }
  // top must mirror the first citation's fields (same doc, same excerpt)
  const first = chat.body.citations[0];
  assert.strictEqual(chat.body.top.docId, first.docId);
  assert.strictEqual(chat.body.top.document, first.document);
  assert.strictEqual(chat.body.top.paragraph, first.paragraph);
  assert.strictEqual(chat.body.top.excerpt, first.excerpt);
  server.close();
  kb.close();
});

test('widget script is served and self-contained', async () => {
  const { kb, server, port } = await startServer();
  const res = await get(`http://localhost:${port}/widget.js`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(
    res.headers['content-type'],
    'application/javascript; charset=UTF-8',
    'widget.js is the cross-origin embeddable script — browsers strict-MIME-block a <script src> served as text/plain'
  );
  assert.match(res.body, /ragdesk-fab/);
  server.close();
  kb.close();
});

test('widget script supports RAGDESK_CHAT_TOKEN via data-token', async () => {
  const { kb, server, port } = await startServer({ chatToken: 'chatTok' });
  const res = await get(`http://localhost:${port}/widget.js`);
  assert.strictEqual(res.status, 200);
  assert.match(res.body, /getAttribute\('data-token'\)/);
  assert.match(res.body, /headers\.Authorization = 'Bearer ' \+ TOKEN/);
  // non-2xx (e.g. missing/invalid token -> 401) surfaces the server error
  // instead of being silently shown as "（暂无回答）".
  assert.match(res.body, /if \(!r\.ok\) throw new Error\(data\.error/);
  server.close();
  kb.close();
});

test('widget script wiring: defaults, domain passthrough and chat body shape', async () => {
  const { kb, server, port } = await startServer();
  try {
    const res = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(res.status, 200);
    // host page controls endpoint/domain/token via data-* attributes; a missing
    // attribute must fall back (data-api -> /api/chat, data-domain -> general,
    // data-token -> '') rather than break the embed.
    assert.match(res.body, /script\.getAttribute\('data-api'\) \|\| '\/api\/chat'/);
    assert.match(res.body, /script\.getAttribute\('data-domain'\) \|\| 'general'/);
    assert.match(res.body, /script\.getAttribute\('data-title'\) \|\| '知识库助手'/);
    assert.match(res.body, /script\.getAttribute\('data-greeting'\) \|\| '您好，我是您的知识库助手，请问有什么可以帮您？'/);
    assert.match(res.body, /script\.getAttribute\('data-token'\) \|\| ''/);
    // the title/greeting fallbacks feed the rendered chrome and the opening bot bubble
    assert.ok(res.body.includes("'<div id=\"ragdesk-head\">' + esc(TITLE) +"), 'title fallback must render into the panel head');
    assert.ok(res.body.includes("addMsg('bot', esc(GREETING));"), 'greeting fallback must seed the opening bot bubble');
    // the selected domain is forwarded with every question so doc presets apply;
    // body shape must match what /api/chat validates server-side.
    assert.match(res.body, /JSON\.stringify\(\{ query: q, domain: DOMAIN \}\)/);
    // widget renders answer/citations document+paragraph/confidence from the
    // chat payload (the fields both demo.js and index.html depend on).
    assert.ok(res.body.includes("data.answer || '（暂无回答）'"));
    assert.ok(res.body.includes("esc(c.document) + ' §' + c.paragraph"));
    assert.ok(res.body.includes("Math.round((data.confidence || 0) * 100) + '%</span>'"));
  } finally {
    server.close();
    kb.close();
  }
});

test('widget.js caps citations at two for the compact panel and surfaces network failures as 请求失败:reason', async () => {
  const { kb, server, port } = await startServer();
  try {
    const res = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(res.status, 200);
    // the embeddable panel is 340px wide, so the citation list is capped at two
    // lines — a rewire that renders the whole pool would bloat the bubble and
    // wreck the compact layout the widget is embedded for.
    assert.match(
      res.body,
      /var cites = \(data\.citations \|\| \[\]\)\.slice\(0, 2\)/,
      'widget must cap the rendered citation pool at two'
    );
    // each capped citation still renders 来源：document §paragraph under the answer
    assert.match(
      res.body,
      /'<span class="rd-cite">来源：' \+ esc\(c\.document\) \+ ' §' \+ c\.paragraph \+ '<\/span>'/,
      'citation lines must render 来源：document §paragraph'
    );
    // only the capped lines are joined into the bubble (a spread of all
    // citations here would show — the wire honors limit but the panel must not)
    assert.match(
      res.body,
      /\(data\.citations \|\| \[\]\)\.slice\(0, 2\)[\s\S]*?\.join\(''\);/,
      'the capped citation list must be joined into the bubble text'
    );
    // network/parse failures fall back to a readable 请求失败 message carrying the
    // escaped reason — never an unescaped raw error or a silent empty bubble.
    assert.ok(
      res.body.includes("addMsg('bot', '请求失败：' + esc(err.message));"),
      'network failures must surface as 请求失败:reason, not silent blank'
    );
  } finally {
    server.close();
    kb.close();
  }
});

test('chat POST target wiring: widget.js fetches the data-api endpoint, demo.js fetches /api/chat literally, both escape the user question', async () => {
  const { kb, server, port } = await startServer();
  // The data-api/data-domain attributes only matter if the script actually
  // issues fetch(API, ...) — a rewire to a hardcoded endpoint would break
  // cross-origin embeds (widget) and the demo page would silently stop
  // reaching /api/chat. Combined with the user-question XSS escape this
  // locks the two chat submit paths end to end.
  try {
    const widget = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(widget.status, 200);
    // the data-api fallback (locked separately) must feed the real POST target
    assert.match(widget.body, /fetch\(API, \{/, 'widget must POST to the data-api value, not a hardcoded endpoint');
    // the title fallback also labels the floating button's hover tooltip
    assert.ok(widget.body.includes('fab.title = TITLE;'), 'title fallback must set the FAB tooltip');
    // the user's question is escaped before innerHTML like every other interpolation
    assert.ok(widget.body.includes("addMsg('user', esc(q));"), 'widget must escape the user question before rendering');

    const demo = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(demo.status, 200);
    // the demo posts straight to the same-origin /api/chat endpoint
    assert.match(demo.body, /fetch\('\/api\/chat', \{/, 'demo must POST to /api/chat');
    assert.ok(demo.body.includes("addMsg('user', esc(q));"), 'demo must escape the user question before rendering');
  } finally {
    server.close();
    kb.close();
  }
});

test('client submit guards: blank/whitespace questions never fire a request, demo shows a pending bubble, widget binds click+Enter to submit', async () => {
  const { kb, server, port } = await startServer();
  // The wire 400s for blank/whitespace queries (locked elsewhere) are purely
  // defensive: both client scripts trim their input and return before any
  // fetch, so a user typing spaces or nothing makes zero requests. A rewire
  // that dropped the guard would silently spam /api/chat with 400-able junk.
  // The demo also shows a pending bubble while the request is in flight.
  try {
    const widget = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(widget.status, 200);
    assert.match(widget.body, /var q = input\.value\.trim\(\);\n\s*if \(!q\) return;/, 'widget submit must trim and refuse blank/whitespace');
    // the two widget submit triggers: send button click and Enter in the input
    assert.ok(widget.body.includes("sendBtn.addEventListener('click', submit);"), 'widget send button must submit');
    assert.ok(widget.body.includes("if (e.key === 'Enter') submit();"), 'widget Enter key must submit');

    const demo = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(demo.status, 200);
    assert.match(demo.body, /const q = input\.value\.trim\(\);/);
    assert.match(demo.body, /if \(!q\) return;/, 'demo submit must trim and refuse blank/whitespace');
    // pending-state bubble: captured so success/error can replace it
    assert.ok(
      demo.body.includes("const thinking = addMsg('bot', '正在检索知识库…');"),
      'demo must show a pending bubble while the chat request is in flight'
    );
  } finally {
    server.close();
    kb.close();
  }
});

test('admin.js upload wiring: click-to-upload binding, disabled in-flight guard, error surfaces and data-action row buttons', async () => {
  const { kb, server, port } = await startServer();
  // The upload/render contracts are locked (FormData append, action notches,
  // pending label), but the *wiring* that makes them fire is not: the click
  // binding on the upload button, the re-entry guard that disables it while a
  // batch upload is in flight, the network-failure path and the per-row
  // view/delete buttons that adminFetch against /api/admin/docs — a rewire
  // that drops any of these silently breaks the panel without touching the
  // already-pinned render strings.
  try {
    const res = await get(`http://localhost:${port}/admin.js`);
    assert.strictEqual(res.status, 200);
    // the upload button is the single trigger for the whole upload flow
    assert.ok(res.body.includes("uploadBtn.addEventListener('click', upload);"), 'the upload button must be click-bound to upload');
    // in-flight guard: once a batch upload starts the button is disabled (so a
    // second click cannot interleave) and re-enabled after try/finally semantics
    assert.ok(res.body.includes('uploadBtn.disabled = true;'), 'upload must disable the button while in flight');
    assert.ok(res.body.includes('uploadBtn.disabled = false;'), 'upload must re-enable the button after the batch');
    // no selected files: the upload short-circuits before any request
    assert.ok(res.body.includes('if (!files.length) return;'), 'upload must short-circuit with no selected files');
    // network failure surfaces the reason instead of blanking the result area
    assert.ok(res.body.includes("uploadResult.textContent = '上传失败：' + e.message;"), 'upload must surface network failures with the reason');
    // per-row buttons carry data-actions and round-trip through adminFetch so a
    // deleted doc refreshes the table; the "leave unless confirmed" gate pins
    // the confirm prompt that guards every delete
    assert.ok(res.body.includes('tr.querySelector(\'[data-action="view"]\').addEventListener(\'click\', () => viewChunks(d.id, d.filename));'), 'view buttons must open the chunk preview for that doc');
    assert.ok(res.body.includes("tr.querySelector('[data-action=\"delete\"]').addEventListener('click', async () => {"), 'delete buttons must bind a click handler');
    assert.ok(res.body.includes('if (!confirm(`删除文档「${d.filename}」及其分块？`)) return;'), 'delete must be confirm-gated');
    assert.ok(res.body.includes("await adminFetch('/api/admin/docs/' + d.id, { method: 'DELETE' });"), 'delete must call adminFetch DELETE on the doc endpoint');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin.js renders the wire-locked admin fields: stats arithmetic, logs "-" fallbacks, chunk detail meta, empty/error states', async () => {
  const { kb, server, port } = await startServer();
  // The wire payload shapes are locked (/api/admin/stats, /api/admin/logs,
  // docs detail chunks), but admin.js is the only consumer of those fields:
  // the stats card arithmetic, the "-" fallbacks for a null top_score and a
  // missing domain, the chunk meta line and the empty/error states would
  // silently stop rendering if rewired. Lock the render contracts.
  try {
    const res = await get(`http://localhost:${port}/admin.js`);
    assert.strictEqual(res.status, 200);
    // stats card: total/with_answer/命中率 computed client-side from the payload
    assert.ok(res.body.includes("<div class=\"stat\"><b>${s.total}</b><span>总查询</span></div>"), 'stats card must render 总查询');
    assert.ok(res.body.includes("<div class=\"stat\"><b>${s.with_answer}</b><span>有回答命中</span></div>"), 'stats card must render 有回答命中');
    assert.ok(res.body.includes("<div class=\"stat\"><b>${hit}</b><span>命中率</span></div>"), 'stats card must render 命中率');
    assert.ok(res.body.includes("s.total > 0 ? Math.round((s.with_answer / s.total) * 100) + '%' : '-'"), '命中率 must be total-guarded and fall back to "-"');
    // logs rows: null top_score and missing domain render "-" (mirrors the
    // wire lock on null top_score if the fix were reverted, the panel would show "undefined" or "NaN%")
    assert.ok(res.body.includes("l.top_score == null ? '-' : (l.top_score * 100).toFixed(0) + '%'"), 'null top_score must render "-"');
    assert.ok(res.body.includes("l.domain || '-'"), 'missing domain must render "-"');
    assert.ok(res.body.includes('<tr><td colspan="6" class="dim">暂无查询记录</td></tr>'), 'empty logs must render the no-records state');
    // docs rows: size is humanized to KB client-side
    assert.ok(res.body.includes("(d.size / 1024).toFixed(1) + ' KB'"), 'doc size must render as KB client-side');
    // chunk detail: header "#id · filename", per-chunk meta "chunk_idx · N 字", body escaped
    assert.ok(res.body.includes("chunksDoc.textContent = filename ? `#${id} · ${filename}` : `#${id}`;"), 'chunk card header must render #id · filename');
    assert.ok(res.body.includes('class="chunk-meta">#${c.chunk_idx} · ${c.body.length} 字</span>` + esc(c.body);'), 'chunk rows must render idx · length and escape the body');
    assert.ok(res.body.includes('<div class="dim small">该文档暂无分块。</div>'), 'empty chunks must render the no-chunks state');
    assert.ok(res.body.includes('chunksBody.innerHTML = \'<div class="dim small">加载失败：HTTP \' + res.status'), 'chunk load failure must surface the HTTP status');
    // delete gating: the confirm prompt before DELETE, upload pending/reset states
    assert.ok(res.body.includes('删除文档「${d.filename}」及其分块？'), 'doc delete must be confirm-gated');
    assert.ok(res.body.includes("uploadResult.textContent = '上传中…';"), 'upload must show the pending state');
    assert.ok(res.body.includes("fileInput.value = '';"), 'upload must reset the file input afterwards');
  } finally {
    server.close();
    kb.close();
  }
});

test('demo page badges and subtitle keep claiming the offline engine the /api/health payload reports', async () => {
  const { kb, server, port } = await startServer();
  // The landing page advertises the offline architecture (LLM 关闭 / Embedding
  // 关闭 / SQLite FTS5 + BM25). /api/health reports the same facts as booleans;
  // a rewire that flips the engine state (e.g. an on-by-default LLM mode) must
  // not leave the page claiming the old offline stance.
  try {
    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    assert.ok(idx.body.includes('<p class="subtitle">垂直行业 RAG 客服壳 · 离线检索问答演示（无外部 LLM）</p>'), 'subtitle must keep the offline-architecture claim');
    assert.ok(idx.body.includes('<span class="badge badge-off">LLM 关闭</span>'), 'badge must advertise LLM off');
    assert.ok(idx.body.includes('<span class="badge badge-off">Embedding 关闭</span>'), 'badge must advertise embedding off');
    assert.ok(idx.body.includes('<span class="badge badge-on">SQLite FTS5 + BM25</span>'), 'badge must advertise SQLite FTS5 + BM25 as on');

    const health = await get(`http://localhost:${port}/api/health`);
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.engine.llm, false, 'engine must report LLM off for the badge claim to hold');
    assert.strictEqual(health.body.engine.embedding, false, 'engine must report embedding off for the badge claim to hold');
    assert.strictEqual(health.body.engine.fts, true, 'engine must report FTS on for the badge claim to hold');
    assert.strictEqual(health.body.mode, 'offline', 'engine must report offline mode for the subtitle claim to hold');
  } finally {
    server.close();
    kb.close();
  }
});

test('demo example chips fill the input and submit via requestSubmit; widget FAB toggles the panel and seeds the greeting once', async () => {
  const { kb, server, port } = await startServer();
  // The demo's suggested-question chips are the page's only one-click chat
  // path: each chip label comes from the active domain preset, click fills the
  // input and submits the form (going through the same trim/pending/error
  // pipeline as typed questions). The widget's FAB click toggles the panel and
  // seeds the greeting bubble only on the first open.
  try {
    const demo = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(demo.status, 200);
    // chips render from the active domain preset; a missing preset degrades to {} not a throw
    assert.ok(demo.body.includes('const d = domains[domainSelect.value] || {};'), 'example lookup must degrade to {} for unknown domains');
    assert.ok(demo.body.includes('for (const q of d.examples || []) {'), 'examples must come from the active domain preset');
    assert.ok(demo.body.includes('b.textContent = q;'), 'chip label must be the raw example text');
    // clicking fills the input and submits the form through the normal pipeline
    assert.ok(demo.body.includes('input.value = q;'), 'chip click must fill the input');
    assert.ok(demo.body.includes('form.requestSubmit();'), 'chip click must submit the form');

    const widget = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(widget.status, 200);
    // the floating button is a literal glyph, and clicking toggles the panel
    assert.ok(widget.body.includes("fab.textContent = '\u{1F4AC}';"), 'FAB must render the chat glyph');
    assert.ok(widget.body.includes('panel.classList.toggle(\'open\')'), 'FAB click must toggle the panel open state');
    // the greeting seeds only on the first open, so reopening keeps history
    assert.ok(widget.body.includes('if (open && body.children.length === 0) addMsg(\'bot\', esc(GREETING));'), 'greeting must seed only on first open');
  } finally {
    server.close();
    kb.close();
  }
});

test('widget.js is a self-contained embed: single-instance guard, injected stylesheet, panel chrome and auto-scroll', async () => {
  const { kb, server, port } = await startServer();
  // The MIME and data-* wiring suites prove the script SERVES and reads config;
  // this one locks that it RENDERS without depending on the host page: a global
  // guard tolerates double-loading, the stylesheet is injected into document.head
  // (never a /style.css link), the close button is aria-labelled, the input bar
  // exists with its placeholder, and new messages auto-scroll the panel body.
  try {
    const res = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(res.status, 200);
    // embedding a <script src=widget.js> twice must not render two FABs/panels
    assert.ok(res.body.includes('if (window.__ragDeskWidget) return;'), 'widget must refuse a second instance');
    assert.ok(res.body.includes('window.__ragDeskWidget = true;'), 'widget must flag itself as the mounted instance');
    // self-contained CSS: inject a <style> tag, do not require host-page styles
    assert.ok(res.body.includes("var style = document.createElement('style');"), 'widget must create its own style element');
    assert.ok(res.body.includes('style.textContent = css;'), 'widget must fill the injected stylesheet');
    assert.ok(res.body.includes('document.head.appendChild(style);'), 'widget must attach its stylesheet to <head>');
    // panel chrome: the close button is reachable and aria-labelled, the input
    // bar is present with a placeholder so the compact panel has affordances
    assert.ok(res.body.includes('aria-label="关闭">×</button>'), 'widget close button must be aria-labelled');
    assert.ok(res.body.includes('placeholder="请输入问题…"'), 'widget input must keep an inline placeholder');
    // messages auto-scroll so the newest bubble stays visible in the 440px panel
    assert.ok(res.body.includes('m.className = \'rd-msg \' + who;'), 'widget messages must carry the rd-msg role class');
    assert.ok(res.body.includes('body.scrollTop = body.scrollHeight;'), 'widget must auto-scroll on new messages');
  } finally {
    server.close();
    kb.close();
  }
});

test('demo.js and widget.js emit the exact class names the stylesheets style for citations, meta and confidence', async () => {
  const { kb, server, port } = await startServer();
  // The rendering suites prove the fields reach innerHTML; this one locks the
  // CSS hooks the stylesheets actually target. /style.css styles
  // .bot-cite/.cite-doc (demo chat) and the widget's injected stylesheet styles
  // .rd-meta/.rd-cite — a rewire that drops a class name leaves the bubble
  // unstyled without anyone noticing. Pin the emitted class names and the
  // confidence literals that go with them.
  try {
    const demo = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(demo.status, 200);
    // citation line: the outer span and its bold doc-name child both carry the
    // class names /style.css selects on
    assert.ok(
      demo.body.includes('<span class="bot-cite"><span class="cite-doc">'),
      'demo citation must emit the bot-cite/cite-doc hooks style.css styles'
    );
    // the confidence prefix says 可置信度 inside the .bot-meta block
    assert.ok(demo.body.includes('可置信度 '), 'demo confidence line must keep the 可置信度 label');

    const widget = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(widget.status, 200);
    // widget bot message: the meta line is an .rd-meta span and the whole block
    // is .rd-msg .bot — the two hooks the injected stylesheet selects on
    assert.ok(
      widget.body.includes('<span class="rd-meta">离线检索 · 置信度 '),
      'widget must emit the rd-meta span with its offline-confidence label'
    );
    assert.ok(widget.body.includes("m.className = 'rd-msg ' + who;"), 'widget messages must carry the rd-msg hook its CSS targets');
    // /style.css must still carry the demo-side hooks (guarded against a CSS
    // rewire that restyles by id and silently orphans the emitted classes)
    const css = await get(`http://localhost:${port}/style.css`);
    assert.strictEqual(css.status, 200);
    assert.ok(css.body.includes('.bot-cite {'), 'style.css must keep the .bot-cite rule');
    assert.ok(css.body.includes('.bot-cite .cite-doc {'), 'style.css must keep the .cite-doc emphasis rule');
  } finally {
    server.close();
    kb.close();
  }
});

test('static page skeletons carry the exact headings, form controls and table headers the scripts render into', async () => {
  const { kb, server, port } = await startServer();
  // The element-id test proves demo.js/admin.js can FIND their hooks; this one
  // locks what the pages present around those hooks: the upload control shape,
  // the <thead> column contracts the row renderers fill (admin.js writes 8
  // cells per docs row and 6 per logs row), the chunks card staying hidden
  // until "查看分块", and the demo ask form's submit wiring. A rewire that
  // drops a header column without touching admin.js leaves a shifted table.
  try {
    const admin = await get(`http://localhost:${port}/admin`);
    assert.strictEqual(admin.status, 200);
    assert.ok(admin.body.includes('<h1>RAG-Desk 管理后台</h1>'), 'admin page must keep its page heading');
    assert.ok(admin.body.includes('<p class="subtitle">上传文档 · 查看索引 · 查询日志</p>'), 'admin page must keep its subtitle');
    assert.ok(admin.body.includes('<h2>上传文档</h2>'), 'admin must keep the upload card heading');
    assert.ok(admin.body.includes('<h2>索引状态</h2>'), 'admin must keep the stats card heading');
    assert.ok(admin.body.includes('<h2>已索引文档</h2>'), 'admin must keep the docs card heading');
    assert.ok(admin.body.includes('<h2>分块预览'), 'admin must keep the chunks card heading');
    assert.ok(admin.body.includes('<h2>查询日志</h2>'), 'admin must keep the logs card heading');
    // upload control: the input must accept multiple files and the button must
    // keep the exact label the upload-result copy echoes
    assert.ok(admin.body.includes('<input type="file" id="file-input" multiple'), 'upload input must accept multiple files');
    assert.ok(admin.body.includes('<button id="upload-btn">上传并索引</button>'), 'admin must keep the upload button');
    // the chunks card must START hidden; admin.js reveals it on 查看分块 only
    assert.ok(admin.body.includes('<div class="admin-card" id="chunks-card" hidden>'), 'chunks card must start hidden');
    // docs thead must stay column-compatible with loadDocs' 8-cell rows (the
    // colspan="2" covers the view/delete action buttons)
    assert.ok(
      admin.body.includes('<tr><th>ID</th><th>文件名</th><th>类型</th><th>分块</th><th>大小</th><th>上传时间</th><th colspan="2"></th></tr>'),
      'docs thead must keep its six labeled columns plus the two action cells'
    );
    // logs thead must match loadLogs' six rendered cells exactly
    assert.ok(
      admin.body.includes('<tr><th>时间</th><th>查询</th><th>领域</th><th>命中</th><th>置信度</th><th>来源文档</th></tr>'),
      'logs thead must keep its six labeled columns'
    );

    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    assert.ok(idx.body.includes('<h1>RAG-Desk</h1>'), 'demo page must keep its heading');
    assert.ok(idx.body.includes('<label for="domain-select">领域预设：</label>'), 'demo page must label the domain select');
    // the ask form must submit via a submit button (click AND Enter both fire
    // form submit, which is the only path demo.js listens on)
    assert.ok(idx.body.includes('<form id="ask-form" class="ask-bar">'), 'demo page must keep the ask form wrapper');
    assert.ok(idx.body.includes('<input id="ask-input" type="text"'), 'demo ask input must stay a text field');
    assert.ok(idx.body.includes('autocomplete="off"'), 'demo ask input must disable browser autofill');
    assert.ok(idx.body.includes('<button type="submit">发送</button>'), 'demo form must keep its submit-send button');
    assert.ok(idx.body.includes('<div id="examples" class="examples dim"></div>'), 'demo page must keep the examples container');
  } finally {
    server.close();
    kb.close();
  }
});

test('widget.js panel chrome: the message area, input bar and send button are created and bound by id, and the input clears after every send', async () => {
  const { kb, server, port } = await startServer();
  // The pass-13 lock proves the panel's close button and input placeholder,
  // but not that the chat area, the input bar and the send button exist or
  // that submit() clears the box. A rewire that drops a chrome element (or
  // renames its id, breaking host-page CSS/the querySelector bindings) would
  // silently ship a dead input bar. Lock the four-line panel skeleton, the
  // three getElementById-style bindings and the post-send clearing verbatim.
  try {
    const res = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(res.status, 200);
    // the message scroll area must be a dedicated element (failure to create
    // it leaves addMsg appending to a null node -> the whole widget dies)
    assert.ok(res.body.includes('<div id="ragdesk-body"></div>'), 'widget panel must create the message area element');
    // the bottom bar must wrap the text input (the input placeholder is
    // already pinned; lock the bar container and the input's id together so a
    // rewire cannot keep the placeholder copy while breaking the layout)
    assert.ok(
      res.body.includes('<div id="ragdesk-inputbar"><input id="ragdesk-input" placeholder="请输入问题…"/>'),
      'widget panel must create the input bar wrapping the id-bound text input'
    );
    assert.ok(res.body.includes('<button id="ragdesk-send">发送</button>'), 'widget panel must create the send button');
    // the three chrome elements must be bound to local vars by id (these are
    // the only handles addMsg/submit/ask close over)
    assert.ok(res.body.includes("var body = panel.querySelector('#ragdesk-body');"), 'widget must bind the message area handle');
    assert.ok(res.body.includes("var input = panel.querySelector('#ragdesk-input');"), 'widget must bind the input handle');
    assert.ok(res.body.includes("var sendBtn = panel.querySelector('#ragdesk-send');"), 'widget must bind the send button handle');
    // after a successful send the box clears so the next question starts fresh
    assert.ok(res.body.includes("input.value = '';"), 'widget must clear the input after handing off the question');
  } finally {
    server.close();
    kb.close();
  }
});

test('demo.js submit flow: press send and the question is echoed escaped, the input clears, the pending bubble is replaced by the render, and the panel scrolls; admin.js builds chunk rows via createElement + className', async () => {
  const { kb, server, port } = await startServer();
  // The submit event is the single entry point of the demo's asking loop: a
  // rewire that stops binding it (or keeps the form default) would page-reload
  // on every question instead of calling /api/chat. The wire locks pin the
  // fetch body and error surfaces, but not the wiring itself. Likewise the
  // admin chunk rows are appended as real DOM elements (className 'chunk'),
  // not innerHTML strings — the innerHTML contract is already pinned, the
  // createElement path is not.
  try {
    const demo = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(demo.status, 200);
    // the ask-form must be submitted via JS, never the native page reload
    assert.ok(demo.body.includes("form.addEventListener('submit', async (e) => {"), 'demo must bind the ask-form submit listener');
    assert.ok(demo.body.includes('e.preventDefault();'), 'demo must prevent the form default page reload');
    // the typed question is echoed as an escaped user bubble, then the box clears
    assert.ok(demo.body.includes("addMsg('user', esc(q));"), 'demo must echo the user question escaped');
    assert.ok(demo.body.includes("input.value = '';"), 'demo must clear the input after echoing the question');
    // the pending bubble captured before fetch is replaced by the rendered answer,
    // and the panel scrolls to the newest message on every send
    assert.ok(demo.body.includes('thinking.innerHTML = renderBotMessage(data);'), 'demo must replace the pending bubble with the rendered answer');
    assert.ok(demo.body.includes('chatEl.scrollTop = chatEl.scrollHeight;'), 'demo must scroll the message area to the newest bubble');

    const admin = await get(`http://localhost:${port}/admin.js`);
    assert.strictEqual(admin.status, 200);
    // chunk rows are real <div class="chunk"> nodes created and appended per
    // chunk — the class name is what /style.css selects on for the preview card
    assert.ok(admin.body.includes("div.className = 'chunk';"), 'admin must build each chunk row as a .chunk element');
    assert.ok(admin.body.includes('chunksBody.appendChild(div);'), 'admin must append each chunk row to the chunk list');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin-side class hooks: the .stats/.stat/.docs-table/.chunk/.danger/.ghost rules style.css ships stay paired with the classes admin.js and admin.html emit', async () => {
  // The demo-side counterpart locks .bot-cite hooks; nothing pins the admin
  // skin. A CSS rewire that restyles admin by id (or drops a rule) would
  // silently orphan the class names the admin page markup and admin.js row
  // renderers emit, so lock the class-name contract on both ends: the served
  // stylesheet must keep every admin rule, admin.js must keep emitting the
  // docs-count stats card and the per-row ghost/danger buttons, and the
  // admin.html skeleton must keep the containers those rules style.
  const { kb, server, port } = await startServer();
  try {
    const css = await get(`http://localhost:${port}/style.css`);
    assert.strictEqual(css.status, 200);
    for (const rule of ['.stats {', '.stat {', '.stat b {', '.stat span {', '.docs-table {', '.docs-table button.danger {', '.docs-table .ghost {', '.chunks {', '.chunk {', '.chunk .chunk-meta {']) {
      assert.ok(css.body.includes(rule), `style.css must keep the admin rule "${rule}"`);
    }

    const admin = await get(`http://localhost:${port}/admin`);
    assert.strictEqual(admin.status, 200);
    assert.ok(admin.body.includes('<div id="stats" class="stats"></div>'), 'admin page must keep the #stats container with the .stats hook');
    assert.ok(admin.body.includes('<table class="docs-table">'), 'admin page must keep the docs table with the .docs-table hook');
    assert.ok(admin.body.includes('<table class="docs-table logs-table">'), 'admin page must keep the logs table with the .logs-table hook');
    assert.ok(admin.body.includes('<div class="chunks" id="chunks-body"></div>'), 'admin page must keep the chunks container with the .chunks hook');

    const js = await get(`http://localhost:${port}/admin.js`);
    assert.strictEqual(js.status, 200);
    assert.ok(js.body.includes('<div class="stat"><b>${docs.length}</b><span>文档</span></div>'), 'docs stats card must render the 文档 stat');
    assert.ok(js.body.includes('<span>分块</span></div>`;'), 'docs stats card must render the 分块 stat');
    assert.ok(js.body.includes('<td><button class="ghost" data-action="view" data-id="${d.id}">查看分块</button></td>'), 'docs rows must keep the .ghost 查看分块 button');
    assert.ok(js.body.includes('<td><button class="danger" data-action="delete" data-id="${d.id}">删除</button></td>'), 'docs rows must keep the .danger 删除 button');
  } finally {
    server.close();
    kb.close();
  }
});

test('demo.js offline FALLBACK presets: the in-page legal/medical/procurement/general presets and the FALLBACK default state survive so the demo boots when /api/domains is unreachable', async () => {
  // The /api/domains wire test locks the server-side presets; demo.js also
  // ships its own copy of the four presets used only while the sync fetch has
  // not resolved. Those FALLBACK strings deliberately differ from the server
  // presets (e.g. the demo legal greeting omits 法律法规, general is 通用 not
  // 通用 · General), so a stale/refused /api/domains still leaves the select,
  // greeting and chips populated. Nothing pins them; a rewire that guts
  // FALLBACK (or inits domains to empty) would render a blank domain toolbar
  // offline while every wire test passes.
  const { kb, server, port } = await startServer();
  try {
    const res = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('const FALLBACK = {'), 'demo.js must still ship the in-page FALLBACK presets');
    assert.ok(res.body.includes('let domains = FALLBACK;'), 'domains must default to FALLBACK before the sync resolves');
    assert.ok(res.body.includes('// In-page fallback so the demo still works if /api/domains is unreachable.'), 'demo.js must keep the offline-resilience comment');
    assert.ok(res.body.includes("label: '法律 · 律师事务所',"), 'FALLBACK legal label must stay');
    assert.ok(res.body.includes("greeting: '您好，我是律所智能问答助手。您可以询问合同、诉讼流程、收费标准等问题。',"), 'FALLBACK legal greeting must stay');
    assert.ok(res.body.includes("label: '医疗 · 诊所',"), 'FALLBACK medical label must stay');
    assert.ok(res.body.includes("greeting: '您好，我是诊所在线导诊助手。可以询问挂号、科室、体检等问题。',"), 'FALLBACK medical greeting must stay');
    assert.ok(res.body.includes("label: '招采 · 中标公告',"), 'FALLBACK procurement label must stay');
    assert.ok(res.body.includes("greeting: '您好，这里是招投标信息助手。可以查询公告要点、投标要求、截止时间。',"), 'FALLBACK procurement greeting must stay');
    assert.ok(res.body.includes("label: '通用',"), 'FALLBACK general preset must stay with its distinct 通用 label');
    assert.ok(res.body.includes("greeting: '您好，这是您专属的知识库问答助手。',"), 'FALLBACK general greeting must stay');
    assert.ok(res.body.includes("examples: ['律师咨询费怎么收取？', '劳动仲裁的流程是什么？', '合同纠纷可以起诉吗？'],"), 'FALLBACK legal chips must stay');
    assert.ok(res.body.includes("examples: [],"), 'FALLBACK general must expose no chips');
  } finally {
    server.close();
    kb.close();
  }
});

test('demo-side class hooks: the .msg/.bot-meta/.chat/.ask-bar/.examples/.demo-card/.demo-toolbar/.demo-footer rules style.css ships stay paired with the classes demo.js emits and index.html carries', async () => {
  // The widget skin contract (rd-msg) and the admin skin (.stats/.docs-table/
  // .chunk/...) are locked; the demo chat skin is not. A rewire that restyles
  // the demo chat by id, or a dropped rule, would silently orphan the class
  // names demo.js message builder emits and the index.html skeleton uses, so
  // lock the class-name contract on all three ends: the served stylesheet must
  // keep every demo-chat rule, demo.js must keep emitting the .msg role class,
  // and index.html must keep the containers those rules select on.
  const { kb, server, port } = await startServer();
  try {
    const css = await get(`http://localhost:${port}/style.css`);
    assert.strictEqual(css.status, 200);
    for (const rule of ['.chat {', '.msg {', '.msg.user {', '.msg.bot {', '.bot-meta {', '.ask-bar {', '.examples {', '.demo-card {', '.demo-toolbar {', '.demo-footer {']) {
      assert.ok(css.body.includes(rule), `style.css must keep the demo-chat rule "${rule}"`);
    }

    const js = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(js.status, 200);
    assert.ok(js.body.includes("el.className = 'msg ' + role;"), 'demo.js must emit the .msg role class its CSS targets');

    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    assert.ok(idx.body.includes('<div id="chat" class="chat"></div>'), 'demo page must keep the chat container with the .chat hook');
    assert.ok(idx.body.includes('<div class="demo-toolbar">'), 'demo page must keep the toolbar with the .demo-toolbar hook');
    assert.ok(idx.body.includes('<section class="demo-card">'), 'demo page must keep the card with the .demo-card hook');
    assert.ok(idx.body.includes('<footer class="demo-footer dim">'), 'demo page must keep the footer with the .demo-footer hook');
  } finally {
    server.close();
    kb.close();
  }
});

test('page-chrome skin: the .demo-header h1/.subtitle/.badges/.badge/.badge-off header rules and the .admin-card/.grid/.upload-row/.logs-table admin rules style.css ships stay paired with the demo-page and admin-page skeletons that carry them', async () => {
  // The three per-feature skins (.bot-cite demo chat, .stats/.docs-table/
  // .chunk admin, rd-* widget) are locked; the shared page chrome is not. The
  // header band — .demo-header h1, .subtitle, .badges/.badge/.badge-off — and
  // the admin card layout — .admin-card, .grid, .upload-row, .logs-table —
  // style both served pages, yet only the .badge-on state and a few heading
  // texts are pinned. A rewire that restyles the chrome by id (or drops a
  // rule) would silently orphan the classes the skeleton markup carries, so
  // lock the CSS rules together with the demo-page/index.html and admin-page
  // carriers they select on.
  const { kb, server, port } = await startServer();
  try {
    const css = await get(`http://localhost:${port}/style.css`);
    assert.strictEqual(css.status, 200);
    for (const rule of ['.demo-header h1 {', '.subtitle {', '.badges {', '.badge {', '.badge-off {', '.admin-card {', '.admin-card h2 {', '.grid {', '.upload-row {', '.upload-row input[type=file] {', '.upload-row button, .docs-table button {', '.logs-table td {', '.dim {', '.small {']) {
      assert.ok(css.body.includes(rule), `style.css must keep the page-chrome rule "${rule}"`);
    }

    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    assert.ok(idx.body.includes('<body class="demo-page">'), 'demo page must carry the demo-page body class');
    assert.ok(idx.body.includes('<header class="demo-header">'), 'demo page must carry the demo-header hook the title rules select on');
    assert.ok(idx.body.includes('<div class="badges">'), 'demo page must carry the badges container the .badge rules style');

    const admin = await get(`http://localhost:${port}/admin`);
    assert.strictEqual(admin.status, 200);
    assert.ok(admin.body.includes('<body class="admin-page">'), 'admin page must carry the admin-page body class');
    assert.ok(admin.body.includes('<section class="grid">'), 'admin page must stack its cards in the .grid container');
    assert.ok(admin.body.includes('<div class="upload-row">'), 'admin page must keep the .upload-row file-and-button row');
  } finally {
    server.close();
    kb.close();
  }
});

test('demo.js domain-change flow re-renders greeting and chips, keeps the selection across auto-sync, caps excerpt at 160 and gates confidence on a top hit', async () => {
  const { kb, server, port } = await startServer();
  // The demo page's domain <select> and example chips are driven by demo.js:
  // switching domains must re-render the greeting and examples, the auto-sync
  // refresh must preserve the user's selection, and renderBotMessage must cap
  // citation excerpts and only claim a confidence percentage when there is a
  // top hit (mirroring the wire contract: miss responses carry no top field).
  try {
    const res = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(res.status, 200);
    // renderFor is the single re-render entry: greeting from the active preset
    // plus a fresh example-chip row (empty for presets without examples).
    assert.ok(res.body.includes("greetingEl.textContent = d.greeting || '';"), 'renderFor must show the active preset greeting');
    assert.ok(res.body.includes('renderExamples();'), 'renderFor must rebuild the example chips');
    // both the change listener and the initial render run renderFor — a domain
    // switch re-renders, and the page opens showing the default domain.
    assert.ok(res.body.includes("domainSelect.addEventListener('change', () => renderFor(domainSelect.value));"), 'domain switch must re-render via renderFor');
    assert.ok(res.body.includes('renderFor(domainSelect.value);'), 'demo must render the initial domain at boot');
    // fillSelect preserves the user's current selection across the /api/domains
    // auto-sync refresh, falling back to the first server preset otherwise.
    assert.ok(res.body.includes('domainSelect.value = domains[prev] ? prev : (list[0] || {}).id;'), 'auto-sync must preserve the selected domain');
    // renderBotMessage: excerpt is capped to 160 characters before interpolation
    // (the wire tests lock excerpt derivation server-side; this is the client's
    // truncation boundary) and the confidence line renders only on a top hit.
    assert.match(res.body, /esc\(c\.excerpt \|\| ''\)\.slice\(0, 160\)/, 'citation excerpt must be capped at 160 chars');
    assert.ok(res.body.includes('const conf = data.top ?'), 'confidence line must be gated on a top hit');
    assert.ok(res.body.includes('<div class="bot-meta">'), 'bot messages must render the meta block');
    assert.ok(res.body.includes('· 模式：'), 'meta block must join confidence and mode');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin.js routes each data function to its wire-locked endpoint; widget close hides the panel; demo input carries the placeholder', async () => {
  const { kb, server, port } = await startServer();
  // The /api/admin/* wire tests and the admin.html form alone do not prove the
  // page's JS actually calls those endpoints from the functions that render
  // them. Lock the data-function -> endpoint pairing so a rewire that points a
  // button at the wrong route (or drops a call) stays visible, plus the widget
  // close button that makes the FAB toggle symmetric, and the demo input
  // placeholder that tells users what to ask.
  try {
    const admin = await get(`http://localhost:${port}/admin.js`);
    assert.strictEqual(admin.status, 200);
    for (const [fn, call] of [
      ['loadStats', "adminFetch('/api/admin/stats')"],
      ['loadDocs (boot + refresh)', "adminFetch('/api/admin/docs')"],
      ['delete', "adminFetch('/api/admin/docs/' + d.id, { method: 'DELETE' })"],
      ['viewChunks', "adminFetch('/api/admin/docs/' + id)"],
      ['loadLogs', "adminFetch('/api/admin/logs?limit=50')"],
      ['upload', "adminFetch('/api/admin/upload', { method: 'POST', body: fd })"],
    ]) {
      assert.ok(admin.body.includes(call), `admin.js ${fn} must call ${call}`);
    }
    // the per-action upload results only exist because the caught response is
    // parsed and mapped; lock the action-key branches the admin panel renders
    assert.ok(admin.body.includes("r.action === 'indexed'"), 'upload results must render the indexed action');
    assert.ok(admin.body.includes("r.action === 'duplicate'"), 'upload results must render the duplicate action');
    assert.ok(admin.body.includes("r.action === 'error'"), 'upload results must render the error action');

    const widget = await get(`http://localhost:${port}/widget.js`);
    assert.strictEqual(widget.status, 200);
    // the close button is the inverse of the FAB toggle — a rewire that breaks
    // close leaves the panel stuck open after dismissal
    assert.match(widget.body, /panel\.querySelector\('#ragdesk-close'\)\.addEventListener\('click', function \(\) \{\n\s*panel\.classList\.remove\('open'\);/);

    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    // the ask input advertises a concrete example so users know what to type
    assert.ok(
      idx.body.includes('placeholder="请输入您的问题，例如：律师咨询费怎么收取？"'),
      'demo ask input must keep the example placeholder'
    );
  } finally {
    server.close();
    kb.close();
  }
});

test('static pages served', async () => {
  const { kb, server, port } = await startServer();
  const idx = await get(`http://localhost:${port}/`);
  assert.strictEqual(idx.status, 200);
  assert.match(idx.body, /RAG-Desk/);
  const admin = await get(`http://localhost:${port}/admin`);
  assert.strictEqual(admin.status, 200);
  server.close();
  kb.close();
});

test('static pages carry the element ids demo.js and admin.js read at startup', async () => {
  const { kb, server, port } = await startServer();
  try {
    // demo.js starts by resolving every one of these via getElementById;
    // a missing id silently kills the page (null.querySelector throws).
    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    for (const id of ['domain-select', 'greeting', 'chat', 'ask-form', 'ask-input', 'examples']) {
      assert.ok(idx.body.includes(`id="${id}"`), `demo page must carry id="${id}"`);
    }
    // admin.js resolves its own set; both pages must keep wiring up.
    const admin = await get(`http://localhost:${port}/admin`);
    assert.strictEqual(admin.status, 200);
    for (const id of ['file-input', 'upload-btn', 'upload-result', 'stats', 'docs-body', 'chunks-card', 'chunks-doc', 'chunks-body', 'logs-body']) {
      assert.ok(admin.body.includes(`id="${id}"`), `admin page must carry id="${id}"`);
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('static page script boot: demo.js/admin.js serve as JS and pages srce them with exact titles', async () => {
  const { kb, server, port } = await startServer();
  // The demo and admin pages boot via <script src="/demo.js|admin.js">; if
  // those assets were renamed/moved (widget.js IS locked, these two are not),
  // the pages would silently load with no behavior. Lock their 200/JS-MIME
  // serving plus the pages' <title> and <script src> so a rewire stays visible.
  try {
    const demoJs = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(demoJs.status, 200);
    assert.match(demoJs.headers['content-type'], /application\/javascript/);
    assert.match(demoJs.body, /ask-form|domain-select/, 'demo.js must keep its chat-driving logic');

    const adminJs = await get(`http://localhost:${port}/admin.js`);
    assert.strictEqual(adminJs.status, 200);
    assert.match(adminJs.headers['content-type'], /application\/javascript/);
    assert.match(adminJs.body, /upload-btn|docs-body/, 'admin.js must keep its admin-driving logic');

    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    assert.match(idx.headers['content-type'], /text\/html/);
    assert.ok(idx.body.includes('<title>RAG-Desk · 离线知识问答演示</title>'), 'demo page must keep its exact title');
    assert.ok(idx.body.includes('<script src="/demo.js"></script>'), 'demo page must src the served demo.js');

    const admin = await get(`http://localhost:${port}/admin`);
    assert.strictEqual(admin.status, 200);
    assert.match(admin.headers['content-type'], /text\/html/);
    assert.ok(admin.body.includes('<title>RAG-Desk · 管理后台</title>'), 'admin page must keep its exact title');
    assert.ok(admin.body.includes('<script src="/admin.js"></script>'), 'admin page must src the served admin.js');
  } finally {
    server.close();
    kb.close();
  }
});

test('/style.css serves as CSS and both statically served pages link it', async () => {
  const { kb, server, port } = await startServer();
  // Neither page hides its layout in inline styles — both link /style.css; if
  // express.static stopped serving the file (or the link tags were dropped),
  // both UIs would render unstyled while the element-id and script tests pass.
  try {
    const css = await get(`http://localhost:${port}/style.css`);
    assert.strictEqual(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/, 'style.css must serve as CSS');
    // byte-exact Content-Length is what express.static sets on file responses
    assert.strictEqual(css.headers['content-length'], String(Buffer.byteLength(css.body)), 'style.css Content-Length must match its bytes');
    // keep a couple of distinctive rules so a rename/regeneration is visible:
    // :root theme vars, the two shells, and one badge state the UIs color by
    assert.ok(css.body.includes(':root {'), 'style.css must keep its theme variables');
    assert.ok(css.body.includes('.demo-shell'), 'style.css must keep the demo layout rules');
    assert.ok(css.body.includes('.admin-shell'), 'style.css must keep the admin layout rules');
    assert.ok(css.body.includes('.badge-on'), 'style.css must keep the badge-on state used by both pages');

    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    assert.ok(idx.body.includes('<link rel="stylesheet" href="/style.css"'), 'demo page must link the served stylesheet');
    const admin = await get(`http://localhost:${port}/admin`);
    assert.strictEqual(admin.status, 200);
    assert.ok(admin.body.includes('<link rel="stylesheet" href="/style.css"'), 'admin page must link the served stylesheet');
  } finally {
    server.close();
    kb.close();
  }
});

test('static pages carry the in-page fallback presets, upload accept-list and nav links the JS renders', async () => {
  const { kb, server, port } = await startServer();
  // The element-id/script tests only prove demo.js CAN find its hooks; the
  // demo page's offline fallback (used when /api/domains sync bails) is that
  // <select> already contains one <option> per domain id, the admin upload
  // form's accept list advertises exactly the extensions isSupportedFile()
  // accepts, and the footer links reach the admin panel and health check.
  try {
    const idx = await get(`http://localhost:${port}/`);
    assert.strictEqual(idx.status, 200);
    // the four fallback options must exist verbatim — a rewire that drops one
    // leaves the demo unable to switch domains when /api/domains is unreachable
    for (const [id, label] of [
      ['legal', '法律 · 律师事务所'],
      ['medical', '医疗 · 诊所'],
      ['procurement', '招采 · 中标公告'],
      ['general', '通用'],
    ]) {
      assert.ok(
        idx.body.includes(`<option value="${id}">${label}</option>`),
        `demo page must keep the ${id} fallback <option> with its exact label`
      );
    }
    assert.strictEqual((idx.body.match(/<option/g) || []).length, 4, 'demo page must not drift from the four preset domains');
    // footer nav: the demo links to the admin panel and the health check
    assert.ok(idx.body.includes('<a href="/admin">管理后台</a>'), 'demo footer must link the admin panel');
    assert.ok(idx.body.includes('<a href="/api/health">健康检查</a>'), 'demo footer must link the health check');
    assert.ok(idx.body.includes('<code>RAG-DESK 数据完全本地存储</code>'), 'demo footer must keep the local-storage slogan');

    const admin = await get(`http://localhost:${port}/admin`);
    assert.strictEqual(admin.status, 200);
    // the accept list must keep matching the server-side whitelist (md, markdown,
    // pdf, docx, txt, csv); a narrower list would silently hide formats the
    // server indexes, a wider one would invite unsupported-kind upload errors
    assert.ok(
      admin.body.includes('accept=".md,.markdown,.pdf,.docx,.txt,.csv"'),
      'admin upload input must advertise exactly the six supported extensions'
    );
    assert.ok(admin.body.includes('<a href="/">返回演示页</a>'), 'admin page must link back to the demo');
  } finally {
    server.close();
    kb.close();
  }
});

test('demo page wiring: chat body shape, error surfacing, domains auto-sync and XSS escape', async () => {
  const { kb, server, port } = await startServer();
  // demo.js is the demo page's only client logic (widget.js has three source
  // wiring suites, demo.js none); a rewire that silently breaks the demo must
  // stay visible. Lock the source-level contracts the wire tests depend on:
  // chat body shape, error surfacing, /api/domains sync guard, HTML escaping
  // and the render fields drawn from /api/chat.
  try {
    const res = await get(`http://localhost:${port}/demo.js`);
    assert.strictEqual(res.status, 200);
    // the demo submits the exact { query, domain } body /api/chat validates; a
    // rewire would silently stop honoring the selected domain preset.
    assert.match(res.body, /JSON\.stringify\(\{ query: q, domain: domainSelect\.value \}\)/);
    // non-ok responses surface the server error (with HTTP status), network
    // failures surface 检索失败 with the escaped reason — never blank/garbage.
    assert.ok(res.body.includes('请求失败（HTTP ${res.status}）：${esc((data && data.error) || \'服务器未返回错误详情\')}'), 'demo.js must surface server errors with status');
    assert.ok(res.body.includes('检索失败：${esc(err.message)}'), 'demo.js must surface network failures with the reason');
    // /api/domains auto-sync replaces the in-page FALLBACK presets; the guard
    // keeps a malformed/empty payload from wiping the select options.
    assert.match(res.body, /fetch\('\/api\/domains'\)/);
    assert.ok(res.body.includes('if (!Array.isArray(data.domains) || !data.domains.length) return;'), 'domains sync must guard non-array/empty payloads');
    assert.ok(res.body.includes('map[d.id] = { greeting: d.greeting, examples: d.examples || [] };'), 'domains sync must build the preset map');
    // every field interpolated into bot messages is HTML-escaped before innerHTML
    assert.match(res.body, /replace\(\/\[&<>"']\/g/, 'demo.js must escape HTML metacharacters before innerHTML');
    // renderBotMessage draws answer/citation/confidence/mode from the /api/chat
    // payload — the same fields the wire tests lock on the endpoint.
    assert.ok(res.body.includes("esc(data.answer).replace(/\\n/g, '<br>')"), 'answer must render newlines as <br>');
    assert.ok(res.body.includes('esc(c.document)}</span> §${c.paragraph}：${ex}'), 'citations must render document §paragraph: excerpt');
    assert.ok(res.body.includes('Math.round((data.confidence || 0) * 100)}%'), 'confidence must render as a percentage');
    assert.match(res.body, /'offline-retrieval' \? '离线检索' : '检索\+LLM'/, 'mode must render offline-retrieval distinctly');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin page wiring: auto-sync boot, token-gated retry, error surfacing and per-file upload results', async () => {
  const { kb, server, port } = await startServer();
  // admin.js is the admin page's only client logic and now the last of the
  // three client scripts without a source-level wiring lock (demo.js locked at
  // a04adbf, widget.js earlier); a rewire that silently breaks the panel must
  // stay visible. Lock the source contracts the admin wire tests depend on.
  try {
    const res = await get(`http://localhost:${port}/admin.js`);
    assert.strictEqual(res.status, 200);
    // boots by loading docs and logs; the docs load also renders the stats card
    assert.match(res.body, /loadDocs\(\)/, 'admin.js must boot the docs list');
    assert.match(res.body, /loadLogs\(\)/, 'admin.js must boot the logs list');
    // token gate: one 401 retry after a single prompt, with no re-prompt loop
    assert.ok(res.body.includes("prompt('该后台需要访问令牌（RAGDESK_ADMIN_TOKEN），请输入：')"), 'token gate must prompt like a file upload');
    assert.match(res.body, /if \(res\.status === 401 && !retried\)/, '401 must trigger exactly one retry');
    assert.ok(res.body.includes('return adminFetch(url, opts, true); // retry once; a still-401 response surfaces as an error, no re-prompt loop'), 'admin.js must document the no-re-prompt-loop contract');
    // upload posts multipart FormData and renders per-file indexed/duplicate/error
    // results exactly as the wire tests lock on /api/admin/upload
    assert.match(res.body, /new FormData\(\)/, 'upload must collect files into FormData');
    assert.ok(res.body.includes("fd.append('files', f)"), 'upload must append files under the files field');
    assert.ok(res.body.includes("if (r.action === 'indexed') return `${r.filename}: 已索引（${r.chunks} 分块）`;"), 'indexed results must render chunk count');
    assert.ok(res.body.includes("if (r.action === 'duplicate') return `${r.filename}: 内容已存在，跳过`;"), 'duplicate results must render the skip reason');
    assert.ok(res.body.includes("if (r.action === 'error') return `${r.filename}: 失败 — ${r.error || '未知错误'}`;"), 'error results must surface the failure reason');
    // docs/logs rows surface server errors with HTTP status instead of blank rows
    assert.ok(res.body.includes('加载失败（HTTP ${res.status}）：${esc(data.error || \'服务器未返回错误详情\')}'), 'admin.js must surface docs/logs load errors with status');
    // every field interpolated into rows is HTML-escaped before innerHTML
    assert.match(res.body, /replace\(\/\[&<>"']\/g/, 'admin.js must escape HTML metacharacters before innerHTML');
  } finally {
    server.close();
    kb.close();
  }
});

test('CORS preflight passes without credentials even when endpoint auth is on', async () => {
  const { kb, server, port } = await startServer({ adminToken: 'adm', chatToken: 'ch0' });
  // browsers always send the preflight before the credentialed request; a
  // token-gated route must still answer the OPTIONS with 204 so the widget
  // chat and admin DELETE actually fire.
  const admin = await new Promise((resolve, reject) => {
    http
      .request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/docs/1',
          method: 'OPTIONS',
          headers: { Origin: 'https://console.example', 'Access-Control-Request-Method': 'DELETE' },
        },
        (r) => {
          r.resume();
          r.on('end', () => resolve({ status: r.statusCode, allowOrigin: r.headers['access-control-allow-origin'] }));
        }
      )
      .on('error', reject)
      .end();
  });
  assert.strictEqual(admin.status, 204, 'admin preflight without x-admin-token must pass');
  assert.strictEqual(admin.allowOrigin, 'https://console.example');

  const chat = await new Promise((resolve, reject) => {
    http
      .request(
        {
          host: 'localhost',
          port,
          path: '/api/chat',
          method: 'OPTIONS',
          headers: { Origin: 'https://customer.example', 'Access-Control-Request-Method': 'POST' },
        },
        (r) => {
          r.resume();
          r.on('end', () => resolve({ status: r.statusCode, allowOrigin: r.headers['access-control-allow-origin'] }));
        }
      )
      .on('error', reject)
      .end();
  });
  assert.strictEqual(chat.status, 204, 'chat preflight without Authorization must pass');
  assert.strictEqual(chat.allowOrigin, 'https://customer.example');
  server.close();
  kb.close();
});

test('CORS preflight advertises the exact Allow-Methods and Allow-Headers sets the routes use', async () => {
  const { kb, server, port } = await startServer({ adminToken: 'adm', chatToken: 'ch0' });
  // The browsers that drive the widget (demo/chat) and the admin panel read the
  // OPTIONS response to decide which method/headers the REAL request may carry:
  // a preflight that stops advertising "x-admin-token" would silently turn the
  // token-gated admin upload/DELETE into an indistinguishable CORS network
  // failure (no console, blank panel). The existing preflight test pins only
  // 204 + allow-origin; the parser-error (6ba71f0), actual-response (95206b3)
  // and error-response (301e5ca) suites lock the same header pair on their own
  // paths, so lock the pair on the preflight branch itself — pinned and
  // reflected — with the exact server strings, and confirm the 204 body stays
  // empty (res.end() after the header write, no content-type).
  const preflight = (reqPath, requestMethod, origin, targetPort = port) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port: targetPort,
          path: reqPath,
          method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': requestMethod },
        },
        (r) => {
          r.resume();
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              allowOrigin: r.headers['access-control-allow-origin'],
              allowMethods: r.headers['access-control-allow-methods'],
              allowHeaders: r.headers['access-control-allow-headers'],
              contentType: r.headers['content-type'],
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
  try {
    // reflected-origin branches: chat POST and admin DELETE, both under active
    // token gates that the preflight must NOT trip (browsers send no token yet)
    for (const [reqPath, requestMethod] of [
      ['/api/chat', 'POST'],
      ['/api/admin/docs/1', 'DELETE'],
      ['/api/health', 'GET'],
    ]) {
      const r = await preflight(reqPath, requestMethod, 'https://customer.example');
      assert.strictEqual(r.status, 204, `${reqPath} preflight must answer 204 with no body`);
      assert.strictEqual(r.allowOrigin, 'https://customer.example', `${reqPath} preflight reflects the origin`);
      assert.strictEqual(
        r.allowMethods,
        'GET,POST,DELETE,OPTIONS',
        `${reqPath} preflight must advertise exactly the methods the server routes support`
      );
      assert.strictEqual(
        r.allowHeaders,
        'Content-Type, x-admin-token, Authorization',
        `${reqPath} preflight must advertise the x-admin-token/Authorization headers the gated routes read`
      );
      assert.strictEqual(r.contentType, undefined, `${reqPath} preflight ends with .end() and no content-type/length`);
    }

    // pinned branch: RAGDESK_ALLOW_ORIGIN emits the allow-origin verbatim while
    // the method/header set is identical, so a pinned deploy still lets the
    // browser preflight the same real request shape.
    const app2 = buildApp(kb, { allowOrigin: 'https://pinned.example' });
    const server2 = await new Promise((resolve) => {
      const s = app2.listen(0, () => resolve(s));
    });
    try {
      const pinned = await preflight(
        '/api/admin/docs/1',
        'DELETE',
        'https://customer.example',
        server2.address().port
      );
      assert.strictEqual(pinned.status, 204);
      assert.strictEqual(pinned.allowOrigin, 'https://pinned.example', 'pinned preflight origin is emitted verbatim');
      assert.strictEqual(pinned.allowMethods, 'GET,POST,DELETE,OPTIONS');
      assert.strictEqual(pinned.allowHeaders, 'Content-Type, x-admin-token, Authorization');
    } finally {
      server2.close();
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('token-gated admin and chat endpoints reject without their tokens', async () => {
  const { kb, server, port } = await startServer({ adminToken: 'adm0', chatToken: 'ch0' });
  try {
    // Admin gate: RAGDESK_ADMIN_TOKEN set -> /api/admin/* must require the
    // x-admin-token header, including reading the audit trail and mutating.
    const docsNoAuth = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docsNoAuth.status, 401);
    assert.strictEqual(docsNoAuth.body.error, 'unauthorized: missing or invalid x-admin-token');

    const docsWrong = await new Promise((resolve, reject) => {
      http
        .request(
          { host: 'localhost', port, path: '/api/admin/docs', method: 'GET', headers: { 'x-admin-token': 'nope' } },
          (r) => {
            r.resume();
            r.on('end', () => resolve(r.statusCode));
          }
        )
        .on('error', reject)
        .end();
    });
    assert.strictEqual(docsWrong, 401, 'wrong admin token must also be rejected');

    const docDeleteWrong = await new Promise((resolve, reject) => {
      http
        .request(
          { host: 'localhost', port, path: '/api/admin/docs/1', method: 'DELETE', headers: { 'x-admin-token': 'nope' } },
          (r) => {
            r.resume();
            r.on('end', () => resolve(r.statusCode));
          }
        )
        .on('error', reject)
        .end();
    });
    assert.strictEqual(docDeleteWrong, 401, 'admin mutation must be token-gated');

    // Chat gate: RAGDESK_CHAT_TOKEN set -> /api/chat requires Bearer. The body
    // is valid JSON even without auth, so a 401 here proves the gate, not a
    // validation error.
    const chatNoAuth = await post(`http://localhost:${port}/api/chat`, { query: '诊所几点开门' });
    assert.strictEqual(chatNoAuth.status, 401);
    assert.strictEqual(chatNoAuth.body.error, 'unauthorized');

    const chatWrong = await post(`http://localhost:${port}/api/chat`, { query: '诊所几点开门' });
    // same helper has no header knob; craft the request directly to assert 401
    // is about the token, not the payload shape.
    const wrongTok = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ query: '诊所几点开门' });
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/chat',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer bad' },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(wrongTok.status, 401);
    assert.strictEqual(wrongTok.body.error, 'unauthorized');

    // Correct tokens (and only correct tokens) open the routes.
    const health = await get(`http://localhost:${port}/api/health`);
    assert.strictEqual(health.status, 200, 'health stays public');

    const docsOk = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docsOk.status, 401, 'plain GET still rejected');
    const docsGood = await new Promise((resolve, reject) => {
      http
        .request(
          { host: 'localhost', port, path: '/api/admin/docs', method: 'GET', headers: { 'x-admin-token': 'adm0' } },
          (r) => {
            let out = '';
            r.on('data', (c) => (out += c));
            r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
          }
        )
        .on('error', reject)
        .end();
    });
    assert.strictEqual(docsGood.status, 200, 'correct admin token opens the docs list');

    const chatGood = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ query: '诊所几点开门' });
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            Authorization: 'Bearer ch0',
          },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(chatGood.status, 200, 'correct chat token opens /api/chat');
  } finally {
    server.close();
    kb.close();
  }
});

test('configured admin token gates log, stats and doc-detail reads and the upload write; public routes stay open', async () => {
  const { kb, server, port } = await startServer({ adminToken: 'adm1' });
  // The baseline token test pinned docs-list/delete and chat; this one pins the
  // REMAINING /api/admin/* routes under a configured token. Discriminators:
  //  - a missing-token GET on an unknown doc id must read 401 (the gate STEPS
  //    BEFORE the 404 lookup), never a leak of the not-found body;
  //  - an unauthenticated upload carrying a VALID multipart file must 401 and,
  //    crucially, must NOT index it (gate precedes multer + handler, so auth
  //    failure has zero side effects);
  //  - health and domains stay public when only the admin token is configured.
  const withAdmin = (method, reqPath, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port, path: reqPath, method, headers: { 'x-admin-token': 'adm1', ...headers } },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => {
            let body = out;
            try { body = JSON.parse(out || '{}'); } catch (_) { /* keep raw */ }
            resolve({ status: r.statusCode, body });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  try {
    // logs and stats reads reject without the token…
    assert.strictEqual((await get(`http://localhost:${port}/api/admin/logs`)).status, 401);
    assert.strictEqual((await get(`http://localhost:${port}/api/admin/stats`)).status, 401);
    // …and open with it (empty DB: stable empty shapes).
    const logs = await withAdmin('GET', '/api/admin/logs');
    assert.strictEqual(logs.status, 200);
    assert.deepStrictEqual(logs.body, { logs: [], stats: { total: 0, with_answer: 0 } });
    assert.strictEqual((await withAdmin('GET', '/api/admin/stats')).status, 200);

    // doc detail: 401 when unauthenticated even though the doc id doesn't
    // exist — the gate must run before the 404 lookup.
    assert.strictEqual((await get(`http://localhost:${port}/api/admin/docs/999`)).status, 401);
    assert.strictEqual((await withAdmin('GET', '/api/admin/docs/999')).status, 404);
    assert.equal((await withAdmin('GET', '/api/admin/docs/999')).body.error, 'not found');

    // upload: a valid multipart file posted WITHOUT the token is rejected at
    // the gate, and the bytes are NOT indexed (auth failure has no side
    // effect). The same bytes with the token index cleanly.
    const boundary = '----rd-auth';
    const content = Buffer.from('关于新设备采购的中标通知，中标人蓝天科技公司。');
    const multipart = (authHeader) => {
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="secret.md"\r\nContent-Type: text/markdown\r\n\r\n`
        ),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: 'localhost',
            port,
            path: '/api/admin/upload',
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': body.length,
              ...(authHeader ? { 'x-admin-token': 'adm1' } : {}),
            },
          },
          (r) => {
            let out = '';
            r.on('data', (c) => (out += c));
            r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    };
    const unauthUpload = await multipart(false);
    assert.strictEqual(unauthUpload.status, 401);
    assert.deepStrictEqual(await kb.getAllDocs(), [], 'unauthorized upload must not index anything');
    const authUpload = await multipart(true);
    assert.strictEqual(authUpload.status, 200);
    assert.strictEqual(authUpload.body.results[0].action, 'indexed');
    assert.deepStrictEqual((await kb.getAllDocs()).map((d) => d.filename), ['secret.md']);

    // public surfaces stay open under a configured admin token.
    assert.strictEqual((await get(`http://localhost:${port}/api/health`)).status, 200);
    const domains = await get(`http://localhost:${port}/api/domains`);
    assert.strictEqual(domains.status, 200);
    assert.ok(domains.body.domains.length >= 1, 'domain presets remain public');
  } finally {
    server.close();
    kb.close();
  }
});

test('chat-only token: /api/chat is gated while the admin area stays fully open', async () => {
  const { kb, server, port } = await startServer({ chatToken: 'onlyChat' });
  // The auth matrix pins both-tokens-on (admin0/chat0) and admin-only; this
  // locks the THIRD corner: RAGDESK_CHAT_TOKEN configured with no admin token.
  // Discriminators:
  //  - /api/chat without/wrong Bearer -> the exact 401 (gate BEFORE body
  //    parsing), with the correct token -> 200 and indexed answers;
  //  - /api/admin/* (docs/stats/logs/upload/delete) needs NO token at all —
  //    assertAdmin is a no-op when adminToken is empty, so chat gating must not
  //    leak onto the admin surface;
  //  - health/domains stay public as always.
  const chat = (auth) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify({ query: '诊所几点开门' });
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out || '{}') }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  try {
    await kb.ingestBuffer('clinic.md', Buffer.from('诊所工作时间：周一至周六 8:00-18:00，周日休息。'));

    // chat gate: no token and wrong token are both the exact 401; the correct
    // token answers (so the 401 is about auth, not the payload).
    const none = await chat();
    assert.strictEqual(none.status, 401);
    assert.deepStrictEqual(none.body, { error: 'unauthorized' }, 'missing Bearer on gated chat is the exact 401');

    const wrong = await chat('wrongTok');
    assert.strictEqual(wrong.status, 401);
    assert.deepStrictEqual(wrong.body, { error: 'unauthorized' }, 'wrong Bearer is the exact 401');

    const good = await chat('onlyChat');
    assert.strictEqual(good.status, 200, 'correct Bearer opens /api/chat');
    assert.ok(good.body.citations.length >= 1, 'gated-but-authenticated chat still answers from the index');
    assert.strictEqual(good.body.top.document, 'clinic.md');

    // admin area: every route is open without any token when admin is unset.
    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.status, 200, 'docs list needs no token when only chat is gated');
    assert.strictEqual(docs.body.docs.length, 1);
    assert.strictEqual((await get(`http://localhost:${port}/api/admin/stats`)).status, 200);
    assert.strictEqual((await get(`http://localhost:${port}/api/admin/logs`)).status, 200);

    // admin write path open too: delete then re-upload works without a token.
    const delRes = await new Promise((resolve, reject) => {
      http
        .request({ host: 'localhost', port, path: '/api/admin/docs/1', method: 'DELETE' }, (r) => {
          r.resume();
          r.on('end', () => resolve(r.statusCode));
        })
        .on('error', reject)
        .end();
    });
    assert.strictEqual(delRes, 200, 'admin delete needs no token when only chat is gated');
    assert.deepStrictEqual(await kb.getAllDocs(), [], 'delete took effect without a token');

    const boundary = '----rd-chatonly';
    const content = Buffer.from('关于采购代理服务的招标公告，投标截止时间为下月十五日。');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="tender.md"\r\nContent-Type: text/markdown\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.strictEqual(up.status, 200, 'admin upload needs no token when only chat is gated');
    assert.strictEqual(up.body.results[0].action, 'indexed');

    // public surfaces stay public.
    assert.strictEqual((await get(`http://localhost:${port}/api/health`)).status, 200);
    assert.strictEqual((await get(`http://localhost:${port}/api/domains`)).status, 200);
  } finally {
    server.close();
    kb.close();
  }
});

test('chatAuth matches the whole Authorization header: the bare token alone is not enough', async () => {
  const { kb, server, port } = await startServer({ chatToken: 's3cret', adminToken: '' });
  // chatAuth compares the ENTIRE Authorization header to exactly
  // `Bearer ${chatToken}` (an exact string compare, not a token extract). So a
  // client that sends the raw token with no "Bearer " scheme, the scheme with a
  // stray space, or a differently-cased scheme — must ALL 401, even though each
  // carries the right secret. Widget deployments hand the configured token to
  // widget.js, which always prefixes "Bearer "; a secured chat must not accept
  // an alternative spelling.
  const chat = (authHeader) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify({ query: '几点开门' });
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out || '{}') }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  try {
    const badVariants = [
      's3cret', // bare token, no scheme
      'Bearer  s3cret', // double space between scheme and token
      'bearer s3cret', // lowercase scheme
      'Bearer s3ret', // token itself differs
    ];
    for (const h of badVariants) {
      const res = await chat(h);
      assert.strictEqual(res.status, 401, `variant ${JSON.stringify(h)} must 401`);
      assert.deepStrictEqual(res.body, { error: 'unauthorized' });
    }

    const ok = await chat('Bearer s3cret');
    assert.strictEqual(ok.status, 200, 'the exact "Bearer <token>" spelling must still open chat');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin gate reads only the exact x-admin-token header, not Authorization — the two gates live on separate keys', async () => {
  const { kb, server, port } = await startServer({ adminToken: 'adm0', chatToken: 'ch0' });
  // The preflight advertises "Content-Type, x-admin-token, Authorization" and
  // chatAuth reads Authorization, but nothing pins WHERE the admin gate reads
  // FROM: every existing token test sends the token in a header literally
  // spelled x-admin-token (the same constant assertAdmin compares), so a
  // refactor that moved admin auth onto Authorization — or an accidental swap
  // of the two secrets — would keep every test green while silently letting
  // one deployment's token open the wrong surface.
  const adminReq = (headers) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: 'localhost', port, path: '/api/admin/docs', method: 'GET', headers }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      });
      r.on('error', reject);
      r.end();
    });
  try {
    // The admin token must NOT be importable via the chat gate's key.
    const adminTokAsBearer = await adminReq({ Authorization: 'Bearer adm0' });
    assert.strictEqual(adminTokAsBearer.status, 401, 'admin token inside Authorization must not open admin');
    assert.strictEqual(adminTokAsBearer.body.error, 'unauthorized: missing or invalid x-admin-token');

    // A chat token in Authorization must not satisfy the admin gate either.
    const chatTokAsBearer = await adminReq({ Authorization: 'Bearer ch0' });
    assert.strictEqual(chatTokAsBearer.status, 401, 'the chat token must not open admin via Authorization');

    // The exact key still opens it, proving the 401s are about the header key,
    // not about auth being broken.
    const good = await adminReq({ 'x-admin-token': 'adm0' });
    assert.strictEqual(good.status, 200, 'the exact x-admin-token header still opens admin');

    // Symmetrically, the chat gate must reject the admin key: chat auth is
    // Authorization-only, so a client crossing the keys is locked out.
    const chatRes = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ query: '几点开门' });
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/chat',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-admin-token': 'ch0' },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out || '{}') }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(chatRes.status, 401, 'chat must not accept the correct chat token in the x-admin-token header');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload with no files returns a stable JSON 400', async () => {
  const { kb, server, port } = await startServer();
  // POST with no multipart body at all
  const noBody = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port, path: '/api/admin/upload', method: 'POST' },
      (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => {
          try {
            resolve({ status: r.statusCode, body: JSON.parse(out) });
          } catch (_) {
            resolve({ status: r.statusCode, body: out });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(noBody.status, 400);
  assert.strictEqual(noBody.body.error, 'no files', 'empty upload must name the reason');

  // multipart with zero file parts
  const boundary = '----rd-none';
  const emptyMulti = Buffer.from(`--${boundary}--\r\n`);
  const noFiles = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/admin/upload',
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': emptyMulti.length },
      },
      (r) => {
        let out = '';
        r.on('data', (c) => (out += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
      }
    );
    req.on('error', reject);
    req.write(emptyMulti);
    req.end();
  });
  assert.strictEqual(noFiles.status, 400);
  assert.strictEqual(noFiles.body.error, 'no files');
  server.close();
  kb.close();
});
test('/api/domains returns preset domains with labels and example questions', async () => {
  const { kb, server, port } = await startServer();
  try {
    const res = await get(`http://localhost:${port}/api/domains`);
    assert.strictEqual(res.status, 200);
    const ids = res.body.domains.map((d) => d.id);
    assert.ok(ids.includes('legal'));
    assert.ok(ids.includes('medical'));
    assert.ok(ids.includes('procurement'));
    assert.ok(ids.includes('general'));
    const legal = res.body.domains.find((d) => d.id === 'legal');
    assert.match(legal.label, /法律/);
    assert.ok(Array.isArray(legal.examples) && legal.examples.length > 0);
    assert.ok(res.body.domains.every((d) => d.greeting));

    // demo.js renders every preset entry: fillSelect shows d.label, ask() swaps
    // the greeting and example chips from d.greeting/d.examples. Lock the exact
    // per-domain content so a preset change that breaks the demo page fails.
    const byId = Object.fromEntries(res.body.domains.map((d) => [d.id, d]));
    assert.strictEqual(byId.legal.label, '法律 · 律师事务所');
    assert.strictEqual(
      byId.legal.greeting,
      '您好，我是律所智能问答助手。您可以询问合同、诉讼流程、收费标准、法律法规等问题。'
    );
    assert.deepStrictEqual(byId.legal.examples, [
      '律师咨询费怎么收取？',
      '劳动仲裁的流程是什么？',
      '合同纠纷可以起诉吗？',
    ]);
    assert.strictEqual(byId.medical.label, '医疗 · 诊所');
    assert.strictEqual(
      byId.medical.greeting,
      '您好，我是诊所在线导诊助手。可以询问挂号、科室、复诊流程与医保报销等问题。'
    );
    assert.deepStrictEqual(byId.medical.examples, ['挂号需要带什么？', '儿童接种疫苗时间？', '可以刷医保卡吗？']);
    assert.strictEqual(byId.procurement.label, '招采 · 中标公告');
    assert.strictEqual(
      byId.procurement.greeting,
      '您好，这里是招投标信息助手。可以查询公告要点、投标要求、截止时间与联系方式。'
    );
    assert.deepStrictEqual(byId.procurement.examples, [
      '这个项目什么时候截止投标？',
      '中标人是谁？',
      '项目预算金额是多少？',
    ]);
    assert.strictEqual(byId.general.label, '通用 · General');
    assert.strictEqual(byId.general.greeting, '您好，这是您专属的知识库问答助手。');
    assert.deepStrictEqual(byId.general.examples, [], 'general exposes no preset example chips');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/domains body is exactly { domains } exposing only the four public fields per preset', async () => {
  const { kb, server, port } = await startServer();
  // chat/docs/logs/stats all have whole-body locks; /api/domains is the last
  // public endpoint without one. demo.js reads only id/label/greeting/examples,
  // so the response must NOT leak engine-internal preset fields
  // (fallback/lead/footer/systemPrompt) onto the public wire, and the four
  // presets must arrive in preset-definition order (legal/medical/procurement/
  // general) matching the select dropdown demo.js builds.
  try {
    const res = await get(`http://localhost:${port}/api/domains`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body), ['domains'], 'body must be exactly { domains }, nothing else');
    assert.deepStrictEqual(
      res.body.domains.map((d) => Object.keys(d).sort()),
      [
        ['examples', 'greeting', 'id', 'label'].sort(),
        ['examples', 'greeting', 'id', 'label'].sort(),
        ['examples', 'greeting', 'id', 'label'].sort(),
        ['examples', 'greeting', 'id', 'label'].sort(),
      ],
      'each preset row exposes exactly id/label/greeting/examples — no internal fields leak'
    );
    assert.deepStrictEqual(
      res.body.domains.map((d) => d.id),
      ['legal', 'medical', 'procurement', 'general'],
      'presets arrive in source definition order'
    );

    // presets are static config: a chat under the same domain must not change
    // what /api/domains exposes
    await post(`http://localhost:${port}/api/chat`, { query: '几点开门', domain: 'medical' });
    const again = await get(`http://localhost:${port}/api/domains`);
    assert.deepStrictEqual(again.body, res.body, 'presets are stable and identical after a chat');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/stats reports total and matched query counts', async () => {
  const { kb, server, port } = await startServer();
  const before = await get(`http://localhost:${port}/api/admin/stats`);
  assert.strictEqual(before.status, 200);
  assert.strictEqual(before.body.stats.total, 0);
  assert.strictEqual(before.body.stats.with_answer, 0, 'empty DB must report 0, not null');

  await kb.ingestBuffer('q.md', Buffer.from('本诊所工作日 8:00 开门。'));
  await post(`http://localhost:${port}/api/chat`, { query: '诊所以什么时间开门' });
  const after = await get(`http://localhost:${port}/api/admin/stats`);
  assert.strictEqual(after.body.stats.total, 1);
  assert.strictEqual(after.body.stats.with_answer, 1);
  server.close();
  kb.close();
});

test('/api/admin/stats counts a miss toward total but not with_answer', async () => {
  const { kb, server, port } = await startServer();
  // admin.js computes 命中率 = with_answer/total client-side; a no-hit query
  // must still count toward the query total while leaving with_answer at 0,
  // otherwise a miss would drag the hit rate toward 100%.
  try {
    const miss = await post(`http://localhost:${port}/api/chat`, { query: 'qqq zzz xxx' });
    assert.strictEqual(miss.status, 200);
    assert.strictEqual(miss.body.citations.length, 0, 'probe must actually miss');
    const stats = await get(`http://localhost:${port}/api/admin/stats`);
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.stats.total, 1, 'a miss is still a logged query');
    assert.strictEqual(stats.body.stats.with_answer, 0, 'a miss must not count as answered');
  } finally {
    server.close();
    kb.close();
  }
});

test('CORS headers ride on actual responses, not just preflight', async () => {
  const { kb, server, port } = await startServer();
  // Cross-origin widgets depend on the real GET/POST responses carrying CORS
  // headers so the browser lets the page read the body; preflight alone is not
  // enough. The default (no RAGDESK_ALLOW_ORIGIN) reflects the request origin.
  const withOrigin = (method, reqPath, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port, path: reqPath, method, headers: { Origin: 'https://page.example', ...headers } },
        (r) => {
          r.resume();
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              allowOrigin: r.headers['access-control-allow-origin'],
              allowMethods: r.headers['access-control-allow-methods'],
              allowHeaders: r.headers['access-control-allow-headers'],
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

  const health = await withOrigin('GET', '/api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.allowOrigin, 'https://page.example', 'GET response must reflect the origin');
  assert.strictEqual(health.allowMethods, 'GET,POST,DELETE,OPTIONS');
  assert.strictEqual(health.allowHeaders, 'Content-Type, x-admin-token, Authorization');

  const chat = await withOrigin('POST', '/api/chat', {
    'Content-Type': 'application/json',
    'Content-Length': '0',
  });
  assert.strictEqual(chat.status, 400, 'empty body 400 still carries CORS headers');
  assert.strictEqual(chat.allowOrigin, 'https://page.example', 'error responses must stay cross-origin readable');

  // requests WITHOUT an Origin stay CORS-free (same-origin traffic, no leak)
  const sameOrigin = await new Promise((resolve, reject) => {
    http
      .get({ host: 'localhost', port, path: '/api/health' }, (r) => {
        r.resume();
        r.on('end', () => resolve(r.headers['access-control-allow-origin']));
      })
      .on('error', reject);
  });
  assert.strictEqual(sameOrigin, undefined, 'no Origin header => no CORS headers');
  server.close();
  kb.close();
});

test('CORS headers ride on error responses too (401/404 stay cross-origin readable)', async () => {
  const { kb, server, port } = await startServer({ adminToken: 'adm0', chatToken: 'ch0' });
  // Browser widgets must be able to READ a rejection even when the request
  // fails: without Access-Control-Allow-Origin on the 401/404 the browser
  // masks the JSON error as a network failure and admin.js / demo.js would
  // silently blank instead of surfacing "unauthorized". The CORS middleware
  // runs before auth and the /api 404 catch-all, so every error response that
  // follows an Origin request must still carry the header.
  const withOrigin = (method, reqPath, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port, path: reqPath, method, headers: { Origin: 'https://page.example', ...headers } },
        (r) => {
          r.resume();
          r.on('end', () =>
            resolve({ status: r.statusCode, body: r.headers['content-type'], allowOrigin: r.headers['access-control-allow-origin'] })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
  try {
    // admin 401 (missing x-admin-token) still reflects the origin
    const admin = await withOrigin('GET', '/api/admin/docs');
    assert.strictEqual(admin.status, 401);
    assert.strictEqual(admin.allowOrigin, 'https://page.example', 'admin 401 must stay cross-origin readable');

    // chat 401 (missing Bearer) still reflects the origin
    const chat = await withOrigin('POST', '/api/chat', {
      'Content-Type': 'application/json',
      'Content-Length': '0',
    });
    assert.strictEqual(chat.status, 401);
    assert.strictEqual(chat.allowOrigin, 'https://page.example', 'chat 401 must stay cross-origin readable');

    // unknown API path 404 still reflects the origin
    const unknown = await withOrigin('GET', '/api/nope');
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.allowOrigin, 'https://page.example', 'api 404 must stay cross-origin readable');

    // even the central error-handler responses (500 path) keep CORS headers
    const failingKb = {
      engineInfo: () => {
        throw new Error('boom');
      },
      getQueryStats: () => ({ total: 0, with_answer: 0 }),
    };
    const app2 = buildApp(failingKb, {});
    const server2 = await new Promise((resolve) => {
      const s = app2.listen(0, () => resolve(s));
    });
    try {
      const res = await new Promise((resolve, reject) => {
        http
          .get(
            { host: 'localhost', port: server2.address().port, path: '/api/health', headers: { Origin: 'https://page.example' } },
            (r) => {
              r.resume();
              r.on('end', () =>
                resolve({ status: r.statusCode, allowOrigin: r.headers['access-control-allow-origin'] })
              );
            }
          )
          .on('error', reject);
      });
      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.allowOrigin, 'https://page.example', 'engine 500 must stay cross-origin readable');
    } finally {
      server2.close();
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('CORS headers ride on the 413 oversized-body error too (body parsers run after CORS)', async () => {
  const { kb, server, port } = await startServer();
  // express.json() caps the body at 2mb, so the 413 comes out of the body
  // parser BEFORE the route. If the CORS middleware sat after it, a browser
  // widget posting an oversized payload would get a header-less 413 and the
  // browser would mask the readable JSON as a CORS network failure. Lock that
  // the rejected request still reflects the Origin with the full CORS set.
  try {
    const huge = JSON.stringify({ query: 'x'.repeat(2 * 1024 * 1024 + 100) });
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(huge),
            Origin: 'https://widget.example',
          },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              allowOrigin: r.headers['access-control-allow-origin'],
              allowMethods: r.headers['access-control-allow-methods'],
              body: JSON.parse(out),
            })
          );
        }
      );
      req.on('error', reject);
      req.write(huge);
      req.end();
    });
    assert.strictEqual(res.status, 413, 'oversized JSON body must 413');
    assert.match(res.body.error, /request body too large/);
    assert.strictEqual(res.allowOrigin, 'https://widget.example', '413 must stay cross-origin readable');
    assert.strictEqual(res.allowMethods, 'GET,POST,DELETE,OPTIONS');
  } finally {
    server.close();
    kb.close();
  }
});

test('CORS headers ride on the 400 malformed-JSON parse error too (parse-failed branch)', async () => {
  const { kb, server, port } = await startServer();
  // express.json() rejects a non-JSON body with entity.parse.failed BEFORE the
  // route; the central handler maps it to a 400. Same CORS concern as the 413:
  // a browser widget posting a broken payload must still be able to READ the
  // JSON error (masked as a network failure otherwise), so lock the reflected
  // Origin with the full header set AND the exact stable err.message body that
  // production.test.js only asserts loosely by type, un-origined.
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength('{bad json'),
            Origin: 'https://widget.example',
          },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              allowOrigin: r.headers['access-control-allow-origin'],
              allowMethods: r.headers['access-control-allow-methods'],
              allowHeaders: r.headers['access-control-allow-headers'],
              ct: r.headers['content-type'],
              body: JSON.parse(out),
            })
          );
        }
      );
      req.on('error', reject);
      req.write('{bad json');
      req.end();
    });
    assert.strictEqual(res.status, 400, 'malformed JSON body must 400, not 500/HTML');
    assert.match(res.ct, /application\/json/, 'parse errors must stay stable JSON for client JSON.parse');
    assert.match(res.body.error, /Expected property name or '}'/, 'parse-failed surfaces the parser message as error');
    assert.strictEqual(res.allowOrigin, 'https://widget.example', '400 parse error must stay cross-origin readable');
    assert.strictEqual(res.allowMethods, 'GET,POST,DELETE,OPTIONS');
    assert.strictEqual(res.allowHeaders, 'Content-Type, x-admin-token, Authorization');
  } finally {
    server.close();
    kb.close();
  }
});

test('CORS wildcard allow-origin is returned on error responses too', async () => {
  const { kb, server, port } = await startServer({ allowOrigin: '*' });
  // with RAGDESK_ALLOW_ORIGIN=* every response (not just preflight) returns the
  // wildcard; an untoken-gated 404 here proves the wildcard flows through the
  // /api catch-all as well as happy paths.
  try {
    const res = await new Promise((resolve, reject) => {
      http
        .get(
          { host: 'localhost', port, path: '/api/nope', headers: { Origin: 'https://any.example' } },
          (r) => {
            r.resume();
            r.on('end', () => resolve({ status: r.statusCode, allowOrigin: r.headers['access-control-allow-origin'] }));
          }
        )
        .on('error', reject);
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.allowOrigin, '*', 'wildcard must reach error responses, not just preflight');
  } finally {
    server.close();
    kb.close();
  }
});

test('CORS pinned allow-origin is emitted verbatim on success, preflight and error responses', async () => {
  const { kb, server, port } = await startServer({ allowOrigin: 'https://app.example' });
  // RAGDESK_ALLOW_ORIGIN set to a concrete origin must be emitted as-is on
  // every response — the list of allowed pages is a fixed production config,
  // so a request from ANY other origin must still receive the pinned value,
  // never a reflection of the requesting origin. This locks the middle branch
  // of app.js CORS middleware (wildcard + default-reflection are covered
  // elsewhere); a 404 here also proves the pinned value flows through the /api
  // catch-all, not just happy paths.
  const withOrigin = (method, reqPath, origin = 'https://attacker.example') =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port, method, path: reqPath, headers: { Origin: origin } },
        (r) => {
          r.resume();
          r.on('end', () => resolve({ status: r.statusCode, allowOrigin: r.headers['access-control-allow-origin'] }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  try {
    // preflight from a foreign origin gets the pinned origin, not a reflection
    const preflight = await withOrigin('OPTIONS', '/api/chat');
    assert.strictEqual(preflight.status, 204);
    assert.strictEqual(preflight.allowOrigin, 'https://app.example', 'preflight must emit the pinned origin verbatim');

    // happy path (public chat, no token) from a foreign origin
    const chat = await withOrigin('GET', '/api/health');
    assert.strictEqual(chat.status, 200);
    assert.strictEqual(chat.allowOrigin, 'https://app.example', '200 responses must carry the pinned origin');

    // error path (unknown /api route) from a foreign origin
    const nope = await withOrigin('GET', '/api/nope');
    assert.strictEqual(nope.status, 404);
    assert.strictEqual(nope.allowOrigin, 'https://app.example', 'error responses must carry the pinned origin, not a reflection');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/docs rows carry the size and created_at fields the admin table renders', async () => {
  const { kb, server, port } = await startServer();
  // admin.js renders d.size (KB), d.created_at, d.kind and d.chunk_count from
  // the list rows; lock the full row shape so a storage refactor cannot drop
  // a field the table depends on.
  await kb.ingestBuffer('doc.md', Buffer.from('本诊所工作日 8:00 开门。' + 'x'.repeat(300)));
  const res = await get(`http://localhost:${port}/api/admin/docs`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.docs.length, 1);
  const row = res.body.docs[0];
  assert.strictEqual(row.filename, 'doc.md');
  assert.strictEqual(row.kind, 'markdown');
  assert.strictEqual(typeof row.size, 'number');
  assert.ok(row.size > 0, 'size must be the real byte count');
  assert.ok(Number.isInteger(row.size));
  assert.strictEqual(typeof row.created_at, 'string');
  assert.ok(row.created_at.length > 0, 'created_at must be a populated timestamp string');
  assert.strictEqual(typeof row.chunk_count, 'number');
  assert.ok(row.chunk_count >= 1);

  // the single-doc view carries the same fields for the detail panel
  const detail = await get(`http://localhost:${port}/api/admin/docs/${row.id}`);
  assert.strictEqual(detail.body.doc.size, row.size);
  assert.strictEqual(detail.body.doc.created_at, row.created_at);
  server.close();
  kb.close();
});

test('/api/chat confidence is a [0,1] number: >0 for hits, exactly 0 for a miss', async () => {
  const { kb, server, port } = await startServer();
  // demo.js renders 置信度 Math.round(data.confidence*100)% gated on data.top;
  // widget.js renders it unconditionally. Lock the contract on the wire so a
  // storage/answer refactor cannot emit NaN/undefined that breaks the UIs.
  await kb.ingestBuffer(
    'notice.md',
    Buffer.from('供应商须为境内注册并取得营业执照的企业。近三年无重大违法违规记录，须提供最近一年财务报表。')
  );
  const hit = await post(`http://localhost:${port}/api/chat`, { query: '供应商资格要求' });
  assert.strictEqual(hit.status, 200);
  assert.ok(hit.body.citations.length >= 1, 'query must hit the ingested doc');
  assert.strictEqual(typeof hit.body.confidence, 'number');
  assert.ok(Number.isFinite(hit.body.confidence), 'confidence must be finite');
  assert.ok(hit.body.confidence > 0 && hit.body.confidence <= 1, 'a hit must report positive confidence');

  // a nonsense query matches nothing: 0 confidence and no top doc
  const miss = await post(`http://localhost:${port}/api/chat`, { query: 'qqqqq zzzzz xxxxx' });
  assert.strictEqual(miss.status, 200);
  assert.strictEqual(miss.body.citations.length, 0);
  assert.strictEqual(miss.body.confidence, 0, 'a miss must report exactly 0 confidence');
  assert.strictEqual(miss.body.top, null, 'a miss must report no top doc');
  server.close();
  kb.close();
});

test('/api/chat body is exactly the engine answer contract: full-payload lock', async () => {
  const { kb, server, port } = await startServer();
  // The per-field tests above pin individual values; this pin locks the WHOLE
  // response body so an added/dropped/renamed key is caught, not just a value
  // change. The miss path is fully deterministic (the general fallback is a
  // constant), the hit path must equal kb.answer() verbatim (route = pure
  // forward, no injected fields like a debug flag).
  try {
    // miss against an empty corpus: stable literal shape
    const missQ = 'qqqqq zzzzz xxxxx';
    const miss = await post(`http://localhost:${port}/api/chat`, { query: missQ, domain: 'general' });
    assert.strictEqual(miss.status, 200);
    assert.deepStrictEqual(miss.body, {
      answer: '抱歉，知识库中没有找到相关内容。',
      mode: 'offline-retrieval',
      llm: false,
      domain: 'general',
      confidence: 0,
      citations: [],
      top: null,
      query: missQ,
    });

    // hit: the wire body is exactly the engine result, byte for byte
    await kb.ingestBuffer('vet.md', Buffer.from('本诊所工作日 8:00 开门，周六日 9:00 开门。预约电话 010-1234。'));
    const hitQ = '诊所以什么时间开门';
    const hit = await post(`http://localhost:${port}/api/chat`, { query: hitQ, domain: 'general' });
    assert.strictEqual(hit.status, 200);
    assert.deepStrictEqual(
      hit.body,
      kb.answer(hitQ, { domain: 'general', limit: 3 }),
      'the route must forward the engine answer unchanged'
    );

    // top IS the first citation: UIs render top.document confidently, and the
    // answer must actually embed the cited excerpt.
    assert.deepStrictEqual(hit.body.top, hit.body.citations[0]);
    assert.ok(hit.body.answer.startsWith('以下是知识库中与您问题最相关的原文片段：'));
    assert.ok(hit.body.citations[0].excerpt.length > 0, 'a hit must carry a populated excerpt');
    assert.ok(hit.body.answer.includes(hit.body.citations[0].excerpt), 'answer embeds the cited excerpt');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/chat citation excerpt is anchor-windowed on the wire, not head-cut', async () => {
  const { kb, server, port } = await startServer();
  // excerptFrom() windows the citation excerpt around the first query-hit so
  // UIs render the ANSWER slice instead of the chunk head. Unit tests lock the
  // helper, but /api/chat only asserted excerpt.length > 0 — a head-cutting
  // regression would either truncate away the anchor or grow past 160 chars,
  // and both are caught here. The doc is one 223-char no-break paragraph, so
  // chunkText emits it as a single chunk unchanged; the first 采购流程 sits at
  // index 173 (>160), deep enough that only windowing (not head-cutting) can
  // produce the expected 160-char excerpt that still contains the anchor.
  const lead =
    '本通知适用于所有拟参与本招标项目的潜在供应商，请务必在正式投标之前阅读以下全部条款，' +
    '各项要求适用于供应商准入、资格预审以及后续全部招标环节，' +
    '第三条特别强调潜在投标人应当具备合法经营资格，且近三年内未发生重大违法违规记录，' +
    '第四条要求提交最近一年经审计的财务报表以证明财务状况良好，' +
    '第五条要求投标文件在投标截止时间前递交至指定地点并附完整原件，';
  const tail =
    '其中与采购流程直接相关的补充材料应当单独装订成册随附递交，评审委员会将依据公开公平公正的原则进行综合评审。';
  const body = lead + tail;
  assert.ok(body.indexOf('采购流程') > 160, 'premise: the anchor term sits deeper than the 160-char window');
  await kb.ingestBuffer('tender.md', Buffer.from(body));
  try {
    const q = '采购流程相关材料如何递交';
    const hit = await post(`http://localhost:${port}/api/chat`, { query: q, domain: 'general' });
    assert.strictEqual(hit.status, 200);
    const ex = hit.body.citations[0].excerpt;
    assert.strictEqual(ex.length, 161, 'exactly 160 windowed chars plus one leading ellipsis');
    assert.ok(ex.startsWith('…'), 'a truncated head is marked with a leading ellipsis');
    assert.ok(ex.includes('采购'), 'the excerpt must contain the hit anchor, not the doc head');
    assert.ok(!ex.endsWith('…'), 'the excerpt reaches the doc tail, so no trailing ellipsis');
    assert.deepStrictEqual(
      hit.body,
      kb.answer(q, { domain: 'general', limit: 3 }),
      'the wire body is still exactly the engine answer'
    );
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/chat multi-doc hits rank citations by relevance — top is the first citation and the order is query-dependent', async () => {
  const { kb, server, port } = await startServer();
  // Every earlier chat test ingests a SINGLE matching doc, so the wire order
  // of multiple citations is unasserted. storage.search() runs FTS5 bm25 with
  // ORDER BY score ASC (lower = better) and the route must surface citations
  // in that rank order with top === citations[0]. Two docs with inverted
  // overlap for two queries make the order genuinely discriminating: a fixed
  // insertion/ID ordering would fail the flipped case even though all values
  // (docId 1 then 2) stay identical.
  try {
    await kb.ingestBuffer(
      'strong.md',
      Buffer.from('咨询费收取规则明确指出：咨询费按每小时 300 元收取，咨询费包含发票费用，咨询费多退少补。')
    );
    await kb.ingestBuffer('weak.md', Buffer.from('客户可在前台咨询费用相关事宜，电话 010-1234。'));

    // Query favoring strong.md (咨询费 x4 vs the weak doc's single 咨询…费用):
    // it must rank first and be echoed verbatim as top.
    const strong = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收', limit: 10 });
    assert.strictEqual(strong.status, 200);
    assert.deepStrictEqual(
      strong.body.citations.map((c) => c.document),
      ['strong.md', 'weak.md'],
      'the more on-topic doc must rank first for its own query'
    );
    assert.deepStrictEqual(strong.body.top, strong.body.citations[0], 'top is exactly the first (top-ranked) citation');
    assert.strictEqual(strong.body.top.document, 'strong.md');

    // Query favoring weak.md's only unique term: the rank order must invert.
    const weak = await post(`http://localhost:${port}/api/chat`, { query: '费用', limit: 10 });
    assert.strictEqual(weak.status, 200);
    assert.deepStrictEqual(
      weak.body.citations.map((c) => c.document),
      ['weak.md', 'strong.md'],
      'a query favoring the other doc must invert the citation order'
    );
    assert.strictEqual(weak.body.top.document, 'weak.md');
    assert.deepStrictEqual(weak.body.top, weak.body.citations[0]);
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/stats body is exactly { stats: { total, with_answer } } — full-payload lock', async () => {
  const { kb, server, port } = await startServer();
  // admin.js renders 总查询数/命中数/命中率 straight from stats.total and
  // stats.with_answer; the per-field tests above pin values but not the key
  // set. Lock the whole payload so a storage/route refactor cannot add, drop
  // or rename a stat key the panel depends on.
  try {
    const empty = await get(`http://localhost:${port}/api/admin/stats`);
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(empty.body, { stats: { total: 0, with_answer: 0 } }, 'empty DB: exactly two integer keys');

    await kb.ingestBuffer('q.md', Buffer.from('本诊所工作日 8:00 开门。'));
    await post(`http://localhost:${port}/api/chat`, { query: '诊所以什么时间开门' }); // hit
    await post(`http://localhost:${port}/api/chat`, { query: 'qqq zzz xxx' }); // miss

    const after = await get(`http://localhost:${port}/api/admin/stats`);
    assert.strictEqual(after.status, 200);
    assert.deepStrictEqual(after.body, { stats: { total: 2, with_answer: 1 } }, 'hit counts, miss counts only toward total');
    assert.deepStrictEqual(Object.keys(after.body.stats).sort(), ['total', 'with_answer'], 'stats has exactly these two keys');
    assert.strictEqual(typeof after.body.stats.total, 'number');
    assert.strictEqual(typeof after.body.stats.with_answer, 'number');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/docs rows carry sha256, status and mime; detail chunks expose exactly id/chunk_idx/body', async () => {
  const { kb, server, port } = await startServer();
  // listDocs returns d.* + chunk_count (a computed alias, not a column), so the
  // full row shape on the wire is sha256/status/mime/updated_at plus the fields
  // the admin table renders. sha256 is deterministic (SHA-256 of the fed bytes),
  // status defaults to 'ready', and ingestBuffer without meta leaves mime NULL.
  // The per-doc view selects the same d.* row WITHOUT chunk_count, so the two
  // key sets on the wire differ in exactly that one key.
  const text = '本诊所工作日 8:00 开门，周六日 9:00 开门。预约电话 010-1234。';
  const buf = Buffer.from(text);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  await kb.ingestBuffer('clinic.md', buf);
  try {
    const list = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.docs.length, 1);
    const row = list.body.docs[0];
    assert.deepStrictEqual(Object.keys(row).sort(), [
      'chunk_count',
      'created_at',
      'filename',
      'id',
      'kind',
      'mime',
      'sha256',
      'size',
      'status',
      'updated_at',
    ]);
    assert.strictEqual(row.sha256, sha, 'sha256 must be the digest of the stored bytes');
    assert.strictEqual(row.status, 'ready', 'status defaults to ready on ingest');
    assert.strictEqual(row.mime, null, 'upload without meta carries no mime');
    assert.strictEqual(row.updated_at, row.created_at, 'a fresh row sets both timestamps on insert');
    assert.strictEqual(row.size, buf.length);
    assert.strictEqual(row.filename, 'clinic.md');
    assert.strictEqual(row.kind, 'markdown');

    // the single-doc view: same doc row minus the computed chunk_count alias,
    // plus chunks whose exact key set is id/chunk_idx/body (doc_id is
    // deliberately absent from the wire; listChunks never selects it).
    const detail = await get(`http://localhost:${port}/api/admin/docs/${row.id}`);
    assert.strictEqual(detail.status, 200);
    assert.deepStrictEqual(
      Object.keys(detail.body.doc).sort(),
      Object.keys(row).filter((k) => k !== 'chunk_count').sort()
    );
    const docRow = { ...row };
    delete docRow.chunk_count;
    assert.deepStrictEqual(detail.body.doc, docRow, 'detail doc row = list row minus the chunk_count alias');
    assert.strictEqual(detail.body.doc.sha256, sha);
    assert.strictEqual(detail.body.doc.status, 'ready');
    assert.strictEqual(detail.body.doc.mime, null);

    // chunk rows: exactly three keys, ascending chunk_idx, body re-joins to the
    // source text byte-for-byte; detail chunk count agrees with the list alias
    assert.ok(Array.isArray(detail.body.chunks));
    assert.ok(detail.body.chunks.length >= 1, 'the text must produce chunks');
    assert.strictEqual(row.chunk_count, detail.body.chunks.length, 'list aggregation must match the detail view');
    const indexes = detail.body.chunks.map((c) => c.chunk_idx);
    assert.deepStrictEqual(indexes, [...indexes].sort((a, b) => a - b), 'chunk_idx must be ascending');
    for (const c of detail.body.chunks) {
      assert.deepStrictEqual(Object.keys(c).sort(), ['body', 'chunk_idx', 'id']);
      assert.strictEqual(typeof c.id, 'number');
      assert.strictEqual(typeof c.chunk_idx, 'number');
      assert.ok(c.chunk_idx >= 1, 'chunk_idx is 1-based');
      assert.strictEqual(typeof c.body, 'string');
    }
    assert.strictEqual(
      detail.body.chunks.map((c) => c.body).join(''),
      text,
      'concatenated chunk bodies must reconstruct the ingested text exactly'
    );
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/docs response body is exactly { docs }; detail body is exactly { doc, chunks }', async () => {
  const { kb, server, port } = await startServer();
  // admin.js reads the docs list as data.docs and the detail view as data.chunks;
  // row-level key sets are pinned elsewhere, but no test locks the BODY-level
  // shape, so a route that renames or wraps the array (e.g. { docs, total } or
  // { list }) would silently blank the table. Pin the empty state exactly, the
  // populated key set, and the detail body's exact { doc, chunks } keys.
  try {
    const empty = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(empty.body, { docs: [] }, 'fresh DB body is exactly { docs: [] }, no extra keys');

    await kb.ingestBuffer('a.md', Buffer.from('本诊所工作日 8:00 开门。'));
    await kb.ingestBuffer('b.md', Buffer.from('供应商须取得营业执照。'));
    const list = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(Object.keys(list.body).sort(), ['docs'], 'the docs response carries exactly the docs key');
    assert.ok(Array.isArray(list.body.docs));
    assert.strictEqual(list.body.docs.length, 2);
    assert.ok(list.body.docs.every((d) => d && typeof d === 'object'));

    const detail = await get(`http://localhost:${port}/api/admin/docs/${list.body.docs[0].id}`);
    assert.strictEqual(detail.status, 200);
    assert.deepStrictEqual(Object.keys(detail.body).sort(), ['chunks', 'doc'], 'the detail response carries exactly doc + chunks');
  } finally {
    server.close();
    kb.close();
  }
});

test('/api/admin/logs body is { logs, stats } and each row carries the full queries_log shape', async () => {
  const { kb, server, port } = await startServer();
  // listQueryLogs returns q.* (id/query/domain/matched/top_score/top_doc_id/
  // source/created_at) plus a LEFT-JOIN top_filename; the JSON body also embeds
  // the shared stats object. Per-field assertions exist elsewhere, but no test
  // pins the complete row key set (an added/renamed column would slip through)
  // nor the body-level { logs, stats } shape the admin panel reads from.
  await kb.ingestBuffer('clinic.md', Buffer.from('本诊所工作日 8:00 开门，周六日 9:00 开门。预约电话 010-1234。'));
  try {
    const chat = await post(`http://localhost:${port}/api/chat`, { query: '诊所以什么时间开门' });
    assert.strictEqual(chat.status, 200);
    assert.ok(chat.body.citations.length >= 1, 'query must hit the ingested doc');

    const res = await get(`http://localhost:${port}/api/admin/logs`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      Object.keys(res.body).sort(),
      ['logs', 'stats'],
      'the logs response body carries exactly logs + stats'
    );
    assert.deepStrictEqual(
      res.body.stats,
      { total: 1, with_answer: 1 },
      'embedded stats must match the standalone /api/admin/stats contract'
    );
    assert.strictEqual(res.body.logs.length, 1);
    const row = res.body.logs[0];

    // exact row key set, deliberately including top_filename only on the wire
    assert.deepStrictEqual(
      Object.keys(row).sort(),
      ['created_at', 'domain', 'id', 'matched', 'query', 'source', 'top_doc_id', 'top_filename', 'top_score'],
      'every queries_log column plus the LEFT-JOIN filename'
    );
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.query, '诊所以什么时间开门');
    assert.strictEqual(row.domain, 'general');
    assert.strictEqual(row.matched, chat.body.citations.length);
    assert.strictEqual(row.source, 'api', 'chat-endpoint queries are logged with source="api"');
    assert.strictEqual(row.top_doc_id, chat.body.top.docId);
    assert.strictEqual(row.top_filename, 'clinic.md');
    assert.strictEqual(row.top_score, chat.body.confidence, 'top_score mirrors the answer-level confidence of the top doc');
    assert.strictEqual(typeof row.created_at, 'string');
    assert.ok(row.created_at.length > 0);
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload reports exact per-action result shapes in one batch: indexed/duplicate/error key sets in part order', async () => {
  const { kb, server, port } = await startServer();
  // admin.js renders each result by r.action: indexed reads r.chunks, duplicate
  // renders from filename alone, error reads r.error. Existing per-field tests
  // never pin the exact key set, so an added/renamed field (e.g. duplicate
  // carrying chunks, or error leaking a docId) would slip through. Lock all
  // three shapes in one batch, the part-order equivalence of the results array,
  // and HTTP 200 for a partially failing batch.
  const contents = 'nullam_tempus_duopoints 律师事务所收费标准按小时计费，先签合同后服务。';
  const boundary = '----rd-shapes';
  const body = Buffer.from(
    [
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="fee.md"\r\nContent-Type: text/markdown\r\n\r\n${contents}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="fee.md"\r\nContent-Type: text/markdown\r\n\r\n${contents}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="bad.xyz"\r\nContent-Type: application/octet-stream\r\n\r\nnope\r\n`,
      `--${boundary}--\r\n`,
    ].join('')
  );
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.strictEqual(res.status, 200, 'a partially failing batch still returns 200 with per-file results');
    assert.strictEqual(res.body.results.length, 3, 'one result per multipart part');

    // indexed: exactly { filename, action, docId, chunks }
    assert.deepStrictEqual(Object.keys(res.body.results[0]).sort(), ['action', 'chunks', 'docId', 'filename']);
    assert.deepStrictEqual(res.body.results[0], { filename: 'fee.md', action: 'indexed', docId: 1, chunks: 1 });

    // duplicate: exactly { filename, action, docId } — no chunks, no error
    assert.deepStrictEqual(Object.keys(res.body.results[1]).sort(), ['action', 'docId', 'filename']);
    assert.deepStrictEqual(
      res.body.results[1],
      { filename: 'fee.md', action: 'duplicate', docId: 1 },
      'same-batch re-upload must report duplicate and point at the first doc id'
    );

    // error: exactly { filename, action, error } — no docId, no chunks
    assert.deepStrictEqual(Object.keys(res.body.results[2]).sort(), ['action', 'error', 'filename']);
    assert.deepStrictEqual(
      res.body.results[2],
      { filename: 'bad.xyz', action: 'error', error: '不支持的文件类型: bad.xyz' }
    );

    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.body.docs.length, 1, 'only the indexable file persists across the three-part batch');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin upload dedup keys on file bytes (sha256), not filename: same content under a new name duplicates', async () => {
  const { kb, server, port } = await startServer();
  // ingestion dedup compares the fed bytes' sha256 (knowledge.js ingestBuffer)
  // before extension/parse; the admin table shows the filename of the ORIGINAL
  // upload. Existing dedup tests re-upload under the SAME filename, so a
  // refactor that keyed dedup on filename instead of content would pass.
  // Re-uploading identical bytes under a different name must still duplicate
  // and leave the stored doc (and its filename) untouched.
  const contents = '张三 律师 收费 标准 按小时计费，先签合同后服务，具体价格面议。';
  const boundary = '----rd-duprename';
  const part = (name) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n${contents}\r\n`
    );
  const upload = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  try {
    const first = await upload(Buffer.concat([part('fee.md'), Buffer.from(`--${boundary}--\r\n`)]));
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.body.results[0], { filename: 'fee.md', action: 'indexed', docId: 1, chunks: 1 });

    // identical bytes, different name, different mime type — sha256 wins
    const second = await upload(Buffer.concat([part('renamed-refund.md'), Buffer.from(`--${boundary}--\r\n`)]));
    assert.strictEqual(second.status, 200);
    assert.deepStrictEqual(
      second.body.results[0],
      { filename: 'renamed-refund.md', action: 'duplicate', docId: 1 },
      "same content under a new name must still duplicate to the original doc"
    );

    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.body.docs.length, 1, 'the rename must not add a second row');
    assert.strictEqual(docs.body.docs[0].filename, 'fee.md', 'the stored doc keeps its original filename');
  } finally {
    server.close();
    kb.close();
  }
});

test('uploading the same bytes again after a DELETE re-indexes them (sha256 dedup must not block the lifecycle)', async () => {
  const { kb, server, port } = await startServer();
  // deleteDoc purges docs/chunks/fts rows, so the sha256 is freed: re-uploading
  // the exact same bytes must index a FRESH doc instead of reporting duplicate.
  // A dedup cache that survived the delete (or dedup keyed on anything but the
  // live docs table) would break the delete→re-upload admin workflow.
  const contents = '法医鉴定收费标准 3000元起，出诊费另计，报告出具周期十个工作日。';
  const boundary = '----rd-reidx';
  const part = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="forensic.md"\r\nContent-Type: text/markdown\r\n\r\n${contents}\r\n`
  );
  const upload = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  const del = (id) =>
    new Promise((resolve, reject) => {
      http
        .request({ host: 'localhost', port, path: `/api/admin/docs/${id}`, method: 'DELETE' }, (r) => {
          r.resume();
          r.on('end', () => resolve({ status: r.statusCode }));
        })
        .on('error', reject)
        .end();
    });
  try {
    const first = await upload(Buffer.concat([part, Buffer.from(`--${boundary}--\r\n`)]));
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.body.results[0], { filename: 'forensic.md', action: 'indexed', docId: 1, chunks: 1 });

    const delRes = await del(first.body.results[0].docId);
    assert.strictEqual(delRes.status, 200);
    const afterDel = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(afterDel.body.docs.length, 0, 'DELETE leaves an empty list');

    const second = await upload(Buffer.concat([part, Buffer.from(`--${boundary}--\r\n`)]));
    assert.strictEqual(second.status, 200);
    assert.deepStrictEqual(
      second.body.results[0],
      { filename: 'forensic.md', action: 'indexed', docId: 2, chunks: 1 },
      'same bytes re-uploaded after a DELETE must index fresh, not duplicate'
    );

    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.body.docs.length, 1);
    assert.strictEqual(docs.body.docs[0].id, 2, 'the re-upload lives as a brand new row');

    const ans = await post(`http://localhost:${port}/api/chat`, { query: '法医鉴定多少钱' });
    assert.ok(ans.body.citations.length >= 1, 'the re-indexed content is retrievable again');
  } finally {
    server.close();
    kb.close();
  }
});

test('admin docs list carries the exact file kind per format the table renders', async () => {
  const { kb, server, port } = await startServer();
  try {
    // each supported fixture maps to a distinct kind via fileKindOf (extractors.fileKind)
    const kinds = {
      'law-services.docx': 'docx',
      'clinic-guide.pdf': 'pdf',
      'faq-transfer.csv': 'csv',
      'notice-provider.txt': 'text',
      'vaccine.md': 'markdown',
    };
    for (const [name, expected] of Object.entries(kinds)) {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'corpus', name));
      const res = await kb.ingestBuffer(name, buf);
      assert.strictEqual(res.action, 'indexed', `${name} should index`);
    }

    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.body.docs.length, Object.keys(kinds).length);

    // every row's kind must equal the per-extension mapping, else the admin
    // table's kind column (admin.js renders d.kind) would show wrong labels
    const byName = new Map(docs.body.docs.map((d) => [d.filename, d.kind]));
    for (const [name, expected] of Object.entries(kinds)) {
      assert.strictEqual(byName.get(name), expected, `${name} should list kind ${expected}`);
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('upload mime persists into the docs row via the wire (multipart Content-Type carried through)', async () => {
  const { kb, server, port } = await startServer();
  try {
    // app.js feeds every uploaded file's multer mimetype into ingestBuffer's
    // meta.mime; a refactor that stopped forwarding it would leave the admin
    // list's mime column empty on real uploads while the unit-level mime test
    // still passes. Lock the end-to-end path: what the browser sends as the
    // part's Content-Type must be what appears on the /api/admin/docs row.
    const boundary = '----rd-mime';
    const parts = [
      ['notice-provider.txt', 'text/plain'],
      ['faq-transfer.csv', 'text/csv'],
      ['vaccine.md', 'text/markdown'],
    ].map(([name, mime]) => {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'corpus', name));
      return Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`
        ),
        buf,
        Buffer.from('\r\n'),
      ]);
    });
    const body = Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port,
          path: '/api/admin/upload',
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        },
        (r) => {
          let out = '';
          r.on('data', (c) => (out += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(out) }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 3);
    for (const r of res.body.results) assert.strictEqual(r.action, 'indexed');

    const docs = await get(`http://localhost:${port}/api/admin/docs`);
    assert.strictEqual(docs.body.docs.length, 3);
    const byName = new Map(docs.body.docs.map((d) => [d.filename, d.mime]));
    assert.strictEqual(byName.get('notice-provider.txt'), 'text/plain', 'txt part mime must survive to the row');
    assert.strictEqual(byName.get('faq-transfer.csv'), 'text/csv', 'csv part mime must survive to the row');
    assert.strictEqual(byName.get('vaccine.md'), 'text/markdown', 'md part mime must survive to the row');
    assert.ok(docs.body.docs.every((d) => typeof d.mime === 'string'), 'uploaded rows must carry a real mime, not null');
  } finally {
    server.close();
    kb.close();
  }
});
