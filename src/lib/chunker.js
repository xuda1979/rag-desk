'use strict';

/**
 * Knowledge chunking with overlapping windows and paragraph-aware splits.
 *
 * Strategy:
 *  - Split the raw text into "paragraphs" (double newlines separate; if the
 *    doc has no blank lines, fall back to whole-text windows).
 *  - Oversized paragraphs (longer than `window`) are split into overlapping
 *    chunks with `overlap` characters of context carried over.
 *  - Small paragraphs are packed together up to `window` size so chunks
 *    remain context-rich instead of tiny.
 *
 * @param {string} text
 * @param {{window?: number, overlap?: number}} [opts]
 * @returns {Array<{index:number, text:string}>}
 */
function chunkText(text, opts = {}) {
  const window = opts.window || 400;
  const overlap = Math.min(opts.overlap ?? 40, window - 1);
  const src = String(text == null ? '' : text).trim();
  if (!src) return [];

  const chunks = [];

  // Split an over-long run, carrying `overlap` chars between windows.
  const emitRun = (run) => {
    let rest = run;
    while (rest.length > window) {
      let cut = window;
      // prefer cutting near a sentence boundary inside the first window
      const breaks = rest.slice(0, window).search(/[。！？!?；;]/);
      if (breaks !== -1 && breaks > window * 0.5) cut = breaks + 1;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut - overlap);
    }
    const tail = rest.trim();
    if (tail) chunks.push(tail);
  };

  // Split text into paragraph-ish units, then pack/oversize each.
  // Splitting on single newlines keeps markdown QA blocks and numbered list
  // items as distinct paragraphs; the pack-down step re-groups related lines.
  const paras = src
    .split(/\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paras.length === 1 && paras[0].length === src.length && !src.includes('\n')) {
    // no paragraph breaks at all -> treat whole text as one run
    emitRun(src);
    return chunks.map((c, i) => ({ index: i + 1, text: c }));
  }

  let buf = '';
  for (const p of paras) {
    if (p.length > window) {
      if (buf) {
        chunks.push(buf.trim());
        buf = '';
      }
      emitRun(p);
    } else if (buf && buf.length + p.length + 1 > window) {
      chunks.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  return chunks
    .filter((c) => c.length > 0)
    .map((c, i) => ({ index: i + 1, text: c }));
}

module.exports = { chunkText };
