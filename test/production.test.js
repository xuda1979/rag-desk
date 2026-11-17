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

test('prod: body-less chat and deliberately-thrown app errors follow the stable JSON error contract', async () => {
  // Leaf 97: a POST /api/chat with no body and no content-type leaves req.body
  // undefined, so the `req.body || {}` destructure in the /api/chat handler
  // substitutes {} and answers the same stable JSON 400 as an explicit blank.
  {
    const { kb, server, port } = await startServer();
    try {
      const bare = await req(port, { method: 'POST', reqPath: '/api/chat' });
      assert.strictEqual(bare.status, 400);
      assert.deepStrictEqual(bare.body, { error: 'query is required' });
    } finally {
      server.close();
      kb.close();
    }
  }

  // Leaf 187: an error carrying type 'entity.too.large' but no status/code
  // (as a synthetic thrown payload can) must map to 413 with the body-parser
  // message, not fall through to the 500 default.
  {
    const throwing = {
      answer: () => {
        throw { type: 'entity.too.large' };
      },
    };
    const app = buildApp(throwing, {});
    const tooLarge = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = tooLarge.address().port;
      const res = await req(port, {
        method: 'POST',
        reqPath: '/api/chat',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      });
      assert.strictEqual(res.status, 413);
      assert.deepStrictEqual(res.body, { error: 'request body too large' });
    } finally {
      tooLarge.close();
    }
  }

  // Leaf 197: a thrown non-Error (a bare string) has neither .status nor
  // .message, so the fallback message is the generic 'internal server error'.
  {
    const throwing = {
      answer: () => {
        throw 'boom-string';
      },
    };
    const app = buildApp(throwing, {});
    const improper = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = improper.address().port;
      const res = await req(port, {
        method: 'POST',
        reqPath: '/api/chat',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      });
      assert.strictEqual(res.status, 500);
      assert.deepStrictEqual(res.body, { error: 'internal server error' });
      assert.match(res.headers['content-type'], /application\/json/);
    } finally {
      improper.close();
    }
  }

  // Leaf 97: the `req.body || {}` destructure's falsy side is unreachable over
  // HTTP (express body-parser always leaves req.body a truthy {}), so invoke
  // the /api/chat handler directly with a null body, skipping the parsers.
  {
    const kb = new KnowledgeBase(freshDb());
    try {
      const app = buildApp(kb, {});
      const route = app._router.stack.find((l) => l.route && l.route.path === '/api/chat');
      assert.ok(route, '/api/chat route layer must exist');
      const layers = route.route.stack;
      const handle = layers[layers.length - 1].handle;
      const sent = [];
      const res = {
        json: (o) => sent.push(['json', o]),
        status: (c) => {
          sent.push(['status', c]);
          return res;
        },
      };
      handle({ body: null, get: () => null }, res, () => {});
      assert.deepStrictEqual(sent, [
        ['status', 400],
        ['json', { error: 'query is required' }],
      ], 'a null body substitutes {} and answers the stable JSON 400');
    } finally {
      kb.close();
    }
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

test('prod: server.js without RAGDESK_DB or PORT falls back to data/ragdesk.db and port 3000', async () => {
  // The spawn-based boot tests always set RAGDESK_DB and PORT, so the falsy
  // sides of `process.env.RAGDESK_DB || ...` and `process.env.PORT || 3000`
  // (server.js lines 10-11) are never taken. Re-require the module with both
  // env vars deleted, stubbing ./app, ./lib/knowledge and seed-fixtures so the
  // module resolves the defaults without touching the dev DB or port 3000.
  const realLoad = Module._load;
  const saved = { PORT: process.env.PORT, RAGDESK_DB: process.env.RAGDESK_DB };
  let observed = null; // { kbPath, opts, port }
  try {
    delete process.env.PORT;
    delete process.env.RAGDESK_DB;
    delete require.cache[require.resolve('../src/server')];
    Module._load = function (request, parent, isMain) {
      if (typeof request === 'string') {
        if (request.endsWith('lib/knowledge')) {
          return {
            KnowledgeBase: class {
              constructor(dbPath) {
                observed = observed || {};
                observed.kbPath = dbPath;
              }
              close() {}
              storage = { getSetting: () => null, setSetting: () => {} };
            },
          };
        }
        if (request === './app') {
          return {
            buildApp: (kb, opts) => {
              observed = observed || {};
              observed.opts = opts;
              return { listen: (port) => { observed.port = port; return { close: () => {} }; } };
            },
          };
        }
        if (request.endsWith('seed-fixtures')) {
          // never settles: the boot IIFE hangs before logging or stamping
          return { seedIfNeeded: () => new Promise(() => {}) };
        }
      }
      return realLoad.apply(this, arguments);
    };
    require('../src/server');

    assert.ok(observed, 'stubs must have been exercised');
    assert.strictEqual(
      observed.kbPath,
      path.join(path.dirname(require.resolve('../src/server')), '..', 'data', 'ragdesk.db'),
      'with RAGDESK_DB unset the DB defaults to <repo>/data/ragdesk.db'
    );
    assert.strictEqual(observed.port, 3000, 'with PORT unset the server binds the default 3000');
    assert.deepStrictEqual(
      observed.opts,
      { adminToken: undefined, chatToken: undefined, allowOrigin: undefined },
      'unset auth/origin envs pass through as undefined'
    );
  } finally {
    Module._load = realLoad;
    delete require.cache[require.resolve('../src/server')];
    process.env.PORT = saved.PORT;
    process.env.RAGDESK_DB = saved.RAGDESK_DB;
  }
});

test('prod: server.js exits 0 promptly on SIGTERM and SIGINT (graceful Docker stop contract)', async () => {
  // The compose file stops the container via SIGTERM; server.js lines 50-55
  // map both SIGTERM and SIGINT to a close() that terminates with exit code 0.
  // The other boot tests fire SIGTERM only as teardown and never assert the
  // outcome, so this contract was unpinned. Spawn a real boot per signal and
  // assert code 0, a clean (non-default) signal disposition, and a bounded
  // shutdown so `docker compose stop` never waits out the grace period.
  const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-sig-'));
  const dbPath = path.join(bootDir, 'sig.db');
  const freePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    const port = await freePort();
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, RAGDESK_DB: dbPath, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, signal: sig })));
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
      if (child.exitCode === null && !out.includes('RAG-Desk running')) {
        assert.fail(`server did not boot on port ${port} (last status ${last && last.status})`);
      }

      const started = Date.now();
      child.kill(signal);
      const res = await exited;
      const shutdownMs = Date.now() - started;

      assert.strictEqual(res.code, 0, `${signal} must exit 0 for a graceful Docker stop`);
      assert.strictEqual(res.signal, null, `${signal} must be caught, not be the default fatal disposition`);
      assert.ok(shutdownMs < 5000, `${signal} shutdown should be prompt, took ${shutdownMs}ms`);
      assert.ok(out.includes('RAG-Desk running'), `${signal} boot should log the running banner`);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
    }
  }
  fs.rmSync(bootDir, { recursive: true, force: true });
});

