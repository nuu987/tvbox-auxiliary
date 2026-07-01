// Shared JS utilities embedded into page <script> tags
export const sharedUi = `
const $ = id => document.getElementById(id);

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escAttr(s) {
  return esc(s).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

function toast(msg, type) {
  type = type || 'success';
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 300); }, 2500);
}

function initAuth(tokenInputId, errorId, overlayId, contentId, verifyUrl, onSuccess) {
  let token = '';
  const tokenInput = $(tokenInputId);
  const overlay = $(overlayId);
  const content = $(contentId);
  const errorEl = $(errorId);

  function getToken() { return token; }

  function authFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'Authorization': 'Bearer ' + token });
    return fetch(url, opts);
  }

  function doLogin() {
    token = tokenInput.value.trim();
    if (!token) return;
    fetch(verifyUrl, {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => {
      if (r.ok) {
        overlay.style.display = 'none';
        content.style.display = 'block';
        sessionStorage.setItem('admin_token', token);
        onSuccess();
      } else {
        errorEl.style.display = 'block';
        tokenInput.value = '';
        tokenInput.focus();
      }
    }).catch(() => {
      errorEl.style.display = 'block';
    });
  }

  tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // Auto-login from session
  const saved = sessionStorage.getItem('admin_token');
  if (saved) {
    token = saved;
    fetch(verifyUrl, {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => {
      if (r.ok) {
        overlay.style.display = 'none';
        content.style.display = 'block';
        onSuccess();
      }
    });
  }

  return { doLogin, authFetch, getToken };
}

function toggleCollapsible(toggleEl) {
  toggleEl.classList.toggle('open');
  const body = toggleEl.nextElementSibling;
  if (body) body.classList.toggle('open');
}

function getTheme() {
  return localStorage.getItem('theme') || 'dark';
}

var THEMES = [
  { id: 'dark',  icon: '\\uD83C\\uDF19', label: 'Dark',  dot: '#0a0e14' },
  { id: 'light', icon: '\\u2600\\uFE0F', label: 'Light', dot: '#f4f6f9' }
];

function findTheme(id) {
  for (var i = 0; i < THEMES.length; i++) { if (THEMES[i].id === id) return THEMES[i]; }
  return THEMES[0];
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = findTheme(theme).icon;
}

function toggleTheme() {
  var next = getTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

// Phase 6 VIEWER-03 (Plan 03): streamSse — 浏览器侧 SSE 帧解析（fetch + getReader）。
// D-11: 不用 EventSource（无法设 Authorization 头），用 fetch + ReadableStream 手动解析帧。
// Pitfall 2: TextDecoder.decode(value, {stream:true}) 处理跨 chunk 的多字节 UTF-8（防中文乱码）。
// 按 WHATWG HTML §9.2 SSE wire format 切帧：以 '\\n\\n' 分隔帧，每帧按行解析 'field: value'。
// 返回 { abort } handle 供调用方主动断开（abort 后的 AbortError 不触发 onError）。
function streamSse(url, token, onMessage, onOpen, onError) {
  var controller = new AbortController();
  var decoder = new TextDecoder();
  var buf = '';

  (async function() {
    try {
      var res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        signal: controller.signal,
      });
      if (!res.ok) {
        onError(new Error('HTTP ' + res.status));
        return;
      }
      if (onOpen) onOpen();
      var reader = res.body.getReader();
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        // {stream:true} 处理跨 chunk 的多字节 UTF-8 字符（Pitfall 2，防中文乱码）
        buf += decoder.decode(r.value, { stream: true });
        // 按 '\\n\\n' 切完整帧，半帧留 buf（per WHATWG HTML §9.2）
        var idx;
        while ((idx = buf.indexOf('\\n\\n')) >= 0) {
          var frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // 解析帧：每行 'field: value'，跳过 ':' 注释行（heartbeat），合并多行 data
          var dataLines = [];
          var lines = frame.split('\\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.charAt(0) === ':') continue; // 注释/heartbeat 帧，忽略
            var colonIdx = line.indexOf(':');
            if (colonIdx < 0) continue;
            var field = line.slice(0, colonIdx);
            var val = line.slice(colonIdx + 1);
            if (val.charAt(0) === ' ') val = val.slice(1); // spec: 冒号后可选空格
            if (field === 'data') dataLines.push(val);
            // event/id/retry 字段本方案不用（D-13 统一 data JSON），忽略
          }
          if (dataLines.length > 0) {
            onMessage(dataLines.join('\\n'));
          }
        }
      }
      // 流正常结束（服务器关闭）——视为断开，触发重连
      onError(new Error('stream ended'));
    } catch (e) {
      // 主动 abort（AbortError）不触发 onError，避免断开时误触发重连
      if (e && e.name === 'AbortError') return;
      onError(e);
    }
  })();

  return { abort: function() { controller.abort(); } };
}

`;
