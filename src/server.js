'use strict';

const path = require('node:path');

const { KnowledgeBase } = require('./lib/knowledge');
const { buildApp } = require('./app');
const { seedIfNeeded } = require('../scripts/seed-fixtures');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.RAGDESK_DB || path.join(ROOT, 'data', 'ragdesk.db');
const PORT = Number(process.env.PORT || 3000);

const fs = require('node:fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const kb = new KnowledgeBase(DB_PATH);

const app = buildApp(kb, {
  adminToken: process.env.RAGDESK_ADMIN_TOKEN,
  chatToken: process.env.RAGDESK_CHAT_TOKEN,
  allowOrigin: process.env.RAGDESK_ALLOW_ORIGIN,
});

// landmark boot: seed the fixture corpus on first run so the demo is live.
(async () => {
  if (!kb.storage.getSetting('seeded')) {
    try {
      const res = await seedIfNeeded(kb, { force: false });
      kb.storage.setSetting('seeded', '1');
      console.log(`[seed] ${res.added} docs indexed, ${res.skipped} already present`);
    } catch (e) {
      console.error('[seed] failed:', e.message);
    }
  } else {
    console.log('[seed] already seeded');
  }
})();

const server = app.listen(PORT, () => {
  console.log(`RAG-Desk running at http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin`);
  console.log(`  Demo:   http://localhost:${PORT}/`);
  console.log(`  Health: http://localhost:${PORT}/api/health`);
  console.log(`  DB:     ${DB_PATH}`);
  console.log(`  Mode:   offline retrieval (LLM & embedding disabled)`);
  console.log(`  Admin:  ${process.env.RAGDESK_ADMIN_TOKEN ? 'token-gated' : 'open (set RAGDESK_ADMIN_TOKEN to protect)'}`);
});

// Don't hold the process open once idle in test scenarios.
const close = () => {
  kb.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

module.exports = { app, server, kb };
