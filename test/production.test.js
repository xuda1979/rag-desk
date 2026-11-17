'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Module = require('node:module');

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

test('prod: thrown engine errors become stable JSON 500s, not HTML stack traces', async () => {
  const failingKb = {
    engineInfo: () => {
      throw new Error('boom: corrupt index');
    },
    getQueryStats: () => {
      throw new Error('boom: corrupt index');
    },
    answer: () => ({ query: 'x', answer: '', citations: [] }),
    logQuery: () => {},
    getAllDocs: () => [],
  };
  const app = buildApp(failingKb, {});
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const port = server.address().port;
    for (const reqPath of ['/api/health', '/api/admin/stats']) {
      const res = await req(port, { reqPath });
      assert.strictEqual(res.status, 500);
      assert.match(res.headers['content-type'], /application\/json/);
      assert.deepStrictEqual(res.body, { error: 'boom: corrupt index' });
    }
  } finally {
    server.close();
  }
});

test('prod: unknown API routes return JSON 404, never the Express HTML page', async () => {
  const { kb, server, port } = await startServer();
  try {
    for (const reqPath of ['/api/nope', '/api/admin/nope', '/api/chat/nope']) {
      const res = await req(port, { reqPath });
      assert.strictEqual(res.status, 404);
      assert.match(res.headers['content-type'], /application\/json/);
      assert.deepStrictEqual(res.body, { error: 'not found' });
    }
    // widget/site HTML stays untouched (static routes still serve 200)
    const staticRes = await req(port, { reqPath: '/widget.js' });
    assert.strictEqual(staticRes.status, 200);
  } finally {
    server.close();
    kb.close();
  }
});

test('prod: malformed JSON body becomes a stable JSON 400, not HTML', async () => {
  const { kb, server, port } = await startServer();
  try {
    const res = await req(port, {
      method: 'POST',
      reqPath: '/api/chat',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.strictEqual(typeof res.body.error, 'string');
    assert.ok(res.body.error.length > 0);
  } finally {
    server.close();
    kb.close();
  }
});

test('prod: server.js boot seeds a fresh DB, gates admin, answers chat, and skips re-seed on later boots', async () => {
  const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-boot-'));
  const dbPath = path.join(bootDir, 'boot.db');

  const freePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });

  const boot = (port, db) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          RAGDESK_DB: db,
          PORT: String(port),
          RAGDESK_ADMIN_TOKEN: 'boot-tok',
          RAGDESK_CHAT_TOKEN: 'boot-chat',
          RAGDESK_ALLOW_ORIGIN: 'https://boot.customer.example',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('error', reject);
      const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
      resolve({
        out: () => out,
        kill: () => {
          if (child.exitCode === null) child.kill('SIGTERM');
          return exited;
        },
      });
    });

  const waitHealthy = async (port) => {
    let last;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) return r;
        last = r;
      } catch (_) {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`server did not become healthy on port ${port} (last status ${last && last.status})`);
  };

  const port1 = await freePort();
  const port2 = await freePort();
  let b1 = null;
  let b2 = null;
  try {
    b1 = await boot(port1, dbPath);
    await waitHealthy(port1);
    const healthBody = await (await fetch(`http://127.0.0.1:${port1}/api/health`)).json();
    assert.strictEqual(healthBody.ok, true);
    assert.strictEqual(healthBody.mode, 'offline');

    // fresh DB -> fixture corpus auto-seeded
    const docsRes = await fetch(`http://127.0.0.1:${port1}/api/admin/docs`, {
      headers: { 'x-admin-token': 'boot-tok' },
    });
    assert.strictEqual(docsRes.status, 200);
    const firstCount = (await docsRes.json()).docs.length;
    assert.ok(firstCount >= 10, `boot should seed the corpus, got ${firstCount} docs`);
    assert.ok(/\[seed\] \d+ docs indexed/.test(b1.out()), 'first boot should log the seed');

    // admin token gate is live
    const deny = await fetch(`http://127.0.0.1:${port1}/api/admin/docs`);
    assert.strictEqual(deny.status, 401);

    // chat answers against the seeded corpus
    const chat = await fetch(`http://127.0.0.1:${port1}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer boot-chat' },
      body: JSON.stringify({ query: '常年法律顾问' }),
    });
    assert.strictEqual(chat.status, 200);
    const chatBody = await chat.json();
    assert.ok(chatBody.answer.length > 0, 'booted server should answer queries');

    // RAGDESK_CHAT_TOKEN bearer gate is live on the booted process
    const chatDenied = await fetch(`http://127.0.0.1:${port1}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ query: '常年法律顾问' }),
    });
    assert.strictEqual(chatDenied.status, 401);

    // RAGDESK_ALLOW_ORIGIN is reflected to the allowed origin and replaces
    // foreign origins on real responses (the CORS-wildcard/reflect contract)
    const corsAllowed = await fetch(`http://127.0.0.1:${port1}/api/health`, {
      headers: { Origin: 'https://boot.customer.example' },
    });
    assert.strictEqual(
      corsAllowed.headers.get('access-control-allow-origin'),
      'https://boot.customer.example'
    );
    const corsForeign = await fetch(`http://127.0.0.1:${port1}/api/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.strictEqual(
      corsForeign.headers.get('access-control-allow-origin'),
      'https://boot.customer.example',
      'configured allow-origin must replace unknown origins'
    );

    await b1.kill();
    b1 = null;

    // second boot on the same DB: no re-seed, count unchanged
    b2 = await boot(port2, dbPath);
    await waitHealthy(port2);
    const secondCount = (
      await (await fetch(`http://127.0.0.1:${port2}/api/admin/docs`, {
        headers: { 'x-admin-token': 'boot-tok' },
      })).json()
    ).docs.length;
    assert.strictEqual(secondCount, firstCount, 'restart must not duplicate the corpus');
    assert.ok(b2.out().includes('already seeded'), 'second boot should log the skip');
    await b2.kill();
    b2 = null;
  } finally {
    if (b1) await b1.kill();
    if (b2) await b2.kill();
  }
});

