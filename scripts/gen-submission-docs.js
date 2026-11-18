'use strict';
// Deterministic regenerator for the 软件著作权申请 submission docs.
//
// Computes per-file line counts from the current src/ files under the exact
// methodology of the submitted docs (total = wc -l + 1 counting the final
// newline; effective drops blank lines and lines starting with //, /*, *)
// and rewrites the count-bearing regions:
//   源代码.txt         header count table + 25-page paginated body + tail
//   软件著作权登记表.txt  per-file counts rows + totals lines
//   设计说明书.txt      per-module effective counts in the 3.x headings
//
// Everything else in the register/design docs (prose, layout around the
// touched lines) is preserved byte-for-byte. The 源代码.txt body is rebuilt
// from the current source stream so it tracks the code exactly.
//
// CLI arm writes the three docs and logs a summary. module.exports exposes
// the pieces for test/production.test.js to pin the committed docs to this
// generator / to the source.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUB = path.join(ROOT, '20-rag-desk-软件著作权申请');

const SUBMISSION = {
  '源代码.txt': '源代码.txt',
  '软件著作权登记表.txt': '软件著作权登记表.txt',
  '设计说明书.txt': '设计说明书.txt',
};

const FILES = [
  { rel: 'src/lib/chunker.js', desc: '分块引擎（段落感知 + 重叠窗口）' },
  { rel: 'src/lib/tokenizer.js', desc: '中文二元切词 + FTS5 查询构造' },
  { rel: 'src/lib/storage.js', desc: 'SQLite FTS5 存储层' },
  { rel: 'src/lib/extractors.js', desc: '文档解析（MD/TXT/CSV/DOCX/PDF）' },
  { rel: 'src/lib/domains.js', desc: '领域预设模板包' },
  { rel: 'src/lib/knowledge.js', desc: '摄入、检索、答案组装（离线核心）' },
  { rel: 'src/app.js', desc: 'Express 路由（API + 页面 + 错误）' },
  { rel: 'src/server.js', desc: '服务启动、端口、首次种子' },
];

const isEffective = (l) =>
  !/^\s*$/.test(l) && !/^\s*\/\//.test(l) && !/^\s*\/\*/.test(l) && !/^\s*\*/.test(l);

// Methodology identical to the submitted docs:
//   total     = newline-terminated lines (wc -l + 1): split('\n').length
//   effective = lines that are neither blank nor comment-only
const countLines = (txt) => {
  const lines = txt.split('\n');
  return {
    total: lines.length,
    effective: lines.filter(isEffective).length,
  };
};

const computeCounts = () => {
  const rows = FILES.map((f, i) => {
    const txt = fs.readFileSync(path.join(ROOT, f.rel), 'utf8');
    const { total, effective } = countLines(txt);
    return { ...f, idx: i + 1, total, effective, body: txt };
  });
  const grand = rows.reduce((s, r) => s + r.total, 0);
  const grandEff = rows.reduce((s, r) => s + r.effective, 0);
  // Body stream = one marker line + the file's content lines per file.
  const streamLines = rows.reduce((s, r) => s + 1 + r.total, 0);
  return { rows, grand, grandEff, pages: Math.ceil(streamLines / 50), streamLines };
};

// ---- 源代码.txt -------------------------------------------------------------
const BANNER_96 = '='.repeat(96);
const PAGE_DASH = '─'.repeat(96);

const composeRow = (f) =>
  `  ${String(f.idx).padStart(2, '0')}. ${f.rel}`.padEnd(35) +
  `共  ${String(f.total).padStart(3)} 行 / 有效 ${String(f.effective).padStart(3)} 行`;

const srcHeader = (c) =>
  [
    BANNER_96,
    '                        源  程  序  说  明  与  目  录',
    BANNER_96,
    '',
    '软件名称：RAG-Desk 垂直行业知识库问答系统',
    '版本号  ：V1.0',
    '编程语言：JavaScript（Node.js CommonJS）',
    '著作权人：许达（中国移动研究院）',
    '',
    '一、排版约定',
    '  1. 页面：A4 纵向；',
    '  2. 页眉：每页页眉左侧标注「RAG-Desk 垂直行业知识库问答系统 V1.0」；',
    '  3. 正文：宋体五号字，每页正文固定 50 行；',
    '  4. 页脚：每页页脚居中标示页码（第 N 页 / 共 M 页）；',
    `  5. 本程序共 ${c.pages} 页。`,
    '',
    '二、源程序总体行数',
    `  8 个源文件共 ${c.grand} 行（含注释），去除注释与空行后的有效代码行数为 ${c.grandEff} 行，`,
    '  该行数与《软件著作权登记表》所填「源程序总行数」口径一致。',
    '',
    '三、程序文件组成',
    ...c.rows.map(composeRow),
    '',
    '四、正文',
    '  （以下为真实源程序全文，从第 1 页起连续编排，每页 50 行。）',
    '',
    BANNER_96,
    '',
  ].join('\n');

