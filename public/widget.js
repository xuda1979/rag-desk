/**
 * RAG-Desk embeddable chat float widget.
 *
 * Usage:
 *   <script
 *     src="http://<host>:3000/widget.js"
 *     data-api="http://<host>:3000/api/chat"
 *     data-domain="legal"
 *     data-title="律所在线咨询"
 *     data-greeting="您好，请问有什么可以帮您？"
 *     data-token="<chat token, only if RAGDESK_CHAT_TOKEN is set>"
 *   ></script>
 *
 * The widget renders a floating button bottom-right, opens a chat panel, and
 * posts messages to the data-api endpoint. Fully offline-capable when the
 * host runs RAG-Desk locally. No dependencies.
 */
(function () {
  'use strict';
  if (window.__ragDeskWidget) return;
  window.__ragDeskWidget = true;

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();

  var API = script.getAttribute('data-api') || '/api/chat';
  var DOMAIN = script.getAttribute('data-domain') || 'general';
  var TITLE = script.getAttribute('data-title') || '知识库助手';
  var GREETING = script.getAttribute('data-greeting') || '您好，我是您的知识库助手，请问有什么可以帮您？';
  var TOKEN = script.getAttribute('data-token') || '';

  var css = [
    '#ragdesk-fab{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;',
    'background:#2563eb;color:#fff;border:0;box-shadow:0 4px 14px rgba(0,0,0,.25);',
    'font-size:26px;cursor:pointer;z-index:2147483000;line-height:56px;text-align:center}',
    '#ragdesk-panel{position:fixed;right:20px;bottom:84px;width:340px;max-width:calc(100vw - 40px);',
    'height:440px;max-height:calc(100vh - 120px);background:#fff;border:1px solid #e3e6ea;',
    'border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);display:none;flex-direction:column;',
    'overflow:hidden;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
    'z-index:2147483001;font-size:14px;color:#1f2733}',
    '#ragdesk-panel.open{display:flex}',
    '#ragdesk-head{background:#2563eb;color:#fff;padding:10px 14px;font-weight:600}',
    '#ragdesk-close{float:right;cursor:pointer;border:0;background:none;color:#fff;font-size:16px}',
    '#ragdesk-body{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;background:#fbfcfe}',
    '.rd-msg{max-width:85%;padding:6px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}',
    '.rd-msg.user{align-self:flex-end;background:#2563eb;color:#fff}',
    '.rd-msg.bot{align-self:flex-start;background:#fff;border:1px solid #e3e6ea}',
    '.rd-msg .rd-meta{font-size:10px;color:#8a94a3;margin-top:3px}',
    '.rd-msg .rd-cite{display:block;font-size:10px;color:#2563eb;margin-top:2px}',
    '#ragdesk-inputbar{display:flex;border-top:1px solid #e3e6ea}',
    '#ragdesk-input{flex:1;border:0;padding:10px;outline:none}',
    '#ragdesk-send{border:0;background:#2563eb;color:#fff;padding:0 14px;cursor:pointer}'
  ].join('\n');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var fab = document.createElement('button');
  fab.id = 'ragdesk-fab';
  fab.title = TITLE;
  fab.textContent = '💬';
  document.body.appendChild(fab);

  var panel = document.createElement('div');
  panel.id = 'ragdesk-panel';
  panel.innerHTML =
    '<div id="ragdesk-head">' + esc(TITLE) +
    '<button id="ragdesk-close" aria-label="关闭">×</button></div>' +
    '<div id="ragdesk-body"></div>' +
    '<div id="ragdesk-inputbar"><input id="ragdesk-input" placeholder="请输入问题…"/>' +
    '<button id="ragdesk-send">发送</button></div>';
  document.body.appendChild(panel);

  var body = panel.querySelector('#ragdesk-body');
  var input = panel.querySelector('#ragdesk-input');
  var sendBtn = panel.querySelector('#ragdesk-send');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ask(q) {
    var headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    fetch(API, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ query: q, domain: DOMAIN }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || ('请求失败（HTTP ' + r.status + '）'));
          return data;
        });
      })
      .then(function (data) {
        var ans = esc(data.answer || '（暂无回答）').replace(/\n/g, '<br>');
        var cites = (data.citations || []).slice(0, 2)
          .map(function (c) {
            return '<span class="rd-cite">来源：' + esc(c.document) + ' §' + c.paragraph + '</span>';
          })
          .join('');
        addMsg('bot', ans + '<span class="rd-meta">离线检索 · 置信度 ' +
          Math.round((data.confidence || 0) * 100) + '%</span>' + cites);
      })
      .catch(function (err) {
        addMsg('bot', '请求失败：' + esc(err.message));
      });
  }

  function addMsg(who, html) {
    var m = document.createElement('div');
    m.className = 'rd-msg ' + who;
    m.innerHTML = html;
    body.appendChild(m);
    body.scrollTop = body.scrollHeight;
  }

  fab.addEventListener('click', function () {
    var open = panel.classList.toggle('open');
    if (open && body.children.length === 0) addMsg('bot', esc(GREETING));
  });
  panel.querySelector('#ragdesk-close').addEventListener('click', function () {
    panel.classList.remove('open');
  });
  function submit() {
    var q = input.value.trim();
    if (!q) return;
    addMsg('user', esc(q));
    input.value = '';
    ask(q);
  }
  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submit();
  });
})();