test('prod: docker-compose.yml env wiring matches the keys src/server.js actually reads', () => {
  // Deploying via `docker compose up` is the documented path (README lines 36-42).
  // server.js reads exactly five env keys: PORT, RAGDESK_DB, RAGDESK_ADMIN_TOKEN,
  // RAGDESK_CHAT_TOKEN, RAGDESK_ALLOW_ORIGIN (lines 10-11 and 18-22). If a key
  // name drifts here the container boots against defaults while the compose file
  // silently points at a dead key, so assert the file text against the source.
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  // every env key the compose file sets or documents must be read by server.js
  const composeEnvKeys = [...compose.matchAll(/RAGDESK_[A-Z_]+/g)].map((m) => m[0]);
  assert.ok(composeEnvKeys.length >= 4, 'compose should wire the four RAGDESK_* keys');
  for (const key of composeEnvKeys) {
    assert.ok(
      serverSrc.includes(`process.env.${key}`),
      `compose references ${key} but src/server.js never reads it`
    );
  }
  // and vice versa: server.js must not read a key the compose file neither sets
  // nor documents (active or commented) — such a key would be invisible in prod
  const serverKeys = [...serverSrc.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  const composeText = [compose, 'PORT'].join('\n');
  for (const key of serverKeys) {
    assert.ok(composeText.includes(key), `src/server.js reads ${key} but compose never wires it`);
  }

  // RAGDESK_DB points into the named volume /app/data; server.js mkdirs the
  // missing parent at boot (locked separately), so the path just has to land
  // in WORKDIR while the volume persists it across restarts.
  assert.match(compose, /RAGDESK_DB=\/app\/data\/ragdesk\.db/, 'DB must live on the persistent volume');
  assert.match(compose, /- ragdesk-data:\/app\/data/, 'DB dir must be the named volume mount');
  assert.ok(/^volumes:\s*\n\s*ragdesk-data:/m.test(compose), 'ragdesk-data volume must be declared');

  // healthcheck contract: /api/health, exit 0 on ok, exit 1 otherwise, and the
  // probe URL must use the same port the service publishes (3000).
  assert.match(compose, /\/api\/health/, 'healthcheck must hit the health endpoint');
  assert.match(compose, /r\.ok\?0:1/, 'healthcheck must exit 0 iff the probe is ok');
  assert.match(compose, /127\.0\.0\.1:3000\/api\/health/, 'healthcheck must probe the published port');

  // the admin token is wired with the documented change-me placeholder so the
  // gate is on by default instead of the open-fallback server.js uses when unset
  assert.match(compose, /RAGDESK_ADMIN_TOKEN=change-me/, 'admin gate must default on in prod wiring');
});

test('prod: Dockerfile runtime stage installs prod deps only, matches the start command, and keeps HEALTHCHECK current', () => {
  // The runtime stage runs `npm ci --omit=dev`, so every require() reachable at
  // boot must be a prod dependency; pdfkit (dev-only, build-stage fixture tool)
  // must stay out. The CMD must stay byte-identical to `npm start`, and the
  // HEALTHCHECK env-key (PORT) must match what server.js reads.
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const prodDeps = Object.keys(pkg.dependencies);
  const devDeps = Object.keys(pkg.devDependencies);

  // runtime stage = the second FROM; prod-only install
  assert.match(dockerfile, /RUN npm ci --omit=dev --no-audit --no-fund/, 'runtime image must install prod deps only');
  assert.ok(dockerfile.indexOf('npm ci --omit=dev') > dockerfile.indexOf('FROM node:22-bookworm-slim AS runtime'), 'omit=dev must belong to the runtime stage');
  // the build stage keeps full deps so pdfkit is available for fixture regeneration
  assert.match(dockerfile, /RUN npm ci --no-audit --no-fund/, 'build stage must install full deps for fixture generation');
  assert.ok(dockerfile.indexOf('npm ci --no-audit --no-fund') < dockerfile.indexOf('FROM node:22-bookworm-slim AS runtime'), 'full install must belong to the build stage');

  // every prod package.json dependency is genuinely used by src/ at runtime
  const srcEntries = fs.readdirSync(path.join(__dirname, '..', 'src'), { recursive: true })
    .filter((p) => p.endsWith('.js'))
    .map((p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8'));
  const srcText = srcEntries.join('\n');
  for (const dep of prodDeps) {
    assert.match(srcText, new RegExp(`require\\(['"]${dep}['"]\\)|require\\(['"][^'"]*${dep}[^'"]*['"]\\)`), `src/ must require prod dep ${dep}`);
  }
  // the inverse: no module src/ requires at runtime may be dev-only
  const requiredBySrc = [...srcText.matchAll(/require\(['"](?:[^'"\]/]*\/)*([^'"/]+)['"]\)/g)].map((m) => m[1]);
  for (const mod of requiredBySrc) {
    if (devDeps.includes(mod)) {
      assert.fail(`src/ requires ${mod} but it is a devDependency — the runtime image would crash`);
    }
  }
  // pdfkit specifically is the build-time fixture tool, build stage only
  assert.ok(devDeps.includes('pdfkit'), 'pdfkit must remain a devDependency');

  // CMD must equal `npm start`
  const start = pkg.scripts.start;
  const cmd = /CMD \[([^\]]+)\]/.exec(dockerfile)[1].split(',').map((s) => s.trim().match(/^"(.+)"$/)[1]);
  assert.strictEqual(cmd.join(' '), start, 'the container CMD must match the npm start script');

  // HEALTHCHECK probes /api/health on process.env.PORT||3000 (same read as server.js line 11)
  assert.match(dockerfile, /HEALTHCHECK[^\n]*\n\s*CMD node -e/, 'runtime image must declare a HEALTHCHECK');
  assert.match(dockerfile, /\/api\/health/, 'HEALTHCHECK must probe the health endpoint');
  assert.match(dockerfile, /process\.env\.PORT\|\|3000/, 'HEALTHCHECK port read must mirror server.js');
  assert.match(dockerfile, /r\.ok\?0:1/, 'HEALTHCHECK must exit 0 iff the probe is ok');
});

test('prod: .dockerignore keeps dev/test/build artifacts out of the image context', () => {
  // The runtime stage copies src, public, scripts, fixtures and README only.
  // Anything committed but excluded here (test/, examples/, data/, .git) must
  // never leak into the image context or the `npm ci --omit=dev` layer.
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8');
  for (const entry of ['node_modules', 'data', '.git', 'test', 'examples', '.future-code']) {
    assert.ok(ignore.split(/\r?\n/).includes(entry), `.dockerignore must exclude ${entry}`);
  }
});

test('prod: examples/embeddable.html embed contract matches widget.js and a real backend domain', () => {
  // The committed example embed (README section for 嵌入浮窗) drives widget.js
  // purely through data-* attributes. widget.js reads exactly five of them
  // (api.test.js pins those getAttribute calls), and data-domain names a preset
  // the backend serves via /api/domains. If the example uses an attribute the
  // widget never reads, or a domain id that no longer exists, the demo silently
  // degrades while tests stay green — so assert the file against its two peers.
  const example = fs.readFileSync(path.join(__dirname, '..', 'examples', 'embeddable.html'), 'utf8');
  const widgetSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');

  // the widget must be embedded from the URL the app actually serves
  assert.match(example, /src="http:\/\/localhost:3000\/widget\.js"/, 'example must load widget.js from the served URL');

  const widgetReads = [...widgetSrc.matchAll(/script\.getAttribute\('(data-[a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(widgetReads.length >= 5, `widget.js should read 5 data attributes, got ${widgetReads.length}`);

  // every data-* on the example's two widget script tags must be one the
  // widget actually reads (data-token is documented/optional/sample text)
  const exampleAttrs = [...example.matchAll(/data-([a-z-]+)=/g)].map((m) => `data-${m[1]}`);
  assert.ok(exampleAttrs.length >= 5, `example should wire 5 data attributes, got ${exampleAttrs.length}`);
  for (const attr of exampleAttrs) {
    assert.ok(widgetReads.includes(attr), `example uses ${attr} but widget.js never reads it`);
  }

  // chat traffic must target the API route buildApp serves
  assert.match(example, /data-api="http:\/\/localhost:3000\/api\/chat"/, 'example must point data-api at /api/chat');

  // data-domain must be a preset the backend actually serves (/api/domains)
  const { DOMAINS } = require('../src/lib/domains');
  for (const attr of example.matchAll(/data-domain="([a-z-]+)"/g)) {
    assert.ok(DOMAINS[attr[1]], `example references domain "${attr[1]}" but no such preset is served`);
  }
});

test('prod: README.md documents the exact API, env, limits, response shape and embed surface the code serves', () => {
  // README.md is the operational contract fed into the software-copyright
  // submission: its route table, env table, upload limits and chat response
  // shape must stay true to what src/app.js / src/server.js / src/lib/knowledge.js
  // actually implement. A doc drift here ships a spec that the binary denies.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');

  // ---- route table (README table rows) must match app.js route registrations
  const appRoutes = {
    'GET /api/health': /app\.get\('\/api\/health',/,
    'GET /api/domains': /app\.get\('\/api\/domains',/,
    'GET /api/admin/docs ': /app\.get\('\/api\/admin\/docs',/,
    'GET /api/admin/docs/:id': /app\.get\('\/api\/admin\/docs\/:id',/,
    'DELETE /api/admin/docs/:id': /app\.delete\('\/api\/admin\/docs\/:id',/,
    'POST /api/admin/upload': /app\.post\('\/api\/admin\/upload',/,
    'GET /api/admin/logs': /app\.get\('\/api\/admin\/logs',/,
    'GET /api/admin/stats': /app\.get\('\/api\/admin\/stats',/,
    'GET /widget.js': /app\.get\('\/widget\.js',/,
  };
  for (const methodPath of Object.keys(appRoutes)) {
    const [verb, p] = methodPath.split(' ');
    assert.match(appSrc, appRoutes[methodPath], `src/app.js must register ${verb} ${p} as README documents`);
    assert.ok(
      readme.includes(p),
      `README.md must document the ${p} route`
    );
  }
  assert.ok(readme.includes('/api/chat'), 'README.md must document POST /api/chat');

  // ---- upload limits: field name `files`, max 20 files, max 50MB each
  assert.match(appSrc, /upload\.array\('files', 20\)/, 'app.js must accept field "files", max 20');
  assert.match(appSrc, /fileSize: 50 \* 1024 \* 1024/, 'app.js must cap each file at 50MB');
  assert.match(readme, /字段名 `files`/, 'README must document the multipart field name');
  assert.match(readme, /50MB/, 'README must document the 50MB per-file limit');
  assert.match(readme, /20 个/, 'README must document the 20-file per-upload limit');

  // ---- chat response shape: the README sample must match knowledge.js answer()
  const responseKeys = ['answer', 'mode', 'llm', 'confidence', 'citations', 'top', 'query'];
  for (const key of responseKeys) {
    assert.match(kbSrc, new RegExp(`${key}:`), `knowledge.js answer() must return ${key} as README documents`);
  }
  // citations entries carry docId/document/paragraph/excerpt; top carries the same
  assert.match(kbSrc, /docId: c\.docId/, 'citations entries must carry docId');
  assert.match(kbSrc, /document: c\.filename/, 'citations entries must carry document');
  assert.match(kbSrc, /paragraph: c\.chunkIndex/, 'citations entries must carry paragraph');
  assert.match(kbSrc, /excerpt: this\.excerptFrom/, 'citations entries must carry excerpt');
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'offline mode tag must be exactly what README shows');
  assert.match(kbSrc, /llm: false/, 'llm must default false as README states');
  assert.match(readme, /"mode": "offline-retrieval"/, 'README sample must show mode offline-retrieval');
  assert.match(readme, /"llm": false/, 'README sample must show llm false');

  // ---- env table: every documented variable is read, defaults match server.js
  const envReads = [
    ['PORT', serverSrc, 'process.env.PORT'],
    ['RAGDESK_DB', serverSrc, 'process.env.RAGDESK_DB'],
    ['RAGDESK_ADMIN_TOKEN', appSrc, 'RAGDESK_ADMIN_TOKEN'],
    ['RAGDESK_CHAT_TOKEN', appSrc, 'RAGDESK_CHAT_TOKEN'],
    ['RAGDESK_ALLOW_ORIGIN', appSrc, 'RAGDESK_ALLOW_ORIGIN'],
  ];
  for (const [varName, src, needle] of envReads) {
    assert.ok(readme.includes(varName), `README.md must document ${varName}`);
    assert.ok(src.includes(needle), `${varName} documented in README must actually be read (${needle})`);
  }
  assert.match(serverSrc, /PORT \|\| 3000/, 'README default PORT=3000 must match server.js');
  assert.match(serverSrc, /RAGDESK_DB \|\| path\.join\(ROOT, 'data', 'ragdesk\.db'\)/, 'README default DB path must match server.js');

  // ---- health / admin page / embed surface
  assert.ok(readme.includes('/api/health'), 'README must document the health endpoint');
  assert.ok(readme.includes('/admin'), 'README must document the admin page');
  assert.ok(readme.includes('widget.js'), 'README must document widget.js');
  assert.ok(readme.includes('ragdesk-data'), 'README must document the persistent named volume');
});
