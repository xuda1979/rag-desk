'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Storage } = require('./storage');
const { chunkText } = require('./chunker');
const { getDomain } = require('./domains');
const {
  extractDocx,
  extractPdf,
  textFromBuffer,
  fileKind,
} = require('./extractors');

/**
 * KnowledgeBase: ingestion + retrieval for RAG-Desk.
 */
class KnowledgeBase {
  /**
   * @param {string} dbPath
   * @param {{markdownLib?:object}} [opts]
   */
  constructor(dbPath, opts = {}) {
    this.storage = new Storage(dbPath);
    this.markdownLib = opts.markdownLib || null; // optional plugin, e.g. marked
  }

  close() {
    this.storage.close();
  }

  // ---------------- metadata helpers ----------------
  _sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  async _extractText(filename, buffer) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.pdf') {
      return await extractPdf(buffer);
    }
    if (ext === '.docx') {
      return extractDocx(buffer);
    }
    const t = textFromBuffer(filename, buffer);
    if (t !== null) return t;
    throw new Error(`不支持的文件格式: ${filename || '?'}`);
  }

  fileKindOf(filename) {
    return fileKind(filename);
  }

  isSupportedFile(filename) {
    return fileKind(filename) !== null;
  }

  // ---------------- ingestion ----------------
  /**
   * Ingest a single document from a buffer.
   * Deduplicates by sha256; idempotent re-upload does nothing but report.
   * @returns {{action:'indexed'|'duplicate'|'error', docId?:number, error?:string}}
   */
  async ingestBuffer(filename, buffer, meta = {}) {
    if (!this.isSupportedFile(filename)) {
      return { action: 'error', error: `不支持的文件类型: ${filename}` };
    }
    const sha = this._sha256(buffer);
    const existing = this.storage.getDocBySha(sha);
    if (existing) {
      return { action: 'duplicate', docId: existing.id };
    }
    try {
      const text = await this._extractText(filename, buffer);
      const kind = this.fileKindOf(filename);
      const docId = this.storage.insertDoc({
        filename: path.basename(filename),
        kind,
        mime: meta.mime || null,
        size: buffer.length,
        sha256: sha,
      });
      const chunks = chunkText(text, { window: 400, overlap: 40 });
      this.storage.insertChunks(docId, chunks);
      return { action: 'indexed', docId, chunks: chunks.length };
    } catch (e) {
      return { action: 'error', error: String(e && e.message ? e.message : e) };
    }
  }

  /**
   * Ingest a file path directly (used by seed script / docs folder).
   */
  async ingestFile(filePath, meta = {}) {
    const buf = fs.readFileSync(filePath);
    return this.ingestBuffer(path.basename(filePath), buf, meta);
  }

  /**
   * Re-index a directory of files (ignores unsupported).
   * @returns {Promise<Array<object>>}
   */
  async ingestDir(dirPath) {
    const out = [];
    const entries = fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isFile());
    for (const e of entries) {
      const full = path.join(dirPath, e.name);
      try {
        const res = await this.ingestFile(full);
        out.push({ filename: e.name, ...res });
      } catch (err) {
        out.push({ filename: e.name, action: 'error', error: String(err.message || err) });
      }
    }
    return out;
  }

  getAllDocs() {
    return this.storage.listDocs();
  }

  getDoc(id) {
    return this.storage.getDoc(id);
  }

  getDocChunks(id) {
    return this.storage.listChunks(id);
  }

  deleteDoc(id) {
    return this.storage.deleteDoc(id);
  }

  // ---------------- retrieval ----------------
  /**
   * Retrieve top chunks for a query.
   */
  async retrieve(query, limit = 3) {
    return this.storage.search(query, limit);
  }

  /**
   * Extract a short relevant excerpt from a chunk body anchored at the
   * first occurrence of a query term or query bigram, so citations show the
   * answer slice rather than the chunk head.
   */
  excerptFrom(chunkBody, query, width = 160) {
    const body = String(chunkBody || '').replace(/\s+/g, ' ').trim();
    if (!body) return '';
    const { ngrams, CJK_RE, normalize } = require('./tokenizer');
    // candidate anchor terms: whole query, then each CJK bigram
    const anchors = [];
    const q = normalize(query);
    if (q) anchors.push(q);
    for (const run of q.split(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/).filter(Boolean)) {
      for (const g of ngrams(run, 2)) anchors.push(g);
    }
    let idx = -1;
    for (const a of anchors) {
      const i = body.indexOf(a);
      if (i !== -1) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return body.length > width ? body.slice(0, width) + '…' : body;
    let start = Math.max(0, idx - Math.floor(width / 4));
    let end = Math.min(body.length, start + width);
    if (end === body.length) start = Math.max(0, body.length - width);
    let excerpt = body.slice(start, end);
    if (start > 0) excerpt = '…' + excerpt;
    if (end < body.length) excerpt = excerpt + '…';
    return excerpt;
  }

  /**
   * Answer a query in fully offline mode: retrieval + rules, no LLM.
   */
  answer(query, opts = {}) {
    const domainCfg = getDomain(opts.domain);
    const limit = opts.limit || 3;
    const { chunks } = this.storage.search(query, limit);
    const top = chunks[0] || null;

    let answerText;
    if (!top) {
      answerText = domainCfg.fallback;
    } else {
      const lead = domainCfg.lead;
      const excerpt = this.excerptFrom(top.body, query);
      answerText = `${lead}\n\n${excerpt}\n\n${domainCfg.footer}`.trim();
    }

    return {
      answer: answerText,
      mode: 'offline-retrieval',
      llm: false,
      domain: domainCfg.id,
      confidence: top ? confidenceScore(top, chunks) : 0,
      citations:
        top ? chunks.map((c) => ({
          docId: c.docId,
          document: c.filename,
          paragraph: c.chunkIndex,
          excerpt: this.excerptFrom(c.body, query),
        })) : [],
      top: top
        ? {
            docId: top.docId,
            document: top.filename,
            paragraph: top.chunkIndex,
            excerpt: this.excerptFrom(top.body, query),
          }
        : null,
      query: query,
    };
  }

  /**
   * Answer with optional LLM summarizer. OFF by default; the caller passes a
   * summarizer that turns {query, context, systemPrompt} into text. We keep a
   * mock here for tests.
   */
  async answerWithLlm(query, opts = {}) {
    const domainCfg = getDomain(opts.domain);
    const { chunks } = this.storage.search(query, opts.limit || 5);
    const top = chunks[0] || null;
    const context = chunks.map((c) => c.body).join('\n\n');
    if (!top) {
      return {
        answer: domainCfg.fallback,
        mode: 'llm',
        llm: true,
        domain: domainCfg.id,
        confidence: 0,
        citations: [],
        query,
      };
    }
    const summarizer = opts.summarizer || mockSummarizer;
    const answer = await summarizer({
      query,
      context,
      systemPrompt: domainCfg.systemPrompt,
    });
    return {
      answer,
      mode: 'llm',
      llm: true,
      domain: domainCfg.id,
      confidence: confidenceScore(top, chunks),
      citations: chunks.map((c) => ({
        docId: c.docId,
        document: c.filename,
        paragraph: c.chunkIndex,
        excerpt: this.excerptFrom(c.body, query),
      })),
      query,
    };
  }

  searchRaw(query, limit = 5) {
    return this.storage.search(query, limit);
  }

  // ---------------- logs & settings ----------------
  logQuery(entry) {
    this.storage.logQuery(entry);
  }

  getQueryLogs(limit = 100) {
    return this.storage.listQueryLogs(limit);
  }

  getQueryStats() {
    return this.storage.queryLogStats();
  }

  getSetting(key, dflt) {
    return this.storage.getSetting(key, dflt);
  }

  setSetting(key, value) {
    this.storage.setSetting(key, value);
  }

  engineInfo() {
    return {
      fts: true,
      bm25: true,
      embedding: false,
      llm: false,
      tokenizer: 'bigram-cjk + unicode61',
      storage: this.storage.dbPath,
    };
  }

  /** Set (or replace) the active markdown renderer plugin. */
  setMarkdownLib(lib) {
    this.markdownLib = lib;
  }
}

/** Simple confidence: hinge on the top score vs the score spread. */
function confidenceScore(top, chunks) {
  if (chunks.length === 0) return 0;
  const s1 = Math.abs(top.score || 0);
  if (chunks.length === 1) return Math.min(0.5 + s1, 1);
  const s2 = Math.abs(chunks[1].score || 0);
  const gap = s1 / (s1 + s2 || 1);
  return Math.max(0.05, Math.min(1, 0.4 + gap * 0.55));
}

/** Default LLM summarizer for the OFF-by-default path (mock only). */
async function mockSummarizer({ query, context }) {
  const first = String(context)
    .split(/\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 8);
  return `（模拟 LLM 摘要，未启用真实模型。基于检索结果最相关句子作答）\n\n${first || '未找到相关内容。'}`;
}

module.exports = { KnowledgeBase, mockSummarizer, confidenceScore };
