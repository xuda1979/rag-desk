(function () {
  'use strict';

  const chatEl = document.getElementById('chat');
  const form = document.getElementById('ask-form');
  const input = document.getElementById('ask-input');
  const domainSelect = document.getElementById('domain-select');
  const greetingEl = document.getElementById('greeting');
  const examplesEl = document.getElementById('examples');

  // In-page fallback so the demo still works if /api/domains is unreachable.
  const FALLBACK = {
    legal: {
      label: '法律 · 律师事务所',
      greeting: '您好，我是律所智能问答助手。您可以询问合同、诉讼流程、收费标准等问题。',
      examples: ['律师咨询费怎么收取？', '劳动仲裁的流程是什么？', '合同纠纷可以起诉吗？'],
    },
    medical: {
      label: '医疗 · 诊所',
      greeting: '您好，我是诊所在线导诊助手。可以询问挂号、科室、体检等问题。',
      examples: ['挂号需要带什么？', '儿童接种疫苗时间？', '可以刷医保卡吗？'],
    },
    procurement: {
      label: '招采 · 中标公告',
      greeting: '您好，这里是招投标信息助手。可以查询公告要点、投标要求、截止时间。',
      examples: ['这个项目什么时候截止投标？', '中标人是谁？', '项目预算金额是多少？'],
    },
    general: {
      label: '通用',
      greeting: '您好，这是您专属的知识库问答助手。',
      examples: [],
    },
  };

  // Populated from /api/domains so custom domains added to src/lib/domains.js
  // appear automatically (user manual 4.2); falls back to FALLBACK when the
  // endpoint is unreachable.
  let domains = FALLBACK;

  function fillSelect(list) {
    const prev = domainSelect.value;
    domainSelect.innerHTML = '';
    for (const d of list) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      domainSelect.appendChild(opt);
    }
    domainSelect.value = domains[prev] ? prev : (list[0] || {}).id;
  }

  function renderFor(active) {
    const d = domains[active] || {};
    greetingEl.textContent = d.greeting || '';
    renderExamples();
  }

  function renderExamples() {
    examplesEl.innerHTML = '';
    const d = domains[domainSelect.value] || {};
    for (const q of d.examples || []) {
      const b = document.createElement('button');
      b.textContent = q;
      b.addEventListener('click', () => {
        input.value = q;
        form.requestSubmit();
      });
      examplesEl.appendChild(b);
    }
  }

  function addMsg(role, html) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = html;
    chatEl.appendChild(el);
    chatEl.scrollTop = chatEl.scrollHeight;
    return el;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function renderBotMessage(data) {
    const answer = esc(data.answer).replace(/\n/g, '<br>');
    const cites = (data.citations || [])
      .map((c) => {
        const ex = esc(c.excerpt || '').slice(0, 160);
        return `<span class="bot-cite"><span class="cite-doc">${esc(c.document)}</span> §${c.paragraph}：${ex}</span>`;
      })
      .join('');
    const conf = data.top ? `可置信度 ${Math.round((data.confidence || 0) * 100)}%` : '';
    return `${answer}<div class="bot-meta">${conf} · 模式：${
      data.mode === 'offline-retrieval' ? '离线检索' : '检索+LLM'
    }</div>${cites}`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    addMsg('user', esc(q));
    input.value = '';
    const thinking = addMsg('bot', '正在检索知识库…');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, domain: domainSelect.value }),
      });
      const data = await res.json();
      thinking.innerHTML = renderBotMessage(data);
    } catch (err) {
      thinking.innerHTML = `检索失败：${esc(err.message)}`;
    }
    chatEl.scrollTop = chatEl.scrollHeight;
  });

  domainSelect.addEventListener('change', () => renderFor(domainSelect.value));
  renderFor(domainSelect.value);

  // Auto-sync the domain list and presets from the server.
  fetch('/api/domains')
    .then((r) => r.json())
    .then((data) => {
      if (!Array.isArray(data.domains) || !data.domains.length) return;
      const map = {};
      for (const d of data.domains) {
        map[d.id] = { greeting: d.greeting, examples: d.examples || [] };
      }
      domains = map;
      fillSelect(data.domains);
      renderFor(domainSelect.value);
    })
    .catch(() => {});
})();
