'use strict';

/**
 * Chinese-friendly FTS5 tokenization utilities.
 *
 * SQLite FTS5 does not segment Chinese text out of the box. We use a
 * "unicode61 + separators" scheme: characters are split on punctuation,
 * whitespace and Latin/CJK boundary crossings, while runs of Han characters
 * are additionally n-grammed so short queries (2~3 chars) still hit the
 * index. Benign ascii words (english / numbers / urls) are kept whole.
 */

// Ranges (code points) of CJK characters we n-gram.
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

// Characters treated as delimiters (punctuation / symbols / control).
const DELIM_RE = /[\s\p{P}\p{S}\p{C}]+/u;

/** Normalize text for FTS: lowercase latin, trim, collapse whitespace. */
function normalize(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Split text into tokens, classifying each run as 'cjk' (Han) or 'other'.
 * Punctuation and whitespace break tokens and are dropped.
 */
function tokenize(text) {
  const t = String(text == null ? '' : text);
  const out = [];
  let buf = '';
  let bufIsCJK = null;

  const flush = () => {
    if (buf) out.push({ kind: bufIsCJK ? 'cjk' : 'other', token: buf });
    buf = '';
    bufIsCJK = null;
  };

  for (const ch of t) {
    if (DELIM_RE.test(ch)) {
      flush();
      continue;
    }
    const isCJK = CJK_RE.test(ch);
    if (bufIsCJK === null) bufIsCJK = isCJK;
    else if (isCJK !== bufIsCJK) {
      flush();
      bufIsCJK = isCJK;
    }
    buf += ch;
  }
  flush();
  return out;
}

/** Tokenize a CJK run into overlapping n-grams (default bigrams). */
function ngrams(cjkRun, n = 2) {
  const out = [];
  if (cjkRun.length < n) {
    out.push(cjkRun);
    return out;
  }
  for (let i = 0; i <= cjkRun.length - n; i++) out.push(cjkRun.slice(i, i + n));
  return out;
}

/**
 * Produce an FTS5 MATCH query.
 *
 * A pure-Chinese run becomes an OR-group of its bigrams, e.g.
 *   律师咨询费怎么收取  ->  ("律师" OR "师咨" OR "咨询" OR "询费" OR
 *                          "费怎" OR "怎么" OR "么收" OR "收取")
 * so a chunk that shares even a few bigrams is retrieved and BM25 ranks by
 * overlap. Latin/number runs keep AND semantics ("400" "123" "4567").
 *
 * Returns '' when no usable terms (caller falls back to a LIKE scan).
 */
function toQuery(text) {
  const groups = [];
  for (const { kind, token } of tokenize(normalize(text))) {
    if (kind === 'cjk') {
      if (token.length === 1) groups.push(`"${token}"`);
      else groups.push(`(${ngrams(token, 2).map((g) => `"${g}"`).join(' OR ')})`);
    } else {
      groups.push(`"${token}"`);
    }
  }
  return groups.join(' ');
}

/** Build the expansion list for indexing a chunk. */
function expandForIndex(text) {
  return tokenize(text).flatMap(({ kind, token }) =>
    kind === 'cjk' ? ngrams(token, 2) : [normalize(token)]
  );
}

/** Strip the trailing "-- N of M --" page markers pdf-parse appends. */
function stripPageMarkers(text) {
  return String(text).replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim();
}

module.exports = {
  normalize,
  toQuery,
  ngrams,
  expandForIndex,
  stripPageMarkers,
  CJK_RE,
};
