'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const { KnowledgeBase } = require('../src/lib/knowledge');
const { buildApp } = require('../src/app');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-prod-'));
  return path.join(dir, 'app.db');
}

function startServer(opts) {
  const kb = new KnowledgeBase(freshDb());
  const app = buildApp(kb, opts);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ kb, server, port: server.address().port }));
  });
}

function req(port, { method = 'GET', reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const u = {
      host: 'localhost',
      port,
      path: reqPath,
      method,
      headers,
    };
    const r = http.request(u, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(out) });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, body: out });
        }
      });
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

test('prod: admin endpoints are token-gated when RAGDESK_ADMIN_TOKEN is set', async () => {
  const { kb, server, port } = await startServer({ adminToken: 's3cret' });
  try {
    // no token -> 401 with a JSON error body frontends can display
    const deny = await req(port, { reqPath: '/api/admin/docs' });
    assert.strictEqual(deny.status, 401);
    assert.match(deny.body.error, /unauthorized/);

    // wrong token -> 401 with a JSON error body frontends can display
    const wrong = await req(port, {
      reqPath: '/api/admin/docs',
      headers: { 'x-admin-token': 'nope' },
    });
    assert.strictEqual(wrong.status, 401);
    assert.match(wrong.body.error, /unauthorized/);

    // correct token -> 200
    const ok = await req(port, {
      reqPath: '/api/admin/docs',
      headers: { 'x-admin-token': 's3cret' },
    });
    assert.strictEqual(ok.status, 200);
    assert.ok(Array.isArray(ok.body.docs));

    // POST /api/chat is NOT gated by the admin token (public surface)
    const chat = await req(port, {
      method: 'POST',
      reqPath: '/api/chat',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    assert.strictEqual(chat.status, 200);
  } finally {
    server.close();
    kb.close();
  }
});

test('prod: chat endpoint is bearer-gated when RAGDESK_CHAT_TOKEN is set', async () => {
  const { kb, server, port } = await startServer({ chatToken: 'chatTok' });
  try {
    const deny = await req(port, {
      method: 'POST',
      reqPath: '/api/chat',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    assert.strictEqual(deny.status, 401);
    // widget + demo rely on the JSON error body to surface the rejection
    assert.strictEqual(typeof deny.body.error, 'string');
    assert.ok(deny.body.error.length > 0);

    const ok = await req(port, {
      method: 'POST',
      reqPath: '/api/chat',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer chatTok' },
      body: JSON.stringify({ query: 'hello' }),
    });
    assert.strictEqual(ok.status, 200);
  } finally {
    server.close();
    kb.close();
  }
});

test('prod: CORS allowOrigin "*" returns the wildcard to every origin', async () => {
  const { kb, server, port } = await startServer({ allowOrigin: '*' });
  try {
    for (const origin of ['https://a.example', 'https://b.example', 'null']) {
      const res = await req(port, {
        reqPath: '/api/chat',
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*', `origin ${origin} should get the wildcard`);
    }
  } finally {
    server.close();
    kb.close();
  }
});

test('prod: CORS reflects origin by default and honors RAGDESK_ALLOW_ORIGIN', async () => {
  const { kb, server, port } = await startServer(); // no allowOrigin -> reflect
  try {
    const open = await req(port, {
      reqPath: '/api/chat',
      method: 'OPTIONS',
      headers: { Origin: 'https://customer.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.strictEqual(open.status, 204);
    assert.strictEqual(open.headers['access-control-allow-origin'], 'https://customer.example');
  } finally {
    server.close();
    kb.close();
  }

  const { kb: kb2, server: s2, port: p2 } = await startServer({ allowOrigin: 'https://docs.example.com' });
  try {
    const ok = await req(p2, {
      reqPath: '/api/chat',
      method: 'OPTIONS',
      headers: { Origin: 'https://docs.example.com' },
    });
    assert.strictEqual(ok.headers['access-control-allow-origin'], 'https://docs.example.com');
    const other = await req(p2, {
      reqPath: '/api/chat',
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    assert.strictEqual(other.headers['access-control-allow-origin'], 'https://docs.example.com');
  } finally {
    s2.close();
    kb2.close();
  }
});

test('prod: mailformed upload error returns stable JSON not HTML', async () => {
  const { kb, server, port } = await startServer();
  try {
    const res = await req(port, {
      method: 'POST',
      reqPath: '/api/admin/upload',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: 'nope' }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body && typeof res.body.error === 'string');
  } finally {
    server.close();
    kb.close();
  }
});

test('prod: DOCX ingest works with only runtime deps (fflate is a prod dependency)', async () => {
  const { kb, server, port } = await startServer();
  try {
    // Build the DOCX fixture bytes the same way the seed script does.
    const buf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'corpus', 'law-services.docx'));
    const out = await kb.ingestBuffer('law-services.docx', buf);
    assert.strictEqual(out.action, 'indexed');
    const ans = kb.answer('常年法律顾问');
    assert.ok(ans.top, 'DOCX content should be retrievable');
    assert.match(ans.top.excerpt, /常年法律顾问/);
  } finally {
    server.close();
    kb.close();
  }
});

test('prod: 50MB upload limit enforced (LIMIT_FILE_SIZE -> 413 JSON)', async () => {
  const { kb, server, port } = await startServer();
  try {
    const big = Buffer.alloc(51 * 1024 * 1024, 0x61);
    const boundary = '----rd-big';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="big.md"\r\nContent-Type: text/markdown\r\n\r\n`
      ),
      big,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await req(port, {
      method: 'POST',
      reqPath: '/api/admin/upload',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
    });
    assert.strictEqual(res.status, 413);
    assert.match(JSON.stringify(res.body), /too large/);
  } finally {
    server.close();
    kb.close();
  }
});
