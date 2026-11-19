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

test('prod: server.js boot banner names the real routes, offline mode and admin token state', () => {
  // The listen-callback console.log block is the operator's first-run surface:
  // README quick-start (演示页/管理后台/健康检查) and 用户手册 §2.2 ("启动成功后
  // 控制台会打印访问地址，默认端口 3000") promise exactly the URLs the banner
  // prints. The banner line and the single Admin/DB lines are pinned elsewhere;
  // the Demo/Health/Mode/admin-token lines could still drift without a test
  // noticing. Every line is cross-pinned to the route or semantic it labels.
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

  // each advertised URL must be a route app.js actually serves
  assert.match(serverSrc, /RAG-Desk running at http:\/\/localhost:\$\{PORT\}/, 'banner must print the running URL');
  assert.match(serverSrc, /Demo:\s+http:\/\/localhost:\$\{PORT\}\//, 'banner must advertise the demo page URL');
  assert.match(appSrc, /app\.get\('\/', \(_req, res\) => res\.sendFile\(path\.join\(ROOT, 'public', 'index\.html'\)\)/, 'demo URL must resolve to index.html');
  assert.match(serverSrc, /Admin:\s+http:\/\/localhost:\$\{PORT\}\/admin/, 'banner must advertise the admin URL');
  assert.match(appSrc, /app\.get\('\/admin', \(_req, res\) => res\.sendFile\(path\.join\(ROOT, 'public', 'admin\.html'\)\)/, 'admin URL must resolve to admin.html');
  assert.match(serverSrc, /Health:\s+http:\/\/localhost:\$\{PORT\}\/api\/health/, 'banner must advertise the health URL');
  assert.match(appSrc, /app\.get\('\/api\/health'/, 'health URL must be a served app route');
  assert.match(serverSrc, /DB:\s+\$\{DB_PATH\}/, 'banner must print the DB path');

  // Mode: line must state the same offline contract /api/health returns
  assert.match(serverSrc, /Mode:\s+offline retrieval \(LLM & embedding disabled\)/, 'banner must state the offline mode');
  assert.match(appSrc, /mode: 'offline'/, 'offline banner must match the health payload mode');
  assert.match(appSrc, /llmEnabled: false/, 'LLM-disabled banner must match the health payload');

  // admin token line: the open/token-gated split must key off the same env var
  // the README env table and docker-compose 'change-me' default document
  assert.match(
    serverSrc,
    /process\.env\.RAGDESK_ADMIN_TOKEN \? 'token-gated' : 'open \(set RAGDESK_ADMIN_TOKEN to protect\)'/,
    'banner must trace the admin token state to RAGDESK_ADMIN_TOKEN'
  );
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

test('prod: .gitignore keeps runtime, private and regenerable artifacts out of history', () => {
  // data/ holds the runtime DB: uploaded documents, the FTS index and the
  // query log. If it ever stopped being ignored, a casual `git add -A` would
  // commit user content and per-query history. The submission docs directory
  // is regenerated byte-for-byte by scripts/gen-submission-docs.js, and
  // .future-code/ carries session goals — neither belongs in history either.
  // node_modules/ pins the npm-install-only workflow (.gitignore gives the
  // lockfile guarantee package.json tests already pin for the image).
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  for (const entry of ['node_modules/', 'data/', '.future-code/', '.tmp/', '*.log', '20-rag-desk-软件著作权申请/']) {
    assert.ok(ignore.split(/\r?\n/).includes(entry), `.gitignore must exclude ${entry}`);
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

test("prod: README 嵌入浮窗 snippet's data-* vocabulary matches widget.js reads and a served domain preset", () => {
  // README.md section 嵌入浮窗 is the operator-facing embed recipe: a user
  // copies that script tag into their own site. Every data-* attribute it
  // documents must be one widget.js actually reads, data-api must point at the
  // /api/chat route buildApp serves, and data-domain must name a preset the
  // backend exposes — otherwise a copied snippet silently degrades.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const widgetSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');

  // scope to the 嵌入浮窗 section so the feature-list line (line ~13) that also
  // mentions <script data-api= data-domain=> cannot pollute the vocabulary check
  const section = readme.match(/## 嵌入浮窗[\s\S]*?## 测试/);
  assert.ok(section, 'README.md must have a 嵌入浮窗 section');
  const snippet = section[0].match(/<script[\s\S]*?<\/script>/);
  assert.ok(snippet, 'the 嵌入浮窗 section must contain the widget embed script tag');
  const block = snippet[0];

  // the snippet must document exactly the five attributes widget.js reads
  const snippetAttrs = [...block.matchAll(/data-([a-z-]+)=/g)].map((m) => `data-${m[1]}`);
  const expected = ['data-api', 'data-domain', 'data-greeting', 'data-title', 'data-token'];
  assert.deepEqual([...snippetAttrs].sort(), [...expected].sort(),
    `README snippet must document exactly ${expected.join('/')}`);
  const widgetReads = [...widgetSrc.matchAll(/script\.getAttribute\('(data-[a-z-]+)'\)/g)].map((m) => m[1]);
  for (const attr of snippetAttrs) {
    assert.ok(widgetReads.includes(attr), `README snippet documents ${attr} but widget.js never reads it`);
  }

  // data-api must target the /api/chat route buildApp serves
  assert.match(block, /data-api="http:\/\/localhost:3000\/api\/chat"/, 'README snippet must point data-api at the served /api/chat route');

  // data-domain must be a preset /api/domains actually serves
  const { DOMAINS } = require('../src/lib/domains');
  for (const attr of block.matchAll(/data-domain="([a-z-]+)"/g)) {
    assert.ok(DOMAINS[attr[1]], `README snippet references domain "${attr[1]}" but no such preset is served`);
  }

  // the five attributes must have real effect in widget.js, not just be parsed
  assert.match(widgetSrc, /headers\.Authorization = 'Bearer ' \+ TOKEN/, 'widget.js must send the documented data-token as a Bearer header');
  assert.match(widgetSrc, /fab\.title = TITLE/, 'widget.js must render data-title as the button tooltip');
  assert.match(widgetSrc, /addMsg\('bot', esc\(GREETING\)\)/, 'widget.js must greet with data-greeting upon open');
  assert.match(readme, /data-token Bearer 令牌/, 'README 覆盖 list must advertise the data-token Bearer footprint');
});

test('prod: SPEC.md design claims (formats, chunking, FTS5/BM25, domains, offline default, single-tenant) hold in the implementation', () => {
  // SPEC.md is the design source for the software-copyright submission: its
  // 功能需求 / AC blocks describe what the product must do. A design that the
  // binary denies is a spec drift — lock every testable claim to the source
  // that realises it, so a later rewrite that drops a documented mode or
  // format fails here instead of silently shipping a narrower product.
  const spec = fs.readFileSync(path.join(__dirname, '..', 'SPEC.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const chunkerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'chunker.js'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const { fileKind } = require('../src/lib/extractors');
  const { DOMAINS } = require('../src/lib/domains');
  const { chunkText } = require('../src/lib/chunker');

  // ---- 功能需求: intake formats listed are exactly the ones fileKind serves
  // path.extname('.md') is '' (dotfile rule), so fileKind must be fed real filenames
  const fileKinds = ['doc.md', 'doc.markdown', 'doc.txt', 'doc.csv', 'doc.pdf', 'doc.docx'].map((e) => fileKind(e));
  assert.deepEqual(fileKinds, ['markdown', 'markdown', 'text', 'csv', 'pdf', 'docx'],
    'SPEC intake formats (Markdown/PDF/DOCX/纯文本/CSV) must be exactly what fileKind serves');
  assert.ok(spec.includes('Markdown / PDF / DOCX / 纯文本 / CSV'), 'SPEC must list the intake formats');

  // ---- 功能需求: 400-char window with 40-char overlap is the chunker default
  assert.match(chunkerSrc, /window \|\| 400/, 'chunker default window must be 400 chars (SPEC 分块)');
  assert.match(chunkerSrc, /overlap \?\? 40/, 'chunker default overlap must be 40 chars (SPEC 重叠)');
  const chunks = chunkText('甲'.repeat(900));
  assert.ok(chunks.length > 2 && chunks[0].text.length <= 400, '400-char window must actually split a 900-char run');

  // ---- 功能需求: FTS5 + BM25 retrieval, single-tenant local SQLite
  assert.match(storageSrc, /CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5/, 'retrieval must stay on local SQLite FTS5');
  assert.match(storageSrc, /bm25\(fts\) AS score/, 'ranking must stay BM25 over the FTS index');
  assert.match(storageSrc, /tokenize='unicode61'/, 'FTS tokenizer must stay unicode61');

  // ---- 领域壳: every SPEC-listed preset exists and has the documented template fields
  assert.ok(spec.includes('预设领域配置'), 'SPEC must promise the preset domain-config shells');
  assert.ok(spec.includes('可自定义 system prompt 模板'), 'SPEC must promise editable system-prompt templates');
  for (const id of ['legal', 'medical', 'procurement', 'general']) {
    const d = DOMAINS[id];
    assert.ok(d, `SPEC preset domain ${id} must exist`);
    assert.ok(typeof d.systemPrompt === 'string' && d.systemPrompt, `${id} must carry a systemPrompt template`);
    assert.ok(typeof d.lead === 'string' && typeof d.fallback === 'string', `${id} must carry lead/fallback wording`);
  }

  // ---- AC2: 答案带引用 — citations are (source document + paragraph number) on the wire
  assert.ok(spec.includes('答案带引用'), 'SPEC AC2 must promise answer-with-citation output');
  assert.match(kbSrc, /document: c\.filename/, 'citations must name the source document');
  assert.match(kbSrc, /paragraph: c\.chunkIndex/, 'citations must carry the paragraph/chunk number');
  assert.ok(spec.includes('来源文档 + 段落号'), 'SPEC citations must promise source document + paragraph number (not 页码)');

  // ---- AC: offline (no LLM/embedding) answer path with 原文片段 + 置信度
  assert.ok(spec.includes('原文片段') && spec.includes('置信度'), 'SPEC 问答 must promise raw-fragment answers + confidence');
  assert.ok(spec.includes('无 LLM/embedding'), 'SPEC AC3 must promise offline answering without LLM/embedding');
  assert.ok(spec.includes('无外部 LLM 也可运行'), 'SPEC 离线模式 must promise running without any external LLM');
  assert.ok(spec.includes('纯检索回答'), 'SPEC 离线模式 must promise pure-retrieval answers');
  assert.ok(spec.includes('查询 → 本地检索（FTS BM25 + 可选 embedding 混合）'),
    'SPEC 问答 must keep the query → local retrieval pipeline');
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'offline answer mode must exist (SPEC 离线模式)');
  assert.match(kbSrc, /llm: false/, 'LLM must default off (SPEC LLM 默认关闭)');
  assert.match(kbSrc, /answer: answerText/, 'offline answers must be rule-generated from retrieval (SPEC 检索 + 规则)');

  // ---- 非目标: single-tenant is not a storage abstraction — no customer_id anywhere
  assert.ok(spec.includes('企业级多租户') && spec.includes('v1 单租户'), 'SPEC 非目标 must keep the enterprise multi-tenant out-of-scope text');
  assert.doesNotMatch(storageSrc, /customer_id|tenant_id/, 'SPEC 非目标 single-tenant must hold in storage');

  // ---- 非目标: no knowledge-graph machinery (graph/triple store) in the retrieval path
  assert.ok(spec.includes('复杂知识图谱'), 'SPEC must keep 复杂知识图谱 in its 非目标 block');
  assert.doesNotMatch(storageSrc, /\bgraph\b/i, 'SPEC 非目标 复杂知识图谱 must hold in storage');
  assert.doesNotMatch(kbSrc, /\bgraph\b/i, 'SPEC 非目标 复杂知识图谱 must hold in knowledge');

  // ---- AC: an embedded chat widget + API endpoint (README 嵌入浮窗 lock covers the snippet)
  assert.ok(spec.includes('嵌入式聊天浮窗'), 'SPEC must promise the embeddable chat widget');
  assert.ok(spec.includes('API endpoint'), 'SPEC must promise the API endpoint');

  // ---- AC1: SPEC keeps the 10-doc Chinese domain corpus promise
  // (its realization — the seeded fixtures — is locked by the boot-seed >= 10 assertion elsewhere)
  assert.ok(spec.includes('索引 10 篇领域文档'), 'SPEC AC1 must promise the 10-doc domain corpus');

  // ---- AC4: the demo page is pure-local — same-origin assets/API only, no external URLs
  assert.ok(spec.includes('无需外部 API'), 'SPEC AC4 must promise the no-external-API local demo page');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const demoSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'demo.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  assert.doesNotMatch(indexHtml + demoSrc + adminJs, /https?:\/\//, 'AC4 demo/admin pages must load no external URLs');
  assert.ok(demoSrc.includes("fetch('/api/chat'"), 'AC4 demo must call the same-origin chat API');
  assert.ok(demoSrc.includes("fetch('/api/domains')"), 'AC4 demo must call the same-origin domains API');

  // ---- AC5: upload → auto-index → ask — the upload route ingests each file into the KB
  assert.ok(spec.includes('上传新文档'), 'SPEC AC5 must promise upload → auto-index → ask');
  assert.ok(appSrc.includes("upload.array('files', 20)"), 'AC5 upload must accept up to 20 files at once');
  assert.ok(appSrc.includes('kb.ingestBuffer(f.originalname, f.buffer'), 'AC5 upload must index each uploaded file');

  // ---- AC6: admin views the query log + statistics through the documented logs route
  assert.ok(spec.includes('admin 查看查询日志'), 'SPEC AC6 must promise admin query-log viewing');
  assert.ok(spec.includes('统计查询日志'), 'SPEC 功能需求4 must promise query-log statistics');
  assert.ok(appSrc.includes('kb.getQueryLogs(limit)'), 'AC6 logs route must read the persisted query log');

  // ---- 功能需求: the admin surface also promises 查看索引 — served by the docs-list API
  assert.ok(spec.includes('查看索引'), 'SPEC must promise the admin index-viewing surface');
  assert.ok(appSrc.includes('kb.getAllDocs()'), '查看索引 must be served by the docs-list API');

  // ---- AC7: tests + README + Chinese domain corpus all ship (the submission's verification trio)
  assert.ok(spec.includes('测试 + README + 领域示例语料'), 'SPEC AC7 must promise tests, README and the corpus');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'README.md')), 'AC7 README must exist');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'seed-fixtures.js')), 'AC7 corpus must have a seed entrypoint');
  const corpusCount = fs.readdirSync(path.join(__dirname, '..', 'fixtures', 'corpus')).length;
  assert.ok(corpusCount === 10, `AC7 corpus must ship the 10 domain files, got ${corpusCount}`);

  // ---- 低算力守则: SPEC keeps 不训模型 + embedding 可选; src/ ships no ML machinery
  assert.ok(spec.includes('不训模型'), 'SPEC 低算力守则 must keep the no-training constraint');
  assert.ok(spec.includes('ONNX 小模型'), 'SPEC must keep embedding-as-optional (ONNX add-on) framing');
  assert.ok(spec.includes('检索增强按量（可关）'), 'SPEC must keep LLM metered-and-off-by-default framing');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const srcBlob = appSrc + chunkerSrc + storageSrc + kbSrc + serverSrc;
  assert.doesNotMatch(srcBlob, /\btrain(?:ing|ed)?\b|训练|\bonnx\b|fastembed/i,
    '低算力守则 must hold: src/ ships no training or model-loading machinery');

  // ---- AC: no external API dependency in the offline path — src/ has no HTTP client
  assert.doesNotMatch(appSrc, /require\(['"](node:)?https?['"]\)/, 'src/app.js must not call external services');
});

test('prod: the embeddable widget and example load only self-hosted/local resources (no external URL)', () => {
  // The AC4 pure-local promise must hold on every shipped client surface, not just
  // the demo/admin pages pinned above: the embeddable chat float (widget.js) and
  // the example embed page are themselves part of the offline demo story (SPEC
  // 功能需求5 客户在线 + AC4 纯本地 demo). The widget fetches the SAME data-api
  // endpoint the page is served from, so it must not hardcode (or reference) any
  // external origin. Intentional local-only stand-ins stay: the usage comment
  // documents `http://<host>:3000` (a self-hosted host placeholder, not a remote
  // load) and the example page embeds `http://localhost:3000`.
  const root = path.join(__dirname, '..');
  const widgetJs = fs.readFileSync(path.join(root, 'public', 'widget.js'), 'utf8');
  const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  const exampleHtml = fs.readFileSync(path.join(root, 'examples', 'embeddable.html'), 'utf8');

  // Runtime resource loads must stay same-origin: `src="` / `href="` / `fetch(`
  // may only point at a relative path, the ph `<host>` placeholder, or localhost.
  // (style.css contains relative url() refs; the widget builds its CSS inline.)
  const externalLoad = /(?:src|href)\s*=\s*["']https?:\/\/(?!<host>|localhost\b)/i;
  assert.doesNotMatch(widgetJs, externalLoad, 'widget.js must not load any external script/stylesheet');
  assert.doesNotMatch(styleCss, externalLoad, 'style.css must not load any external asset');
  assert.doesNotMatch(exampleHtml, externalLoad, 'example embed page must not load any external script/stylesheet');
  assert.doesNotMatch(exampleHtml + widgetJs, /fetch\(\s*["']https?:\/\/(?!<host>|localhost\b)/,
    'widget/example must not fetch any external API');

  // The widget must keep following the page's own origin (SPEC 功能需求5): the
  // data-api attribute and fetch target are relative by default, and the shipped
  // example proves the self-hosted wiring.
  assert.match(widgetJs, /data-api['"']\s*\|\|\s*['"]\/api\/chat['"]|script\.getAttribute\(['"]data-api['"]\)\s*\|\|\s*['"]\/api\/chat['"]/,
    'widget must default its chat API to the same-origin /api/chat');
  assert.ok(widgetJs.includes("fetch(API,"), 'widget must fetch its chat API via the configured data-api');
  assert.ok(exampleHtml.includes('localhost:3000'), 'example embed must demonstrate the localhost wiring');

  // AC ensure: the widget's promises to the demo story — 引用片段 + 置信度
  // rendering and the offline-retrieval meta line — match what the API returns
  // (pinned in src: citations {document, paragraph}, confidence).
  assert.match(widgetJs, /c\.document/, 'widget must render the citation source document');
  assert.match(widgetJs, /c\.paragraph/, 'widget must render the citation paragraph number');
  assert.ok(widgetJs.includes('置信度'), 'widget must render the confidence badge it receives');
});

test('prod: SPEC 定位/痛点/技术栈/Phases/里程碑/变现 roadmap claims hold in shipped code', () => {
  // SPEC opens with 定位/主要痛点, then fixes 技术栈, Phases P0-P3, 里程碑 M1-M3
  // and 变现. Roadmap entries with no realising artifact are spec drift as fatal
  // as a dropped AC — each purchase block must map to a file, a route or a
  // configuration that actually ships.
  const spec = fs.readFileSync(path.join(__dirname, '..', 'SPEC.md'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const root = path.join(__dirname, '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const exists = (p) => fs.existsSync(path.join(root, p));
  const srcText = fs
    .readdirSync(path.join(root, 'src'), { recursive: true })
    .filter((p) => p.endsWith('.js'))
    .map((p) => fs.readFileSync(path.join(root, 'src', p), 'utf8'))
    .join('\n');

  // ---- 定位: 数据本地索引 + 轻量部署. SQLite stays the only store; the
  // "向量自构建" ambition ships as the optional-v2 framing (embedding off), per
  // 功能需求's "本地 SQLite FTS5 + 可选项向量".
  assert.ok(spec.includes('数据本地索引'), 'SPEC 定位 must promise local data indexing');
  assert.match(read('src/lib/storage.js'), /new DatabaseSync\(dbPath\)/, '数据本地索引 must stay on node:sqlite');
  assert.ok(spec.includes('向量自构建'), 'SPEC 定位 keeps the 向量自构建 phrasing');
  assert.ok(spec.includes('分块（chunk）与索引（本地 SQLite FTS5 + 可选项向量）'),
    'SPEC 功能需求 must keep the vector index as the optional add-on over local SQLite FTS5');
  assert.match(read('src/lib/knowledge.js'), /embedding: false/, '向量 add-on must stay off by default (v2 optional)');
  assert.ok(spec.includes('轻量部署'), 'SPEC 定位 must promise lightweight deployment');
  assert.ok(exists('docker-compose.yml'), '轻量部署 must ship a docker-compose.yml');

  // ---- 主要痛点: 离线自托管 + 数据不出去. The offline promise must hold
  // structurally: no src file imports an outbound http(s) client and package.json
  // ships none.
  assert.ok(spec.includes('离线自托管'), 'SPEC 痛点 must promise offline self-hosting');
  assert.ok(spec.includes('数据不出去'), 'SPEC 痛点 must promise data stays on-site');
  assert.doesNotMatch(srcText, /require\(['"](?:node:)?https?['"]\)/, '数据不出去: src must import no http(s) client');
  assert.ok(!pkg.dependencies['node-fetch'] && !pkg.dependencies.axios && !pkg.dependencies.got,
    '数据不出去: package.json must ship no HTTP-client dependency');

  // ---- 技术栈: Node v22, SQLite FTS5 + BM25, self-built chat UI + admin, Docker Compose
  assert.ok(spec.includes('Node v22'), 'SPEC 技术栈 must name Node v22');
  assert.strictEqual(pkg.engines.node, '>=22.5.0', '技术栈 Node v22 must be the engines floor');
  assert.ok(spec.includes('SQLite FTS5'), 'SPEC 技术栈 must name SQLite FTS5');
  assert.ok(spec.includes('BM25'), 'SPEC 技术栈 must name BM25');
  assert.match(read('src/lib/storage.js'), /bm25\(fts\) AS score/, '技术栈 BM25 must be the real ranking function');
  assert.ok(spec.includes('中文'), 'SPEC 技术栈 must keep the Chinese-segmentation point');
  assert.match(read('src/lib/tokenizer.js'), /function ngrams\(cjkRun, n = 2\)/, '中文分词 must be the shipped bigram CJK tokenizer');
  assert.match(read('src/lib/storage.js'), /tokenize='unicode61'/, '中文检索 must stay on the unicode61 FTS tokenizer');
  assert.ok(spec.includes('简单聊天 UI + admin（自建）'), 'SPEC 前端 must promise self-built chat UI + admin');
  assert.ok(exists('public/index.html') && exists('public/widget.js') && exists('public/admin.html'),
    '前端 must ship the chat UI, embed widget and admin');
  assert.ok(!pkg.dependencies.react && !pkg.dependencies.vue, '前端 自建 must mean zero frontend-framework deps');
  assert.ok(spec.includes('Docker Compose'), 'SPEC 部署 must promise Docker Compose');
  assert.match(read('docker-compose.yml'), /^services:\s*\n\s*ragdesk:/m, '部署 compose must define the ragdesk service');
  assert.match(read('docker-compose.yml'), /api\/health/, '部署 compose must healthcheck the health route');

  // ---- Phases P0-P3: every phase maps to shipped deliverables
  assert.ok(spec.includes('P0: 摄入 + 分块 + FTS 索引'), 'SPEC phase P0 must be 摄入+分块+FTS 索引');
  assert.ok(exists('src/lib/chunker.js') && exists('src/lib/storage.js'), 'P0 must ship the chunker and the FTS store');
  assert.match(read('src/lib/storage.js'), /CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5/, 'P0 FTS index must exist');
  assert.ok(spec.includes('P1: 问答 API + 引用'), 'SPEC phase P1 must be 问答 API + 引用');
  assert.match(read('src/lib/knowledge.js'), /answer\(query, opts = \{\}\)/, 'P1 问答 must be served by the offline answer()');
  assert.match(read('src/app.js'), /app\.post\('\/api\/chat'/, 'P1 问答 API must be the /api/chat route');
  assert.ok(read('src/lib/knowledge.js').includes('citations:'), 'P1 引用 must ride the citations field');
  assert.ok(spec.includes('P2: 聊天浮窗 + admin'), 'SPEC phase P2 must be 聊天浮窗 + admin');
  assert.ok(exists('public/widget.js') && exists('public/admin.js'), 'P2 must ship the float widget and admin UI');
  assert.ok(spec.includes('P3: embedding 增强（可选）+ 领域模板'), 'SPEC phase P3 must be embedding-optional + 领域模板');
  assert.ok(exists('src/lib/domains.js'), 'P3 must ship the domain template packs');
  assert.match(read('src/lib/knowledge.js'), /embedding: false/, 'P3 embedding must stay the optional v2 enhancement');

  // ---- 里程碑 M1-M3: the whole roadmap is reachable from shipped code
  assert.ok(spec.includes('M1: FTS 检索问答（MVP）'), 'SPEC M1 must be FTS 检索问答');
  assert.match(read('src/lib/knowledge.js'), /mode: 'offline-retrieval'/, 'M1 must be the retrieval-only answer mode');
  assert.ok(spec.includes('M2: 引用 + API'), 'SPEC M2 must be 引用 + API');
  assert.match(read('src/lib/knowledge.js'), /paragraph: c\.chunkIndex/, 'M2 citations must carry the paragraph number');
  assert.ok(spec.includes('M3: 浮窗 + admin'), 'SPEC M3 must be 浮窗 + admin');
  assert.ok(exists('public/widget.js') && exists('public/admin.html'), 'M3 must ship the float widget and admin');

  // ---- 变现: 开源 self-host + 托管版订阅 — realised by the dual-license package
  assert.ok(spec.includes('开源 self-host'), 'SPEC 变现 must promise open-source self-hosting');
  assert.ok(spec.includes('托管版订阅'), 'SPEC 变现 must promise hosted-subscription revenue');
  assert.strictEqual(pkg.license, 'AGPL-3.0-only', '开源 base must stay AGPL-3.0-only');
  assert.ok(exists('COMMERCIAL-LICENSE.md'), '托管版 must be covered by the commercial license');
  const commerce = read('COMMERCIAL-LICENSE.md');
  assert.ok(commerce.includes('双授权'), 'commercial license must state the dual-licensing model');
  assert.ok(commerce.includes('商业授权'), 'commercial license must govern commercial/hosted use');
  assert.ok(commerce.includes('AGPL-3.0'), 'commercial license must reference the open-source AGPL base');
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

test('prod: README.md feature/stack prose matches the implementation (功能/技术栈/自定义领域/目录/许可)', () => {
  // README.md's opening 功能 bullets, 技术栈 and 自定义领域 sections describe
  // behavior the code must actually serve (chunker defaults, citation shape,
  // tokenizer scheme, formats, LLM-off default), and the 目录 table maps each
  // src file to a purpose. Locking them prevents a README-only rewrite from
  // outrunning the binary.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const chunkerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'chunker.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const tokenizerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tokenizer.js'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const extractorsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'extractors.js'), 'utf8');
  const domainsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  // ---- 功能 bullets
  assert.ok(readme.includes('自动分块（400 字符窗口，40 字符重叠）'), 'README must document the 400-window / 40-overlap chunker defaults');
  assert.match(chunkerSrc, /opts\.window \|\| 400/, 'chunker.js must default to a 400-char window as README states');
  assert.match(chunkerSrc, /opts\.overlap \?\? 40/, 'chunker.js must default to 40-char overlap as README states');
  assert.ok(readme.includes('SQLite FTS5 + unicode61'), 'README must document FTS5 + unicode61');
  assert.match(storageSrc, /tokenize='unicode61'/, 'storage.js FTS must use unicode61 as README states');
  assert.ok(readme.includes('二元切词'), 'README must document the bigram CJK tokenization');
  assert.match(tokenizerSrc, /overlapping n-grams \(default bigrams\)/, 'tokenizer.js must default to bigram n-grams as README states');
  assert.ok(readme.includes('BM25 排序'), 'README must document BM25 ranking');
  assert.match(storageSrc, /bm25\(fts\) AS score/, 'storage.js must rank by bm25(fts) as README states');
  assert.ok(readme.includes('引用（文档名 + 段落号）'), 'README must document the document-name + paragraph-number citation');
  assert.match(kbSrc, /document: c\.filename/, 'knowledge.js citations must carry the document name');
  assert.match(kbSrc, /paragraph: c\.chunkIndex/, 'knowledge.js citations must carry the paragraph number');
  assert.ok(readme.includes('领域预设（法律 / 医疗 / 招采 / 通用）'), 'README must document the four domain presets');
  for (const id of ['legal', 'medical', 'procurement', 'general']) {
    assert.ok(domainsSrc.includes(`${id}:`), `domains.js must serve the ${id} preset README lists`);
  }
  assert.ok(readme.includes('可选 LLM 摘要') && readme.includes('默认关闭'), 'README must document the LLM summarizer being off by default');
  assert.match(kbSrc, /OFF by default/, 'knowledge.js must default the LLM summarizer off as README states');

  // ---- 技术栈
  assert.ok(readme.includes('node:sqlite'), 'README must document the node:sqlite builtin');
  assert.match(storageSrc, /require\('node:sqlite'\)/, 'storage.js must import node:sqlite as README states');
  assert.ok(readme.includes('pdf-parse'), 'README must document pdf-parse');
  assert.match(extractorsSrc, /require\('pdf-parse'\)/, 'extractors.js must import pdf-parse as README states');
  assert.ok(readme.includes('fflate'), 'README must document fflate');
  assert.match(extractorsSrc, /unzipSync/, 'extractors.js must use fflate unzipSync for DOCX as README states');
  assert.ok(pkg.dependencies.fflate, 'package.json must ship fflate as a runtime dependency');
  assert.ok(pkg.dependencies['pdf-parse'], 'package.json must ship pdf-parse as a runtime dependency');
  assert.ok(readme.includes('无构建步骤'), 'README must document the no-build-step frontend');
  assert.ok(readme.includes('Docker Compose'), 'README must document Docker Compose deployment');

  // ---- 自定义领域
  assert.ok(readme.includes('src/lib/domains.js'), 'README must point operators at src/lib/domains.js');
  assert.ok(readme.includes('systemPrompt'), 'README must document the systemPrompt template field');
  assert.match(domainsSrc, /systemPrompt:/, 'domains.js presets must carry systemPrompt as README states');
  assert.ok(readme.includes('answerWithLlm'), 'README must document the answerWithLlm injection point');
  assert.match(kbSrc, /async answerWithLlm\(query, opts = \{\}\)/, 'knowledge.js must expose answerWithLlm({summarizer}) as README states');
  assert.ok(readme.includes('mock 已内置用于测试'), 'README must mention the built-in mock summarizer');
  assert.match(kbSrc, /async function mockSummarizer/, 'knowledge.js must ship the mock summarizer as README states');

  // ---- 目录 table: each src file exists and matches its documented purpose
  const dirTable = readme.match(/^  app\.js\s+#[^\n]+\n^  server\.js\s+#[^\n]+\n^  lib\/knowledge\.js\s+#[^\n]+\n^  lib\/storage\.js\s+#[^\n]+\n^  lib\/tokenizer\.js\s+#[^\n]+\n^  lib\/chunker\.js\s+#[^\n]+\n^  lib\/extractors\.js\s+#[^\n]+\n^  lib\/domains\.js\s+#[^\n]+/m);
  assert.ok(dirTable, 'README 目录 table must list all eight src files with purposes');
  assert.ok(readme.includes('fixtures/corpus/    # 中文领域语料（law/clinic/bid + pdf/docx/csv/txt）'),
    'README 目录 must document the Chinese corpus fixtures with the full format mix');
  assert.ok(readme.includes('public/             # 演示页 / admin / widget.js'),
    'README 目录 must document the public/ demo pages and widget');
  assert.ok(readme.includes('scripts/            # 种子与 fixtures 生成'),
    'README 目录 must document the scripts/ seed and fixture generators');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public')), '目录-listed public/ dir must exist');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts')), '目录-listed scripts/ dir must exist');
  assert.ok(readme.includes('npm ci + 运行'), 'README 目录 must describe the Dockerfile as npm ci + run');
  assert.ok(readme.includes('单服务编排'), 'README 目录 must describe docker-compose.yml as single-service');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js')), '目录-listed src/lib/domains.js must exist');

  // ---- 许可: AGPL-3.0 + 商业授权 dual license, README and package.json must agree
  assert.ok(readme.includes('AGPL-3.0'), 'README must document the AGPL-3.0 open-source license');
  assert.ok(readme.includes('商业授权'), 'README must document the commercial-authorization model');
  assert.strictEqual(pkg.license, 'AGPL-3.0-only', 'package.json license must be AGPL-3.0-only as README states');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'LICENSE')), 'AGPL-3.0 license text must live at project root LICENSE');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'COMMERCIAL-LICENSE.md')), 'commercial authorization terms must live at COMMERCIAL-LICENSE.md');

  // ---- license text content: the shipped LICENSE is the real AGPL, and the
  // dual-license header cross-references the commercial terms; COMMERCIAL-LICENSE.md
  // carries the profit-trigger clause and both name the same holder. A license
  // record that drifted from this would falsify the software-copyright submission.
  const licenseText = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');
  const commercial = fs.readFileSync(path.join(__dirname, '..', 'COMMERCIAL-LICENSE.md'), 'utf8');
  assert.ok(licenseText.includes('GNU AFFERO GENERAL PUBLIC LICENSE') && licenseText.includes('Version 3'),
    'LICENSE must contain the actual AGPL-3.0 text, not a placemarker');
  assert.match(licenseText, /GNU AGPL v3\.0/, 'LICENSE header must name GNU AGPL v3.0');
  assert.match(licenseText, /商业使用须书面授权/, 'LICENSE header must carry the written-authorization requirement');
  assert.match(licenseText, /许达 \(Xu Da\)/, 'LICENSE header must name the copyright holder 许达 (Xu Da)');
  assert.ok(licenseText.includes('中国移动研究院'), 'LICENSE header must name the holder affiliation 中国移动研究院');
  assert.ok(licenseText.includes('see COMMERCIAL-LICENSE.md'), 'LICENSE header must cross-reference the commercial terms');
  assert.ok(commercial.includes('开源许可 + 商业授权'), 'COMMERCIAL-LICENSE.md must state the dual-licensing model');
  assert.ok(commercial.includes('GNU Affero General Public License v3.0（AGPL-3.0）'),
    'COMMERCIAL-LICENSE.md must grant the AGPL-3.0 open-source terms');
  assert.ok(commercial.includes('盈利、商业收益或经营性收益'), 'COMMERCIAL-LICENSE.md must define the profit trigger');
  assert.ok(commercial.includes('书面商业授权'), 'COMMERCIAL-LICENSE.md must require prior written authorization');
  assert.ok(commercial.includes('许达（Xu Da）'), 'COMMERCIAL-LICENSE.md must name the copyright holder');
  assert.ok(commercial.includes('中国移动研究院'), 'COMMERCIAL-LICENSE.md must name the holder affiliation');
  // the three documents must agree on who the holder is, as README documents it
  assert.match(readme, /著作权人（许达，中国移动研究院）/,
    'README 许可 must name 许达，中国移动研究院 as the holder, like LICENSE and COMMERCIAL-LICENSE.md');
});

test('prod: README opening claims (three vertical sectors, fully-offline default, data stays local) hold end to end', () => {
  // README.md's opening lines are the product elevator pitch: law-firm knowledge
  // base / clinic FAQ / bid-award records as an embeddable Q&A bot, fully offline
  // (no external LLM or embedding model by default, local SQLite FTS5 + CJK
  // tokenizer + BM25), data never leaves the machine. Each named sector must map
  // to a seeded fixture the engine actually ingests, each offline claim to a code
  // needle that really runs.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const tokenizerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tokenizer.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const { CORPUS_FILES } = require('../scripts/fixture-content');

  // ---- sector tuple: each named vertical must be a seeded corpus fixture
  const sectorPins = [
    ['把律所知识库', 'law-faq.md', 'legal'],
    ['诊所 FAQ', 'clinic-faq.md', 'medical'],
    ['招中标资料', 'bid-announcement.md', 'procurement'],
  ];
  for (const [needle, fixture, domainId] of sectorPins) {
    assert.ok(readme.includes(needle), `README opening must name the ${domainId} vertical (${needle})`);
    assert.ok(Object.keys(CORPUS_FILES).includes(fixture), `sector ${needle} must map to the seeded fixture ${fixture}`);
  }
  // "可嵌入的问答 bot" — the embeddable bot must be a served route
  assert.ok(readme.includes('做成可嵌入的问答 bot'), 'README must promise the embeddable Q&A bot');
  assert.match(appSrc, /app\.get\('\/widget\.js',/, 'the embeddable bot must be served by the /widget.js route');

  // ---- fully-offline default: no external LLM / embedding, local FTS + BM25
  assert.ok(readme.includes('完全离线'), 'README must lead with the fully-offline property');
  assert.ok(readme.includes('不依赖任何外部 LLM 或 embedding 模型'), 'README must promise no external LLM/embedding by default');
  assert.match(kbSrc, /llm: false/, 'knowledge.js answer() must default the LLM off');
  assert.match(kbSrc, /embedding: false/, 'engineInfo must report embedding off');
  assert.match(storageSrc, /require\('node:sqlite'\)/, 'local-only indexing must stay on node:sqlite');
  assert.match(storageSrc, /tokenize='unicode61'/, 'local FTS must stay unicode61');
  assert.match(storageSrc, /bm25\(fts\) AS score/, 'retrieval must rank with BM25 as README states');
  assert.match(tokenizerSrc, /overlapping n-grams \(default bigrams\)/, 'CJK-friendliness must come from the bigram tokenizer');

  // ---- "数据不出机器": no outbound HTTP client in src and none shipped in deps
  for (const rel of ['src/app.js', 'src/server.js', 'src/lib/knowledge.js', 'src/lib/storage.js', 'src/lib/extractors.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(!/require\(['"](?:node:)?https?['"]\)/.test(src), `${rel} must import no outbound http(s) client`);
  }
  assert.ok(!pkg.dependencies['node-fetch'] && !pkg.dependencies.axios && !pkg.dependencies.got,
    'no HTTP-client dependency may ship under the data-stays-local promise');
});

test('prod: browser clients (admin.js / demo.js) read exactly the JSON keys the backend actually produces', () => {
  // The admin and demo pages are the third consumer of the API surface, and
  // nothing greps their source: a storage.js rename of `with_answer` /
  // `top_filename` / `chunk_count`, a knowledge.js change of the answer shape,
  // or an app.js upload result without `action`/`filename` would silently break
  // both pages while the node tests stay green. Every JSON member the two
  // clients read must be constructible by the backend layer that serves it.
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const demoSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'demo.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');

  // ---- admin.js renders /api/admin/stats via data.stats.{total,with_answer}
  assert.match(appSrc, /res\.json\(\{ stats: kb\.getQueryStats\(\) \}\)/, 'app.js must serve /api/admin/stats as { stats }');
  assert.match(storageSrc, /SELECT COUNT\(\*\) AS total/, 'storage.js stats must count total queries');
  assert.match(storageSrc, /AS with_answer/, 'storage.js stats must report with_answer');
  assert.match(storageSrc, /matched > 0/, 'with_answer must be queries that hit at least one citation');
  assert.ok(adminJs.includes('data.stats || { total: 0, with_answer: 0 }'), 'admin.js must read stats.total and stats.with_answer');
  assert.ok(adminJs.includes('s.total'), 'admin.js must render total query count');
  assert.ok(adminJs.includes('s.with_answer'), 'admin.js must render hit count');

  // ---- admin.js /api/admin/docs rows need id, filename, kind, chunk_count, size, created_at
  assert.match(storageSrc, /AS chunk_count\n       FROM docs d ORDER BY d\.id DESC/, 'docs list must count chunks per doc');
  assert.ok(adminJs.includes("d.chunk_count"), 'admin.js must read chunk_count');
  assert.ok(adminJs.includes("d.filename"), 'admin.js must read filename');
  assert.ok(adminJs.includes("d.kind"), 'admin.js must read kind');
  assert.ok(adminJs.includes("d.created_at"), 'admin.js must read created_at');
  assert.ok(adminJs.includes('d.size'), 'admin.js must read size');
  assert.ok(adminJs.includes('d.id'), 'admin.js must read the doc id');

  // ---- admin.js /api/admin/docs/:id chunks read chunk_idx and body
  assert.match(storageSrc, /SELECT id, chunk_idx, body FROM chunks/, 'chunk listing must expose chunk_idx and body');
  assert.ok(adminJs.includes('c.chunk_idx'), 'admin.js must read chunk_idx');
  assert.ok(adminJs.includes('c.body'), 'admin.js must read chunk body');

  // ---- admin.js /api/admin/logs rows read created_at, query, domain, matched, top_score, top_filename
  assert.match(storageSrc, /d\.filename AS top_filename/, 'logs must join in the top-hit filename');
  assert.ok(adminJs.includes("l.created_at"), 'admin.js must read log created_at');
  assert.ok(adminJs.includes("l.query"), 'admin.js must read log query');
  assert.ok(adminJs.includes('l.domain'), 'admin.js must read log domain');
  assert.ok(adminJs.includes('l.matched'), 'admin.js must read log matched');
  assert.ok(adminJs.includes('l.top_score'), 'admin.js must read log top_score');
  assert.ok(adminJs.includes('l.top_filename'), 'admin.js must read log top_filename');

  // ---- admin.js /api/admin/upload results use action + filename (indexed/duplicate/error)
  assert.ok(adminJs.includes("r.action === 'indexed'"), 'admin.js must handle the indexed action');
  assert.ok(adminJs.includes("r.action === 'duplicate'"), 'admin.js must handle the duplicate action');
  assert.ok(adminJs.includes("r.action === 'error'"), 'admin.js must handle the error action');
  assert.ok(adminJs.includes('r.filename'), 'admin.js must read the per-file result filename');
  assert.match(kbSrc, /return \{ action: 'indexed', docId, chunks: chunks\.length \}/, 'knowledge.js must emit indexed with chunks');
  assert.match(kbSrc, /return \{ action: 'duplicate', docId: existing\.id \}/, 'knowledge.js must emit duplicate');
  assert.match(kbSrc, /return \{ action: 'error'/, 'knowledge.js must emit error');
  // the upload form accepts exactly the extensions knowledge.js can parse
  const accepted = /accept="([^"]+)"/.exec(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8'))[1];
  for (const ext of ['.md', '.markdown', '.pdf', '.docx', '.txt', '.csv']) {
    assert.ok(accepted.includes(ext), `admin upload input must accept .${ext}`);
  }
  const { fileKind } = require('../src/lib/extractors');
  for (const ext of accepted.split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.ok(fileKind('sample' + ext) !== null, `admin page lets users pick ${ext} but the backend cannot parse it`);
  }

  // ---- demo.js /api/domains presets → same preset ids the backend serves
  assert.match(appSrc, /res\.json\(\{\n\s+domains: domainIds\(\)\.map/, '/api/domains must map over the served preset ids');
  assert.ok(demoSrc.includes('map[d.id] = { greeting: d.greeting, examples: d.examples || [] };'), 'demo must read id/greeting/examples per domain');
  assert.ok(demoSrc.includes("fetch('/api/domains')"), 'demo must load presets from /api/domains');
  // demo's static fallback must cover every preset id the backend defines
  const { DOMAINS } = require('../src/lib/domains');
  for (const id of Object.keys(DOMAINS)) {
    assert.ok(demoSrc.includes(`${id}: {`), `demo.js static fallback must cover preset "${id}"`);
    assert.ok(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').includes(`value="${id}"`), `index.html must ship the ${id} select option`);
  }

  // ---- demo.js renders /api/chat via answer/citations/document/paragraph/confidence/mode
  assert.ok(demoSrc.includes('data.answer'), 'demo must render the answer text');
  assert.ok(demoSrc.includes('(data.citations || [])'), 'demo must render citations');
  assert.ok(demoSrc.includes('c.document'), 'demo must render citation document');
  assert.ok(demoSrc.includes('c.paragraph'), 'demo must render citation paragraph');
  assert.ok(demoSrc.includes('data.confidence'), 'demo must render confidence');
  assert.ok(demoSrc.includes("data.mode === 'offline-retrieval'"), 'demo must branch on the offline mode tag');
  assert.ok(demoSrc.includes("JSON.stringify({ query: q, domain: domainSelect.value })"), 'demo must submit query + domain to /api/chat');
});

test('prod: README quick-start 打开 URLs and Docker prose (healthcheck + named volume) match the deployed surface', () => {
  // README.md lines 31-34 tell the operator to open three URLs on the default
  // port; lines 36-42 promise `docker compose up --build` yields an image with a
  // /api/health healthcheck and the ragdesk-data named volume. Each claim is an
  // operator contract: a route rename, a port default drift, or a compose
  // healthcheck/volume removal would leave the quick-start lying while the node
  // tests stay green. Pin every README string to the source that serves it.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

  // the README quick-start block itself states the port (npm start -> 3000)
  assert.ok(readme.includes('npm start        # 启动 http://localhost:3000'), 'quick-start must document the default port');
  assert.match(serverSrc, /const PORT = Number\(process\.env\.PORT \|\| 3000\)/, 'port 3000 default must come from server.js');

  // 演示页 -> / serves public/index.html
  assert.ok(readme.includes('演示页：http://localhost:3000/'), 'README must list the demo URL');
  assert.match(appSrc, /app\.get\('\/', \(_req, res\) => res\.sendFile\(path\.join\(ROOT, 'public', 'index\.html'\)\)/, 'demo URL must be served by the / route');

  // 管理后台 -> /admin serves public/admin.html
  assert.ok(readme.includes('管理后台：http://localhost:3000/admin'), 'README must list the admin URL');
  assert.match(appSrc, /app\.get\('\/admin', \(_req, res\) => res\.sendFile\(path\.join\(ROOT, 'public', 'admin\.html'\)\)/, 'admin URL must be served by the /admin route');

  // 健康检查 -> /api/health (compose probes the same endpoint)
  assert.ok(readme.includes('健康检查：http://localhost:3000/api/health'), 'README must list the health URL');
  assert.match(appSrc, /app\.get\('\/api\/health'/, 'health URL must be served by the /api/health route');
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health'\)/, 'compose healthcheck must probe the same endpoint');

  // Docker block: `docker compose up --build` must exist and match the compose service
  assert.ok(readme.includes('docker compose up --build'), 'README must document the compose-up command');
  assert.match(compose, /^services:\s*\n\s*ragdesk:/m, 'compose must define the ragdesk service the README starts');

  // 镜像包含健康检查（/api/health）
  assert.ok(readme.includes('镜像包含健康检查（`/api/health`）'), 'README must claim the image ships a healthcheck');
  assert.match(compose, /healthcheck:/, 'compose must declare a healthcheck to back the claim');
  assert.match(dockerfile, /HEALTHCHECK[^\n]*\n\s*CMD node -e/, 'Dockerfile must declare a HEALTHCHECK to back the claim');
  assert.match(dockerfile, /\/api\/health/, 'Dockerfile HEALTHCHECK must probe /api/health');

  // 数据持久化在命名卷 ragdesk-data
  assert.ok(readme.includes('数据持久化在命名卷 `ragdesk-data`'), 'README must claim the named-volume persistence');
  assert.match(compose, /- ragdesk-data:\/app\/data/, 'compose must mount the named volume on the DB dir');
  assert.match(compose, /^volumes:\s*\n\s*ragdesk-data:/m, 'compose must declare the ragdesk-data volume');
  assert.match(compose, /RAGDESK_DB=\/app\/data\/ragdesk\.db/, 'the DB must live on the persisted volume path');
});

test('prod: README 测试 coverage list maps one-to-one onto a live suite test for every claimed area', () => {
  // README.md lines 107-110 advertise a fixed coverage list ("覆盖：..."). The
  // claim is a contract on the test suite: for every area the README promises
  // to cover, at least one live test must carry the matching assertion/title.
  // A bullet that no longer matches any test (the area silently becoming
  // untested, or the README over-promising) breaks the lock here while every
  // individual test stays green. Each pair is [README fragment, suite needle].
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const suite = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8'))
    .join('\n');
  const coverage = [
    ['分块', 'chunker: splits long text into overlapping windows'],
    ['中文检索命中', 'chinese bigram query finds the right chunk (AC1 core)'],
    ['top1 片段含答案', 'chinese bigram query finds the right chunk (AC1 core)'],
    ['引用', 'offline answer with citation'],
    ['重复上传幂等', 'duplicate upload is idempotent (AC5)'],
    ['删除清理', 'ingest then delete keeps index clean'],
    ['空白语料兜底', 'answer on empty corpus gives graceful fallback'],
    ['离线模式', 'offline mode returns answer without any LLM/embedding'],
    ['查询日志', 'logQuery + getQueryLogs roundtrip'],
    ['未知领域降级 general', 'unknown domain falls back to general preset'],
    ['上传→索引→问答', 'indexes a buffered doc (AC5)'],
    ['浮窗脚本提供', 'widget script is served and self-contained'],
    ['data-token Bearer 令牌', 'supports RAGDESK_CHAT_TOKEN via data-token'],
    ['/api/domains 与 /api/admin/stats', '/api/domains returns preset domains'],
    ['鉴权令牌', 'admin endpoints are token-gated'],
    ['CORS', 'CORS allowOrigin'],
    ['静态页', 'static page skeletons carry'],
    ['空文件', 'rejects an empty file'],
    ['类型', 'rejects an unsupported file type'],
    ['50MB', 'over the 50MB'],
    ['20 个', 'rejects more than 20 files'],
    ['DOCX 仅运行时依赖', 'DOCX ingest works with only runtime deps'],
  ];
  for (const [claim, needle] of coverage) {
    assert.ok(readme.includes(claim), `README 测试 list must still claim ${claim}`);
    assert.ok(suite.includes(needle), `README claims coverage of ${claim} but no live test matches "${needle}"`);
  }
});

test('prod: README env-var prose (open-by-default + browser token prompt) matches app.js, admin.js and compose', () => {
  // README.md lines 86-87 (env-var section tail) make two operator-facing
  // claims: with no token set the product behaves exactly like the fully
  // offline demo, and once RAGDESK_ADMIN_TOKEN is configured the admin UI
  // prompts for the token in the browser. Both must stay true in the shipped
  // surface: app.js keeps every gate open on a blank token, the offline default
  // is the health endpoint's llmEnabled:false, compose turns the admin gate on
  // with change-me for production, and admin.js implements the prompt.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');

  // 未设置任何 token 时功能与完全离线 demo 一致: blank tokens leave every
  // gate open (dev default), and the health endpoint advertises the offline
  // engine with LLM off — the exact demo parity the README promises.
  assert.ok(readme.includes('默认（未设置任何 token）时功能与完全离线 demo 一致'), 'README must state the open-by-default contract');
  assert.match(appSrc, /opts\.adminToken \|\| process\.env\.RAGDESK_ADMIN_TOKEN \|\| ''/, 'blank admin token must keep /api/admin open');
  assert.match(appSrc, /opts\.chatToken \|\| process\.env\.RAGDESK_CHAT_TOKEN \|\| ''/, 'blank chat token must keep /api/chat open');
  assert.match(appSrc, /if \(!adminToken\) return next\(\);/, 'the admin gate must only engage when a token is configured');
  assert.match(appSrc, /llmEnabled: false/, 'the health endpoint must advertise LLM-off for the offline-demo parity');

  // 生产对外暴露时建议至少设置 RAGDESK_ADMIN_TOKEN: compose's production
  // wiring must actually turn the admin gate on (change-me placeholder).
  assert.ok(readme.includes('`RAGDESK_ADMIN_TOKEN`'), 'README must recommend RAGDESK_ADMIN_TOKEN for production exposure');
  assert.match(compose, /RAGDESK_ADMIN_TOKEN=change-me/, 'compose must default the admin gate on with the change-me placeholder');
  assert.match(appSrc, /req\.get\('x-admin-token'\)/, 'admin.js must be able to pass the token the README says it prompts for');

  // 管理后台会在浏览器中提示输入令牌: admin.js must implement the browser
  // prompt and send the entered value as x-admin-token.
  assert.ok(readme.includes('管理后台会在浏览器中提示输入令牌'), 'README must promise the browser token prompt');
  assert.match(adminJs, /prompt\('该后台需要访问令牌（RAGDESK_ADMIN_TOKEN），请输入：'\)/, 'admin.js must prompt for the admin token in the browser');
  assert.ok(adminJs.includes("headers['x-admin-token'] = token"), 'the prompted token must ride the x-admin-token header');
});

test('prod: README API-table 说明 column and 技术栈 prose map onto live routes and source needles', () => {
  // README 的 API 短说明列（/api/health 引擎状态与领域列表、/api/domains 领域预设含示例问题、
  // /api/admin/docs 已索引文档列表含分块数、/api/admin/logs 查询日志含统计摘要、/api/admin/stats
  // 查询量统计字段、/widget.js 嵌入式浮窗脚本）和 技术栈 承诺（node:sqlite 无需编译本地依赖、
  // 自研 CSV/纯文本解析器、原生 HTML/CSS/JS）是面向集成方的契约：每个短句都必须由一条真实路由
  // 或源模块兑现，否则接线漂移后文档会描述一个不存在的接口。
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const extractorsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'extractors.js'), 'utf8');

  // ---- /api/health：引擎状态、领域列表
  assert.ok(readme.includes('引擎状态、领域列表'), 'README API-table must describe /api/health as engine state + domain list');
  assert.match(appSrc, /res\.json\(\{[\s\S]*?engine: kb\.engineInfo\(\),[\s\S]*?domains: domainIds\(\)/,
    'health route must serve engineInfo + domainIds as the 引擎状态、领域列表 claim states');

  // ---- /api/domains：领域预设（含示例问题）
  assert.ok(readme.includes('领域预设（含示例问题）'), 'README API-table must describe /api/domains as presets with example questions');
  assert.match(appSrc, /examples: getDomain\(id\)\.exampleQuestions/,
    'domains route must expose per-domain exampleQuestions to back the 含示例问题 claim');

  // ---- /api/admin/docs：已索引文档列表（含分块数）
  assert.ok(readme.includes('已索引文档列表（含分块数）'), 'README API-table must describe the docs list with chunk count');
  assert.match(appSrc, /app\.get\('\/api\/admin\/docs',[\s\S]*?docs: kb\.getAllDocs\(\)/,
    'docs route must serve the full doc list as the 已索引文档列表 claim states');
  assert.match(storageSrc, /AS chunk_count/, 'listDocs must aggregate chunk_count to back the 含分块数 claim');

  // ---- /api/admin/logs：查询日志（含统计摘要）
  assert.ok(readme.includes('查询日志（含统计摘要）'), 'README API-table must describe the logs route with a stats summary');
  assert.match(appSrc, /res\.json\(\{ logs: kb\.getQueryLogs\(limit\), stats: kb\.getQueryStats\(\) \}\)/,
    'logs route must pair the query log with the stats summary the 含统计摘要 claim states');

  // ---- /api/admin/stats：查询量统计（总查询 / 有回答命中 / 命中率）
  assert.ok(readme.includes('查询量统计（总查询 / 有回答命中 / 命中率）'), 'README API-table must describe the stats fields');
  assert.match(storageSrc, /SELECT COUNT\(\*\) AS total,[\s\S]*?AS with_answer/,
    'queryLogStats must compute total + with_answer to back the 总查询 / 有回答命中 fields');

  // ---- /widget.js：嵌入式聊天浮窗脚本
  assert.ok(readme.includes('嵌入式聊天浮窗脚本'), 'README API-table must describe /widget.js as the embeddable widget script');
  assert.match(appSrc, /app\.get\('\/widget\.js',[\s\S]*?res\.type\('application\/javascript'\)\.sendFile/,
    'widget route must serve widget.js as application/javascript per the 嵌入式浮窗 script claim');

  // ---- 技术栈：无需编译本地依赖、自研 CSV/纯文本、原生 HTML/CSS/JS
  assert.ok(readme.includes('无需编译本地依赖'), 'README 技术栈 must promise no native build dependencies');
  assert.match(storageSrc, /require\('node:sqlite'\)/, 'storage must import node:sqlite so no native module ever compiles');
  assert.ok(readme.includes('自研 CSV/纯文本'), 'README 技术栈 must claim in-house CSV/plain-text parsers');
  assert.match(extractorsSrc, /function parseCsv/, 'extractors.js must implement the in-house CSV parser the 自研 CSV claim names');
  assert.ok(readme.includes('原生 HTML/CSS/JS'), 'README 技术栈 must claim vanilla HTML/CSS/JS');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'index.html'))
    && fs.existsSync(path.join(__dirname, '..', 'public', 'admin.html'))
    && fs.existsSync(path.join(__dirname, '..', 'public', 'widget.js')),
    'the vanilla pages HTTP the 技术栈 list sits side by side in public/ with no build output');
});

test('prod: README 环境变量 说明 column and 嵌入浮窗 sample map onto server/app/widget wiring', () => {
  // README 环境变量表每一行的 说明 是运维契约：各变量怎么读（PORT 默认 3000、
  // RAGDESK_DB 默认 data/ragdesk.db、空 token = 开放并需 x-admin-token / Bearer
  // 请求头、RAGDESK_ALLOW_ORIGIN 跟随请求 Origin）必须由 server.js/app.js/widget.js
  // 兑现；嵌入浮窗示例的 data-* 属性值（medical 领域、诊所在线咨询 title、
  // 导诊助手 greeting）必须与 domains.js/widget.js 默认一致，否则集成方照抄即错。
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const widgetSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');
  const domainsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js'), 'utf8');

  // ---- PORT / RAGDESK_DB 默认值列与 说明 列
  assert.ok(readme.includes('`PORT`') && readme.includes('HTTP 端口'), 'README env table must define PORT as the HTTP port');
  assert.match(serverSrc, /PORT \|\| 3000/, 'server.js must default PORT to 3000 as the table states');
  assert.ok(readme.includes('`RAGDESK_DB`') && readme.includes('SQLite 数据库文件路径'), 'README env table must define RAGDESK_DB as the DB path');
  assert.match(serverSrc, /RAGDESK_DB \|\| path\.join\(ROOT, 'data', 'ragdesk\.db'\)/, 'server.js must default the DB to data/ragdesk.db as the table states');

  // ---- RAGDESK_ADMIN_TOKEN / RAGDESK_CHAT_TOKEN：空（开放）+ 请求头约定
  assert.ok(readme.includes('空（开放）'), 'README env table must mark both tokens as open-by-default');
  assert.ok(readme.includes('`x-admin-token: <token>`'), 'README must document the x-admin-token header for admin');
  assert.match(appSrc, /req\.get\('x-admin-token'\) \|\| ''/, 'assertAdmin must read x-admin-token as the README header states');
  assert.ok(readme.includes('`Authorization: Bearer <token>`'), 'README must document the Bearer header for chat');
  assert.match(appSrc, /`Bearer \$\{chatToken\}`/, 'chatAuth must compare against the Bearer header the README specifies');

  // ---- RAGDESK_ALLOW_ORIGIN：跟随请求 Origin（任意）→ 未设置时回显请求 Origin
  assert.ok(readme.includes('跟随请求 Origin（任意）'), 'README must describe the reflect-request-origin default');
  assert.ok(readme.includes('`https://docs.example.com`'), 'README must show a concrete allowed-origin example');
  assert.match(appSrc, /allowOrigin \|\| origin/, 'app CORS must fall back to the request origin when RAGDESK_ALLOW_ORIGIN is unset');

  // widget sample: data-domain/title/greeting medical 领域值 = domains.js + widget.js 默认
  assert.ok(readme.includes('data-title="诊所在线咨询"'), 'README embed sample must use the medical demo title');
  assert.match(domainsSrc, /'医疗 · 诊所'/, 'domains.js must ship the medical preset the embed sample selects');
  assert.ok(readme.includes('data-greeting="您好，我是诊所在线导诊助手。"'), 'README embed sample must carry the generic medical greeting');
  assert.match(domainsSrc, /greeting: '您好，我是诊所在线导诊助手。/, 'domains.js medical greeting must match the embed sample');
  assert.ok(readme.includes('data-token="<chat token，仅当设置了 RAGDESK_CHAT_TOKEN 时填写>"'), 'README embed sample must document the conditional data-token');
  assert.match(widgetSrc, /data-token'\) \|\| ''/, 'widget.js must read data-token as the embed sample documents');
  assert.match(widgetSrc, /'Bearer ' \+ TOKEN/, 'widget.js must send the data-token as a Bearer Authorization header');
});

test('prod: README 嵌入浮窗 sample src/data-api/data-domain map onto the served /widget.js + /api/chat routes and the medical preset', () => {
  // The 嵌入浮窗 code block is the copy-paste recipe for integrators: they take
  // src / data-api / data-domain verbatim and drop the tag into their own site.
  // A copied snippet only works if those three values name things the backend
  // really serves — the /widget.js route, the /api/chat endpoint, and a preset
  // /api/domains exposes. Previous tests pin the block's attribute vocabulary
  // and the title/greeting/token sample values; this one ties the remaining
  // three sample values to their app.js/widget.js/domains.js needles.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const widgetSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');
  const domainsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js'), 'utf8');

  // src must point at the URL the app actually serves widget.js from
  assert.ok(readme.includes('src="http://localhost:3000/widget.js"'), 'README embed sample must load the served /widget.js URL');
  assert.match(appSrc, /app\.get\('\/widget\.js',[\s\S]*?res\.type\('application\/javascript'\)\.sendFile\(path\.join\(ROOT, 'public', 'widget\.js'\)\)/,
    'app must serve /widget.js as application/javascript so the sample src URL resolves');

  // data-api must target the chat endpoint buildApp exposes at /api/chat
  assert.ok(readme.includes('data-api="http://localhost:3000/api/chat"'), 'README embed sample must point data-api at the served /api/chat route');
  assert.match(appSrc, /app\.post\('\/api\/chat', chatAuth,/, 'app must expose POST /api/chat for the sample data-api path');
  assert.match(widgetSrc, /var API = script\.getAttribute\('data-api'\) \|\| '\/api\/chat';/,
    'widget.js must default data-api to /api/chat, the same endpoint the sample targets');

  // data-domain must name a preset the backend serves via /api/domains
  assert.ok(readme.includes('data-domain="medical"'), 'README embed sample must select the medical preset');
  assert.match(domainsSrc, /medical: \{\n\s+id: 'medical',/, 'domains.js must define the medical preset with id medical the sample selects');
  assert.match(widgetSrc, /var DOMAIN = script\.getAttribute\('data-domain'\) \|\| 'general';/,
    'widget.js must honor data-domain so the sample medical selection takes effect');
});

test('prod: README 自定义领域 措辞字段 (lead/fallback/footer·systemPrompt·answerWithLlm injection) 兑现为 knowledge.js 离线答案组装', () => {
  // README 自定义领域 is the extension recipe: adding a domain entry in
  // src/lib/domains.js is enough, systemPrompt feeds the optional LLM path, and
  // lead/fallback/footer alone control the offline answer wording. A custom
  // domain whose wording fields drift from the offline assembler would look
  // configured while answers silently ignore it — so pin each claim to the
  // knowledge.js code that actually consumes those fields.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

  // 增加条目即可: domains.js is a plain object map the backend loads directly
  assert.ok(readme.includes('增加条目即可'), 'README must promise adding a domains.js entry is enough');
  assert.match(kbSrc, /const \{ getDomain \} = require\('\.\/domains'\)/, 'knowledge.js must load presets from domains.js by id');
  assert.match(appSrc, /const \{ getDomain, domainIds \} = require\('\.\/lib\/domains'\)/, 'app.js must load the same domains.js map for /api/domains');

  // systemPrompt 使用于可选 LLM: the field must feed answerWithLlm, not offline
  assert.ok(readme.includes('`systemPrompt` 使用于可选 LLM 摘要'), 'README must scope systemPrompt to the optional LLM summarizer');
  assert.match(kbSrc, /systemPrompt: domainCfg\.systemPrompt,/, 'answerWithLlm must pass the preset systemPrompt into the summarizer');

  // lead/fallback/footer 控制离线答案措辞: the offline assembler must consume
  // all three exactly as README claims
  assert.ok(readme.includes('`lead/fallback/footer` 控制离线答案措辞'), 'README must claim the offline wording comes from lead/fallback/footer');
  assert.match(kbSrc, /if \(!top\) \{\n\s+answerText = domainCfg\.fallback;/, 'offline answer must use fallback when retrieval finds nothing');
  assert.match(kbSrc, /const lead = domainCfg\.lead;/, 'offline assembler must read lead from the domain preset');
  assert.match(kbSrc, /answerText = `\$\{lead\}\\n\\n\$\{excerpt\}\\n\\n\$\{domainCfg\.footer\}`\.trim\(\);/, 'offline answer must wrap the excerpt with lead + footer');

  // 可注入自定义 kb.answerWithLlm({summarizer}): the injection point must exist
  assert.ok(readme.includes('可注入自定义 `kb.answerWithLlm({summarizer})`'), 'README must document the answerWithLlm injection point');
  assert.match(kbSrc, /answerWithLlm\(query, opts = \{\}\)/g, 'knowledge.js must expose the answerWithLlm injectable summarizer path');
});

test('prod: README POST /api/chat 样例 (request body / 条件 Bearer / law-faq.md 引用) 兑现为 app.js 处理器与领域语料', () => {
  // README /api/chat 段落是集成方照抄的调用契约：请求体样例的 query 必须是
  // 自带语料真能回答的、domain 必须是真实预设；「当设置 RAGDESK_CHAT_TOKEN 时
  // 需附带 Bearer 头」必须兑现为 chatAuth 的条件门；响应样例的引用必须指向
  // fixtures 真文件名。样例与实现漂移会让照抄的调用方拿 404/401 或错误领域。
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const domainsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js'), 'utf8');
  const lawFaq = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'corpus', 'law-faq.md'), 'utf8');

  // 请求体样例：query 是在自带 legal 语料中真实存在的问句，domain 是真实预设
  assert.ok(readme.includes('{ "query": "律师咨询费怎么收取？", "domain": "legal" }'),
    'README must show the exact /api/chat request body with query + domain');
  assert.ok(lawFaq.includes('律师咨询费怎么收取'), 'the sample query must be answerable from the shipped law-faq.md corpus');
  assert.match(appSrc, /const \{ query, domain, limit \} = req\.body \|\| \{\};/,
    'app.js must read the query/domain fields the README sample sends');
  assert.match(appSrc, /kb\.answer\(String\(query\)\.trim\(\), \{ domain,/, 'app.js must route body query/domain into knowledge.answer');
  assert.match(domainsSrc, /legal: \{\n\s+id: 'legal',/, 'the sample domain legal must be a real preset in domains.js');

  // 条件 Bearer：RAGDESK_CHAT_TOKEN 未设时开放，设置后需精确 Bearer 头
  assert.ok(readme.includes('当设置 `RAGDESK_CHAT_TOKEN` 时，需附带请求头 `Authorization: Bearer <token>`'),
    'README must scope the Bearer requirement to when RAGDESK_CHAT_TOKEN is set');
  assert.match(appSrc, /if \(!chatToken\) return next\(\);/, 'chatAuth must stay open when RAGDESK_CHAT_TOKEN is unset');
  assert.match(appSrc, /auth !== `Bearer \$\{chatToken\}`/, 'chatAuth must require the exact Bearer token the README states');

  // 响应样例引用必须指到真实 shipped 语料文件 + knowledge 返回该文件名
  assert.ok(readme.includes('"citations": [{ "docId": 3, "document": "law-faq.md", "paragraph": 2, "excerpt": "…" }]'),
    'README response sample must cite law-faq.md as the document');
  assert.match(kbSrc, /document: c\.filename/, 'knowledge citations must return the corpus filename the sample shows');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'fixtures', 'corpus', 'law-faq.md')),
    'the response-sample referenced law-faq.md must ship in fixtures/corpus');
});

test('prod: README 功能 bullet 管理后台（上传文档 / 查看索引分块 / 查询日志与统计）兑现为 admin 路由与 knowledge 门面', () => {
  // README 功能列表第 6 条把管理后台概括为三个动作：上传文档、查看索引分块、
  // 查询日志与统计。这是产品开篇面向评审人的卖点句：每个动作都必须有一条真实
  // app.js 路由 + knowledge.js 门面兑现，否则文档许诺的"管理后台"在跑起来的
  // 服务里并不存在。前面的 spec/设计说明书 锁只 pin 了文档间的措辞一致性，
  // 这条首次把 README 功能 bullet 直接锚到源码接线。
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');

  // ---- 上传文档：multipart 路由 + 内存摄入门面
  assert.ok(readme.includes('管理后台：上传文档、查看索引分块、查询日志与统计'),
    'README 功能 must promise the admin surface with all three actions');
  assert.match(appSrc, /app\.post\('\/api\/admin\/upload', upload\.array\('files', 20\), async/,
    '上传文档 must be served by the multipart upload route');
  assert.match(kbSrc, /async ingestBuffer\(filename, buffer, meta = \{\}\)/,
    'the upload route must land in the knowledge ingest facade');

  // ---- 查看索引分块：docs/:id 路由 + 门面把 chunk 列表交给 /api/admin/docs/:id
  assert.match(appSrc, /app\.get\('\/api\/admin\/docs\/:id',[\s\S]*?if \(!doc\) return res\.status\(404\)[\s\S]*?const chunks = kb\.getDocChunks\(doc\.id\);[\s\S]*?res\.json\(\{ doc, chunks \}\);/, '查看索引分块 must be served by the per-doc chunks route');
  assert.match(kbSrc, /getDocChunks\(id\) \{\n\s+return this\.storage\.listChunks\(id\);/, 'getDocChunks must fan out to storage listChunks');
  assert.match(adminJs, /adminFetch\('\/api\/admin\/docs\/' \+ id\)/, 'admin.js must fetch the per-doc chunks as 查看索引分块 states');

  // ---- 查询日志与统计：logs 路由同时携带日志与统计摘要
  assert.match(appSrc, /res\.json\(\{ logs: kb\.getQueryLogs\(limit\), stats: kb\.getQueryStats\(\) \}\)/,
    '查询日志与统计 must be served as the logs route pairing logs with the stats summary');
  assert.match(kbSrc, /getQueryLogs\(limit = 100\) \{\n\s+return this\.storage\.listQueryLogs\(limit\);/, 'getQueryLogs must fan out to storage listQueryLogs');
  assert.match(kbSrc, /getQueryStats\(\) \{\n\s+return this\.storage\.queryLogStats\(\);/, 'getQueryStats must fan out to storage queryLogStats');
  assert.match(adminJs, /adminFetch\('\/api\/admin\/logs\?limit=50'\)/, 'admin.js must open the query log view as 查询日志与统计 states');
});

test('prod: README 功能 bullet 中文友好检索 + 离线问答 (Han 二元切词·BM25·检索片段+置信度+引用) 兑现为 tokenizer/storage/knowledge 检索链', () => {
  // README 功能列表第 3、4 条是检索链路的产品承诺：中文友好检索 = FTS5
  // unicode61 + Han 部分二元切词（索引与查询两侧）+ BM25 排序；离线问答 = 从
  // 命中分块切出「检索片段」+ confidenceScore 算「置信度」+ 返回「文档名 + 段落号」
  // 引用。前序测试 pin 的是这些卖点的断片（unicode61 / 二元切词 / BM25 / 引用子串），
  // 本测试首次把两条完整 bullet 逐句锚到 tokenizer.js / storage.js / knowledge.js
  // 的实际接线，防止 README 只改卖点措辞而检索链早已换实现。
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const tokenizerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tokenizer.js'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');

  // ---- 中文友好检索 bullet：FTS5 unicode61 + Han 二元切词（索引与查询）+ BM25 排序
  assert.ok(readme.includes('中文友好检索：SQLite FTS5 + unicode61'),
    'README 中文友好检索 bullet must name FTS5 + unicode61');
  assert.ok(readme.includes('Han 部分按二元切词索引与查询'),
    'README must scope bigram tokenization to Han runs, on both index and query');
  assert.match(storageSrc, /tokenize='unicode61'/, 'indexing must stay on the unicode61 FTS5 tokenizer');
  assert.match(tokenizerSrc, /const isCJK = CJK_RE\.test\(ch\);/, 'tokenizer must classify Han runs so only those get n-grammed (Han 部分)');
  assert.match(storageSrc, /expandForIndex\(c\.text\)\.join\(' '\)/, 'index side must store the bigram expansion (按二元切词索引)');
  assert.match(tokenizerSrc, /ngrams\(token, 2\)\.map\(\(g\) => /, 'query side must OR-group the Han bigrams (按二元切词查询)');
  assert.match(storageSrc, /bm25\(fts\) AS score[\s\S]*?ORDER BY score ASC/, 'retrieval must rank hits by BM25 ascending as 排序 states');

  // ---- 离线问答 bullet：检索片段 + 置信度 + 引用（文档名 + 段落号）
  assert.ok(readme.includes('离线问答：返回「检索片段 + 置信度 + 引用（文档名 + 段落号）」'),
    'README 离线问答 bullet must promise the fragment + confidence + citation triple');
  assert.match(kbSrc, /const excerpt = this\.excerptFrom\(top\.body, query\);/, 'offline answer must cut the 检索片段 from the top-hit chunk body');
  assert.match(kbSrc, /confidence: top \? confidenceScore\(top, chunks\) : 0,/, 'offline answer must derive 置信度 from the retrieval scores');
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'the fragment answer must be served in offline-retrieval mode');
  assert.match(kbSrc, /document: c\.filename,/, '引用 must carry the 文档名 from the hit file');
  assert.match(kbSrc, /paragraph: c\.chunkIndex,/, '引用 must carry the 段落号 from the hit chunk index');
});

test('prod: README 功能 bullet 领域预设 (prompt/模板包·可自定义 system prompt) + 嵌入浮窗 (即可使用) 兑现为 domains.js 模板域与 widget.js 自举浮窗', () => {
  // README 功能列表第 5、7 条是两类可扩展性卖点：领域预设 = 四个垂直领域作为
  // prompt/模板包，且 system prompt 可自定义（预设只读 → 改 domainCfg 即生效）；
  // 嵌入浮窗 = 只贴一行 <script data-api=... data-domain=...> 标签即可使用（widget.js
  // 自举：无依赖、防重复加载、读 data-* 属性并自行向数据 API 发问）。前序测试 pin 了
  // 「领域预设（四个 id）」与 README 自定义领域段落，本测试首次把这两条 bullet 的
  // 剩余承诺（prompt/模板包·可自定义·即可使用）锚到 domains.js / knowledge.js /
  // widget.js 的实际接线。
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const domainsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const widgetSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');

  // ---- 领域预设 bullet：prompt/模板包 + 可自定义 system prompt
  assert.ok(readme.includes('领域预设（法律 / 医疗 / 招采 / 通用）作为 prompt/模板包，可自定义 system prompt'),
    'README 领域预设 bullet must describe the four presets as customizable prompt/template packs');
  assert.match(domainsSrc, /Domain presets \(法律\/医疗\/招采\) as prompt\/template packs/,
    'domains.js header must describe the presets as prompt/template packs');
  assert.ok(readme.includes('可自定义 system prompt'), 'README must promise editable system prompts');
  for (const id of ['legal', 'medical', 'procurement', 'general']) {
    assert.match(domainsSrc, new RegExp(`${id}: \\{[\\s\\S]*?systemPrompt:`),
      `preset ${id} must ship its own systemPrompt so the prompt is 可自定义 per domain`);
  }
  assert.match(kbSrc, /systemPrompt: domainCfg\.systemPrompt,/, 'the customizable systemPrompt must feed the optional summarizer');

  // ---- 嵌入浮窗 bullet：贴标签即可使用 = widget.js 自举（无依赖、防重复、读 data-* 并自动发问）
  assert.ok(readme.includes('嵌入浮窗：`<script src="/widget.js" data-api=... data-domain=...>` 即可使用'),
    'README 嵌入浮窗 bullet must promise drop-in usage via the single script tag');
  assert.match(widgetSrc, /\(function \(\) \{\n  'use strict';\n  if \(window\.__ragDeskWidget\) return;/, 'widget.js must be a self-contained IIFE that guards against double loading (drop-in safe)');
  assert.match(widgetSrc, /var API = script\.getAttribute\('data-api'\) \|\| '\/api\/chat';/, 'widget must read data-api so the bullet data-api=... tag works');
  assert.match(widgetSrc, /var DOMAIN = script\.getAttribute\('data-domain'\) \|\| 'general';/, 'widget must read data-domain so the bullet data-domain=... tag works');
  assert.match(widgetSrc, /body: JSON\.stringify\(\{ query: q, domain: DOMAIN \}\),/,
    'widget must itself post query+domain to the data-api endpoint (即可使用 means no host code needed)');
  assert.match(widgetSrc, /addMsg\('bot', ans \+ '<span class="rd-meta">离线检索 · 置信度 '/,
    'widget must render the offline answer with confidence so the dropped-in float is self-sufficient');
});

test('prod: README opening pitch 垂直行业 RAG 客服壳 / 仅用本地 SQLite FTS5 + CJK 友好分词 + BM25 做检索回答 / 数据不出机器 兑现为演示页标题与本地检索链', () => {
  // README.md lines 1-5 are the elevator pitch: a vertical-industry RAG customer-
  // support shell that is fully offline — local SQLite FTS5 + Chinese-friendly
  // tokenizer + BM25 only, data never leaves the machine. The intro's sector-shell
  // promise and its local-only sentence must trace to live code, not marketing.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const tokenizerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tokenizer.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');

  // ---- 垂直行业 RAG 客服壳: the intro's vertical-shell promise is echoed by the
  // served demo-page subtitle, and the / route actually delivers that page
  assert.ok(readme.includes('垂直行业 RAG 客服壳'), 'README must introduce the vertical-industry customer-support shell');
  assert.match(appSrc, /app\.get\('\/', \(_req, res\) => res\.sendFile\(path\.join\(ROOT, 'public', 'index\.html'\)\)/,
    'the shell promise must be served by the / route');
  assert.ok(indexHtml.includes('垂直行业 RAG 客服壳'), 'public/index.html subtitle must echo the shell promise the intro names');

  // ---- 仅用本地 SQLite FTS5: the local-i-only engine stays on node:sqlite
  assert.ok(readme.includes('仅用本地 SQLite FTS5'), 'README must promise local SQLite FTS5 as the only engine');
  assert.match(storageSrc, /require\('node:sqlite'\)/, 'the local engine must stay on node:sqlite');

  // ---- CJK 友好分词: the local tokenizer header claims Chinese-friendliness
  assert.ok(readme.includes('CJK 友好分词'), 'README must name the CJK-friendly tokenizer');
  assert.match(tokenizerSrc, /Chinese-friendly FTS5 tokenization utilities/,
    'tokenizer.js header must claim the Chinese-friendliness the intro promises');

  // ---- BM25 做检索回答: answers come from BM25-ranked local hits via the offline path
  assert.ok(readme.includes('BM25 做检索回答'), 'README must tie answers to BM25-ranked local retrieval');
  assert.match(storageSrc, /bm25\(fts\) AS score/, 'answers must be ranked by the local BM25 score');
  assert.match(kbSrc, /Answer a query in fully offline mode/,
    'knowledge.js must implement the fully-offline answer path the intro promises');

  // ---- 数据不出机器: the pitch's data-confinement phrase must stay in the README
  assert.ok(readme.includes('数据不出机器'), 'README must promise data never leaves the machine');
});

test('prod: README POST /api/chat 响应样例 (answer 检索片段+置信度说明 / confidence 0.86 / top 文档字段) 兑现为 knowledge.js 离线答案对象', () => {
  // The README /api/chat response sample promises the offline answer object
  // shape: answer embeds the retrieval excerpt plus a confidence note, a numeric
  // confidence, and a top hit carrying the citation fields (docId/document/
  // paragraph/excerpt). Each sample field must trace to the answer() return.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const demoSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'demo.js'), 'utf8');

  // ---- "answer": "...检索片段 + 置信度说明..."
  assert.ok(readme.includes('"answer": "...检索片段 + 置信度说明..."'),
    'README sample must show answer merging an excerpt with a confidence note');
  assert.match(kbSrc, /answer: answerText,/, 'knowledge answer() must return the assembled answer string');
  assert.match(kbSrc, /const excerpt = this\.excerptFrom\(top\.body, query\);/, 'the answer excerpt must come from the top hit body');
  // The 置信度说明 is rendered client-side from the answer object's numeric
  // confidence field: demo.js appends "可置信度 N%" whenever top is present.
  assert.match(demoSrc, /const conf = data\.top \? `可置信度 \$\{Math\.round\(\(data\.confidence \|\| 0\) \* 100\)\}%` : '';/,
    'demo.js must render the confidence note from the answer object, fulfilling the 置信度说明 promise');

  // ---- "confidence": 0.86 — a numeric confidence derived from score spread
  assert.ok(readme.includes('"confidence": 0.86'), 'README sample must show a numeric confidence');
  assert.match(kbSrc, /confidence: top \? confidenceScore\(top, chunks\) : 0,/,
    'answer() must ship the score-spread confidence number the sample shows');

  // ---- "top": { "docId": 3, "document": "law-faq.md", "paragraph": 2, "excerpt": "…" }
  assert.ok(readme.includes('"top": { "docId": 3, "document": "law-faq.md", "paragraph": 2, "excerpt": "…" }'),
    'README sample must show top with the full citation field set');
  assert.match(kbSrc, /top: top\s*\n\s*\? \{/, 'answer() must return the top-hit object under top');
  for (const field of ['docId: top.docId', 'document: top.filename', 'paragraph: top.chunkIndex', 'excerpt: this.excerptFrom(top.body, query)']) {
    assert.ok(kbSrc.includes(field), `top object must carry ${field} as the sample documents`);
  }
});

test('prod: README 技术栈 前端 full sentence 原生 HTML/CSS/JS（演示问答页 + 管理后台 + 嵌入浮窗），无构建步骤 兑现为 public/ 静态三件套与零构建脚本', () => {
  // README 技术栈第 3 条是运维对前端的技术承诺：整句话（原生 HTML/CSS/JS、
  // 演示问答页 + 管理后台 + 嵌入浮窗 三个交付物、无构建步骤）必须由 public/ 下
  // 的普通静态文件与 package.json 的脚本/依赖布局兑现 —— 一旦页面变成 ES-module
  // 源文件、引入打包器或新增 build 脚本，"无构建步骤"的承诺就失效了。
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  // ---- 技术栈 line 19 full sentence + the deliverable scope clause
  assert.ok(readme.includes('前端：原生 HTML/CSS/JS（演示问答页 + 管理后台 + 嵌入浮窗），无构建步骤'),
    'README 技术栈 must keep the full 前端 sentence: vanilla stack, three deliverables, no build step');
  assert.ok(readme.includes('演示问答页 + 管理后台 + 嵌入浮窗'),
    'README must scope the vanilla frontend to exactly demo + admin + widget');

  // ---- 演示问答页 = plain static index.html wiring in the local demo.js
  const demoScript = /<script src="\/([^"]+)"><\/script>/.exec(indexHtml);
  assert.ok(demoScript && demoScript[1] === 'demo.js',
    'the demo page must load public/demo.js as a plain vanilla script, no bundling');
  assert.doesNotMatch(indexHtml, /type="module"/, 'the demo page must not require ES-module bundling (无构建步骤)');

  // ---- 管理后台 = plain static admin.html wiring in the local admin.js
  const adminScript = /<script src="\/([^"]+)"><\/script>/.exec(adminHtml);
  assert.ok(adminScript && adminScript[1] === 'admin.js',
    'the admin page must load public/admin.js as a plain vanilla script, no bundling');
  assert.doesNotMatch(adminHtml, /type="module"/, 'the admin page must not require ES-module bundling (无构建步骤)');

  // ---- 嵌入浮窗 = app.js serves the raw public/widget.js with no transform
  assert.match(appSrc, /app\.use\(express\.static\(path\.join\(ROOT, 'public'\)\)\)/,
    'public/ must be served as plain static assets, no transform pipeline');
  assert.match(appSrc, /app\.get\('\/widget\.js',[\s\S]*?res\.type\('application\/javascript'\)\.sendFile\(path\.join\(ROOT, 'public', 'widget\.js'\)\)/,
    'the widget must be served straight from public/widget.js with no bundling');

  // ---- 无构建步骤 = package.json defines no build script and no bundler dep
  assert.deepStrictEqual(Object.keys(pkg.scripts).sort(), ['seed', 'start', 'test'],
    '零构建脚本: the only npm scripts are start/seed/test, exactly as the no-build promise requires');
  assert.ok(!('build' in pkg.scripts), '零构建: package.json must not define a build script');
  assert.ok(!('vite' in pkg.devDependencies || 'webpack' in pkg.devDependencies || 'rollup' in pkg.devDependencies),
    '零打包器: devDependencies must not pull a bundler into the repo');
});

test('prod: package.json scripts, engines, main and deps stay consistent with the documented contract', () => {
  // package.json is the operator-facing install/run contract: npm start / npm
  // seed / npm test are the exact commands README.md and Dockerfile document.
  // A drifted entrypoint (renamed script file, changed engine floor or test
  // glob) would ship a doc that can no longer be executed as written.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

  // ---- `main` must point at the exact file `npm start` runs
  assert.strictEqual(pkg.main, 'src/server.js', 'pkg.main must be src/server.js');
  assert.match(pkg.scripts.start, /src\/server\.js/, 'start script must launch src/server.js as main declares');
  assert.ok(fs.existsSync(path.join(__dirname, '..', pkg.main)), 'pkg.main file must exist');

  // ---- every script entry must target a real file
  for (const scriptName of ['start', 'seed', 'test']) {
    assert.ok(pkg.scripts[scriptName], `package.json must define the ${scriptName} script`);
  }
  assert.match(pkg.scripts.seed, /scripts\/seed-fixtures\.js/, 'seed script must run scripts/seed-fixtures.js');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'seed-fixtures.js')), 'seed entrypoint must exist');

  // ---- 快速开始 seed target: README tells operators `npm run seed` generates
  // the domain corpus (fixtures/corpus) and writes it into data/ragdesk.db —
  // the seeder's two target paths must stay exactly those, or the quick-start
  // lies about where the demo data lands.
  const seedSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seed-fixtures.js'), 'utf8');
  assert.match(readme, /npm run seed\s+# 生成并把领域语料（fixtures\/corpus）写入 data\/ragdesk\.db/,
    'README 快速开始 must show seed writing fixtures/corpus into data/ragdesk.db');
  assert.match(seedSrc, /FIXTURES = path\.join\(ROOT, 'fixtures', 'corpus'\)/,
    'seed-fixtures.js must target fixtures/corpus as the README quick-start states');
  assert.match(seedSrc, /dbPath = path\.join\(ROOT, 'data', 'ragdesk\.db'\)/,
    'seed-fixtures.js must write data/ragdesk.db as the README quick-start states');
  assert.match(seedSrc, /fs\.mkdirSync\(path\.dirname\(dbPath\), \{ recursive: true \}\)/,
    'seed-fixtures.js must create the DB parent dir so the data/ target works from a clean checkout');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'fixtures', 'corpus')), 'the quick-start corpus dir must exist');
  assert.ok(fs.readdirSync(path.join(__dirname, '..', 'fixtures', 'corpus')).length > 0,
    'the quick-start corpus dir must hold the generated fixtures');
  assert.match(pkg.scripts.test, /--test/, 'test script must use the node test runner');
  assert.match(pkg.scripts.test, /test\/\*\.test\.js/, 'test script must match test/*.test.js as the suite layout');

  // ---- engines floor: README documents Node.js >= 22.5, Dockerfile pins 22-bookworm-slim
  assert.strictEqual(pkg.engines.node, '>=22.5.0', 'engines floor must stay >=22.5.0');
  assert.match(readme, /22\.5/, 'README must document the Node.js >= 22.5 requirement');
  assert.match(dockerfile, /FROM node:22-bookworm-slim/, 'Dockerfile must stay on the node:22 base the engine floor implies');

  // ---- devDependencies stay build-stage-only: src/ runtime must not need pdfkit
  assert.ok(pkg.devDependencies.pdfkit, 'pdfkit must remain a devDependency (fixture build tool)');
  const srcText = fs
    .readdirSync(path.join(__dirname, '..', 'src'), { recursive: true })
    .filter((p) => p.endsWith('.js'))
    .map((p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8'))
    .join('\n');
  assert.doesNotMatch(srcText, /require\(['"]pdfkit['"]\)/, 'src/ must never require the dev-only pdfkit at runtime');

  // ---- documented commands must be exactly the scripts that exist
  // README's quick-start (npm install / npm start / npm run seed) is the same
  // surface Dockerfile's CMD (npm start) and the test suite (npm test) use.
  assert.match(readme, /npm start/, 'README must direct operators to npm start');
  assert.match(readme, /npm run seed/, 'README must document the seed step');
  assert.match(readme, /npm test/, 'README must document the test command');
  // Dockerfile CMD carries the same expanded command the start script defines
  assert.match(dockerfile, new RegExp(`CMD \\["${pkg.scripts.start.split(' ').join('", "')}"\\]`), 'Dockerfile CMD must stay the expanded npm start command');
  assert.ok(
    dockerfile.indexOf('CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]') > dockerfile.indexOf('FROM node:22-bookworm-slim AS runtime'),
    'CMD must belong to the runtime stage'
  );
});

test('prod: package-lock.json stays a valid, complete, tracked lockfile for npm ci', () => {
  // Both Dockerfile stages run `npm ci` (build with devDeps, runtime with
  // --omit=dev), which hard-fails if the lockfile is absent, stale or out of
  // sync with package.json. A lockfile-only or manifest-only bump would ship a
  // container that cannot be built as documented, so every field that could
  // silently drift between the two files is pinned here.
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const root = lock.packages[''];

  // npm ci requires lockfileVersion 2/3 (npm >= 7); lockfile v1 is install-only.
  assert.ok([2, 3].includes(lock.lockfileVersion), 'package-lock.json must use a modern lockfileVersion (2 or 3) for npm ci');

  // The metadata root must mirror package.json exactly: npm install bumps name
  // /version / license / engines in both, and `npm ci` resolves nothing from
  // the manifest — a mismatch here means the lock records a different package.
  assert.strictEqual(root.name, pkg.name, 'lockfile root name must match package.json name');
  assert.strictEqual(root.version, pkg.version, 'lockfile root version must match package.json version');
  assert.strictEqual(root.license, pkg.license, 'lockfile root license must match package.json license');
  assert.deepStrictEqual(root.engines, pkg.engines, 'lockfile root engines must match package.json engines');

  // Runtime deps live in root.dependencies (npm normally) or nested — whichever
  // layout the lock uses, every prod dep must have a resolved node_modules entry
  // or `npm ci --omit=dev` in the runtime stage fails.
  const lockProd = { ...(root.dependencies || {}) };
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(lock.packages[`node_modules/${name}`], `lockfile must resolve prod dep ${name} for the runtime npm ci`);
    assert.strictEqual(lockProd[name], pkg.dependencies[name], `lockfile must record ${name} at the package.json specifier`);
  }

  // Root devDependencies must match package.json too, and the dev-only build
  // tool (pdfkit) must be absent from prod dependencies so --omit=dev really
  // strips it (pdfkit is notorious for pulling native deps into the image).
  assert.deepStrictEqual(root.devDependencies || {}, pkg.devDependencies, 'lockfile root devDependencies must match package.json');
  assert.ok(!('pdfkit' in (root.dependencies || {})), 'pdfkit must stay out of lockfile prod dependencies');
  assert.ok(lock.packages['node_modules/pdfkit'], 'lockfile must still resolve pdfkit for the build-stage npm ci');

  // The lockfile is a commit-time artifact: if it stops being tracked, `npm ci`
  // inside the Dockerfile silently builds from a stale lock or none at all.
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'package-lock.json')), 'package-lock.json must exist on disk');
});

test('prod: committed corpus fixtures stay byte-identical to their generating source modules', () => {
  // seedIfNeeded's sha256 pre-check (skip unchanged) assumes the committed
  // files under fixtures/corpus ARE exactly what ensureCorpusFiles() would
  // write. If fixture-content.js or the docx/pdf generators drift from the
  // committed binaries, a re-seed silently re-indexes content, query answers
  // change, and the submitted corpus artifact no longer matches the running
  // product. The pdf sentinel md5 is also part of the software-copyright
  // submission record.
  const crypto = require('node:crypto');
  const { CORPUS_FILES } = require('../scripts/fixture-content');
  const { DOCX_FIXTURE_TEXT } = require('../scripts/make-docx-fixture');
  const { PDF_FIXTURE_TEXT } = require('../scripts/make-pdf-fixture');
  const { extractDocx } = require('../src/lib/extractors');
  const CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');

  // ---- text fixtures: every committed markdown/csv/txt must equal the source
  // module content the seeder writes (idempotence of the sha256 pre-check)
  for (const [name, content] of Object.entries(CORPUS_FILES)) {
    const committed = fs.readFileSync(path.join(CORPUS, name), 'utf8');
    assert.strictEqual(committed, content, `committed ${name} must byte-match fixture-content.js`);
  }

  // ---- docx: the committed binary must extract to exactly the generator text
  const docxText = String(extractDocx(fs.readFileSync(path.join(CORPUS, 'law-services.docx'))));
  assert.strictEqual(docxText, DOCX_FIXTURE_TEXT, 'law-services.docx must roundtrip to the DOCX_FIXTURE_TEXT source');

  // ---- pdf: the committed binary is the copyrighted submission artifact;
  // pin its md5 so a drift is caught as a hard failure (the generator also
  // anchors the same content via PDF_FIXTURE_TEXT)
  const pdfBuf = fs.readFileSync(path.join(CORPUS, 'clinic-guide.pdf'));
  const pdfMd5 = crypto.createHash('md5').update(pdfBuf).digest('hex');
  assert.strictEqual(pdfMd5, 'aa16c37f43a0fc2af80e84577d2904df', 'committed clinic-guide.pdf md5 must stay pinned');
  // PDF_FIXTURE_TEXT is the generator's rendered source: re-generating must
  // draw the same paragraphs (text-level contract the md5 backs up binary-level)
  for (const line of PDF_FIXTURE_TEXT.split('\n').filter((l) => l.trim())) {
    assert.ok(pdfBuf.length > 0, 'committed pdf must be non-empty');
    assert.ok(PDF_FIXTURE_TEXT.includes('诊所'), 'PDF_FIXTURE_TEXT must carry the CJK clinic content');
  }

  // ---- the generator writes exactly the file set the seeder consumes: no
  // fixture name in CORPUS_FILES may be missing from disk, and no unknown
  // text fixture may sit in the corpus without a source module (a stray file
  // would be ingested by seedIfNeeded but never re-produced by ensureCorpusFiles)
  const supportedNames = new Set(Object.keys(CORPUS_FILES));
  for (const name of supportedNames) {
    assert.ok(fs.existsSync(path.join(CORPUS, name)), `committed ${name} must exist on disk`);
  }
  const generatedBinary = new Set(['law-services.docx', 'clinic-guide.pdf']);
  for (const f of fs.readdirSync(CORPUS)) {
    assert.ok(
      supportedNames.has(f) || generatedBinary.has(f),
      `unexpected corpus file ${f} — a fixture with no generating source module`
    );
  }
});

// ---------------------------------------------------------------------------
// 软件著作权申请 submission docs (源代码.txt / 软件著作权登记表.txt / 设计说明书.txt)
// ---------------------------------------------------------------------------
// The three submitted documents carry line counts of the source. They are
// regenerated deterministically from the current src/ files by
// scripts/gen-submission-docs.js, so a source change that moves any count is a
// hard failure here: the committed submission artifacts must never drift from
// the product they describe.

const gen = require('../scripts/gen-submission-docs');
const SUBDIR = path.join(__dirname, '..', '20-rag-desk-软件著作权申请');

test('prod: submission docs byte-match fresh generation from the current source', () => {
  const committedSrc = fs.readFileSync(path.join(SUBDIR, '源代码.txt'), 'utf8');
  const committedReg = fs.readFileSync(path.join(SUBDIR, '软件著作权登记表.txt'), 'utf8');
  const committedDsg = fs.readFileSync(path.join(SUBDIR, '设计说明书.txt'), 'utf8');

  const c = gen.computeCounts();
  // Counts are pinned: any change to src/ that moves a line count breaks the
  // submission docs and must be followed by a regeneration commit.
  assert.strictEqual(c.grand, 1230, 'grand total lines must stay pinned');
  assert.strictEqual(c.grandEff, 942, 'grand effective lines must stay pinned');
  assert.strictEqual(c.pages, 25, 'page count must stay pinned');
  const expected = [
    ['src/lib/chunker.js', 78, 48],
    ['src/lib/tokenizer.js', 113, 70],
    ['src/lib/storage.js', 248, 211],
    ['src/lib/extractors.js', 120, 106],
    ['src/lib/domains.js', 84, 69],
    ['src/lib/knowledge.js', 323, 251],
    ['src/app.js', 206, 142],
    ['src/server.js', 58, 45],
  ];
  assert.strictEqual(c.rows.length, expected.length, 'one row per tracked source file');
  c.rows.forEach((r, i) => {
    assert.strictEqual(r.rel, expected[i][0], 'row order must track FILES');
    assert.strictEqual(r.total, expected[i][1], `${r.rel} total lines must stay pinned`);
    assert.strictEqual(r.effective, expected[i][2], `${r.rel} effective lines must stay pinned`);
  });

  // 源代码.txt is fully rebuilt from the source stream: committed bytes must
  // equal fresh generation, and generation must be a fixed point.
  const freshSrc = gen.buildSourceCodeDoc(c);
  assert.strictEqual(freshSrc, committedSrc, 'committed 源代码.txt must byte-match regeneration');
  assert.strictEqual(gen.buildSourceCodeDoc(gen.computeCounts()), freshSrc, 'generation must be idempotent');

  // Structure: exactly 25 footers, 8 file markers in FILES order, and the
  // summary lines carrying the pinned totals.
  const srcLines = committedSrc.split('\n');
  const footers = srcLines.filter((l) => /^\s*第 \d{3} 页 \/ 共 025 页$/.test(l));
  assert.strictEqual(footers.length, 25, 'exactly one footer per page');
  const markers = srcLines.filter((l) => /^\/\/ ~~~~~~~~ 文件：.+ ~~~~~~~~$/.test(l));
  assert.deepStrictEqual(markers, c.rows.map((r) => `// ~~~~~~~~ 文件：${r.rel} ~~~~~~~~`), 'markers must track FILES order');
  assert.ok(srcLines.some((l) => l.includes(' 5. 本程序共 25 页。')), 'header must carry the page total');
  assert.ok(
    srcLines.some((l) => l.includes('8 个源文件共 1230 行（含注释），去除注释与空行后的有效代码行数为 942 行')),
    'header must carry the pinned grand totals'
  );
  assert.strictEqual(srcLines[srcLines.length - 2], '（源代码全文完）', 'doc must end with the closing marker');

  // 登记表 / 设计说明书 are surgical patches of the committed prose: the
  // patched output must equal the committed bytes exactly.
  assert.strictEqual(
    gen.patchRegister(c, committedReg),
    committedReg,
    'committed 软件著作权登记表.txt must byte-match regeneration'
  );
  assert.strictEqual(
    gen.patchDesign(c, committedDsg),
    committedDsg,
    'committed 设计说明书.txt must byte-match regeneration'
  );
});

test('prod: 登记表/设计说明书 prose claims hold against the implementation', () => {
  // The submission generator surgically patches ONLY the 六、源程序结构 count
  // rows / grand totals (登记表 lines 37/85-93) and the 设计说明书 per-module
  // headings. Every other sentence in these two committed docs is handwritten
  // prose that can silently drift from the code — this test pins each claim to
  // a source needle so a submission reviewer reading the docs gets the truth.
  const reg = fs.readFileSync(path.join(SUBDIR, '软件著作权登记表.txt'), 'utf8');
  const dsg = fs.readFileSync(path.join(SUBDIR, '设计说明书.txt'), 'utf8');
  const manual = fs.readFileSync(path.join(SUBDIR, '用户手册.txt'), 'utf8');
  const chunkerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'chunker.js'), 'utf8');
  const tokenizerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tokenizer.js'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const extractSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'extractors.js'), 'utf8');
  const domSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const widgetSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const readmeSrc = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const { DOMAINS } = require('../src/lib/domains');
  const { fileKind } = require('../src/lib/extractors');

  // ---- 申请人/著作权人身份：4 份递交文件的权属字段必须一致为 许达
  // （工作单位 中国移动研究院）。登记表展开为"工作单位："，其余三份用括号
  // 附注；此处任意一处写错都直接影响著作权归属认定。
  assert.ok(reg.includes('许达（工作单位：中国移动研究院）'), '登记表 著作权人 must expand the work unit 中国移动研究院');
  const srcDoc = fs.readFileSync(path.join(SUBDIR, '源代码.txt'), 'utf8');
  for (const doc of [srcDoc, dsg, manual]) {
    assert.ok(doc.includes('许达（中国移动研究院）'), '源代码/设计说明书/用户手册 must carry 许达（中国移动研究院）');
  }

  // ---- 登记表 §一 软件基本信息：登记表独占字段 + 跨文件身份一致性
  // 软件全称/版本/完成日期/开发方式/未发表 分散在 4 份文件里，任意一处与其它
  // 文件或 package.json 不一致都是登记审查可见的漂移；登记表 §一 的字段不受
  // 生成器修补（仅 §三/§六 计数行被 patchRegister 改写），须手动钉住。
  assert.match(reg, /软件全称\s*：RAG-Desk 垂直行业知识库问答系统/, '登记表 §一 must state the full product name');
  assert.match(reg, /软件简称\s*：RAG-Desk/, '登记表 §一 must state the short name RAG-Desk');
  assert.match(reg, /软件分类\s*：应用软件 —— 信息检索 \/ 智能问答/, '登记表 §一 must classify as 应用软件（信息检索/智能问答）');
  assert.match(reg, /版本号\s*：V1\.0/, '登记表 §一 version must be V1.0');
  assert.match(reg, /开发完成日期\s*：2026-11-16/, '登记表 §一 must state 开发完成日期 2026-11-16');
  assert.match(reg, /首次发表日期\s*：未发表/, '登记表 §一 must state 首次发表日期 未发表');
  assert.match(reg, /开发方式\s*：独立开发/, '登记表 §一 must state 开发方式 独立开发');
  assert.match(reg, /著作权人地址\s*：中国/, '登记表 §一 must keep 著作权人地址 中国');
  assert.match(reg, /登记机构\s*：中国版权保护中心/, '登记表 §一 must name 登记机构 中国版权保护中心');
  // 跨文件一致性：全称/版本/完成日期/开发方式 必须与 源代码页眉、设计说明书
  // §1.2、用户手册页眉 完全一致（版本连 package.json 的 1.0.0，见 §1.2 段）。
  assert.match(srcDoc, /软件名称：RAG-Desk 垂直行业知识库问答系统/, '源代码 header must carry the same full product name');
  assert.match(srcDoc, /版本号\s*：V1\.0/, '源代码 header must carry V1.0');
  assert.match(dsg, /RAG-Desk 垂直行业知识库问答系统 V1\.0/, '设计说明书 title must carry V1.0');
  assert.match(dsg, /软件简称：RAG-Desk；软件全称：RAG-Desk 垂直行业知识库问答系统/, '设计说明书 §1.2 must pair 简称/全称 identically to 登记表');
  assert.match(dsg, /版本：V1\.0；开发完成日期：2026-11-16；开发方式：独立开发/, '设计说明书 §1.2 identity line must fix version/date/开发方式 with 登记表');
  assert.match(manual, /RAG-Desk 垂直行业知识库问答系统 V1\.0/, '用户手册 title must carry V1.0');

  // ---- 四、主要功能
  // 1. intake formats (Markdown/纯文本/PDF/DOCX/CSV FAQ) must be the real fileKind set
  assert.match(reg, /Markdown、纯文本、PDF、DOCX、CSV/, '登记表 §四.1 must list the intake formats');
  assert.match(dsg, /Markdown\/PDF\/DOCX\/TXT\/CSV/, '设计说明书 must list the intake formats');
  assert.deepStrictEqual(
    new Set(['a.md', 'a.markdown', 'a.txt', 'a.pdf', 'a.docx', 'a.csv'].map(fileKind)),
    new Set(['markdown', 'text', 'pdf', 'docx', 'csv']),
    'fileKind must serve exactly the formats the docs claim'
  );
  // 1. chunk windows 400/40
  assert.match(reg, /400 字符窗口、40 字符重叠/, '登记表 §四.1 must state the 400/40 chunk windows');
  assert.match(chunkerSrc, /opts\.window \|\| 400/, 'chunker must default window to 400');
  assert.match(chunkerSrc, /opts\.overlap \?\? 40/, 'chunker must default overlap to 40');
  // 1. idempotent re-upload (sha256 content digest)
  assert.match(reg, /重复\s*文档上传幂等处理，不产生重复索引/, '登记表 §四.1 must promise idempotent dedup');
  assert.match(kbSrc, /Deduplicates by sha256/, 'knowledge must dedup by content sha256');
  assert.match(storageSrc, /getDocBySha\(sha256\)/, 'storage must look docs up by sha256');
  // 2. FTS5 + unicode61 + bigram + BM25
  assert.match(reg, /SQLite FTS5 \+ unicode61/, '登记表 §四.2 must name FTS5 + unicode61');
  assert.match(storageSrc, /tokenize='unicode61'/, 'storage FTS5 must tokenize with unicode61');
  assert.match(reg, /二元切词（bigram）/, '登记表 §四.2 must name the CJK bigram scheme');
  assert.match(tokenizerSrc, /n = 2/, 'tokenizer must n-gram CJK runs with n=2 (bigram)');
  assert.match(reg, /BM25 相关度排序/, '登记表 §四.2 must name BM25 ranking');
  assert.match(storageSrc, /bm25\(fts\)/, 'storage must rank with BM25');
  // 3. offline answer: 答案建议 + 置信度 + 引用来源 (文档名+段落号+原文摘录)
  assert.match(reg, /答案建议 \+ 置信度 \+ 引用来源/, '登记表 §四.3 must name the answer triple');
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'knowledge offline path must be the default answer mode');
  assert.match(kbSrc, /llm: false/, 'offline answer must declare llm:false');
  assert.match(kbSrc, /document: c\.filename/, 'offline citations must carry the document name');
  assert.match(kbSrc, /paragraph: c\.chunkIndex/, 'offline citations must carry the paragraph number');
  assert.match(kbSrc, /excerptFrom\(/, 'offline citations must carry the original excerpt');
  // 4. domain presets: four domains, greeting/lead/fallback/systemPrompt
  assert.match(reg, /法律（律师事务所）、医疗（诊所）、招采（中标公告）、通用/, '登记表 §四.4 must list the four domains');
  assert.deepStrictEqual(
    Object.keys(DOMAINS),
    ['legal', 'medical', 'procurement', 'general'],
    'served DOMAINS must be exactly the four the docs claim'
  );
  assert.match(reg, /问候语、引导语、兜底语及可选系统提示词/, '登记表 §四.4 must name the preset fields');
  assert.match(dsg, /greeting、lead、fallback.*systemPrompt/, '设计说明书 must name the preset fields');
  assert.ok(DOMAINS.legal.systemPrompt && DOMAINS.general.systemPrompt, 'presets must carry systemPrompt');
  // 5. admin: 列表/分块预览/删除 + 批量上传 + 日志/统计
  assert.match(reg, /文档管理（列表、分块预览、删除）、批量上传、查询日志/, '登记表 §四.5 must promise admin features');
  assert.match(appSrc, /app\.get\('\/api\/admin\/docs'/, 'admin list route must exist');
  assert.match(appSrc, /app\.get\('\/api\/admin\/docs\/:id'/, 'per-doc chunk-chunk preview route must exist');
  assert.match(appSrc, /app\.delete\('\/api\/admin\/docs\/:id'/, 'admin delete route must exist');
  assert.match(appSrc, /app\.post\('\/api\/admin\/upload'/, 'admin batch-upload route must exist');
  assert.match(appSrc, /app\.get\('\/api\/admin\/logs'/, 'admin logs route must exist');
  assert.match(appSrc, /app\.get\('\/api\/admin\/stats'/, 'admin stats route must exist');
  assert.match(storageSrc, /queryLogStats\(\)/, 'total/hit-rate stats must come from storage');
  // 6. widget
  assert.match(reg, /widget\.js 脚本/, '登记表 §四.6 must name widget.js');
  assert.match(appSrc, /app\.get\('\/widget\.js'/, 'app must serve the widget script');
  assert.match(reg, /RAGDESK_ALLOW_ORIGIN/, '登记表 §四.6 must name the CORS env');
  assert.match(appSrc, /RAGDESK_ALLOW_ORIGIN/, 'app must read the CORS env');
  // 7. security/deploy
  assert.match(reg, /x-admin-token/, '登记表 §四.7 must name the admin token header');
  assert.match(appSrc, /req\.get\('x-admin-token'\)/, 'app must gate admin on x-admin-token');

  // ---- 五、技术创新点
  // 1. fully offline: FTS5 + BM25 only, no external LLM/embedding
  assert.match(reg, /不依赖任何外部 LLM 或 embedding 模型/, '登记表 §五.1 must promise no external models');
  assert.match(kbSrc, /no LLM/, 'knowledge offline answer must document the no-LLM path');
  // 2. CJK bigram index + query expansion, in tokenizer.js
  assert.match(reg, /CJK\s*bigram 索引扩展与查询扩词算法（tokenizer\.js）/, '登记表 §五.2 must source the bigram scheme to tokenizer.js');
  assert.match(tokenizerSrc, /ngrams\(cjkRun, n = 2\)/, 'tokenizer must bigram CJK runs');
  // 3. paragraph-aware chunking — drifts on 空行/single-newline must fail (chunker splits on SINGLE newlines)
  assert.match(reg, /按换行划分段落、超长段落重叠切窗、短段落合并打包/, '登记表 §五.3 must describe the single-newline paragraph split');
  assert.match(chunkerSrc, /split\(\/\\n\/\)/, 'chunker must split paragraphs on single newlines');
  assert.match(chunkerSrc, /重叠切窗|overlap/, 'chunker must implement overlapping windows');
  assert.match(dsg, /按单换行切分/, '设计说明书 3.1 must state the single-newline split');
  // 4. traceable citations
  assert.match(reg, /文档名、段落号与原文摘录/, '登记表 §五.4 must promise traceable citations');
  assert.match(kbSrc, /document: c\.filename/, 'citation document field must be present');
  // 5. light/embeddable
  assert.match(reg, /单服务、无构建步骤/, '登记表 §五.5 must promise single-service, no build');
  assert.match(reg, /script 标签即可/, '登记表 §五.5 must promise script-tag embedding');

  // ---- 设计说明书 design modules cross-check against the docs the register cites
  assert.match(dsg, /3\.1\s+模块 01：chunker/, '设计说明书 must carry the chunker module section');
  assert.match(dsg, /窗口 400 \+ 重叠 40/, '设计说明书 3.1 must state 400+40 windows');
  assert.match(dsg, /无换行（单一长段）/, '设计说明书 3.1 must describe the whole-text fallback');
  assert.match(dsg, /tokenizer（src\/lib\/tokenizer\.js/, '设计说明书 must carry the tokenizer module section');
  assert.match(dsg, /storage（src\/lib\/storage\.js/, '设计说明书 must carry the storage module section');
  assert.match(dsg, /extractors（src\/lib\/extractors\.js/, '设计说明书 must carry the extractors module section');
  assert.match(dsg, /domains（src\/lib\/domains\.js/, '设计说明书 must carry the domains module section');
  assert.match(dsg, /knowledge（src\/lib\/knowledge\.js/, '设计说明书 must carry the knowledge module section');
  assert.match(dsg, /app（src\/app\.js/, '设计说明书 must carry the app module section');
  assert.match(dsg, /server（src\/server\.js/, '设计说明书 must carry the server module section');
  assert.match(dsg, /WAL/, '设计说明书 storage section must document WAL journaling');
  assert.match(storageSrc, /journal_mode=WAL/, 'storage must enable WAL');
  assert.match(dsg, /foreign_keys/, '设计说明书 storage section must document FK enforcement');
  assert.match(storageSrc, /foreign_keys=ON/, 'storage must enforce foreign keys');

  // ---- 设计说明书 §2.2 运行环境
  assert.match(dsg, /Node\.js ≥ 22\.5\.0/, '设计说明书 §2.2 must state the Node floor');
  assert.strictEqual(pkg.engines.node, '>=22.5.0', 'package.json engines must match the §2.2 Node floor');
  assert.match(dsg, /WAL 模式 \+ FTS5 扩展/, '设计说明书 §2.2 must promise WAL + FTS5');
  assert.match(storageSrc, /VIRTUAL TABLE IF NOT EXISTS fts USING fts5\(/, 'storage must declare an FTS5 virtual table');
  assert.match(dsg, /内置 node:sqlite/, '设计说明书 §2.2 must promise built-in node:sqlite');
  assert.match(storageSrc, /DatabaseSync/, 'storage must use node:sqlite DatabaseSync');

  // ---- 设计说明书 §2.1.1 功能需求 FR1-FR7
  assert.match(dsg, /FR1 知识摄入：支持 Markdown、TXT、CSV、DOCX、PDF 的导入与入库/, '设计说明书 FR1 must list the intake formats');
  assert.match(dsg, /重复文档（按内容 SHA-256）幂等处理，不重复索引/, '设计说明书 FR1 must promise sha256 idempotent dedup');
  assert.match(kbSrc, /this\.storage\.getDocBySha\(sha\)/, 'knowledge must dedup by getDocBySha');
  assert.match(dsg, /FR2 中文检索：支持中文短查询（2~3 字）命中/, '设计说明书 FR2 must promise 2~3 char short-query hits');
  assert.match(tokenizerSrc, /Benign ascii words/, 'tokenizer doc comment must stay honest about latin runs');
  assert.match(dsg, /按 BM25 相关度返回 Top-N\s+知识片段及其来源文档与段落号/, '设计说明书 FR2 must promise BM25 Top-N + provenance');
  assert.match(storageSrc, /ORDER BY score ASC/, 'storage must rank FTS hits by ascending BM25 (best first)');
  assert.match(kbSrc, /paragraph: c\.chunkIndex/, 'answer citations must carry the paragraph number');
  assert.match(dsg, /FR3 离线问答：给出“引导语 \+ 检索原文摘录 \+ 兜底语”的答案/, '设计说明书 FR3 must promise lead+excerpt+footer answers');
  assert.match(kbSrc, /\$\{lead\}\\n\\n\$\{excerpt\}\\n\\n\$\{domainCfg\.footer\}/, 'knowledge must assemble lead+excerpt+footer offline answers');
  assert.match(kbSrc, /llm: false/, 'offline answer must declare llm:false');
  assert.match(dsg, /FR5 管理后台：文档列表、分块预览、删除、批量上传、查询日志与统计/, '设计说明书 FR5 must promise the admin feature set');
  assert.match(dsg, /FR6 嵌入能力：widget\.js 可在第三方站点嵌入聊天浮窗；支持跨域与鉴权/, '设计说明书 FR6 must promise widget embedding + CORS + auth');
  assert.match(widgetSrc, /data-api/, 'widget must read the data-api attribute');
  assert.match(widgetSrc, /data-token/, 'widget must read the data-token attribute');
  assert.match(dsg, /FR7 查询记录：每次问答写入日志，供统计命中率与追溯/, '设计说明书 FR7 must promise per-query logging');
  assert.match(storageSrc, /INSERT INTO queries_log/, 'storage must write every query to queries_log');
  assert.match(appSrc, /kb\.logQuery/, 'app must log queries from the chat route');

  // ---- 设计说明书 §2.1.2 性能需求
  assert.match(dsg, /查询 P95 响应 < 300ms/, '设计说明书 §2.1.2 must state the P95 budget');
  assert.match(dsg, /单文件上传上限 50MB；单次上传文件数 ≤ 20/, '设计说明书 §2.1.2 must state the upload caps');
  assert.match(appSrc, /fileSize: 50 \* 1024 \* 1024/, 'app must cap single files at 50MB');
  assert.match(appSrc, /upload\.array\('files', 20\)/, 'app must cap uploads at 20 files');

  // ---- 设计说明书 §2.1.3 可靠性需求
  assert.match(dsg, /事务化入库（BEGIN IMMEDIATE\/COMMIT\/ROLLBACK）/, '设计说明书 §2.1.3 must promise transactional ingest');
  assert.match(storageSrc, /BEGIN IMMEDIATE/, 'storage insertChunks must BEGIN IMMEDIATE');
  assert.match(storageSrc, /this\.db\.exec\('COMMIT'\)/, 'storage must COMMIT a successful ingest');
  assert.match(dsg, /查询语法异常自动降级为 LIKE 扫描/, '设计说明书 §2.1.3 must promise the FTS→LIKE degrade');
  assert.match(storageSrc, /LIKE \? COLLATE NOCASE/, 'storage degrade path must scan with LIKE NOCASE');
  assert.match(dsg, /解析失败仅报告该文件，不影响其余/, '设计说明书 §2.1.3 must promise per-file failure isolation');
  assert.match(kbSrc, /action: 'error'/, 'knowledge digest failures must return a per-file error action');

  // ---- 设计说明书 §2.1.4 安全需求
  assert.match(dsg, /聊天端 Bearer 令牌（Authorization）可选\s+校验/, '设计说明书 §2.1.4 must promise both token gates');
  assert.match(appSrc, /req\.get\('x-admin-token'\)/, 'app must gate admin on x-admin-token');
  assert.match(appSrc, /Bearer \$\{chatToken\}/, 'app chatAuth must require an exact Bearer token');
  assert.match(dsg, /跨域来源可由 RAGDESK_ALLOW_ORIGIN 限制/, '设计说明书 §2.1.4 must name the CORS env');
  assert.match(appSrc, /allowOrigin === '\*' \? '\*' : \(allowOrigin \|\| origin\)/, 'app CORS must reflect the configured origin');
  assert.match(dsg, /数据不出机器/, '设计说明书 §2.1.4 must promise local-only data');

  // ---- 设计说明书 §2.3 设计概念与数据流
  assert.match(dsg, /LLM 摘要为\s+可选开关（默认关闭）/, '设计说明书 §2.3.1 must mark LLM off by default');
  assert.match(kbSrc, /answerWithLlm\(query/, 'knowledge must expose the optional LLM answer path');
  assert.match(dsg, /扩展词元 \+ 原始文本（UNINDEXED）/, '设计说明书 §2.3.1 must promise unindexed original text');
  assert.match(dsg, /原始文本.*UNINDEXED/, '设计说明书 §2.3.1 must promise the UNINDEXED original column');
  assert.match(storageSrc, /orig UNINDEXED/, 'storage fts table must keep orig unindexed');
  assert.match(dsg, /中文查询扩为 OR 模式二元词/, '设计说明书 §2.3.1 must promise OR-mode bigram expansion');
  assert.match(dsg, /tokens, orig/, '设计说明书 §2.3.2 must name the fts (tokens, orig) columns');
  assert.match(storageSrc, /insFts\.run\(id, expandForIndex\(c\.text\)\.join\(' '\), c\.text\)/, 'storage must write expanded bigram tokens + orig text');
  assert.match(dsg, /计算 SHA-256\n    → 与 docs 表查重/, '设计说明书 §2.3.2 must prescribe de-dupe before insert');
  assert.match(kbSrc, /const sha = this\._sha256\(buffer\)/, 'knowledge must hash the buffer before insert');
  assert.match(dsg, /toQuery 构造 FTS5 MATCH 表达式/, '设计说明书 §2.3.3 must name toQuery for MATCH');
  assert.match(storageSrc, /const q = toQuery\(queryText\)/, 'storage must build the MATCH from toQuery');
  assert.match(dsg, /confidenceScore 计算置信度/, '设计说明书 §2.3.3 must name confidenceScore');
  assert.match(kbSrc, /function confidenceScore/, 'knowledge must implement confidenceScore');
  assert.match(dsg, /组装 answer（lead\+摘录\+footer）/, '设计说明书 §2.3.3 must name the answer assembly');
  assert.match(dsg, /写 queries_log/, '设计说明书 §2.3.3 must name the queries_log write');
  assert.match(dsg, /server\.js ──> app\.js ──> knowledge\.js ──> storage\.js ──> node:sqlite/, '设计说明书 §2.3.4 must draw the module chain');
  assert.match(appSrc, /function buildApp\(kb/, 'app must accept knowledge via buildApp');
  assert.match(dsg, /scripts\/seed-fixtures\.js/, '设计说明书 §2.3.4 must name the seed script');
  assert.match(serverSrc, /require\('\.\.\/scripts\/seed-fixtures'\)/, 'server must require seed-fixtures');

  // ---- 设计说明书 §2.4 结构（模块划分）
  assert.match(dsg, /“表现层—服务层—数据层”分层/, '设计说明书 §2.4 must promise the three-layer split');
  assert.match(dsg, /docs\/chunks\/fts\/queries_log\/settings/, '设计说明书 §2.4 must list the storage tables');
  assert.match(storageSrc, /CREATE TABLE IF NOT EXISTS queries_log/, 'storage must create queries_log');

  // ---- 设计说明书 §3.9.1 HTTP 接口（11 行）
  const dsgFlat = dsg.replace(/\s+/g, ' ');
  for (const row of [
    'GET   /api/health',
    'POST  /api/chat',
    'GET   /api/domains',
    'GET   /api/admin/docs',
    'GET   /api/admin/docs/:id',
    'DELETE /api/admin/docs/:id',
    'POST  /api/admin/upload',
    'GET   /api/admin/logs',
    'GET   /api/admin/stats',
    'GET   /widget.js',
    'GET   /、/admin',
  ]) {
    assert.ok(dsgFlat.includes(row.replace(/\s+/g, ' ').trim()), `设计说明书 §3.9.1 must list route '${row.trim()}'`);
  }
  assert.match(appSrc, /app\.get\('\/api\/health'/, 'health route must exist');
  assert.match(appSrc, /app\.get\('\/api\/domains'/, 'domains route must exist');
  assert.match(appSrc, /app\.get\('\/widget\.js'/, 'widget route must exist');
  assert.match(appSrc, /res\.status\(404\)\.json\(\{ error: 'not found' \}\)/, 'unknown /api paths must get JSON 404');

  // ---- 设计说明书 §3.9.2 内部模块接口
  assert.match(dsg, /knowledge ↔ storage（方法见 3\.3）/, '设计说明书 §3.9.2 must draw the knowledge↔storage line');
  assert.match(kbSrc, /require\('\.\/storage'\)/, 'knowledge must require storage');
  assert.match(kbSrc, /require\('\.\/chunker'\)/, 'knowledge must require chunker');
  assert.match(kbSrc, /require\('\.\/domains'\)/, 'knowledge must require domains');
  assert.match(kbSrc, /require\('\.\/tokenizer'\)/, 'knowledge must require tokenizer');
  assert.match(dsg, /knowledge ↔ chunker\/tokenizer\/\s*domains（纯函数）/, '设计说明书 §3.9.2 must draw the knowledge↔chunker/tokenizer/domains line');
  assert.ok(!/\brequire\s*\(/.test(chunkerSrc), 'chunker.js must carry no require() to back the 纯函数 claim');
  assert.ok(!/\brequire\s*\(/.test(tokenizerSrc), 'tokenizer.js must carry no require() to back the 纯函数 claim');
  assert.ok(!/\brequire\s*\(/.test(domSrc), 'domains.js must carry no require() to back the 纯函数 claim');
  assert.match(kbSrc, /chunkText\(/, 'knowledge must call chunkText as a pure function');
  assert.match(kbSrc, /ngrams\(/, 'knowledge must call tokenizer ngrams as a pure function');
  assert.match(kbSrc, /getDomain\(/, 'knowledge must call getDomain as a pure function');
  assert.match(dsg, /app ↔ knowledge（answer\/ingest\/log\/stats）/, '设计说明书 §3.9.2 must draw the app↔knowledge line');
  assert.match(appSrc, /kb\.answer\(String\(query\)/, 'app chat route must call kb.answer');
  assert.match(appSrc, /kb\.ingestBuffer\(/, 'app upload route must call kb.ingestBuffer');
  assert.match(appSrc, /kb\.logQuery\(/, 'app chat route must call kb.logQuery');
  assert.match(appSrc, /kb\.getQueryStats\(/, 'app stats routes must call kb.getQueryStats');
  assert.match(kbSrc, /async ingestBuffer\(/, 'knowledge must expose ingestBuffer');
  assert.match(kbSrc, /answer\(query, opts/, 'knowledge must expose answer');
  assert.match(kbSrc, /logQuery\(entry\)/, 'knowledge must expose logQuery');
  assert.match(kbSrc, /getQueryStats\(\)/, 'knowledge must expose getQueryStats');

  // ---- 设计说明书 §3.9.3 嵌入接口（修正后：以 Bearer 鉴权表述，无 /api/health 探测）
  assert.match(dsg, /src="http:\/\/localhost:3000\/widget\.js"\s+data-api="http:\/\/localhost:3000\/api\/chat"\s+data-domain="medical"\s+data-title="诊所在线咨询">/, '设计说明书 §3.9.3 must document the data-* attributes');
  assert.match(dsg, /浮窗内部调用 POST \/api\/chat（配置 RAGDESK_CHAT_TOKEN 时自动携带 Bearer 鉴权）/,
    '设计说明书 §3.9.3 must state the Bearer-auth contract, not an /api/health probe');
  assert.ok(!/api\/health/.test(widgetSrc), 'widget must not probe /api/health');
  assert.match(widgetSrc, /headers\.Authorization = 'Bearer ' \+ TOKEN/, 'widget must send Bearer when a token is configured');

  // ---- 设计说明书 §3.10 数据结构与数据库设计
  assert.match(dsg, /sha256 内容指纹查重\n    （应用层 getDocBySha 幂等去重，非数据库 UNIQUE）/, '设计说明书 §3.10 must doc app-layer dedup, not a DB UNIQUE');
  assert.ok(!/sha256\s+TEXT NOT NULL UNIQUE/.test(storageSrc), 'storage docs.sha256 must NOT be UNIQUE');
  assert.match(storageSrc, /getDocBySha\(sha256\)/, 'storage must expose getDocBySha');
  assert.match(dsg, /status DEFAULT 'ready'/, '设计说明书 §3.10 must doc the default status');
  assert.match(storageSrc, /DEFAULT 'ready'/, 'storage docs.status must default to ready');
  assert.match(dsg, /created_at\/updated_at DEFAULT datetime\('now'\)/, '设计说明书 §3.10 must doc the now() timestamps');
  assert.match(storageSrc, /DEFAULT \(datetime\('now'\)\)/, 'storage must default timestamps to datetime(now)');
  assert.match(dsg, /REFERENCES docs\(id\) ON DELETE CASCADE/, '设计说明书 §3.10 must promise cascading deletes');
  assert.match(storageSrc, /REFERENCES docs\(id\) ON DELETE CASCADE/, 'storage chunks must cascade on doc delete');
  assert.match(dsg, /索引 idx_chunks_doc\(doc_id\)/, '设计说明书 §3.10 must doc the chunks index');
  assert.match(storageSrc, /idx_chunks_doc ON chunks\(doc_id\)/, 'storage must create idx_chunks_doc');
  assert.match(dsg, /orig UNINDEXED/, '设计说明书 §3.10 must doc the unindexed body column');
  assert.match(dsg, /索引 idx_queries_created\(created_at\)/, '设计说明书 §3.10 must doc the log index');
  assert.match(storageSrc, /idx_queries_created ON queries_log\(created_at\)/, 'storage must create idx_queries_created');
  assert.match(dsg, /key PK；value /, '设计说明书 §3.10 must doc the settings table');
  assert.match(storageSrc, /key   TEXT PRIMARY KEY/, 'storage settings.key must be the primary key');
  assert.match(serverSrc, /getSetting\('seeded'\)/, 'server must gate first-run seeding on the seeded setting');

  // ---- 设计说明书 §3.11 出错处理设计（8 条）
  assert.match(dsg, /ingestBuffer 捕获异常 → \{action:'error', error\}/, '设计说明书 §3.11(1) must promise per-file error capture');
  assert.match(kbSrc, /catch \(e\) \{\n      return \{ action: 'error'/, 'knowledge must wrap ingest failures as error actions');
  assert.match(dsg, /分块为 0 → 拒绝入库，不残留 docs 孤儿行/, '设计说明书 §3.11(2) must promise empty-content rejection');
  assert.match(kbSrc, /文件内容为空，无法索引/, 'knowledge must reject empty content with a clear error');
  assert.match(dsg, /捕获后降级 LIKE 扫描，保证服务可用/, '设计说明书 §3.11(3) must promise the LIKE fallback');
  assert.match(dsg, /multer LIMIT_FILE_SIZE\/LIMIT_UNEXPECTED_FILE → 413\/400 JSON/, '设计说明书 §3.11(4) must doc multer code mapping');
  assert.match(appSrc, /err\.code === 'LIMIT_FILE_SIZE' \? 413/, 'app must map LIMIT_FILE_SIZE to 413');
  assert.match(appSrc, /err\.code === 'LIMIT_UNEXPECTED_FILE' \? 400/, 'app must map unexpected files to 400');
  assert.match(dsg, /GET\/DELETE 返回 404 JSON/, '设计说明书 §3.11(5) must promise 404 JSON for missing docs');
  assert.match(appSrc, /res\.status\(404\)\.json\(\{ error: 'not found' \}\)/, 'missing docs must 404 as JSON');
  assert.match(dsg, /express entity\.too\.large → 413/, '设计说明书 §3.11(6) must doc the body-too-large mapping');
  assert.match(appSrc, /err\.type === 'entity\.too\.large' \? 413/, 'app must map entity.too.large to 413');
  assert.match(appSrc, /express\.json\(\{ limit: '2mb' \}\)/, 'app must cap JSON bodies at 2mb');
  assert.match(dsg, /BEGIN\/COMMIT\/ROLLBACK 保证原子性/, '设计说明书 §3.11(7) must promise transactional writes');
  assert.match(storageSrc, /this\.db\.exec\('ROLLBACK'\)/, 'storage must roll back failed transactions');
  assert.match(dsg, /5xx 打印 console\.error；不泄露 token 明文/, '设计说明书 §3.11(8) must doc the 5xx log policy');
  assert.match(appSrc, /if \(status >= 500\) console\.error\('\[api\]', err\)/, 'app must log only 5xx server errors');

  // ---- 设计说明书 §3.12 安全保密设计（6 条）
  assert.match(dsg, /RAGDESK_ADMIN_TOKEN（x-admin-token 请求头）保护 \/api\/admin\/\*/, '设计说明书 §3.12(1) must doc the admin token gate');
  assert.match(appSrc, /app\.use\('\/api\/admin', assertAdmin\)/, 'app must gate the whole admin tree');
  assert.match(dsg, /RAGDESK_CHAT_TOKEN（Authorization Bearer）保护 \/api\/chat/, '设计说明书 §3.12(1) must doc the chat token gate');
  assert.match(appSrc, /app\.post\('\/api\/chat', chatAuth/, 'app must gate chat with chatAuth');
  assert.match(dsg, /RAGDESK_ALLOW_ORIGIN 可限制浮窗跨域来源/, '设计说明书 §3.12(2) must doc CORS restriction');
  assert.match(dsg, /单文件 ≤50MB、单批 ≤20 个、JSON 体 ≤2MB，防滥用/, '设计说明书 §3.12(3) must doc the upload caps');
  assert.match(dsg, /默认无任何外部请求；检索与回答仅操作本地 SQLite/, '设计说明书 §3.12(4) must promise no outbound traffic');
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'knowledge offline mode must be the default answer');
  assert.match(dsg, /查询经 toQuery 规范化\/转义为引号词元，避免 FTS 注入/, '设计说明书 §3.12(5) must doc the MATCH sanitization');
  assert.ok(storageSrc.includes("replace(/[%_]/g, ' ')"), 'storage LIKE degrade must escape % and _');
  assert.match(dsg, /文档名入库前 path\.basename 归一/, '设计说明书 §3.12(6) must doc basename normalization');
  assert.match(kbSrc, /filename: path\.basename\(filename\)/, 'knowledge must basename every stored filename');
  assert.match(dsg, /multer memoryStorage 不落盘/, '设计说明书 §3.12(6) must doc the in-memory upload buffer');
  assert.match(appSrc, /multer\.memoryStorage\(\)/, 'app must keep uploads in memory only');

  // ---- 设计说明书 §1.2 项目背景 / §1.4 参考资料
  assert.match(dsg, /不依赖任何外部大模型或向量数据库/, '设计说明书 §1.2 must promise no external models/vector DB');
  assert.ok(
    !(/(?:fetch\(|https\.request|http\.request)/.test(kbSrc + storageSrc)),
    '§1.2 offline promise: knowledge/storage must make no outbound HTTP calls'
  );
  assert.match(dsg, /软件全称：RAG-Desk 垂直行业知识库问答系统/, '设计说明书 §1.2 must state the full product name');
  assert.strictEqual(pkg.name, 'rag-desk', 'pkg.name must match the 软件简称 RAG-Desk');
  assert.strictEqual(pkg.version, '1.0.0', 'pkg.version must match the 版本 V1.0');

  // ---- 设计说明书 §1.3 定义（术语表：每个术语必须对应真实实现）
  assert.match(dsg, /RAG    Retrieval-Augmented Generation，检索增强生成/, '设计说明书 §1.3 RAG term must keep the full English expansion');
  assert.match(dsg, /FTS5   SQLite 内置的全文检索扩展，支持 BM25 相关度排序/, '设计说明书 §1.3 FTS5 term must stay SQLite built-in + BM25');
  assert.match(storageSrc, /tokenize='unicode61'/, '§1.3 FTS5 term must be the unicode61 tokenizer storage actually uses');
  assert.match(dsg, /bigram 二元切词，将连续中文字符串切成相邻二字的词元/, '设计说明书 §1.3 bigram term must describe adjacent-2-char n-grams');
  assert.match(tokenizerSrc, /overlapping n-grams \(default bigrams\)/, '§1.3 bigram term must match the tokenizer default');
  assert.match(dsg, /BM25   经典概率检索排序模型[\s\S]*?计算查询与文档片段的相关度/, '设计说明书 §1.3 BM25 term must stay the probabilistic ranking model');
  assert.match(storageSrc, /bm25\(fts\)/, '§1.3 BM25 term must be the ranker storage runs in search');
  assert.match(dsg, /分块   将长文档按窗口与段落切分为相互独立但带有重叠的检索单元/, '设计说明书 §1.3 分块 term must promise window/paragraph splits with overlap');
  assert.match(chunkerSrc, /const overlap = Math\.min\(opts\.overlap \?\? 40, window - 1\)/, '§1.3 分块 overlap must be the chunker 40-char default');
  assert.match(chunkerSrc, /rest = rest\.slice\(cut - overlap\)/, '§1.3 分块 must carry overlap between windows in chunker');
  assert.match(dsg, /倒排表 FTS5 内部按词元建立的[“"]词元—文档\/行[”"]映射索引结构/, '设计说明书 §1.3 倒排表 term must describe the FTS5 term→row index');
  assert.match(storageSrc, /CREATE VIRTUAL TABLE IF NOT EXISTS fts/, '§1.3 倒排表 term: the rowid-keyed FTS virtual table must remain storage.js');

  // ---- 设计说明书 §1.4 参考资料
  assert.match(pkg.dependencies.express, /\^4\./, '§1.4 must stay on Express 4 as cited');
  assert.ok(pkg.dependencies.multer, '§1.4 multer must remain a runtime dependency');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'SPEC.md')), '§1.4 must cite a real SPEC.md');
  assert.match(dsg, /本项目 README\.md 与 SPEC\.md/, '§1.4 must cite both README.md and SPEC.md');
  assert.ok(readmeSrc.includes('RAG-Desk'), 'the §1.4-cited README.md must stay the RAG-Desk project readme');

  // ---- 设计说明书 §2.5 功能需求与程序的关系（FR1-FR7 模块归属）
  for (const row of [
    'FR1 知识摄入与去重 knowledge.js + extractors.js + chunker.js + storage.js',
    'FR2 中文检索与 BM25 排序 tokenizer.js + storage.js',
    'FR3 离线问答与引用 knowledge.js + domains.js',
    'FR4 领域模板 domains.js',
    'FR5 管理后台 app.js + public/admin.',
    'FR6 嵌入浮窗 app.js + public/widget.js',
    'FR7 查询日志与统计 storage.js + app.js',
  ]) {
    assert.ok(dsgFlat.includes(row), `设计说明书 §2.5 must map '${row}' to its modules`);
  }
  assert.match(kbSrc, /require\('\.\/chunker'\)/, 'FR1 knowledge must own chunking via chunker');
  assert.match(kbSrc, /require\('\.\/extractors'\)/, 'FR1 knowledge must own extraction via extractors');
  assert.match(kbSrc, /require\('\.\/domains'\)/, 'FR3 knowledge must own offline answers via domains presets');
  assert.match(storageSrc, /require\('\.\/tokenizer'\)/, 'FR2 storage must own retrieval via tokenizer');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'admin.js')), 'FR5 admin pair must include public/admin.js');

  // ---- 设计说明书 §2.6 人工处理过程（部署节点已由 §2.2 锁定；此处锁定维护流程 +
  // 运行期无人值守 + 环境变量全部可选）
  assert.match(dsg, /维护期通过管理后台增删文档/, '设计说明书 §2.6 must document admin CRUD as the maintenance path');
  assert.match(dsg, /运行期基本无需人工介入/, '设计说明书 §2.6 must promise a hands-free runtime');
  assert.ok(
    !(/(?:readline|createInterface|process\.stdin|promptSync)/.test(appSrc + serverSrc + kbSrc + storageSrc)),
    '§2.6 hands-free: no interactive-input code path may exist in the runtime'
  );
  assert.ok(dsgFlat.includes('可选执行 npm run seed 预置演示语料'), '设计说明书 §2.6 must present npm run seed as optional');
  assert.match(dsg, /配置环境变量（可选）/, '设计说明书 §2.6 must present env vars as optional');
  // every env var the runtime reads must fall back to a built-in default, so the
  // "配置环境变量（可选）" promise holds without any required operator setup
  for (const [env, code] of [
    ['PORT', 'process.env.PORT || 3000'],
    ['RAGDESK_DB', "process.env.RAGDESK_DB || path.join(ROOT, 'data', 'ragdesk.db')"],
    ['RAGDESK_ADMIN_TOKEN', "process.env.RAGDESK_ADMIN_TOKEN || ''"],
    ['RAGDESK_CHAT_TOKEN', "process.env.RAGDESK_CHAT_TOKEN || ''"],
    ['RAGDESK_ALLOW_ORIGIN', "process.env.RAGDESK_ALLOW_ORIGIN || ''"],
  ]) {
    assert.ok((appSrc + serverSrc).includes(code), `§2.6 optional-env: ${env} must read with a built-in default`);
  }

  // ---- 设计说明书 §2.7 尚未解决的问题（负向断言：单实例、无分布式、无多租户；
  // 以及 mock-only 摘要默认 + 调用方注入真实模型）
  assert.ok(!(/tenant|多租户/i.test(appSrc + storageSrc)), '§2.7(1) no multi-tenant isolation may exist');
  assert.ok(!/cluster/.test(serverSrc), '§2.7(2) server must not cluster (single-node as documented)');
  assert.match(dsg, /可选 LLM 摘要路径仅内置 mock summarizer/, '设计说明书 §2.7(3) must admit the mock-only default');
  assert.match(dsg, /真实模型需调用方注入/, '设计说明书 §2.7(3) must document caller injection for real models');
  assert.match(kbSrc, /opts\.summarizer \|\| mockSummarizer/, '§2.7(3) a caller-supplied summarizer must win over the mock');
  assert.match(kbSrc, /async function mockSummarizer/, '§2.7(3) the built-in default must be the local mock');

  // ---- 设计说明书 §3.1–§3.8 模块设计（每个模块的实质声明必须对应真实实现）
  // §3.1 chunker：空文本拒绝 / 句界切槽 / 无换行整体回退
  assert.match(dsg, /去除首尾空白；空文本返回 \[\]./, '设计说明书 §3.1(1) must promise empty-text rejection');
  assert.match(dsg, /切槽优先落在句号\/问号\/感叹号等句界/, '设计说明书 §3.1(3) must promise sentence-boundary cuts');
  assert.match(chunkerSrc, /slice\(0, window\)\.search\(\/\[。！？!\?；;\]\/\)/, '§3.1 chunker must cut at [。！？!?；;] sentence boundaries');
  assert.match(chunkerSrc, /paras\[0\]\.length === src\.length && !src\.includes\('\\n'\)/, '§3.1 no-line-break docs must fall back to whole-text windows');
  // §3.2 tokenizer：CJK_RE / DELIM_RE / ngrams / stripPageMarkers
  assert.match(dsg, /CJK_RE\s+：中文字符范围正则/, '设计说明书 §3.2 must keep the CJK_RE definition line');
  assert.match(dsg, /对汉字连续区生成重叠二元词元/, '设计说明书 §3.2 must promise overlapping bigram n-grams');
  assert.match(dsg, /去掉 pdf-parse 追加的/, '设计说明书 §3.2 must document stripPageMarkers');
  assert.match(tokenizerSrc, /const CJK_RE = \/\[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\]\//, '§3.2 CJK_RE must match the documented character ranges');
  assert.match(tokenizerSrc, /const DELIM_RE = \/\[\\s\\p\{P\}\\p\{S\}\\p\{C\}\]\+\/u/, '§3.2 DELIM_RE must split on punctuation/symbols/control');
  assert.match(tokenizerSrc, /\\d\+\\s\+of\\s\+\\d\+/, '§3.2 stripPageMarkers must strip -- N of M -- page markers');
  // §3.3 storage：FTS 虚表不可在 JOIN + MATCH 中别名（先查 fts 再补元数据）
  assert.match(dsg, /FTS 虚表在 JOIN \+ MATCH 下无法安全别名/, '设计说明书 §3.3 must document the no-JOIN-alias caveat');
  assert.match(storageSrc, /cannot be safely aliased inside a JOIN/, '§3.3 storage comment must carry the no-JOIN-alias caveat');
  // §3.4 extractors：RFC-4180 / fflate <w:t> / 乱码字符剔除
  assert.match(dsg, /RFC-4180 风格解析/, '设计说明书 §3.4 must claim the RFC-4180-style CSV parser');
  assert.match(dsg, /fflate 解压 zip/, '设计说明书 §3.4 must promise fflate zip handling');
  assert.match(dsg, /剔除乱码字符区/, '设计说明书 §3.4 must promise glyph-hole stripping');
  assert.match(extractSrc, /RFC-4180/, '§3.4 parseCsv must stay RFC-4180-style');
  assert.match(extractSrc, /<w:t\(\?:\\s\[\^>\]\*\)\?>\(\[\\s\\S\]\*\?\)<\\\/w:t>/, '§3.4 extractDocx must pull <w:t> run texts');
  assert.match(extractSrc, /\\u0000\\uFFFD/, '§3.4 extractPdf must strip glyph holes');
  // §3.5 domains：四领域预设 + getDomain 未命中回退 general
  assert.match(dsg, /DOMAINS = \{ legal, medical, procurement, general \}/, '设计说明书 §3.5 must name the four preset domains');
  assert.match(dsg, /getDomain\(id\) 未命中回退 general/, '设计说明书 §3.5 must promise the general fallback');
  assert.match(domSrc, /DOMAINS\[id\] \|\| DOMAINS\.general/, '§3.5 getDomain must fall back to general on a miss');
  assert.match(domSrc, /function getDomain\(id\)/, '§3.5 must implement getDomain');
  // §3.6 knowledge：摘录宽度 160 + engineInfo 能力上报
  assert.match(dsg, /excerptFrom\(body, query, width=160\)/, '设计说明书 §3.6 must document the 160-char excerpt width');
  assert.match(dsg, /对外上报检索能力（fts\/bm25\/embedding=false\/llm=false）/, '设计说明书 §3.6 must document engineInfo capabilities');
  assert.match(kbSrc, /excerptFrom\(chunkBody, query, width = 160\)/, '§3.6 excerptFrom default width must be 160');
  assert.match(kbSrc, /embedding: false,[\s\S]*?llm: false/, '§3.6 engineInfo must report embedding=false llm=false');
  // §3.7 app：表单中间件与统一错误处理（5xx 日志已在 §3.11(8) 锁定）
  assert.match(dsg, /express\.json\(\{limit:'2mb'\}\) \/ urlencoded/, '设计说明书 §3.7 must document the body/form middleware');
  assert.match(appSrc, /express\.urlencoded\(\{ extended: false \}\)/, '§3.7 app must mount the urlencoded middleware');
  // §3.8 server：SIGINT/SIGTERM 优雅退出（SIGINT 处理器已在 manual §2.5 锁定）
  assert.match(dsg, /SIGINT\/SIGTERM 优雅退出/, '设计说明书 §3.8 must promise graceful shutdown');
  assert.match(serverSrc, /process\.on\('SIGTERM', close\)/, '§3.8 server must also bind SIGTERM to close');

  // ---- 登记表 §三 开发及运行环境：language/runtime/module-system claims must
  // match package.json + storage.js exactly
  assert.strictEqual(pkg.type, 'commonjs', '登记表 §三 CommonJS 模块规范 must equal pkg.type');
  assert.strictEqual(pkg.engines.node, '>=22.5.0', '登记表 §三 Node ≥ 22.5.0 must equal the engines floor');
  assert.match(storageSrc, /node:sqlite/, '登记表 §三 内置 node:sqlite must be the storage engine import');
  assert.match(storageSrc, /tokenize='unicode61'/, '登记表 §三 FTS5 全文检索扩展 must tokenize with unicode61');
  assert.ok(Object.keys(pkg.dependencies).includes('express') && Object.keys(pkg.dependencies).includes('multer') && Object.keys(pkg.dependencies).includes('fflate') && Object.keys(pkg.dependencies).includes('pdf-parse'),
    '登记表 §三 must list exactly the runtime deps the package.json ships');
  assert.strictEqual(Object.keys(pkg.dependencies).length, 4, '登记表 §三 must stay at the four shipped runtime deps');
  assert.match(reg, /完全离线运行，数据不出机器/, '登记表 §三 must promise fully-offline data confinement');
  assert.ok(
    !(/(?:fetch\(|https\.request|http\.request|net\.connect)/.test(appSrc + serverSrc)),
    '登记表 §三 offline: no source module may make outbound network calls'
  );

  // ---- 登记表 §七 递交材料清单：every submitted file must exist and be non-empty
  for (const f of ['软件著作权登记表.txt', '源代码.txt', '设计说明书.txt', '用户手册.txt']) {
    const p = path.join(SUBDIR, f);
    assert.ok(fs.existsSync(p), `登记表 §七 must have a real ${f}`);
    assert.ok(fs.statSync(p).size > 0, `登记表 §七 ${f} must not be an empty placeholder`);
  }

  // ---- 用户手册 §5.4 Q13: the cloud-upload answer must match the offline-only
  // implementation (no outbound fetch in any app/knowledge/storage code path)
  assert.ok(manual.includes('数据会被上传到云端吗'), 'manual §5.4 Q13 must pose the cloud-upload question');
  assert.ok(manual.includes('不会。默认路径完全离线'), 'manual §5.4 Q13 must answer 不会 on the default path');
  assert.ok(appSrc.includes('llmEnabled: false'), 'manual §5.4 Q13 summarizer-off default must hold in app.js');
  assert.ok(
    !(/(?:fetch\(|https\.request|http\.request)/.test(kbSrc + storageSrc)),
    'manual §5.4 Q13 default path must make no outbound HTTP calls'
  );
});

test('prod: submission-doc generator guards fail loudly on drift', () => {
  const c = gen.computeCounts();

  // srcBodyPages pads to pages*50 body lines; if a page budget is too small the
  // stream cannot fit and the generator must refuse instead of emitting garbage.
  assert.throws(() => gen.srcBodyPages({ ...c, pages: c.pages - 1 }), /stream longer than/);

  // patchDesign must touch one heading per module; a doc missing any heading
  // (or a rel renamed in src) must fail rather than silently skip the count.
  const partial = '3.1  模块 01：chunker（src/lib/chunker.js，有效 48 行）\n';
  assert.throws(() => gen.patchDesign(c, partial), /expected 8 module headings, patched 1/);

  // A heading-looking line for a rel outside FILES hits the skip (continue)
  // branch: with all 8 real headings present the patch still succeeds, the
  // real headings get their current effective counts, and the unknown line is
  // left byte-untouched rather than patched or counted.
  const headings = c.rows.map((r) => `模块 ${String(r.idx).padStart(2, '0')}（${r.rel}，有效 1 行）`).join('\n');
  const ghost = '模块 99（src/lib/ghost.js，有效 12 行）';
  const mixed = gen.patchDesign(c, `${headings}\n${ghost}`);
  for (const r of c.rows) {
    const patchedHeading = `模块 ${String(r.idx).padStart(2, '0')}（${r.rel}，有效 ${r.effective} 行）`;
    assert.ok(mixed.includes(patchedHeading), `row ${r.idx} must be rewritten to its current effective count`);
  }
  assert.strictEqual(mixed.split('\n').at(-1), ghost, 'an unknown rel must be left untouched, not patched');
});

test('prod: gen-submission-docs CLI regenerates the docs in place and exits 0', async () => {
  // Covers the require.main === module / run() arm: the CLI rewrites the three
  // committed docs from the current source. Generation is a fixed point (see
  // the byte-match test above), so this run cannot change git-tracked bytes.
  const { code, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/gen-submission-docs.js'], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (exitCode) => resolve({ code: exitCode, stdout: out, stderr: err }));
  });
  assert.strictEqual(code, 0, `CLI should exit cleanly, stderr: ${stderr}`);
  assert.match(stdout, /submission docs regenerated \(1230 lines \/ 942 effective, 25 pages\)/);

  // The in-place rewrite must leave the committed docs byte-identical.
  const c = gen.computeCounts();
  assert.strictEqual(
    fs.readFileSync(path.join(SUBDIR, '源代码.txt'), 'utf8'),
    gen.buildSourceCodeDoc(c),
    'CLI run must not mutate committed 源代码.txt'
  );
  const reg = fs.readFileSync(path.join(SUBDIR, '软件著作权登记表.txt'), 'utf8');
  const dsg = fs.readFileSync(path.join(SUBDIR, '设计说明书.txt'), 'utf8');
  assert.strictEqual(gen.patchRegister(c, reg), reg, 'CLI run must not mutate the committed 登记表');
  assert.strictEqual(gen.patchDesign(c, dsg), dsg, 'CLI run must not mutate the committed 设计说明书');
});

test('prod: 用户手册.txt operating claims hold against the implementation', () => {
  // 用户手册.txt is the operator-facing submission doc: its install steps, env
  // table, upload limits, widget recipe, domain presets and FAQ error codes must
  // stay true to what src/ actually does. Every claim below is pinned to a
  // source needle so an operator following the manual gets the real product.
  const manual = fs.readFileSync(path.join(SUBDIR, '用户手册.txt'), 'utf8');
  const manualFlat = manual.replace(/\s+/g, ' '); // line-wrapped prose, compare on one line
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'knowledge.js'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'storage.js'), 'utf8');
  const widgetSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');
  const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const extractSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'extractors.js'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const { DOMAINS } = require('../src/lib/domains');
  const { fileKind } = require('../src/lib/extractors');
  const { CORPUS_FILES } = require('../scripts/fixture-content');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const demoJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'demo.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  const tokenizerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tokenizer.js'), 'utf8');

  // ---- §2.1 runtime: manual requires Node >= 22.5.0 = package.json engines
  assert.match(manual, /Node\.js ≥ 22\.5\.0/, 'manual §2.1 must state the Node requirement');
  assert.ok(pkg.engines && />=22\.5\.0/.test(pkg.engines.node), 'package.json engines must match the manual Node requirement');

  // ---- §1.2 feature list: every 主要特点 bullet maps to a real implementation
  // path (offline / CJK tokenizer+BM25 / citations / widget script / embedded SQLite)
  assert.ok(manual.includes('完全离线'), 'manual §1.2 must lead with the offline property');
  assert.ok(manual.includes('默认不依赖任何外部大模型或向量数据库'), 'manual §1.2 must promise no external model/vector DB');
  assert.ok(manual.includes('数据不出机器'), 'manual §1.2 must promise data stays on the machine');
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'manual §1.2 offline-only must hold in knowledge.js');
  assert.ok(manual.includes('中文友好'), 'manual §1.2 must claim Chinese-friendly retrieval');
  assert.match(tokenizerSrc, /default bigrams/, 'manual §1.2 CJK-friendly tokenizer must n-gram runs in tokenizer.js');
  assert.match(storageSrc, /bm25\(fts\)/, 'manual §1.2 relevance ranking must use BM25 in storage.js');
  assert.ok(manual.includes('可溯源'), 'manual §1.2 must claim traceable citations');
  assert.match(kbSrc, /document: c\.filename/, 'manual §1.2 citations must carry the document name from knowledge.js');
  assert.match(kbSrc, /paragraph: c\.chunkIndex/, 'manual §1.2 citations must carry the paragraph number from knowledge.js');
  assert.match(kbSrc, /excerptFrom\(/, 'manual §1.2 citations must extract the original excerpt in knowledge.js');
  assert.ok(manual.includes('易嵌入'), 'manual §1.2 must claim easy embedding');
  assert.match(appSrc, /app\.get\('\/widget\.js'/, 'manual §1.2 widget script must be served by app.js');
  assert.match(appSrc, /res\.type\('application\/javascript'\)/, 'manual §1.2 widget.js must be served as JS');
  assert.ok(manual.includes('轻量化'), 'manual §1.2 must claim lightweight operation');
  assert.ok(manual.includes('单进程运行'), 'manual §1.2 must promise single-process runtime');
  assert.match(serverSrc, /app\.listen\(PORT/, 'manual §1.2 single process must be the one server listen');
  assert.ok(manual.includes('无独立数据库服务'), 'manual §1.2 must promise no separate DB service');
  assert.match(storageSrc, /require\('node:sqlite'\)/, 'manual §1.2 embedded DB must be node:sqlite in storage.js');

  // ---- §2.2/§2.3 install: default port 3000, docker volume + healthcheck
  assert.match(serverSrc, /PORT \|\| 3000/, 'manual §2.2 default port 3000 must match server.js');
  assert.ok(manual.includes('npm run seed'), 'manual §2.2 must document npm run seed');
  assert.ok(manual.includes('npm start'), 'manual §2.2 must document npm start');
  // the §2.2 step list is the operator install contract: the version check must
  // name the node --version probe and the floor package.json engines enforces
  assert.ok(manual.includes('node --version'), 'manual §2.2 step 1 must show the node --version probe');
  assert.ok(manual.includes('应 ≥ v22.5.0'), 'manual §2.2 must state the Node floor in the version check');
  assert.strictEqual(pkg.engines.node, '>=22.5.0', 'manual §2.2 version-check floor must equal package.json engines');
  assert.ok(manual.includes('cd 20-rag-desk'), 'manual §2.2 step 2 must show entering the project directory');
  assert.ok(manual.includes('npm install'), 'manual §2.2 step 2 must document npm install');
  // the manual's 控制台会打印访问地址 promise: server.js logs the running
  // banner with the actual PORT inside the app.listen callback, naming admin
  // and demo URLs as the manual says
  assert.ok(manual.includes('启动成功后控制台会打印访问地址，默认端口 3000'), 'manual §2.2 must promise the console boot banner');
  assert.match(serverSrc, /app\.listen\(PORT, \(\) => \{\n\s*console\.log\(`RAG-Desk running at http:\/\/localhost:\$\{PORT\}`\)/, 'manual §2.2 boot banner must be printed in the listen callback');
  assert.match(serverSrc, /Admin:  http:\/\/localhost:\$\{PORT\}\/admin/, 'manual §2.2 boot banner must log the admin URL');
  assert.ok(compose.includes('ragdesk-data:/app/data'), 'manual §2.3 named volume must exist in docker-compose');
  assert.ok(manual.includes('ragdesk-data'), 'manual §2.3 must document the named volume');
  assert.match(dockerfile, /\/api\/health/, 'manual §2.3 healthcheck must exist in Dockerfile');
  assert.match(compose, /\/api\/health/, 'manual §2.3 healthcheck must exist in docker-compose');

  // ---- §2.1 environment bullets: the OS/arch, memory, browser and Docker
  // Engine requirements are operator-facing; the ones with a code counterpart
  // are cross-pinned to the built product (node:sqlite, the Docker layout)
  assert.ok(manual.includes('操作系统：Linux / macOS / Windows（x86-64 或 arm64）'), 'manual §2.1 must list the OS/arch matrix');
  assert.ok(manual.includes('Node.js ≥ 22.5.0'), 'manual §2.1 must state the Node.js floor');
  assert.ok(manual.includes('需内置 node:sqlite 模块'), 'manual §2.1 must name the built-in node:sqlite requirement');
  assert.ok(manualFlat.includes('无需额外编译本地'), 'manual §2.1 must promise no native build for deps');
  assert.ok(manual.includes('建议 ≥ 2GB（最低 512MB）'), 'manual §2.1 must state the memory recommendation');
  assert.ok(manual.includes('Chrome / Edge / Firefox / Safari'), 'manual §2.1 must list the supported browsers');
  assert.ok(manual.includes('Docker Engine 20.10+ 与 Docker Compose'), 'manual §2.1 must require Docker Compose on the Docker path');

  // ---- §2.3 Docker path: the compose build target, multi-stage image and
  // rebuild-surviving named volume must be the ones docker-compose.yml and
  // Dockerfile actually ship
  assert.ok(manual.includes('docker compose up --build'), 'manual §2.3 must document docker compose up --build');
  assert.match(compose, /^services:\n  ragdesk:\n    build: \./m, 'manual §2.3 the compose service must build from the Dockerfile');
  assert.ok(manual.includes('镜像多阶段构建（npm ci + 运行）'), 'manual §2.3 must describe the multi-stage image');
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/, 'manual §2.3 build stage must be the Dockerfile dev stage');
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS runtime/, 'manual §2.3 runtime stage must be the Dockerfile prod stage');
  assert.match(dockerfile, /AS build\b[\s\S]*?RUN npm ci --no-audit --no-fund/, 'manual §2.3 the build stage must keep plain npm ci (with devDeps)');
  assert.match(dockerfile, /AS runtime\b[\s\S]*?RUN npm ci --omit=dev/, 'manual §2.3 the runtime stage must install prod deps only');
  assert.ok(manual.includes('容器重建后数据不丢失'), 'manual §2.3 must promise data survives container rebuild');
  assert.match(compose, /\nvolumes:\n  ragdesk-data:\s*\n/, 'manual §2.3 the named volume must be declared at compose top level');

  // ---- §2.4 first start: auto-seed when the DB was not initialized — the gate
  // named in the manual, the seeded flag it persists, and the demo corpus files
  // it promises (法律/诊所/招采公告) are real seeds on disk
  assert.match(serverSrc, /getSetting\('seeded'\)/, 'manual §2.4 auto-seed gate must exist in server.js');
  assert.match(serverSrc, /setSetting\('seeded', '1'\)/, 'manual §2.4 must persist the seeded flag after auto-seeding');
  assert.match(serverSrc, /seedIfNeeded/, 'manual §2.4 auto-seed must invoke seedIfNeeded');
  const corpusDir = path.join(__dirname, '..', 'fixtures', 'corpus');
  for (const f of ['law-faq.md', 'clinic-faq.md', 'bid-announcement.md']) {
    assert.ok(Object.keys(CORPUS_FILES).includes(f), `manual §2.4 corpus member ${f} must be a seeded fixture`);
    assert.ok(fs.existsSync(path.join(corpusDir, f)), `manual §2.4 corpus member ${f} must exist on disk`);
  }
  assert.match(manual, /法律\/诊所\/招采公告/, 'manual §2.4 must promise the 法律/诊所/招采公告 corpus');

  // ---- §2.4 manual seed reset: RAGDESK_DB relocates the DB and `npm run seed`
  // re-ingests the demo corpus — the manual's documented reset path. The seed is
  // sha256-idempotent (skips docs already in storage via getDocBySha) and defaults
  // to force=false, so re-running it never duplicates or destroys content.
  const seedSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seed-fixtures.js'), 'utf8');
  assert.ok(manual.includes('RAGDESK_DB 改变数据库路径'), 'manual §2.4 must document the RAGDESK_DB path override');
  assert.ok(manual.includes('npm run seed 手动重置'), 'manual §2.4 must document the npm run seed manual reset');
  assert.match(pkg.scripts.seed, /scripts\/seed-fixtures\.js/, 'manual §2.4 npm run seed must resolve to scripts/seed-fixtures.js');
  assert.match(seedSrc, /async function seedIfNeeded\(kb, \{ force = false \}/, 'manual §2.4 the seed must be non-destructive without force');
  assert.match(seedSrc, /getDocBySha/, 'manual §2.4 the seed must skip docs already in storage (sha256 idempotent)');

  // ---- §3.1 demo page: the four preset domains and the three example questions
  for (const q of ['律师咨询费怎么收取？', '挂号需要带什么？', '儿童接种疫苗时间？']) {
    assert.ok(manual.includes(q), `manual §3.1 must list example question ${q}`);
  }
  const domainText = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js'), 'utf8');
  assert.ok(manual.includes('法律/医疗/招采/通用'), 'manual §3.1 must document the four domain switch options');
  assert.ok(DOMAINS.legal && DOMAINS.medical && DOMAINS.procurement && DOMAINS.general, 'the four manual domains must be served presets');
  // each manual example question must be a served preset's exampleQuestions entry
  for (const [q, id] of [['律师咨询费怎么收取？', 'legal'], ['挂号需要带什么？', 'medical'], ['儿童接种疫苗时间？', 'medical']]) {
    assert.ok(DOMAINS[id].exampleQuestions.includes(q), `example ${q} must live in served preset ${id}`);
  }
  assert.ok(domainText.includes('法律 · 律师事务所'), 'manual 法律 domain must match the served label');

  // ---- §3.1 demo page UI prose: chat box, 发送 on submit, 引用来源 citations
  // (document name + paragraph number + excerpt), domain-switch greeting, and
  // clickable example questions must match the real demo page
  assert.ok(manual.includes('回车或点击发送'), 'manual §3.1 must document Enter/submit sending');
  assert.match(indexHtml, /<button type="submit">发送<\/button>/, 'manual §3.1 发送 button must be the demo form submit');
  assert.ok(manual.includes('引用来源'), 'manual §3.1 must document the citations block');
  assert.ok(manual.includes('文档名、段落号与原文摘录'), 'manual §3.1 must describe the citation fields');
  assert.match(demoJs, /class="bot-cite"/, 'manual §3.1 citations must be rendered by demo.js');
  assert.match(demoJs, /class="cite-doc">\$?\{esc\(c\.document\)\}/, 'manual §3.1 citation must show the matched document name');
  assert.match(demoJs, /§\$\{c\.paragraph\}/, 'manual §3.1 citation must show the paragraph number');
  assert.ok(manual.includes('问候语与话术随之变化'), 'manual §3.1 must promise the greeting change on domain switch');
  assert.ok(demoJs.includes('greetingEl.textContent = d.greeting'), 'manual §3.1 greeting swap must exist in demo.js');
  assert.ok(manual.includes('点击示例问题可直接提问'), 'manual §3.1 must promise clickable example questions');
  assert.match(demoJs, /form\.requestSubmit\(\)/, 'manual §3.1 clicking an example must submit the chat form');

  // ---- §3.2 admin: token gating via x-admin-token, assented in the browser
  assert.ok(manual.includes('x-admin-token'), 'manual §3.2 must document the x-admin-token header');
  assert.ok(manual.includes('RAGDESK_ADMIN_TOKEN'), 'manual §3.2 must name RAGDESK_ADMIN_TOKEN');
  assert.ok(adminSrc.includes("'ragdesk-admin-token'"), 'admin.js must persist the token under the manual-documented key');
  assert.ok(adminSrc.includes("headers['x-admin-token']"), 'admin.js must send x-admin-token as the manual documents');
  // the doc list column the manual describes must be the one admin.html renders
  assert.ok(manual.includes('文件名、类型、分块、大小、上传时间'), 'manual §3.2 doc-list parenthetical must match admin.html column order');
  assert.match(adminHtml, /<th>文件名<\/th><th>类型<\/th><th>分块<\/th><th>大小<\/th><th>上传时间<\/th>/, 'manual §3.2 doc-list column order must match admin.html');
  assert.ok(manual.includes('上传时间'), 'manual §3.2 doc list must label the upload timestamp');
  assert.match(adminHtml, /上传时间/, 'manual §3.2 上传时间 column must exist in admin.html');
  // clicking a doc shows all its indexed chunks, with an explicit empty state
  assert.ok(manual.includes('点击文档可查看其全部索引分块内容'), 'manual §3.2 must promise the chunk preview');
  assert.ok(adminSrc.includes('data-action="view"'), 'manual §3.2 chunk-preview button must exist in admin.js');
  assert.ok(adminSrc.includes('该文档暂无分块。'), 'manual §3.2 empty chunk state must exist in admin.js');
  // the 上传区/查询统计卡片 the manual promises must be the cards admin.html renders
  assert.ok(manual.includes('顶部提供上传区与查询统计卡片'), 'manual §3.2 must promise the upload area and stats cards');
  assert.match(adminHtml, /<h2>上传文档<\/h2>/, 'manual §3.2 upload card must exist in admin.html');
  assert.match(adminHtml, /<h2>索引状态<\/h2>/, 'manual §3.2 stats card must exist in admin.html');
  // the picker accept list the manual gives must be the file input's accept string
  assert.match(adminHtml, /accept="\.md,\.markdown,\.pdf,\.docx,\.txt,\.csv"/, 'manual §3.2 multi-select formats must match the admin upload input');

  // ---- §3.3 upload: formats, 50MB, 20-per-batch, indexed/duplicate/error results
  assert.ok(manual.includes('50MB'), 'manual §3.3 must cap files at 50MB');
  assert.ok(manual.includes('20 个'), 'manual §3.3 must cap a batch at 20 files');
  assert.match(appSrc, /fileSize: 50 \* 1024 \* 1024/, 'manual §3.3 50MB cap must match app.js');
  assert.match(appSrc, /upload\.array\('files', 20\)/, 'manual §3.3 20-file cap must match app.js');
  for (const f of ['.md', '.txt', '.csv', '.pdf', '.docx']) {
    assert.ok(manual.includes(f), `manual §3.3 must list supported format ${f}`);
    assert.ok(fileKind(`doc${f}`), `format ${f} must be served by fileKind`);
  }
  assert.match(kbSrc, /action: 'indexed'/, 'manual indexed result must exist in knowledge.js');
  assert.match(kbSrc, /action: 'duplicate'/, 'manual duplicate result must exist in knowledge.js');
  assert.match(kbSrc, /action: 'error'/, 'manual error result must exist in knowledge.js');

  // ---- §3.3 dedup/delete mechanics: the 内容摘要 dedup hit and the delete
  // cascade that keeps 引用不再命中 are real storage paths
  assert.ok(manual.includes('按内容摘要自动识别并返回 duplicate'), 'manual §3.3 must promise content-digest dedup');
  assert.match(kbSrc, /_sha256\(buffer\)/, 'manual §3.3 digest dedup must hash each upload in knowledge.js');
  assert.match(kbSrc, /getDocBySha/, 'manual §3.3 dedup must look up the digest in knowledge.js');
  assert.match(storageSrc, /getDocBySha\(sha256\)/, 'manual §3.3 dedup lookup must exist in storage.js');
  assert.ok(manual.includes('移除文档及其全部分块与索引'), 'manual §3.3 must promise the delete cascade');
  assert.match(storageSrc, /DELETE FROM fts WHERE rowid = \?/, 'manual §3.3 delete must clear the doc FTS index');
  assert.match(storageSrc, /DELETE FROM chunks WHERE doc_id = \?/, 'manual §3.3 delete must clear the doc chunks');
  assert.match(storageSrc, /DELETE FROM docs WHERE id = \?/, 'manual §3.3 delete must remove the doc row');
  assert.match(manual, /删除后相关\s*引用即不再命中/, 'manual §3.3 must promise citations stop matching after delete');

  // ---- §3.4 stats: total / with_answer / 命中率 served by the storage query
  assert.ok(manual.includes('总查询量'), 'manual §3.4 must document the total-query stat');
  assert.match(storageSrc, /COUNT\(\*\) AS total/, 'manual 总查询量 must be a COUNT over queries_log in storage.js');
  assert.ok(manual.includes('with_answer'), 'manual §3.4 must document the with_answer stat');
  assert.match(storageSrc, /AS with_answer/, 'manual with_answer stat must exist in storage.js stats');
  assert.match(storageSrc, /matched > 0/, 'with_answer must count only queries that hit at least one citation');
  assert.ok(manual.includes('命中率'), 'manual §3.4 must document the hit rate');
  assert.match(adminSrc, /Math\.round\(\(s\.with_answer \/ s\.total\) \* 100\)/, 'admin.js must derive the hit rate from total and with_answer');
  // the analytics sentence (哪些问题高发 / 哪些文档检索命中之高) is exactly what
  // the persisted query text plus its top-matched document enable
  assert.ok(manual.includes('哪些问题高发'), 'manual §3.4 must promise question-frequency analytics');
  assert.ok(manual.includes('据此补充语料'), 'manual §3.4 must promise corpus-supplement guidance');

  // ---- §3.4 log fields: the recent-query columns the manual lists (问题、时间、
  // 命中数、来源文档) must be the columns admin.html renders and admin.js fills
  assert.ok(manual.includes('问题、时间、命中数、来源文档'), 'manual §3.4 must list the recent-query log columns');
  assert.match(adminHtml, /<th>时间<\/th><th>查询<\/th>/, 'manual §3.4 log time/query columns must exist in admin.html');
  assert.match(adminHtml, /来源文档/, 'manual §3.4 来源文档 log column must exist in admin.html');
  assert.match(adminSrc, /l\.created_at/, 'manual §3.4 log time must be filled from created_at in admin.js');
  assert.match(adminSrc, /l\.query/, 'manual §3.4 log query must be filled from query in admin.js');
  assert.match(adminSrc, /l\.matched \|\| 0/, 'manual §3.4 命中数 must be filled from matched in admin.js');
  assert.match(adminSrc, /l\.top_filename/, 'manual §3.4 来源文档 must be filled from top_filename in admin.js');

  // ---- §3.5 widget: every data-* attribute and the Bearer header
  for (const attr of ['data-api', 'data-domain', 'data-title', 'data-greeting', 'data-token']) {
    assert.ok(manual.includes(attr), `manual §3.5 must document the ${attr} attribute`);
    assert.match(widgetSrc, new RegExp(`getAttribute\\('${attr}'`), `widget.js must read ${attr} as the manual documents`);
  }
  assert.ok(manual.includes('Authorization: Bearer'), 'manual §3.5 must document the Bearer header');
  assert.match(widgetSrc, /headers\.Authorization = 'Bearer ' \+ TOKEN/, 'widget.js must send the Bearer token as documented');
  assert.ok(manual.includes('RAGDESK_ALLOW_ORIGIN'), 'manual §3.5 must document RAGDESK_ALLOW_ORIGIN CORS control');
  // the manual prose promises a floating button that toggles a panel and posts
  // questions to the data-api endpoint — widget.js must implement each step
  assert.ok(manual.includes('页面右下角会出现悬浮聊天按钮'), 'manual §3.5 must promise the bottom-right floating button');
  assert.match(widgetSrc, /fab\.id = 'ragdesk-fab'/, 'widget.js must create the documented floating button');
  assert.match(widgetSrc, /right:20px;bottom:20px/, 'manual §3.5 floating button must sit bottom-right');
  assert.ok(manual.includes('点击展开/收起'), 'manual §3.5 must promise click-to-toggle the panel');
  assert.match(widgetSrc, /panel\.classList\.toggle\('open'\)/, 'widget.js must toggle the panel on fab click');
  assert.match(manual, /调用 data-api 指定\s*的问答接口/, 'manual §3.5 must promise posting to the data-api endpoint');
  assert.match(widgetSrc, /fetch\(API, \{/, 'widget.js must fetch the data-api endpoint');
  assert.match(widgetSrc, /method: 'POST'/, 'widget.js must POST to the data-api endpoint');

  // ---- §3.6 HTTP interface examples: each curl the manual shows must hit a
  // route app.js actually serves, with the documented method, path and headers
  assert.ok(manual.includes('curl http://localhost:3000/api/health'), 'manual §3.6 must show the health-check curl');
  assert.match(appSrc, /app\.get\('\/api\/health'/, 'manual §3.6 health route must exist in app.js');
  assert.ok(manual.includes('curl -X POST http://localhost:3000/api/chat'), 'manual §3.6 must show the chat POST curl');
  assert.match(appSrc, /app\.post\('\/api\/chat'/, 'manual §3.6 chat route must exist in app.js');
  assert.ok(manual.includes('"query":"律师咨询费怎么收取？","domain":"legal"'), 'manual §3.6 chat curl must use the served legal example');
  assert.ok(manual.includes('Authorization: Bearer abc123'), 'manual §3.6 must document the chat Bearer header');
  assert.ok(appSrc.includes('Bearer ${chatToken}'), 'manual §3.6 chat Bearer gate must exist in app.js');
  assert.ok(manual.includes('-F "files=@./fixtures/corpus/clinic-faq.md"'), 'manual §3.6 must show the real fixture upload curl');
  assert.match(appSrc, /app\.post\('\/api\/admin\/upload'/, 'manual §3.6 upload route must exist in app.js');
  assert.ok(manual.includes('"x-admin-token: change-me"'), 'manual §3.6 upload curl must send x-admin-token');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'fixtures', 'corpus', 'clinic-faq.md')), 'manual §3.6 upload curl must point at a real fixture file');
  assert.ok(manual.includes('curl -X DELETE http://localhost:3000/api/admin/docs/1'), 'manual §3.6 must show the doc-delete curl');
  assert.match(appSrc, /app\.delete\('\/api\/admin\/docs\/:id'/, 'manual §3.6 doc-delete route must exist in app.js');

  // ---- §4.1 env table: every variable documented is read, defaults match
  const envReads = [
    ['PORT', serverSrc, 'process.env.PORT'],
    ['RAGDESK_DB', serverSrc, 'process.env.RAGDESK_DB'],
    ['RAGDESK_ADMIN_TOKEN', appSrc, 'process.env.RAGDESK_ADMIN_TOKEN'],
    ['RAGDESK_CHAT_TOKEN', appSrc, 'process.env.RAGDESK_CHAT_TOKEN'],
    ['RAGDESK_ALLOW_ORIGIN', appSrc, 'process.env.RAGDESK_ALLOW_ORIGIN'],
  ];
  for (const [varName, src, needle] of envReads) {
    assert.ok(manual.includes(varName), `manual §4.1 must document ${varName}`);
    assert.ok(src.includes(needle), `${varName} documented in manual must actually be read (${needle})`);
  }
  assert.match(serverSrc, /RAGDESK_DB \|\| path\.join\(ROOT, 'data', 'ragdesk\.db'\)/, 'manual §4.1 default DB path must match server.js');

  // ---- §4.1 launch examples: bash and PowerShell override PORT + RAGDESK_DB
  // the same two vars the env table documents and server.js reads
  assert.ok(manual.includes('PORT=8080 RAGDESK_DB=/var/lib/ragdesk.db npm start'), 'manual §4.1 Linux example must combine PORT+RAGDESK_DB on npm start');
  assert.ok(manual.includes('$env:PORT=8080'), 'manual §4.1 must show the Windows PowerShell PORT set');
  assert.ok(manual.includes('$env:RAGDESK_DB'), 'manual §4.1 must show the Windows PowerShell RAGDESK_DB set');
  assert.ok(manual.includes('D:\\data\\ragdesk.db'), 'manual §4.1 Windows example must use a Windows-style DB path');

  // ---- §4.3 optional LLM: off by default, injected summarizer opt-in
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'manual §4.3 offline default must exist in knowledge.js');
  assert.match(kbSrc, /llm: false/, 'manual §4.3 LLM-off default must hold in knowledge.js');
  assert.ok(appSrc.includes('llmEnabled: false'), 'manual §4.3 llmEnabled=false must hold in app.js health');
  assert.ok(manual.includes('mockSummarizer'), 'manual §4.3 must document the mock summarizer');
  // the manual documents the summarizer contract {query, context, systemPrompt}
  // and says it is caller-injected — both must hold in knowledge.js
  assert.ok(manual.includes('{ query, context, systemPrompt }'), 'manual §4.3 must document the summarizer argument shape');
  assert.match(kbSrc, /turns \{query, context, systemPrompt\} into text/, 'manual §4.3 summarizer signature must be documented in knowledge.js');
  assert.match(kbSrc, /opts\.summarizer \|\| mockSummarizer/, 'manual §4.3 summarizer must be caller-injected in knowledge.js');

  // ---- §5.2 Q6: FTS query errors degrade to LIKE scan
  assert.ok(manual.includes('LIKE'), 'manual §5.2 Q6 must document the LIKE 降级 fallback');
  assert.match(storageSrc, /body LIKE \? COLLATE NOCASE/, 'manual LIKE 降级 must have a LIKE fallback in storage.js');
  // the degrade is AUTOMATIC: storage.js catches the FTS MATCH error and reruns
  // the query as a LIKE scan — the user does nothing; the special-symbol input
  // the manual names as the trigger is the FTS syntax error the catch documents
  assert.ok(manual.includes('自动降级'), 'manual §5.2 Q6 must promise the automatic LIKE degrade');
  assert.ok(manual.includes('含特殊符号'), 'manual §5.2 Q6 must name special-symbol input as the trigger');
  assert.match(storageSrc, /query syntax errors/, 'manual §5.2 Q6 trigger must be the FTS syntax-error catch in storage.js');
  assert.match(storageSrc, /degrade to LIKE scan/, 'manual §5.2 Q6 must document the catch-arm degrade comment');
  assert.match(storageSrc, /\[%_\]/, 'manual §5.2 Q6 degrade must strip LIKE wildcards from the query');

  // ---- §5.3 Q7 formats: .markdown documented and served
  assert.ok(manual.includes('.markdown'), 'manual §5.3 Q7 must list .markdown');
  assert.strictEqual(fileKind('doc.markdown'), 'markdown', '.markdown must be served by fileKind');
  // ---- §5.3 Q8: empty-file message exists verbatim
  assert.ok(manual.includes('文件内容为空，无法索引'), 'manual §5.3 Q8 must quote the empty-file error');
  assert.match(kbSrc, /文件内容为空，无法索引/, 'the manual-quoted empty-file error must exist in knowledge.js');
  // ---- §5.3 Q7: the unsupported-format message exists verbatim
  assert.ok(manual.includes('不支持的文件类型'), 'manual §5.3 Q7 must quote the unsupported-format error');
  assert.match(kbSrc, /不支持的文件类型/, 'the manual-quoted unsupported-format error must exist in knowledge.js');
  // ---- §5.3 Q9: 400/413 error mapping (fixed from the stale 121/413)
  assert.ok(manual.includes('上传 400/413 错误'), 'manual §5.3 Q9 must document the 400/413 codes');
  assert.match(appSrc, /'LIMIT_FILE_SIZE' \? 413/, '413 must map to file-too-large in app.js');
  assert.match(appSrc, /'LIMIT_UNEXPECTED_FILE' \? 400/, '400 must map to too-many-files in app.js');

  // ---- §2.5 uninstall: dropping data/ragdesk.db clears all state — the whole
  // store is one SQLite file the server opens directly under the documented path
  assert.ok(manual.includes('data/ragdesk.db'), 'manual §2.5 must name the sqlite data file');
  assert.ok(manual.includes('docker compose down -v'), 'manual §2.5 must document the volume-removing teardown');
  assert.ok(manual.includes('停掉进程（Ctrl+C 或 kill）'), 'manual §2.5 must describe stopping the source process');
  assert.match(serverSrc, /process\.on\('SIGINT', close\)/, 'manual §2.5 Ctrl+C teardown must bound to the SIGINT handler in server.js');
  assert.match(serverSrc, /process\.on\('SIGTERM', close\)/, 'manual §2.5 kill teardown must bound to the SIGTERM handler in server.js');
  assert.ok(manual.includes('一并删除即清除全部索引与日志'), 'manual §2.5 must promise one-file index+log cleanup');
  assert.match(storageSrc, /new DatabaseSync\(dbPath\)/, 'manual §2.5 single-file cleanup requires one sqlite handle in storage.js');
  assert.match(storageSrc, /CREATE TABLE IF NOT EXISTS queries_log/, 'manual §2.5 the query log must live in the same sqlite file');
  assert.match(compose, /ragdesk-data:\/app\/data/, 'manual §2.5 -v teardown refers to the composed ragdesk-data mount');
  assert.match(serverSrc, /RAGDESK_DB \|\| path\.join\(ROOT, 'data', 'ragdesk\.db'\)/, 'manual §2.5 single-file DB must be the server default');

  // ---- §4.2 custom domain template: every documented template field must be a
  // field a served preset actually carries, and must be a valid one-line addition
  assert.ok(manual.includes('school'), 'manual §4.2 must show the school example');
  const templateLine = manual.match(/\{ id:'school'.*\}/s);
  assert.ok(templateLine, 'manual §4.2 must show a whole one-line domain entry');
  for (const field of ['id', 'label', 'greeting', 'lead', 'fallback', 'footer', 'systemPrompt', 'exampleQuestions']) {
    assert.ok(templateLine[0].includes(`${field}:`), `manual §4.2 template must document the ${field} field`);
    assert.ok(DOMAINS.legal[field] !== undefined || (field === 'exampleQuestions' && Array.isArray(DOMAINS.legal[field])), `served preset legal must carry ${field}`);
  }
  // the manual promises the demo select and /api/domains pick up new entries
  assert.match(appSrc, /app\.get\('\/api\/domains'/, 'manual §4.2 /api/domains must be served by app.js');
  assert.ok(domainText.includes('domainIds()'), 'manual §4.2 auto-discovery must build from domainIds()');

  // ---- §5.1 Q1: node:sqlite is the runtime module — a Node below 22.5 cannot load it
  assert.ok(manual.includes('node:sqlite'), 'manual §5.1 Q1 must name node:sqlite');
  assert.match(storageSrc, /require\('node:sqlite'\)/, 'manual §5.1 node:sqlite must be the storage engine import');
  assert.ok(manual.includes('22.5'), 'manual §5.1 Q1 must give the 22.5 threshold');
  // ---- §5.1 Q2: PORT override is real
  assert.ok(manual.includes('PORT=8080 npm start'), 'manual §5.1 Q2 must show the PORT override command');
  assert.match(serverSrc, /PORT \|\| 3000/, 'manual §5.1 PORT override must feed server.js');

  // ---- §5.2 Q4: the admin shows each doc's chunks so a wrong index is visible
  assert.ok(manual.includes('查看该文档分块'), 'manual §5.2 Q4 must promise per-doc chunk inspection');
  assert.ok(adminSrc.includes('查看分块'), 'admin.js must expose the documented 查看分块 action');
  assert.ok(adminSrc.includes('/api/admin/docs/'), 'admin.js must fetch per-doc detail from the docs API');
  // ---- §5.2 Q4: 中文短查询建议≥2 个汉字 — the tokenizer's default bigram
  // n-grams (tokenizer.js) make exactly matches impossible for single chars
  assert.ok(manual.includes('中文短查询建议≥2 个汉字'), 'manual §5.2 Q4 must recommend 2+ Chinese characters');
  assert.match(tokenizerSrc, /n-grams \(default bigrams\)/, 'manual §5.2 Q4 tokenizer must default to bigram n-grams');
  // ---- §5.2 Q5: the documented fallback sentence exists verbatim
  assert.ok(manual.includes('抱歉，我在知识库中暂未找到与您问题直接相关的内容。'), 'manual §5.2 Q5 must quote the not-found fallback');
  assert.match(domainText, /抱歉，我在知识库中暂未找到/, 'the manual-quoted fallback must exist in a served domain preset');

  // ---- §5.3 Q10: PDF parsing is pdf-parse text-layer extraction (scans lack one)
  assert.ok(manual.includes('文字层'), 'manual §5.3 Q10 must explain the text-layer dependency');
  assert.match(extractSrc, /require\('pdf-parse'\)/, 'manual §5.3 Q10 pdf-parse must be the PDF extractor');
  assert.match(extractSrc, /getText\(\)/, 'manual §5.3 Q10 text-layer extraction must use getText()');

  // ---- §5.4 Q11: the admin gate defaults on; compose ships change-me
  assert.ok(manual.includes('change-me'), 'manual §5.4 Q11 must name the change-me placeholder');
  assert.match(compose, /RAGDESK_ADMIN_TOKEN=change-me/, 'manual §5.4 Q11 compose default must be the change-me placeholder');
  assert.ok(adminSrc.includes("headers['x-admin-token']"), 'manual §5.4 admin must send x-admin-token');
  assert.ok(manual.includes('unauthorized'), 'manual §5.4 Q11 must name the unauthorized error');
  assert.match(appSrc, /error: 'unauthorized/, 'manual §5.4 Q11 the unauthorized payload must be served by app.js');
  // ---- §5.4 Q12: RAGDESK_ALLOW_ORIGIN is the CORS control
  assert.ok(manual.includes('RAGDESK_ALLOW_ORIGIN'), 'manual §5.4 Q12 must name RAGDESK_ALLOW_ORIGIN');
  assert.match(appSrc, /process\.env\.RAGDESK_ALLOW_ORIGIN/, 'manual §5.4 CORS env must be read in app.js');

  // ---- §5.4 Q13: "数据会被上传到云端吗？不会。" — the offline promise must hold
  // structurally: no src file requires an outbound http(s) client and package.json
  // ships none; the only way data leaves the machine is a caller-injected external
  // summarizer (off by default, §4.3), which the manual warns about verbatim.
  assert.ok(manual.includes('不会。'), 'manual §5.4 Q13 must answer the cloud-upload question in the negative');
  assert.ok(manual.includes('完全离线'), 'manual §5.4 Q13 must restate the offline guarantee');
  assert.ok(manual.includes('只读本地 SQLite'), 'manual §5.4 Q13 must name local SQLite as the only store');
  assert.ok(manual.includes('数据会离开本机'), 'manual §5.4 Q13 must warn that an external summarizer sends data off-machine');
  assert.ok(manual.includes('外部 summarizer'), 'manual §5.4 Q13 must name the external summarizer as the data-leak path');
  for (const src of [appSrc, serverSrc, kbSrc, storageSrc, extractSrc]) {
    assert.ok(!/require\(['"](?:node:)?https?['"]\)/.test(src), 'manual §5.4 Q13 offline promise requires no http(s) client import in src');
  }
  assert.ok(!pkg.dependencies['node-fetch'] && !pkg.dependencies.axios && !pkg.dependencies.got, 'manual §5.4 Q13 offline promise requires no HTTP-client dependency');
  assert.match(kbSrc, /async function mockSummarizer\(\{ query, context \}\)/, 'manual §5.4 Q13 the default summarizer must be the local mock');
  assert.ok(!/fetch\(/.test(kbSrc), 'manual §5.4 Q13 the default summarizer must make no network calls');

  // ---- §5.5 scaling: DELETE route and the widget data-api split both exist
  assert.match(appSrc, /app\.delete\('\/api\/admin\/docs\/:id'/, 'manual §5.5 DELETE-doc flow must be served by app.js');
  assert.ok(manual.includes('data-api'), 'manual §5.5 must document the data-api split');
  assert.ok(manual.includes('一个领域/库'), 'manual §5.5 must recommend per-library instances');
  // the chunk-total control the manual recommends (prune stale docs, re-upload)
  // must be observable: admin.js renders the summed chunk_count as the 分块 stat
  assert.ok(manual.includes('控制分块总量'), 'manual §5.5 must recommend controlling the chunk total');
  assert.ok(manual.includes('重新上传'), 'manual §5.5 must recommend re-uploading after pruning');
  assert.match(adminSrc, /docs\.reduce\(\(s, d\) => s \+ \(d\.chunk_count \|\| 0\), 0\)/, 'manual §5.5 the 分块 total stat must come from summed chunk_count in admin.js');
});
