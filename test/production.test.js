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
  for (const id of ['legal', 'medical', 'procurement', 'general']) {
    const d = DOMAINS[id];
    assert.ok(d, `SPEC preset domain ${id} must exist`);
    assert.ok(typeof d.systemPrompt === 'string' && d.systemPrompt, `${id} must carry a systemPrompt template`);
    assert.ok(typeof d.lead === 'string' && typeof d.fallback === 'string', `${id} must carry lead/fallback wording`);
  }

  // ---- AC: citations are (source document + paragraph number) on the wire
  assert.match(kbSrc, /document: c\.filename/, 'citations must name the source document');
  assert.match(kbSrc, /paragraph: c\.chunkIndex/, 'citations must carry the paragraph/chunk number');

  // ---- AC: offline (no LLM/embedding) answer path with 原文片段 + 置信度
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'offline answer mode must exist (SPEC 离线模式)');
  assert.match(kbSrc, /llm: false/, 'LLM must default off (SPEC LLM 默认关闭)');
  assert.match(kbSrc, /answer: answerText/, 'offline answers must be rule-generated from retrieval (SPEC 检索 + 规则)');

  // ---- 非目标: single-tenant is not a storage abstraction — no customer_id anywhere
  assert.doesNotMatch(storageSrc, /customer_id|tenant_id/, 'SPEC 非目标 single-tenant must hold in storage');

  // ---- AC: an embedded chat widget + API endpoint (README 嵌入浮窗 lock covers the snippet)
  assert.ok(spec.includes('嵌入式聊天浮窗'), 'SPEC must promise the embeddable chat widget');
  assert.ok(spec.includes('API endpoint'), 'SPEC must promise the API endpoint');

  // ---- AC: no external API dependency in the offline path — src/ has no HTTP client
  assert.doesNotMatch(appSrc, /require\(['"](node:)?https?['"]\)/, 'src/app.js must not call external services');
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
  assert.ok(readme.includes('fixtures/corpus/    # 中文领域语料（law/clinic/bid'), 'README 目录 must document the Chinese corpus fixtures');
  assert.ok(readme.includes('npm ci + 运行'), 'README 目录 must describe the Dockerfile as npm ci + run');
  assert.ok(readme.includes('单服务编排'), 'README 目录 must describe docker-compose.yml as single-service');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'lib', 'domains.js')), '目录-listed src/lib/domains.js must exist');

  // ---- 许可: README claims MIT, package.json must declare the same license
  assert.ok(readme.includes('MIT'), 'README must document the MIT license');
  assert.strictEqual(pkg.license, 'MIT', 'package.json license must be MIT as README states');
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

  // ---- §2.1 runtime: manual requires Node >= 22.5.0 = package.json engines
  assert.match(manual, /Node\.js ≥ 22\.5\.0/, 'manual §2.1 must state the Node requirement');
  assert.ok(pkg.engines && />=22\.5\.0/.test(pkg.engines.node), 'package.json engines must match the manual Node requirement');

  // ---- §2.2/§2.3 install: default port 3000, docker volume + healthcheck
  assert.match(serverSrc, /PORT \|\| 3000/, 'manual §2.2 default port 3000 must match server.js');
  assert.ok(manual.includes('npm run seed'), 'manual §2.2 must document npm run seed');
  assert.ok(manual.includes('npm start'), 'manual §2.2 must document npm start');
  assert.ok(compose.includes('ragdesk-data:/app/data'), 'manual §2.3 named volume must exist in docker-compose');
  assert.ok(manual.includes('ragdesk-data'), 'manual §2.3 must document the named volume');
  assert.match(dockerfile, /\/api\/health/, 'manual §2.3 healthcheck must exist in Dockerfile');
  assert.match(compose, /\/api\/health/, 'manual §2.3 healthcheck must exist in docker-compose');

  // ---- §2.4 first start: auto-seed when the DB was not initialized
  assert.match(serverSrc, /getSetting\('seeded'\)/, 'manual §2.4 auto-seed gate must exist in server.js');

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

  // ---- §3.2 admin: token gating via x-admin-token, assented in the browser
  assert.ok(manual.includes('x-admin-token'), 'manual §3.2 must document the x-admin-token header');
  assert.ok(manual.includes('RAGDESK_ADMIN_TOKEN'), 'manual §3.2 must name RAGDESK_ADMIN_TOKEN');
  assert.ok(adminSrc.includes("'ragdesk-admin-token'"), 'admin.js must persist the token under the manual-documented key');
  assert.ok(adminSrc.includes("headers['x-admin-token']"), 'admin.js must send x-admin-token as the manual documents');

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

  // ---- §3.4 stats: total / with_answer / 命中率 served by the storage query
  assert.ok(manual.includes('with_answer'), 'manual §3.4 must document the with_answer stat');
  assert.match(storageSrc, /AS with_answer/, 'manual with_answer stat must exist in storage.js stats');

  // ---- §3.5 widget: every data-* attribute and the Bearer header
  for (const attr of ['data-api', 'data-domain', 'data-title', 'data-greeting', 'data-token']) {
    assert.ok(manual.includes(attr), `manual §3.5 must document the ${attr} attribute`);
    assert.match(widgetSrc, new RegExp(`getAttribute\\('${attr}'`), `widget.js must read ${attr} as the manual documents`);
  }
  assert.ok(manual.includes('Authorization: Bearer'), 'manual §3.5 must document the Bearer header');
  assert.match(widgetSrc, /headers\.Authorization = 'Bearer ' \+ TOKEN/, 'widget.js must send the Bearer token as documented');
  assert.ok(manual.includes('RAGDESK_ALLOW_ORIGIN'), 'manual §3.5 must document RAGDESK_ALLOW_ORIGIN CORS control');

  // ---- §3.6 curl example: the corpus file it uploads must exist on disk
  assert.ok(manual.includes('-F "files=@./fixtures/corpus/clinic-faq.md"'), 'manual §3.6 must show the real fixture upload curl');

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

  // ---- §4.3 optional LLM: off by default, injected summarizer opt-in
  assert.match(kbSrc, /mode: 'offline-retrieval'/, 'manual §4.3 offline default must exist in knowledge.js');
  assert.match(kbSrc, /llm: false/, 'manual §4.3 LLM-off default must hold in knowledge.js');
  assert.ok(appSrc.includes('llmEnabled: false'), 'manual §4.3 llmEnabled=false must hold in app.js health');
  assert.ok(manual.includes('mockSummarizer'), 'manual §4.3 must document the mock summarizer');

  // ---- §5.2 Q6: FTS query errors degrade to LIKE scan
  assert.ok(manual.includes('LIKE'), 'manual §5.2 Q6 must document the LIKE 降级 fallback');
  assert.match(storageSrc, /body LIKE \? COLLATE NOCASE/, 'manual LIKE 降级 must have a LIKE fallback in storage.js');

  // ---- §5.3 Q7 formats: .markdown documented and served
  assert.ok(manual.includes('.markdown'), 'manual §5.3 Q7 must list .markdown');
  assert.strictEqual(fileKind('doc.markdown'), 'markdown', '.markdown must be served by fileKind');
  // ---- §5.3 Q8: empty-file message exists verbatim
  assert.ok(manual.includes('文件内容为空，无法索引'), 'manual §5.3 Q8 must quote the empty-file error');
  assert.match(kbSrc, /文件内容为空，无法索引/, 'the manual-quoted empty-file error must exist in knowledge.js');
  // ---- §5.3 Q9: 400/413 error mapping (fixed from the stale 121/413)
  assert.ok(manual.includes('上传 400/413 错误'), 'manual §5.3 Q9 must document the 400/413 codes');
  assert.match(appSrc, /'LIMIT_FILE_SIZE' \? 413/, '413 must map to file-too-large in app.js');
  assert.match(appSrc, /'LIMIT_UNEXPECTED_FILE' \? 400/, '400 must map to too-many-files in app.js');

  // ---- §2.5 uninstall: dropping data/ragdesk.db clears all state — the whole
  // store is one SQLite file the server opens directly under the documented path
  assert.ok(manual.includes('data/ragdesk.db'), 'manual §2.5 must name the sqlite data file');
  assert.ok(manual.includes('docker compose down -v'), 'manual §2.5 must document the volume-removing teardown');
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
  // ---- §5.4 Q12: RAGDESK_ALLOW_ORIGIN is the CORS control
  assert.ok(manual.includes('RAGDESK_ALLOW_ORIGIN'), 'manual §5.4 Q12 must name RAGDESK_ALLOW_ORIGIN');
  assert.match(appSrc, /process\.env\.RAGDESK_ALLOW_ORIGIN/, 'manual §5.4 CORS env must be read in app.js');

  // ---- §5.5 scaling: DELETE route and the widget data-api split both exist
  assert.match(appSrc, /app\.delete\('\/api\/admin\/docs\/:id'/, 'manual §5.5 DELETE-doc flow must be served by app.js');
  assert.ok(manual.includes('data-api'), 'manual §5.5 must document the data-api split');
  assert.ok(manual.includes('一个领域/库'), 'manual §5.5 must recommend per-library instances');
});
