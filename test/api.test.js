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
      .get({ host: u.hostname, port: u.port, path: u.pathname, headers: { accept: 'application/json' } }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let body = out;
          try {
            body = JSON.parse(out);
          } catch (_) {}
          resolve({ status: res.statusCode, body });
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
  const res = await post(`http://localhost:${port}/api/chat`, {});
  assert.strictEqual(res.status, 400);
  server.close();
  kb.close();
});

test('server-side: /api/health reports offline engine', async () => {
  const { kb, server, port } = await startServer();
  const res = await get(`http://localhost:${port}/api/health`);
  assert.strictEqual(res.body.ok, true);
  assert.deepStrictEqual(res.body.mode, 'offline');
  assert.strictEqual(res.body.llmEnabled, false);
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
  server.close();
  kb.close();
});

test('widget script is served and self-contained', async () => {
  const { kb, server, port } = await startServer();
  const res = await get(`http://localhost:${port}/widget.js`);
  assert.strictEqual(res.status, 200);
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
  server.close();
  kb.close();
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