// Flat stream: marker line + content lines per file, in FILES order.
const bodyStream = (c) => {
  const stream = [];
  for (const r of c.rows) {
    stream.push(`// ~~~~~~~~ 文件：${r.rel} ~~~~~~~~`);
    const contentLines = r.body.replace(/\n$/, '').split('\n');
    for (const l of contentLines) stream.push(l);
  }
  return stream;
};

// Paginate the stream into c.pages pages of exactly 50 body lines each,
// wrapped in per-page scaffold: banner/title/banner before, banner+footer+blank
// after. Pages are adjacent: page N's trailing blank is immediately followed
// by page N+1's banner.
const srcBodyPages = (c) => {
  const stream = bodyStream(c);
  const pad = c.pages * 50 - stream.length;
  if (pad < 0) throw new Error(`stream longer than ${c.pages} pages`);
  const filled = stream.concat(Array(pad).fill(''));
  const out = [];
  for (let p = 0; p < c.pages; p++) {
    out.push(PAGE_DASH);
    out.push('RAG-Desk 垂直行业知识库问答系统 V1.0');
    out.push(PAGE_DASH);
    for (let i = p * 50; i < (p + 1) * 50; i++) out.push(filled[i]);
    out.push(PAGE_DASH);
    out.push(
      `                          第 ${String(p + 1).padStart(3, '0')} 页 / 共 ${String(c.pages).padStart(3, '0')} 页`
    );
    out.push('');
  }
  return out.join('\n') + '\n';
};

const buildSourceCodeDoc = (c) =>
  srcHeader(c) + '\n' + srcBodyPages(c) + '\n（源代码全文完）\n';

// ---- 软件著作权登记表.txt -----------------------------------------------------
// Surgical patch: only the counts rows (lines 37, 85-92) and the totals line
// (93) are rewritten; prose and layout are untouched.
const patchRegister = (c, docText) => {
  const lines = docText.split('\n');
  lines[36] = lines[36].replace(/\d+ 行/, `${c.grandEff} 行`);
  for (const r of c.rows) {
    const i = 84 + r.idx - 1;
    lines[i] = lines[i].replace(
      /共 \d+ 行 \/ 有效 \d+ 行$/,
      `共 ${r.total} 行 / 有效 ${r.effective} 行`
    );
  }
  lines[92] = lines[92].replace(
    /共 \d+ 行（含注释）.*?(\d+) 行。/,
    `共 ${c.grand} 行（含注释），有效代码行数 ${c.grandEff} 行。`
  );
  return lines.join('\n');
};

// ---- 设计说明书.txt ----------------------------------------------------------
// Surgical: only the per-module effective counts inside the 3.x headings.
const patchDesign = (c, docText) => {
  const lines = docText.split('\n');
  let touched = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('有效 ') || !lines[i].includes(' 行）')) continue;
    const f = c.rows.find((r) => lines[i].includes(r.rel));
    if (!f) continue;
    lines[i] = lines[i].replace(/，有效 \d+ 行）/, `，有效 ${f.effective} 行）`);
    touched++;
  }
  if (touched !== c.rows.length) {
    throw new Error(`设计说明书.txt: expected ${c.rows.length} module headings, patched ${touched}`);
  }
  return lines.join('\n');
};

// ---- CLI / exports -----------------------------------------------------------
const run = () => {
  const c = computeCounts();
  fs.writeFileSync(path.join(SUB, SUBMISSION['源代码.txt']), buildSourceCodeDoc(c));
  fs.writeFileSync(
    path.join(SUB, SUBMISSION['软件著作权登记表.txt']),
    patchRegister(c, fs.readFileSync(path.join(SUB, SUBMISSION['软件著作权登记表.txt']), 'utf8'))
  );
  fs.writeFileSync(
    path.join(SUB, SUBMISSION['设计说明书.txt']),
    patchDesign(c, fs.readFileSync(path.join(SUB, SUBMISSION['设计说明书.txt']), 'utf8'))
  );
  return c;
};

if (require.main === module) {
  const c = run();
  console.log(
    `submission docs regenerated (${c.grand} lines / ${c.grandEff} effective, ${c.pages} pages)`
  );
}

module.exports = { FILES, computeCounts, buildSourceCodeDoc, patchRegister, patchDesign, srcBodyPages, countLines, run };
