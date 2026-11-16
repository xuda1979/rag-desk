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
      .get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { accept: 'application/json' } }, (res) => {
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

test('server-side: /api/health reports offline engine', async () => {
  const { kb, server, port } = await startServer();
  const res = await get(`http://localhost:${port}/api/health`);
  assert.strictEqual(res.body.ok, true);
  assert.deepStrictEqual(res.body.mode, 'offline');
  assert.strictEqual(res.body.llmEnabled, false);
  assert.strictEqual(res.body.engine.fts, true, 'FTS5 backend advertised');
  assert.strictEqual(res.body.engine.bm25, true, 'BM25 ranking advertised');
  assert.strictEqual(res.body.engine.embedding, false, 'no embeddings in offline mode');
  assert.strictEqual(res.body.engine.llm, false, 'no LLM in offline mode');
  assert.match(res.body.engine.tokenizer, /bigram-cjk/, 'tokenizer described');
  assert.deepStrictEqual(res.body.domains, ['legal', 'medical', 'procurement', 'general']);
  server.close();
  kb.close();
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
  assert.strictEqual(byName['bad.xyz'].action, 'error');
  assert.match(byName['bad.xyz'].error, /不支持的文件类型/);
  const docs = await get(`http://localhost:${port}/api/admin/docs`);
  assert.strictEqual(docs.body.docs.length, 1, 'only the indexable file is persisted');
  const ans = await post(`http://localhost:${port}/api/chat`, { query: '咨询费怎么收' });
  assert.strictEqual(ans.body.top.document, 'good.md', 'good file is retrievable after mixed upload');
  server.close();
  kb.close();
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
  // non-2xx (e.g. missing/invalid token -> 401) surfaces the server error
  // instead of being silently shown as "（暂无回答）".
  assert.match(res.body, /if \(!r\.ok\) throw new Error\(data\.error/);
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
  server.close();
  kb.close();
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