test('prod: server.js creates the DB parent directory at boot (RAGDESK_DB into a missing nested path)', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-bootdir-'));
  const absentRoot = path.join(baseDir, 'app', 'data'); // deliberately NOT created
  const dbPath = path.join(absentRoot, 'nested', 'ragdesk.db');

  const freePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });

  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      RAGDESK_DB: dbPath,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));

  try {
    let last;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) break;
        last = r;
      } catch (_) {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(dbPath), `db file should be created at ${dbPath}`);
    assert.ok(fs.statSync(absentRoot).isDirectory(), `parent dirs should be created recursively (${absentRoot})`);
    assert.ok(fs.statSync(path.dirname(dbPath)).isDirectory(), `db parent dir should exist (${path.dirname(dbPath)})`);
    assert.ok(out.includes(`DB:     ${dbPath}`), 'boot should log the single DB path');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  }
});

test('prod: a failed boot-time seed is non-fatal — server still boots healthy and retries next launch', async () => {
  // server.js cold-starts the corpus seed in an async IIFE and catches the
  // rejection at lines 32-33 ("[seed] failed:") instead of aborting the boot.
  // Force that path in-process: stub seed-fixtures to throw, then require
  // src/server.js with a temp DB and a free port so the module binds without
  // touching data/ragdesk.db or a real port.
  const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-seedfail-'));
  const dbPath = path.join(bootDir, 'fail.db');
  const freePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
  const port = await freePort();

  const realLoad = Module._load;
  const save = { PORT: process.env.PORT, RAGDESK_DB: process.env.RAGDESK_DB };
  let app, server, kb;
  let errOut = '';
  const origErr = console.error;
  console.error = (...args) => (errOut += args.map(String).join(' ') + '\n');
  try {
    process.env.PORT = String(port);
    process.env.RAGDESK_DB = dbPath;
    Module._load = function (request, parent, isMain) {
      // Module._load hands the specifier exactly as the caller wrote it
      // ("../scripts/seed-fixtures"), not a resolved absolute path.
      if (typeof request === 'string' && request.endsWith('seed-fixtures')) {
        return {
          seedIfNeeded: async () => {
            throw new Error('boom: fixtures dir is unwritable');
          },
        };
      }
      return realLoad.apply(this, arguments);
    };
    ({ app, server, kb } = require('../src/server'));

    // the seed IIFE ran at require-time; poll until the failure was logged
    for (let i = 0; i < 50 && !errOut.includes('[seed] failed:'); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(errOut.includes('[seed] failed:'), 'the seed rejection must be logged, not swallowed');
    assert.ok(errOut.includes('boom: fixtures dir is unwritable'), 'the underlying cause must surface');

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(health.status, 200);
    const body = await health.json();
    assert.strictEqual(body.ok, true, 'the server must boot and serve despite the seed failure');
    assert.strictEqual(body.mode, 'offline');
  } finally {
    console.error = origErr;
    Module._load = realLoad;
    process.env.PORT = save.PORT;
    process.env.RAGDESK_DB = save.RAGDESK_DB;
    if (kb) kb.close();
    if (server) await new Promise((r) => server.close(r));
  }

  // the failed seed must not stamp the 'seeded' sentinel, so the next launch
  // retries the corpus instead of assuming it is present
  const probe = new KnowledgeBase(dbPath);
  try {
    assert.strictEqual(probe.getSetting('seeded'), null, 'failed seed leaves no completion marker');
  } finally {
    probe.close();
  }
});
