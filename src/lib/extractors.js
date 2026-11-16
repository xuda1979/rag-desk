'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Parse CSV (RFC-4180-ish, handles embedded quotes/newlines) into rows. */
function parseCsv(text) {
  let src = String(text == null ? '' : text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const commitField = () => {
    row.push(field);
    field = '';
  };
  const commitRow = () => {
    commitField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      commitField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      commitRow();
    } else {
      field += ch;
    }
  }
  if (field || row.length) commitRow();
  return rows;
}

/** DOCX: unzip via fflate, concatenate the <w:t> text node values. */
function extractDocx(buffer) {
  const { unzipSync, strFromU8 } = require('fflate');
  const files = unzipSync(new Uint8Array(buffer));
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('DOCX: missing word/document.xml');
  const doc = strFromU8(xml);
  const parts = [];
  const tagRe = /<w:p[ >]/g;
  // split into paragraphs then pull out <w:t> run texts
  doc.split(/<\/w:p>/).forEach((para) => {
    const texts = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(para)) !== null) texts.push(m[1]);
    if (texts.length) parts.push(texts.join('').trim());
  });
  return parts.join('\n');
}

/** PDF via pdf-parse, stripping trailing page-marker lines. */
async function extractPdf(buffer) {
  const { stripPageMarkers } = require('./tokenizer');
  const PDFParse = require('pdf-parse').PDFParse;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const out = await parser.getText();
  let text = Array.isArray(out) ? out.join('') : out.text || '';
  text = text.replace(/[\u0000\uFFFD]+/g, ' '); // strip glyph holes
  return stripPageMarkers(text);
}

/** Extract plain text from any format we know, by extension. */
function textFromBuffer(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.txt':
      return buffer.toString('utf8');
    case '.csv':
      return parseCsv(buffer.toString('utf8'))
        .map((r) => r.join('\t'))
        .join('\n');
    default:
      return null;
  }
}

/** Detect a file's kind from its extension. */
function fileKind(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.pdf':
      return 'pdf';
    case '.docx':
      return 'docx';
    case '.csv':
      return 'csv';
    case '.txt':
      return 'text';
    default:
      return null;
  }
}

/** True when the file shows a supported extension. */
function isSupportedFile(filename) {
  return fileKind(filename) !== null;
}

module.exports = { parseCsv, extractDocx, extractPdf, textFromBuffer, fileKind, isSupportedFile };
