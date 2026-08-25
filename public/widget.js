/* Nemo AI website chat widget — embed with:
   <script src="https://YOUR_NEMO_GATEWAY/widget.js" data-channel="YOUR_CHANNEL_ID"></script>
   Self-contained, no dependencies. Posts to the widget-webhook and renders the agent reply. */
(function () {
  // capture config synchronously (document.currentScript is null after this tick)
  var script = document.currentScript;
  var channel = script && script.getAttribute('data-channel');
  if (!channel) { console.warn('[Nemo] widget: missing data-channel'); return; }
  var API = 'https://ogfmyjiuqmgroobckdyw.supabase.co/functions/v1/widget-webhook/' + channel;
  var accent = (script.getAttribute('data-accent') || '#8B7CF8');
  var title = (script.getAttribute('data-title') || 'Чат');

  // one session per visitor — degrade to an in-memory id if storage is blocked (Safari
  // "Block All Cookies", private mode, partitioned iframe) so the widget still works.
  var SKEY = 'nemo_widget_session_' + channel;
  var session;
  try {
    session = localStorage.getItem(SKEY);
    if (!session) { session = 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(SKEY, session); }
  } catch (e) { session = 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  function init() {
    if (document.getElementById('nemo-widget-btn')) return; // idempotent
    var css = ''
      + '.nemo-btn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;background:' + accent + ';color:#fff;border:none;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center}'
      + '.nemo-btn svg{width:26px;height:26px}'
      + '.nemo-panel{position:fixed;right:20px;bottom:88px;width:min(360px,calc(100vw - 40px));height:min(520px,calc(100vh - 120px));background:#12162A;color:#E9EBF4;border:1px solid rgba(255,255,255,.1);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font-family:system-ui,Segoe UI,sans-serif}'
      + '.nemo-panel.open{display:flex}'
      + '.nemo-hd{padding:14px 16px;font-weight:600;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between}'
      + '.nemo-hd button{background:none;border:none;color:#9096AE;cursor:pointer;font-size:20px;line-height:1}'
      + '.nemo-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}'
      + '.nemo-m{max-width:82%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}'
      + '.nemo-m.u{align-self:flex-end;background:' + accent + ';color:#fff;border-bottom-right-radius:4px}'
      + '.nemo-m.a{align-self:flex-start;background:rgba(255,255,255,.06);border-bottom-left-radius:4px}'
      + '.nemo-in{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(255,255,255,.08)}'
      + '.nemo-in input{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:9px 12px;color:#E9EBF4;outline:none;font-size:14px}'
      + '.nemo-in button{background:' + accent + ';color:#fff;border:none;border-radius:10px;padding:0 14px;cursor:pointer;font-weight:600}'
      + '.nemo-in button:disabled{opacity:.5}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

    var btn = document.createElement('button');
    btn.className = 'nemo-btn'; btn.id = 'nemo-widget-btn'; btn.setAttribute('aria-label', 'Открыть чат');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5z"/></svg>';

    var panel = document.createElement('div');
    panel.className = 'nemo-panel';
    panel.innerHTML = '<div class="nemo-hd"><span></span><button aria-label="Закрыть">&times;</button></div>'
      + '<div class="nemo-msgs"></div>'
      + '<div class="nemo-in"><input type="text" placeholder="Напишите сообщение..." /><button>&rsaquo;</button></div>';
    panel.querySelector('.nemo-hd span').textContent = title; // safe from HTML injection

    document.body.appendChild(btn); document.body.appendChild(panel);
    var msgs = panel.querySelector('.nemo-msgs');
    var input = panel.querySelector('.nemo-in input');
    var send = panel.querySelector('.nemo-in button');
    var greeted = false, sending = false;

    function add(text, who) {
      var d = document.createElement('div'); d.className = 'nemo-m ' + who; d.textContent = text;
      msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d;
    }
    function toggle() {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) { input.focus(); if (!greeted) { greeted = true; add('Здравствуйте! Чем помочь?', 'a'); } }
    }
    btn.addEventListener('click', toggle);
    panel.querySelector('.nemo-hd button').addEventListener('click', toggle);

    function submit() {
      if (sending) return;
      var text = (input.value || '').trim(); if (!text) return;
      input.value = ''; add(text, 'u');
      sending = true; send.disabled = true;
      var typing = add('…', 'a');
      fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, session_id: session }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { typing.textContent = (j && j.reply) ? j.reply : 'Секунду, оператор скоро подключится.'; })
        .catch(function () { typing.textContent = 'Ошибка связи. Попробуйте ещё раз.'; })
        .finally(function () { sending = false; send.disabled = false; msgs.scrollTop = msgs.scrollHeight; input.focus(); });
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !sending) submit(); });
  }

  // <body> may not exist yet if the tag is in <head> — wait for DOM if needed
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
