'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { getDomain, domainIds } = require('./lib/domains');

const ROOT = path.join(__dirname, '..');

/**
 * Coerce a user-supplied limit into a sane integer. Malformed values (e.g.
 * "abc") would otherwise pass NaN into SQLite LIMIT ? and blow up with a
 * "datatype mismatch" 500; negative/zero/huge values are clamped too.
 * @param {*} v raw value from query/body
 * @param {number} dflt fallback when v is not a positive finite number
 * @returns {number}
 */
function safeLimit(v, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : dflt;
}

/**
 * Build the express app backed by the given KnowledgeBase.
 * A factory so tests can spin up isolated instances.
 *
 * @param {{
 *   adminToken?: string,
 *   chatToken?: string,
 *   allowOrigin?: string,
 * }} [opts] optional security overrides (also read from env by
 *   server.js: RAGDESK_ADMIN_TOKEN / RAGDESK_CHAT_TOKEN / RAGDESK_ALLOW_ORIGIN).
 *   Leaving a token empty keeps the corresponding area open (dev default).
 */
function buildApp(kb, opts = {}) {
  const adminToken = opts.adminToken || process.env.RAGDESK_ADMIN_TOKEN || '';
  const chatToken = opts.chatToken || process.env.RAGDESK_CHAT_TOKEN || '';
  const allowOrigin = opts.allowOrigin || process.env.RAGDESK_ALLOW_ORIGIN || '';

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));

  // CORS for the embeddable widget: when RAGDESK_ALLOW_ORIGIN is set it is
  // reflected; otherwise a permissive default lets customer pages call the
  // chat API cross-origin (chat is the public-facing surface; admin stays
  // same-origin and additionally token-gated when configured).
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (!origin) return next();
    res.set('Access-Control-Allow-Origin', allowOrigin === '*' ? '*' : (allowOrigin || origin));
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // ---------------------------------------------------------------- auth
  // Admin endpoints are only protected when RAGDESK_ADMIN_TOKEN is set
  // (enabled in docker-compose). API mutation is always read-only otherwise.
  const assertAdmin = (req, res, next) => {
    if (!adminToken) return next();
    const given = req.get('x-admin-token') || '';
    if (given !== adminToken) {
      return res.status(401).json({ error: 'unauthorized: missing or invalid x-admin-token' });
    }
    next();
  };
  app.use('/api/admin', assertAdmin);

  // Optional bearer-token gate for chat embedding on third-party sites.
  const chatAuth = (req, res, next) => {
    if (!chatToken) return next();
    const auth = req.get('authorization') || '';
    if (auth !== `Bearer ${chatToken}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      engine: kb.engineInfo(),
      domains: domainIds(),
      mode: 'offline',
      llmEnabled: false,
    });
  });

  // ---------------------------------------------------------------- chat api
  app.post('/api/chat', chatAuth, (req, res) => {
    const { query, domain, limit } = req.body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const result = kb.answer(String(query).trim(), { domain, limit: safeLimit(limit, 3) });
    kb.logQuery({
      query: result.query,
      domain: result.domain,
      matched: result.citations.length,
      topScore: result.confidence,
      topDocId: result.top ? result.top.docId : null,
      source: 'api',
    });
    res.json(result);
  });

  // ---------------------------------------------------------------- admin api
  app.get('/api/admin/docs', (_req, res) => {
    res.json({ docs: kb.getAllDocs() });
  });

  app.get('/api/admin/docs/:id', (req, res) => {
    const doc = kb.getDoc(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'not found' });
    const chunks = kb.getDocChunks(doc.id);
    res.json({ doc, chunks });
  });

  app.delete('/api/admin/docs/:id', (req, res) => {
    const doc = kb.getDoc(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'not found' });
    kb.deleteDoc(doc.id);
    res.json({ ok: true });
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
  app.post('/api/admin/upload', upload.array('files', 20), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'no files' });
    const results = [];
    for (const f of files) {
      results.push({
        filename: f.originalname,
        ...(await kb.ingestBuffer(f.originalname, f.buffer, { mime: f.mimetype })),
      });
    }
    res.json({ results });
  });

  app.get('/api/admin/logs', (req, res) => {
    const limit = safeLimit(req.query.limit, 100);
    res.json({ logs: kb.getQueryLogs(limit), stats: kb.getQueryStats() });
  });

  app.get('/api/admin/stats', (_req, res) => {
    res.json({ stats: kb.getQueryStats() });
  });

  app.get('/api/domains', (_req, res) => {
    res.json({
      domains: domainIds().map((id) => ({
        id,
        label: getDomain(id).label,
        greeting: getDomain(id).greeting,
        examples: getDomain(id).exampleQuestions,
      })),
    });
  });

  // Unknown API paths get a JSON 404 so client-side JSON.parse never hits the
  // Express HTML error page.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // ---------------------------------------------------------------- pages
  app.use(express.static(path.join(ROOT, 'public')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
  app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
  app.get('/widget.js', (_req, res) => {
    res.type('application/javascript').sendFile(path.join(ROOT, 'public', 'widget.js'));
  });

  // ---------------------------------------------------------------- errors
  // Central JSON error handler: multer/express/body-parser failures and any
  // thrown engine errors become stable JSON instead of HTML stack traces.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status =
      err && err.status ? err.status :
      err && err.code === 'LIMIT_FILE_SIZE' ? 413 :
      err && err.code === 'LIMIT_UNEXPECTED_FILE' ? 400 :
      err && err.type === 'entity.too.large' ? 413 : 500;
    const message =
      err && err.code === 'LIMIT_FILE_SIZE'
        ? 'file too large (max 50MB)'
        : err && err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'too many files (max 20 per upload)'
          : err && err.type === 'entity.too.large'
            ? 'request body too large'
            : err && err.message
              ? err.message
              : 'internal server error';
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { buildApp };
