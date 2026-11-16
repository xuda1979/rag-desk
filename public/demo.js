(function () {
  'use strict';

  const chatEl = document.getElementById('chat');
  const form = document.getElementById('ask-form');
  const input = document.getElementById('ask-input');
  const domainSelect = document.getElementById('domain-select');
  const greetingEl = document.getElementById('greeting');
  const examplesEl = document.getElementById('examples');

  const GREETINGS = {
    legal: '您好，我是律所智能问答助手。您可以询问合同、诉讼流程、收费标准等问题。',
    medical: '您好，我是诊所在线导诊助手。可以询问挂号、科室、体检等问题。',
    procurement: '您好，这里是招投标信息助手。可以查询公告要点、投标要求、截止时间。',
    general: '您好，这是您专属的知识库问答助手。',
  };
  const EXAMPLES = {
    legal: ['律师咨询费怎么收取？', '劳动仲裁的流程是什么？', '合同纠纷可以起诉吗？'],
    medical: ['挂号需要带什么？', '儿童接种疫苗时间？', '可以刷医保卡吗？'],
    procurement: ['这个项目什么时候截止投标？', '中标人是谁？', '项目预算金额是多少？'],
    general: ['介绍一下你们的知识库'],
  };

  function renderExamples() {
    examplesEl.innerHTML = '';
    (EXAMPLES[domainSelect.value] || []).forEach((q) => {
      const b = document.createElement('button');
      b.textContent = q;
      b.addEventListener('click', () => {
        input.value = q;
        form.requestSubmit();
      });
      examplesEl.appendChild(b);
    });
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

  domainSelect.addEventListener('change', () => {
    greetingEl.textContent = GREETINGS[domainSelect.value] || '';
    renderExamples();
  });
  renderExamples();
  greetingEl.textContent = GREETINGS[domainSelect.value];
})();
