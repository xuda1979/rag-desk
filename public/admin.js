(function () {
  'use strict';

  const docsBody = document.getElementById('docs-body');
  const logsBody = document.getElementById('logs-body');
  const statsEl = document.getElementById('stats');
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');
  const uploadResult = document.getElementById('upload-result');
  const chunksCard = document.getElementById('chunks-card');
  const chunksDoc = document.getElementById('chunks-doc');
  const chunksBody = document.getElementById('chunks-body');

  // Token gate (optional): when the server requires RAGDESK_ADMIN_TOKEN we ask
  // once and add it as header on every admin request.
  const TOKEN_KEY = 'ragdesk-admin-token';
  let token = localStorage.getItem(TOKEN_KEY) || '';

  async function adminFetch(url, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    if (token) headers['x-admin-token'] = token;
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      token = (prompt('该后台需要访问令牌（RAGDESK_ADMIN_TOKEN），请输入：') || '').trim();
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        return adminFetch(url, opts); // retry once with the new token
      }
      localStorage.removeItem(TOKEN_KEY);
    }
    return res;
  }

  async function loadStats() {
    const res = await adminFetch('/api/admin/stats');
    if (!res.ok) return;
    const data = await res.json();
    const s = data.stats || { total: 0, with_answer: 0 };
    const hit = s.total > 0 ? Math.round((s.with_answer / s.total) * 100) + '%' : '-';
    statsEl.innerHTML +=
      `<div class="stat"><b>${s.total}</b><span>总查询</span></div>` +
      `<div class="stat"><b>${s.with_answer}</b><span>有回答命中</span></div>` +
      `<div class="stat"><b>${hit}</b><span>命中率</span></div>`;
  }

  async function loadDocs() {
    const res = await adminFetch('/api/admin/docs');
    const data = await res.json();
    statsEl.innerHTML =
      `<div class="stat"><b>${data.docs.length}</b><span>文档</span></div>` +
      `<div class="stat"><b>${data.docs.reduce((s, d) => s + (d.chunk_count || 0), 0)}</b><span>分块</span></div>`;
    loadStats();
    docsBody.innerHTML = '';
    for (const d of data.docs) {
      const tr = document.createElement('tr');
      const size = (d.size / 1024).toFixed(1) + ' KB';
      tr.innerHTML =
        `<td>${d.id}</td><td>${esc(d.filename)}</td><td>${d.kind}</td>` +
        `<td>${d.chunk_count}</td><td>${size}</td><td>${esc(d.created_at || '')}</td>` +
        `<td><button class="ghost" data-action="view" data-id="${d.id}">查看分块</button></td>` +
        `<td><button class="danger" data-action="delete" data-id="${d.id}">删除</button></td>`;
      tr.querySelector('[data-action="view"]').addEventListener('click', () => viewChunks(d.id, d.filename));
      tr.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!confirm(`删除文档「${d.filename}」及其分块？`)) return;
        await adminFetch('/api/admin/docs/' + d.id, { method: 'DELETE' });
        loadDocs();
      });
      docsBody.appendChild(tr);
    }
  }

  async function viewChunks(id, filename) {
    chunksBody.innerHTML = '<div class="dim small">加载中…</div>';
    chunksCard.hidden = false;
    chunksDoc.textContent = filename ? `#${id} · ${filename}` : `#${id}`;
    const res = await adminFetch('/api/admin/docs/' + id);
    if (!res.ok) {
      chunksBody.innerHTML = '<div class="dim small">加载失败：HTTP ' + res.status + '</div>';
      return;
    }
    const data = await res.json();
    const chunks = data.chunks || [];
    if (!chunks.length) {
      chunksBody.innerHTML = '<div class="dim small">该文档暂无分块。</div>';
      return;
    }
    chunksBody.innerHTML = '';
    for (const c of chunks) {
      const div = document.createElement('div');
      div.className = 'chunk';
      div.innerHTML =
        `<span class="chunk-meta">#${c.chunk_idx} · ${c.body.length} 字</span>` + esc(c.body);
      chunksBody.appendChild(div);
    }
  }

  async function loadLogs() {
    const res = await adminFetch('/api/admin/logs?limit=50');
    const data = await res.json();
    logsBody.innerHTML = '';
    const rows = data.logs || [];
    if (rows.length === 0) {
      logsBody.innerHTML = '<tr><td colspan="6" class="dim">暂无查询记录</td></tr>';
      return;
    }
    for (const l of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${esc(l.created_at || '')}</td><td>${esc(l.query)}</td>` +
        `<td>${l.domain || '-'}</td><td>${l.matched || 0}</td>` +
        `<td>${l.top_score == null ? '-' : (l.top_score * 100).toFixed(0) + '%'}</td>` +
        `<td>${esc(l.top_filename || '-')}</td>`;
      logsBody.appendChild(tr);
    }
  }

  async function upload() {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    uploadBtn.disabled = true;
    uploadResult.textContent = '上传中…';
    try {
      const res = await adminFetch('/api/admin/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        uploadResult.textContent = `上传失败（HTTP ${res.status}）：${(data && data.error) || '服务器未返回错误详情'}`;
        return;
      }
      uploadResult.textContent = (data.results || [])
        .map((r) => `${r.filename}: ${r.action === 'indexed' ? `已索引（${r.chunks} 分块）` : r.action}`)
        .join('；');
      loadDocs();
    } catch (e) {
      uploadResult.textContent = '上传失败：' + e.message;
    }
    uploadBtn.disabled = false;
    fileInput.value = '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  uploadBtn.addEventListener('click', upload);
  loadDocs();
  loadLogs();
})();
