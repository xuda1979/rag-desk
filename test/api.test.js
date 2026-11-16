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
