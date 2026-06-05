import { sharedStyles } from './shared-styles';
import { sharedUi } from './shared-ui';

export const configEditorHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TVBox Auxiliary - Config Editor</title>
<style>
${sharedStyles}

/* Config Editor specific */

/* Item row */
.item{
  display:flex;
  align-items:center;
  gap:10px;
  padding:10px 16px;
  border-bottom:1px solid var(--border);
  transition:background 0.15s;
  font-family:var(--mono);
  font-size:0.75rem;
}

.item[data-id]{cursor:pointer}
.item:last-child{border-bottom:none}
.item:hover{background:var(--surface-2)}

.item.blocked{opacity:0.4}

.item-name{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  color:var(--text-bright);
  font-weight:500;
}

.item.blocked .item-name{
  text-decoration:line-through;
  color:var(--text-dim);
}

.item-type{
  position:relative;
  font-size:0.6rem;
  padding:2px 8px;
  border-radius:4px;
  font-weight:600;
  letter-spacing:0.05em;
  text-transform:uppercase;
  cursor:help;
  white-space:nowrap;
}

.item-type.t0{background:var(--blue-dim);color:var(--blue)}
.item-type.t1{background:var(--green-dim);color:var(--green)}
.item-type.t3{background:var(--amber-dim);color:var(--amber)}
.item-type.t4{background:var(--red-dim);color:var(--red)}
.item-type.terr{background:var(--red-dim);color:var(--red);border:1px solid var(--red)}

/* Tooltip */
.tooltip{
  position:absolute;
  bottom:calc(100% + 8px);
  left:50%;
  transform:translateX(-50%);
  background:var(--surface);
  border:1px solid var(--border-glow);
  border-radius:6px;
  padding:8px 12px;
  font-family:var(--sans);
  font-size:0.75rem;
  font-weight:400;
  color:var(--text);
  white-space:nowrap;
  pointer-events:none;
  opacity:0;
  transition:opacity 0.15s;
  z-index:100;
  text-transform:none;
  letter-spacing:0;
  box-shadow:0 4px 12px rgba(0,0,0,0.3);
}

.tooltip::after{
  content:'';
  position:absolute;
  top:100%;
  left:50%;
  transform:translateX(-50%);
  border:5px solid transparent;
  border-top-color:var(--border-glow);
}

.item-type:hover .tooltip{opacity:1}

.item-api{
  max-width:200px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  color:var(--text-dim);
  font-size:0.65rem;
  cursor:default;
}

.item-actions{
  display:flex;
  gap:6px;
  flex-shrink:0;
  cursor:default;
}

/* Flat list (for parses / lives) */
.flat-list{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:8px;
  overflow:visible;
}

/* Stats bar */
.stats{
  display:flex;
  gap:16px;
  margin-bottom:20px;
  font-family:var(--mono);
  font-size:0.7rem;
  color:var(--text-dim);
}

.stats .stat{
  display:flex;
  align-items:center;
  gap:4px;
}

.stats .num{
  color:var(--green);
  font-weight:600;
}

.stats .blocked-num{
  color:var(--red);
  font-weight:600;
}

/* Loading */
.loading-msg{
  text-align:center;
  padding:60px 20px;
  font-family:var(--mono);
  font-size:0.8rem;
  color:var(--text-dim);
}

/* Checkbox */
.item-check{
  width:14px;
  height:14px;
  accent-color:var(--green);
  cursor:pointer;
  flex-shrink:0;
}

.item-label{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}

/* Batch bar */
.batch-bar{
  position:fixed;
  bottom:24px;
  left:50%;
  transform:translateX(-50%);
  background:var(--surface);
  border:1px solid var(--green-dim);
  border-radius:8px;
  padding:10px 20px;
  display:flex;
  align-items:center;
  gap:12px;
  font-family:var(--mono);
  font-size:0.75rem;
  color:var(--text);
  box-shadow:0 4px 16px rgba(0,0,0,0.4);
  z-index:50;
}
.batch-count{color:var(--green);font-weight:600}

/* Apply Changes button (Phase 14: instant apply) */
.apply-bar{
  position:fixed;
  bottom:24px;
  left:50%;
  transform:translateX(-50%);
  background:var(--surface);
  border:1px solid var(--green-dim);
  border-radius:8px;
  padding:10px 16px;
  display:none; /* 默认隐藏；dirty 时设置为 flex */
  align-items:center;
  gap:10px;
  font-family:var(--mono);
  font-size:0.75rem;
  color:var(--text);
  box-shadow:0 4px 16px rgba(0,0,0,0.4);
  z-index:50;
}
.apply-bar.dirty{display:flex}
.batch-bar.with-apply{bottom:80px}

/* 14-08: Leave confirmation modal (replaces unstyled beforeunload for in-page navigation) */
.leave-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:none;align-items:center;justify-content:center}
.leave-modal-overlay.open{display:flex}
.leave-modal-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;width:420px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:var(--sans)}
.leave-modal-title{font-size:1.05rem;font-weight:700;color:var(--text-bright);margin-bottom:12px}
.leave-modal-body{font-size:0.85rem;color:var(--text);line-height:1.6;margin-bottom:20px}
.leave-modal-actions{display:flex;justify-content:flex-end;gap:10px}

/* Sync-in-progress: disable regex toggle (D-16) */
.regex-toggle-bar.syncing{color:var(--text-dim);pointer-events:none;cursor:not-allowed}
.regex-toggle-bar.syncing .regex-toggle-arrow{color:var(--text-dim)}

/* Sync overlay on flat-list (D-16) */
.flat-list{position:relative}
.flat-list.syncing::before{
  content:'';
  position:absolute;
  inset:0;
  background:transparent;
  border-radius:10px;
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  z-index:10;
  pointer-events:auto;
}
.flat-list.syncing::after{
  content:'';
  position:absolute;
  top:150px;
  right:0;
  bottom:0;
  left:0;
  background-image:var(--aggr-pattern);
  background-repeat:repeat-y;
  background-position:center top;
  background-size:auto 700px;
  z-index:11;
  pointer-events:none;
}
/* SVG pattern: emoji + 正在进行接口聚合…… (theme-aware text color) */
:root{
  --aggr-pattern:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='700' viewBox='0 0 600 700'><text x='300' y='130' font-size='110' text-anchor='middle' dominant-baseline='middle'>%E2%9A%A0%EF%B8%8F</text><text x='300' y='220' font-size='20' text-anchor='middle' fill='%23c8d6e5' font-family='monospace'>%E6%AD%A3%E5%9C%A8%E8%BF%9B%E8%A1%8C%E6%8E%A5%E5%8F%A3%E8%81%9A%E5%90%88%E2%80%A6%E2%80%A6</text></svg>");
}
[data-theme="light"]{
  --aggr-pattern:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='700' viewBox='0 0 600 700'><text x='300' y='130' font-size='110' text-anchor='middle' dominant-baseline='middle'>%E2%9A%A0%EF%B8%8F</text><text x='300' y='220' font-size='20' text-anchor='middle' fill='%232c3e50' font-family='monospace'>%E6%AD%A3%E5%9C%A8%E8%BF%9B%E8%A1%8C%E6%8E%A5%E5%8F%A3%E8%81%9A%E5%90%88%E2%80%A6%E2%80%A6</text></svg>");
}
.btn[disabled]{opacity:0.3;cursor:not-allowed;pointer-events:none}

.footer{margin-top:48px;padding-top:24px}

/* Regex section */
.regex-toggle-bar{display:flex;align-items:center;gap:8px;padding:17px 0;cursor:pointer;user-select:none;font-size:0.75rem;font-weight:600;color:var(--text)}
.regex-toggle-bar:hover{color:var(--text-bright)}
.regex-toggle-arrow{font-size:0.65rem;color:var(--text-dim);transition:transform 0.2s;display:inline-block}
.regex-toggle-bar.open .regex-toggle-arrow{transform:rotate(90deg)}
.regex-panel{margin-bottom:12px}
.regex-textarea{width:100%;min-height:190px;padding:10px;font-family:var(--mono);font-size:0.75rem;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);resize:vertical;box-sizing:border-box}
.regex-textarea:focus{outline:none;border-color:var(--green)}
.regex-header{display:flex;align-items:center;gap:8px;padding:12px 16px;cursor:pointer;user-select:none;transition:background 0.2s}
.regex-header:hover{background:var(--surface-2)}
.regex-header-title{flex:1;font-family:var(--mono);font-size:0.7rem;font-weight:600;color:var(--text-bright);text-transform:uppercase;letter-spacing:0.08em}
.regex-header-arrow{font-size:0.7rem;color:var(--text-dim);transition:transform 0.2s}
.regex-section.open .regex-header-arrow{transform:rotate(90deg)}
.regex-body{display:none;border-top:1px solid var(--border);padding:16px}
.regex-section.open .regex-body{display:block}

/* Regex input form */
.regex-input-row{display:flex;gap:10px;align-items:center;margin-bottom:12px}
.regex-input{flex:1;font-family:var(--mono);font-size:0.75rem}
.regex-error{font-size:0.7rem;color:var(--red);margin-top:4px;padding:4px 0;display:none}
.regex-status{font-size:0.7rem;padding:0;display:none;transition:opacity 0.5s;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.regex-status.saving{color:var(--text-dim)}
.regex-status.saved{color:var(--green)}
.regex-status.noop{color:var(--text-dim)}
.regex-status.error{color:var(--red)}
#applyChangesBtn{padding:6px 20px;min-width:96px}
.regex-description{font-family:var(--mono);font-size:0.75rem;font-weight:400;line-height:1.6;color:var(--text-dim);padding:0 0 12px 0;margin:0}

/* Preview */
.regex-preview{margin-bottom:12px;display:none}
.regex-preview.open{display:block}
.regex-preview-header{font-size:0.7rem;color:var(--text-dim);margin-bottom:6px;font-family:var(--mono)}
.regex-preview-count{color:var(--blue);font-weight:600}
.regex-preview-list{background:var(--surface-2);border-radius:6px;max-height:400px;overflow-y:auto}
.regex-preview-item{padding:6px 12px;font-family:var(--mono);font-size:0.75rem;color:var(--text);border-bottom:1px solid var(--border)}
.regex-preview-item:last-child{border-bottom:none}
.regex-preview-item:hover{background:var(--surface)}
.regex-preview-empty{padding:12px;font-size:0.75rem;color:var(--text-dim);text-align:center;font-family:var(--mono)}

/* Rule list */
.regex-rule-list{margin-top:4px}
.regex-rule-list-empty{padding:16px;font-size:0.75rem;color:var(--text-dim);text-align:center;font-family:var(--mono)}
.regex-rule{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
.regex-rule:last-child{border-bottom:none}
.regex-rule-pattern{flex:1;font-family:var(--mono);font-size:0.75rem;color:var(--text-bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.regex-rule-meta{font-size:0.65rem;color:var(--text-dim);white-space:nowrap}

/* Regex-blocked site */
.item.regex-blocked{border-left:4px solid var(--amber-dim);opacity:1}
.item.regex-blocked .item-name{text-decoration:none;color:var(--text-bright)}
.regex-badge{font-size:0.6rem;padding:1px 6px;border-radius:3px;background:var(--amber-dim);color:var(--amber);font-weight:600;margin-left:6px}
.regex-badge.whitelisted{background:var(--green-dim);color:var(--green)}

@media(max-width:560px){
  .apply-bar,.batch-bar{font-size:0.65rem;padding:8px 12px;gap:8px}
  .apply-bar .btn,.batch-bar .btn{font-size:0.6rem;padding:4px 8px}
}
</style>
<script>(function(){var t=localStorage.getItem('theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
</head>
<body>

<!-- Login -->
<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h2>配置编辑器</h2>
    <p>请输入管理令牌</p>
    <div class="error-msg" id="loginError">无效的令牌</div>
    <input type="password" id="tokenInput" placeholder="管理令牌" autofocus>
    <button class="btn" style="width:100%" onclick="auth.doLogin()">登录</button>
  </div>
</div>

<!-- Main -->
<div class="container" id="mainContent" style="display:none">
  <header class="header">
    <div class="header-top">
      <div class="header-label">配置编辑器</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()">🌙</button>
        </div>
    </div>
    <h1 class="header-title">TVBox <span>Auxiliary</span></h1>
    <nav class="header-nav">
      <a href="/status">首页</a>
      <a href="/admin">接口管理</a>
      <a href="/admin/config-editor" class="active">配置编辑</a>
    </nav>
  </header>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" data-tab="sites" onclick="switchTab('sites')">点播<span class="badge" id="badgeSites">0</span></div>
    <div class="tab" data-tab="parses" onclick="switchTab('parses')">解析<span class="badge" id="badgeParses">0</span></div>
    <div class="tab" data-tab="lives" onclick="switchTab('lives')">直播<span class="badge" id="badgeLives">0</span></div>
  </div>

  <!-- Search -->
  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="搜索名称、API、URL..." oninput="doSearch()">
  </div>

  <!-- Regex toggle button (collapsible, below search) -->
  <div class="regex-toggle-bar" onclick="toggleRegexPanel()">
    <span class="regex-toggle-arrow">&#9654;</span>
    <span>正则表达式</span>
  </div>

  <!-- Regex panel (collapsible) -->
  <div class="regex-panel" id="regexPanel" style="display:none;margin-bottom:12px">
    <p class="regex-description">使用正则表达式进行屏蔽，一行一条，逐条匹配，被命中的站点将被屏蔽，规则会随控件焦点状态自动保存，注意，你仍需应用更改才可即时生效。</p>
    <textarea class="regex-textarea" id="regexTextarea" placeholder="输入正则模式..."></textarea>
    <div class="regex-error" id="regexError"></div>
    <div style="display:flex;align-items:center;gap:8px;margin:7px 0 15px 0">
      <button class="btn sm secondary" id="regexPreviewBtn" onclick="toggleRegexPreview()">预览匹配</button>
      <span class="regex-status" id="regexStatus"></span>
    </div>
    <div class="regex-preview" id="regexPreview" style="display:none;margin-bottom:8px">
      <div class="regex-preview-header"><span>匹配的站点</span> (<span class="regex-preview-count" id="regexPreviewCount">0</span>)</div>
      <div class="regex-preview-list" id="regexPreviewList"></div>
    </div>
  </div>

  <!-- Stats -->
  <div class="stats" id="statsBar"></div>

  <!-- Sites panel -->
  <div class="tab-panel active" id="panelSites">
    <!-- Loading -->
    <div class="loading-msg" id="loadingSites">加载中...</div>
  </div>

  <!-- Parses panel -->
  <div class="tab-panel" id="panelParses">
    <div class="loading-msg" id="loadingParses">加载中...</div>
  </div>

  <!-- Lives panel -->
  <div class="tab-panel" id="panelLives">
    <div class="loading-msg" id="loadingLives">加载中...</div>
  </div>

  <div class="footer">
    <span>TVBox Auxiliary</span>
  </div>
</div>

<div class="batch-bar" id="batchBar" style="display:none">
  <span><span class="batch-count" id="batchCount">0</span> <span>已选</span></span>
  <button class="btn sm secondary" id="selectAllBtn" onclick="toggleSelectAll()">全选</button>
  <button class="btn sm danger" id="batchBlockBtn" onclick="batchBlock()">批量屏蔽</button>
  <button class="btn sm success" id="batchRestoreBtn" onclick="batchRestore()" disabled>批量恢复</button>
  <button class="btn sm secondary" onclick="clearSelection()">取消</button>
</div>

<div class="apply-bar" id="applyBar">
  <button class="btn sm success" id="applyChangesBtn" onclick="applyChanges()">应用更改</button>
</div>

<div class="leave-modal-overlay" id="leaveModal">
  <div class="leave-modal-box">
    <div class="leave-modal-title" id="leaveModalTitle">规则未应用，确定离开？</div>
    <div class="leave-modal-actions">
      <button class="btn sm danger" id="leaveModalLeaveBtn">离开</button>
      <button class="btn sm success" id="leaveModalStayBtn">返回</button>
    </div>
  </div>
</div>

<script>
${sharedUi}


let TOKEN = '';
let DATA = null;
let CURRENT_TAB = 'sites';
let previewVisible = false;

const auth = initAuth('tokenInput', 'loginError', 'loginOverlay', 'mainContent', '/admin/config-data', async function() {
  TOKEN = auth.getToken();
  loadData();
  startSyncPolling();
  // D-24: restore dirty state from sessionStorage on page load,
  // but reconcile with server — if server cleared the marker (e.g. aggregation ran),
  // the client-side dirty flag is stale and must be cleared too
  if (sessionStorage.getItem('configEditorDirty') === 'true') {
    try {
      const statusRes = await auth.authFetch('/status-data');
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (!statusData.dirtyMarker) {
          // Server says no dirty marker — aggregation already ran, clear client state
          _dirty = false;
          sessionStorage.removeItem('configEditorDirty');
        } else {
          _dirty = true;
        }
      } else {
        _dirty = true; // can't verify, assume stale
      }
    } catch {
      _dirty = true; // network error, assume stale
    }
    updateApplyBar();
  }

  // 14-08: Intercept internal link clicks while dirty
  document.addEventListener('click', function(e) {
    if (!_dirty) return;
    let el = e.target;
    while (el && el !== document.body) {
      if (el.tagName === 'A' && el.getAttribute('href')) {
        const href = el.getAttribute('href');
        if (href.startsWith('/') && !href.startsWith('//') && !el.target && !el.hasAttribute('download')) {
          e.preventDefault();
          showLeaveModal(href);
          return;
        }
      }
      el = el.parentElement;
    }
  });

  const stayBtn = document.getElementById('leaveModalStayBtn');
  if (stayBtn) stayBtn.addEventListener('click', hideLeaveModal);

  const leaveBtn = document.getElementById('leaveModalLeaveBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', function() {
    const href = _pendingLeaveHref;
    hideLeaveModal();
    _dirty = false; // clear in-memory only so beforeunload does not double-prompt
    // Keep sessionStorage configEditorDirty so dirty state restores on return
    if (href) {
      window.location.href = href;
    }
  });
});

const SITE_TYPE_TIPS = {
  0: () => "XML 站点：通过 XML 接口获取影视数据",
  1: () => "JSON 站点（MacCMS）：通过 JSON API 获取影视数据",
  3: () => "JAR 插件：通过 Java 爬虫插件获取数据，需要 spider 包",
  4: () => "远程站点：使用远程配置的站点",
};

const PARSE_TYPE_TIPS = {
  0: () => "嗅探解析：通过网页嗅探提取视频地址",
  1: () => "JSON 解析：直接返回 JSON 格式的视频地址",
  2: () => "JSON 扩展解析：带扩展参数的 JSON 解析",
  3: () => "同步解析：合并多个解析接口的结果",
  4: () => "超级解析：高级复合解析模式",
};

const LIVE_TYPE_TIPS = {
  0: () => "直播源：M3U/TXT 格式的频道列表文件",
  3: () => "直播插件：通过 JAR/Python 插件获取频道",
};

async function extractErrorMessage(res, fallback) {
  try { const j = await res.json(); return j && j.error ? String(j.error) : fallback; }
  catch { try { const t = await res.text(); return t || fallback; } catch { return fallback; } }
}

async function loadData() {
  try {
    const res = await fetch('/admin/config-data', {
      headers: { 'Authorization': 'Bearer ' + TOKEN }
    });
    if (res.status === 401) {
      $('loginError').style.display = 'block';
      return;
    }
    DATA = await res.json();
    $('loginOverlay').style.display = 'none';
    $('mainContent').style.display = 'block';
    render();
  } catch (e) {
    $('loginError').textContent = "网络错误";
    $('loginError').style.display = 'block';
  }
}

function switchTab(tab) {
  CURRENT_TAB = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel' + tab.charAt(0).toUpperCase() + tab.slice(1)));
  $('searchInput').value = '';
  doSearch();
  updateBatchBar();

  // Hide regex section on non-Sites tabs (Bug 3 fix)
  const regexBar = document.querySelector('.regex-toggle-bar');
  const regexPanel = $('regexPanel');
  if (tab === 'sites') {
    if (regexBar) regexBar.style.display = '';
    // Don't change regexPanel display — keep its current open/closed state
  } else {
    if (regexBar) regexBar.style.display = 'none';
    if (regexPanel) regexPanel.style.display = 'none';
    // If panel was open, reset state so re-opening on Sites works
    if (regexPanelOpen) {
      regexPanelOpen = false;
      const bar = document.querySelector('.regex-toggle-bar');
      if (bar) bar.classList.remove('open');
    }
  }
}

function render() {
  if (!DATA) return;
  $('badgeSites').textContent = DATA.sites.length;
  $('badgeParses').textContent = DATA.parses.length;
  $('badgeLives').textContent = DATA.lives.length;
  renderSites();
  renderParses();
  renderLives();
  updateStats();
  updateBatchBar();
  loadRegexRules();
  setupRegexAutoSave();
  setupItemClickDelegate();
}

let _itemClickDelegateBound = false;
function setupItemClickDelegate() {
  if (_itemClickDelegateBound) return;
  _itemClickDelegateBound = true;

  // Bind on static panel containers (survives innerHTML re-renders)
  const panels = ['panelSites', 'panelParses', 'panelLives'];
  panels.forEach(pid => {
    const panel = $(pid);
    if (panel) {
      panel.addEventListener('click', function(e) {
        // Skip if click target is checkbox, button, item-type (with tooltip), or item-api
        const skip = e.target.closest('.item-label, .item-check, .item-actions, .item-type, .item-api');
        if (skip) return;

        const item = e.target.closest('.item[data-id]');
        if (!item) return;

        const checkbox = item.querySelector('.item-check');
        if (checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
        }
      });
    }
  });
}

function updateStats() {
  if (!DATA) return;
  const bs = DATA.sites.filter(s => s.blocked).length;
  const bp = DATA.parses.filter(p => p.blocked).length;
  const bl = DATA.lives.filter(l => l.blocked).length;
  const regexBlocked = DATA.sites.filter(s => s.regexBlocked).length;
  const regexRestored = DATA.sites.filter(s => s.isOverridden).length;
  const errCount = DATA.sites.filter(s => s.errSource).length;
  $('statsBar').innerHTML =
    '<div class="stat">' + "可用:" + ' <span class="num">' + (DATA.sites.length - bs) + '</span> ' + "站点" + ', '
    + '<span class="num">' + (DATA.parses.length - bp) + '</span> ' + "解析" + ', '
    + '<span class="num">' + (DATA.lives.length - bl) + '</span> ' + "直播" + '</div>'
    + (bs + bp + bl > 0 ? '<div class="stat">' + "已屏蔽:" + ' <span class="blocked-num">' + (bs + bp + bl) + '</span></div>' : '')
    + (regexBlocked > 0 ? '<div class="stat">' + "正则已屏蔽: {N}".replace('{N}', regexBlocked) + '</div>' : '')
    + (regexRestored > 0 ? '<div class="stat">' + "正则白名单: {N}".replace('{N}', regexRestored) + '</div>' : '')
    + (errCount > 0 ? '<div class="stat">ERR: <span class="blocked-num">' + errCount + '</span></div>' : '');
}

function typeSpan(type, tips) {
  const t = type ?? 0;
  const tipFn = tips[t];
  const tip = tipFn ? tipFn() : "类型 " + t;
  return '<span class="item-type t' + t + '">T' + t + '<span class="tooltip">' + tip + '</span></span>';
}

function renderSites() {
  const container = $('panelSites');
  let html = '<div class="flat-list' + (_syncing ? ' syncing' : '') + '">';
  for (const s of DATA.sites) {
    html += siteRow(s);
  }
  html += '</div>';
  container.innerHTML = html;
}

function siteRow(s) {
  let cls = 'item';
  let check = '';
  let btn = '';
  let badge = '';

  if (s.isOverridden) {
    cls = 'item regex-blocked';
    badge = '<span class="regex-badge whitelisted">' + "白名单" + '</span>';
    btn = '<button class="btn sm success" onclick="reblockRegex(\\'' + escAttr(s.name || s.key) + '\\')">' + "移除白名单" + '</button>';
  } else if (s.regexBlocked) {
    cls = 'item regex-blocked';
    badge = '<span class="regex-badge">Regex</span>';
    btn = '<button class="btn sm secondary" onclick="unblockRegexBlocked(\\'' + escAttr(s.name || s.key) + '\\')">' + "添加白名单" + '</button>';
  } else if (s.blocked) {
    cls = 'item blocked';
    check = '<input type="checkbox" class="item-check" onchange="updateBatchBar()">';
    btn = '<button class="btn sm secondary" onclick="unblock(\\'sites\\',\\'' + escAttr(s.fingerprint) + '\\')">' + "恢复" + '</button>';
  } else {
    check = '<input type="checkbox" class="item-check" onchange="updateBatchBar()">';
    btn = '<button class="btn sm danger" onclick="block(\\'sites\\',\\'' + escAttr(s.fingerprint) + '\\')">' + "屏蔽" + '</button>';
  }

  const blockType = (s.isOverridden || s.regexBlocked) ? ' data-block-type="regex"' : s.blocked ? ' data-block-type="manual"' : '';
  if (check) {
    return '<div class="' + cls + '" data-id="' + esc(s.fingerprint) + '" data-type="sites"' + blockType + ' data-search="' + esc((s.name||'') + ' ' + s.key + ' ' + s.api) + '">'
      + '<label class="item-label">'
      + check
      + '<span class="item-name" title="' + esc(s.key) + '">' + esc(s.name || s.key) + badge + '</span>'
      + '</label>'
      + (s.errSource
        ? '<span class="item-type terr">ERR<span class="tooltip">' + esc(s.errReason || '接口源验证失败') + '</span></span>'
        : typeSpan(s.type, SITE_TYPE_TIPS))
      + '<span class="item-api" title="' + esc(s.api) + '">' + esc(s.api) + '</span>'
      + '<span class="item-actions">' + btn + '</span>'
      + '</div>';
  } else {
    return '<div class="' + cls + '" data-id="' + esc(s.fingerprint) + '" data-type="sites"' + blockType + ' data-search="' + esc((s.name||'') + ' ' + s.key + ' ' + s.api) + '">'
      + '<span class="item-name" style="flex:1" title="' + esc(s.key) + '">' + esc(s.name || s.key) + badge + '</span>'
      + (s.errSource
        ? '<span class="item-type terr">ERR<span class="tooltip">' + esc(s.errReason || '接口源验证失败') + '</span></span>'
        : typeSpan(s.type, SITE_TYPE_TIPS))
      + '<span class="item-api" title="' + esc(s.api) + '">' + esc(s.api) + '</span>'
      + '<span class="item-actions">' + btn + '</span>'
      + '</div>';
  }
}

function renderParses() {
  const container = $('panelParses');
  let html = '<div class="flat-list' + (_syncing ? ' syncing' : '') + '">';
  for (const p of DATA.parses) {
    html += parseRow(p);
  }
  html += '</div>';
  container.innerHTML = html;
}

function parseRow(p) {
  const cls = p.blocked ? 'item blocked' : 'item';
  const id = p.url;
  const check = '<input type="checkbox" class="item-check" onchange="updateBatchBar()">';
  const btn = p.blocked
    ? '<button class="btn sm secondary" onclick="unblock(\\'parses\\',\\'' + escAttr(id) + '\\')">' + "恢复" + '</button>'
    : '<button class="btn sm danger" onclick="block(\\'parses\\',\\'' + escAttr(id) + '\\')">' + "屏蔽" + '</button>';
  return '<div class="' + cls + '" data-id="' + esc(id) + '" data-type="parses" data-search="' + esc((p.name||'') + ' ' + p.url) + '">'
    + '<label class="item-label">'
    + check
    + '<span class="item-name">' + esc(p.name) + '</span>'
    + '</label>'
    + typeSpan(p.type, PARSE_TYPE_TIPS)
    + '<span class="item-api" title="' + esc(p.url) + '">' + esc(p.url) + '</span>'
    + '<span class="item-actions">' + btn + '</span>'
    + '</div>';
}

function renderLives() {
  const container = $('panelLives');
  const liveDisabled = !!DATA.liveDisabled;
  let html = '';
  if (liveDisabled) {
    html += '<div style="padding:10px 14px;margin-bottom:8px;background:var(--amber-dim);border-left:3px solid var(--amber);border-radius:4px;font-size:0.85rem;color:var(--text-bright)">'
      + '直播功能已禁用'
      + '</div>';
  }
  html += '<div class="flat-list' + (_syncing ? ' syncing' : '') + '">';
  for (const l of DATA.lives) {
    html += liveRow(l, liveDisabled);
  }
  html += '</div>';
  container.innerHTML = html;
}

function liveRow(l, liveDisabled) {
  const url = l.url || l.api || '';
  // liveDisabled 时强制 blocked 样式、无 checkbox、无按钮
  const cls = (l.blocked || liveDisabled) ? 'item blocked' : 'item';
  const check = liveDisabled ? '' : '<input type="checkbox" class="item-check" onchange="updateBatchBar()">';
  const btn = (url && !liveDisabled)
    ? (l.blocked
      ? '<button class="btn sm secondary" onclick="unblock(\\'lives\\',\\'' + escAttr(url) + '\\')">' + "恢复" + '</button>'
      : '<button class="btn sm danger" onclick="block(\\'lives\\',\\'' + escAttr(url) + '\\')">' + "屏蔽" + '</button>')
    : '';
  if (check) {
    return '<div class="' + cls + '" data-id="' + esc(url) + '" data-type="lives" data-search="' + esc((l.name||'') + ' ' + url) + '">'
      + '<label class="item-label">'
      + check
      + '<span class="item-name">' + esc(l.name || '(unnamed)') + '</span>'
      + '</label>'
      + typeSpan(l.type, LIVE_TYPE_TIPS)
      + '<span class="item-api" title="' + esc(url) + '">' + esc(url) + '</span>'
      + '<span class="item-actions">' + btn + '</span>'
      + '</div>';
  } else {
    return '<div class="' + cls + '" data-id="' + esc(url) + '" data-type="lives" data-search="' + esc((l.name||'') + ' ' + url) + '">'
      + '<span class="item-name" style="flex:1">' + esc(l.name || '(unnamed)') + '</span>'
      + typeSpan(l.type, LIVE_TYPE_TIPS)
      + '<span class="item-api" title="' + esc(url) + '">' + esc(url) + '</span>'
      + '<span class="item-actions">' + btn + '</span>'
      + '</div>';
  }
}

function doSearch() {
  const q = $('searchInput').value.toLowerCase().trim();
  const panel = document.querySelector('.tab-panel.active');
  if (!panel) return;
  panel.querySelectorAll('.item').forEach(item => {
    const text = (item.dataset.search || '').toLowerCase();
    item.style.display = (!q || text.includes(q)) ? '' : 'none';
  });
}

async function block(type, id) {
  if (type === 'lives' && DATA && DATA.liveDisabled) return;
  try {
    const res = await fetch('/admin/blacklist', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id })
    });
    if (!res.ok) { alert('操作失败: ' + await extractErrorMessage(res, '服务器返回 ' + res.status)); return; }
    if (type === 'sites') {
      const s = DATA.sites.find(s => s.fingerprint === id);
      if (s) s.blocked = true;
    } else if (type === 'parses') {
      const p = DATA.parses.find(p => p.url === id);
      if (p) p.blocked = true;
    } else if (type === 'lives') {
      const l = DATA.lives.find(l => (l.url || l.api || '') === id);
      if (l) l.blocked = true;
    }
    updateItemDom(type, id, true);
    updateStats();
    updateBatchBar();
    markDirty();
    toast("已屏蔽");
  } catch (e) { alert('Network error'); }
}

async function unblock(type, id) {
  if (type === 'lives' && DATA && DATA.liveDisabled) return;
  try {
    const res = await fetch('/admin/blacklist', {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id })
    });
    if (!res.ok) { alert('操作失败: ' + await extractErrorMessage(res, '服务器返回 ' + res.status)); return; }
    if (type === 'sites') {
      const s = DATA.sites.find(s => s.fingerprint === id);
      if (s) s.blocked = false;
    } else if (type === 'parses') {
      const p = DATA.parses.find(p => p.url === id);
      if (p) p.blocked = false;
    } else if (type === 'lives') {
      const l = DATA.lives.find(l => (l.url || l.api || '') === id);
      if (l) l.blocked = false;
    }
    updateItemDom(type, id, false);
    updateStats();
    markDirty();
    toast("已恢复");
  } catch (e) { alert('Network error'); }
}

function updateItemDom(type, id, blocked) {
  const panel = type === 'sites' ? 'panelSites' : type === 'parses' ? 'panelParses' : 'panelLives';
  const el = $(panel).querySelector('[data-id="' + CSS.escape(id) + '"]');
  if (!el) return;
  if (blocked) {
    el.classList.add('blocked');
    el.querySelector('.item-actions').innerHTML = '<button class="btn sm secondary" onclick="unblock(\\'' + type + '\\',\\'' + escAttr(id) + '\\')">' + "恢复" + '</button>';
  } else {
    el.classList.remove('blocked');
    let btns = '';
    if (type === 'sites') {
      const s = DATA.sites.find(s => s.fingerprint === id);
      if (s && s.isOverridden) {
        btns = '<button class="btn sm success" onclick="reblockRegex(\\'' + escAttr(s.name || s.key) + '\\')">' + "移除白名单" + '</button>';
      } else if (s && s.regexBlocked) {
        btns = '<button class="btn sm secondary" onclick="unblockRegexBlocked(\\'' + escAttr(s.name || s.key) + '\\')">' + "添加白名单" + '</button>';
      }
    }
    if (!btns) {
      btns = '<button class="btn sm danger" onclick="block(\\'' + type + '\\',\\'' + escAttr(id) + '\\')">' + "屏蔽" + '</button>';
    }
    el.querySelector('.item-actions').innerHTML = btns;
  }
}

function updateBatchBar() {
  const checked = document.querySelectorAll('.tab-panel.active .item-check:checked');
  const bar = $('batchBar');
  if (checked.length > 0) {
    $('batchCount').textContent = checked.length;
    bar.style.display = 'flex';
    let hasBlocked = 0;
    checked.forEach(cb => {
      const item = cb.closest('.item');
      if (item.classList.contains('blocked')) hasBlocked++;
    });
    $('batchRestoreBtn').disabled = !hasBlocked;
    // Disable batch block when all selected items are already blocked
    $('batchBlockBtn').disabled = hasBlocked === checked.length;
  } else {
    bar.style.display = 'none';
  }
  // Sync select-all button text with current selection state
  const btn = $('selectAllBtn');
  if (btn) {
    const panel = document.querySelector('.tab-panel.active');
    const all = panel ? Array.from(panel.querySelectorAll('.item:not(.regex-blocked) .item-check')).filter(cb => cb.offsetParent !== null) : [];
    btn.textContent = (all.length > 0 && all.every(cb => cb.checked)) ? "取消全选" : "全选";
  }
}

function clearSelection() {
  document.querySelectorAll('.item-check:checked').forEach(cb => { cb.checked = false; });
  updateBatchBar();
  const btn = $('selectAllBtn');
  if (btn) btn.textContent = "全选";
}

function toggleSelectAll() {
  const panel = document.querySelector('.tab-panel.active');
  if (!panel) return;
  const checkboxes = Array.from(panel.querySelectorAll('.item:not(.regex-blocked) .item-check'))
    .filter(cb => cb.offsetParent !== null);
  if (checkboxes.length === 0) return;
  const allChecked = checkboxes.every(cb => cb.checked);
  if (allChecked) {
    // All already checked — deselect all
    checkboxes.forEach(cb => { cb.checked = false; });
  } else {
    // Not all checked — select all
    checkboxes.forEach(cb => { cb.checked = true; });
  }
  updateBatchBar();
  const btn = $('selectAllBtn');
  btn.textContent = allChecked ? "全选" : "取消全选";
}

async function batchBlock() {
  const checked = document.querySelectorAll('.tab-panel.active .item-check:checked');
  if (checked.length === 0) return;
  const byType = {};
  checked.forEach(cb => {
    const item = cb.closest('.item');
    if (item.classList.contains('blocked')) return; // Skip already blocked
    const type = item.dataset.type;
    const id = item.dataset.id;
    if (!byType[type]) byType[type] = [];
    byType[type].push(id);
  });
  try {
    for (const type of Object.keys(byType)) {
      const ids = byType[type];
      const res = await fetch('/admin/blacklist/batch', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ids })
      });
      if (!res.ok) { alert('操作失败: ' + await extractErrorMessage(res, '服务器返回 ' + res.status)); return; }
      ids.forEach(id => {
        if (type === 'sites') { const s = DATA.sites.find(s => s.fingerprint === id); if (s) s.blocked = true; }
        else if (type === 'parses') { const p = DATA.parses.find(p => p.url === id); if (p) p.blocked = true; }
        else if (type === 'lives') { const l = DATA.lives.find(l => (l.url || l.api || '') === id); if (l) l.blocked = true; }
        updateItemDom(type, id, true);
      });
    }
    updateStats();
    updateBatchBar();
    clearSelection();
    markDirty();
    toast("已批量屏蔽");
  } catch (e) { alert('Network error'); }
}

async function batchRestore() {
  const checked = document.querySelectorAll('.tab-panel.active .item-check:checked');
  if (checked.length === 0) return;
  const toRestore = [];
  checked.forEach(cb => {
    const item = cb.closest('.item');
    if (item.classList.contains('blocked') && !item.classList.contains('regex-blocked')) {
      toRestore.push({ type: item.dataset.type, id: item.dataset.id });
    }
  });
  if (toRestore.length === 0) return;
  try {
    for (const { type, id } of toRestore) {
      const res = await fetch('/admin/blacklist', {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id })
      });
      if (!res.ok) {
        // Reload to reflect partial state rather than leaving UI stale
        const reloadRes = await auth.authFetch('/admin/config-data');
        if (reloadRes.ok) { DATA = await reloadRes.json(); }
        renderSites();
        renderParses();
        renderLives();
        updateStats();
        updateBatchBar();
        alert('恢复失败: ' + await extractErrorMessage(res, '服务器返回 ' + res.status));
        return;
      }
    }
    // Full reload per D-10/D-11
    const reloadRes = await auth.authFetch('/admin/config-data');
    if (reloadRes.ok) { DATA = await reloadRes.json(); }
    renderSites();
    renderParses();
    renderLives();
    updateStats();
    updateBatchBar();
    clearSelection();
    markDirty();
    toast("已批量恢复");
  } catch (e) { alert('Network error'); }
}

// ─── Regex Blocking (Phase 5) ─────────────────────────

let regexPanelOpen = false;
let regexSaveTimer = null;
let regexBlurHandler = null;
let regexFadeTimer = null;
let isSaving = false;

function toggleRegexPanel() {
  regexPanelOpen = !regexPanelOpen;
  const panel = $('regexPanel');
  const bar = document.querySelector('.regex-toggle-bar');
  if (regexPanelOpen) {
    panel.style.display = 'block';
    bar.classList.add('open');
    $('regexTextarea').focus();
  } else {
    panel.style.display = 'none';
    bar.classList.remove('open');
  }
}

async function loadRegexRules() {
  try {
    if (DATA && DATA.regexRules && Array.isArray(DATA.regexRules)) {
      // Already loaded from DATA.regexRules
    } else {
      const res = await auth.authFetch('/admin/regex-rules');
      if (!res.ok) return;
      const data = await res.json();
      DATA.regexRules = data.rules || [];
    }
    const ta = $('regexTextarea');
    if (ta && DATA.regexRules) {
      ta.value = DATA.regexRules.map(r => r.pattern).join(String.fromCharCode(10));
    }
  } catch (e) { /* silently handle */ }
}

async function saveRegexRules() {
  const ta = $('regexTextarea');
  if (!ta) return;
  if (isSaving) return;
  isSaving = true;
  const lines = ta.value.split(String.fromCharCode(10)).map(l => l.trim()).filter(l => l.length > 0);

  // Show saving status
  const statusEl = $('regexStatus');
  const errorEl = $('regexError');
  // Clear any previous fade timer to prevent race conditions
  if (regexFadeTimer) clearTimeout(regexFadeTimer);
  errorEl.style.display = 'none';
  statusEl.textContent = "保存中...";
  statusEl.className = 'regex-status saving';
  statusEl.style.display = 'inline';
  statusEl.style.opacity = '1';

  // Validate each line
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 200) { errors.push('Line ' + (i+1) + ': ' + "模式过长（最多200字符）"); continue; }
    try { new RegExp(line, 'u'); } catch { errors.push('Line ' + (i+1) + ': ' + "正则语法无效" + ' — ' + esc(line)); continue; }
    if (/\([^)]*[+*{][^)]*\)[+*{]/.test(line)) { errors.push('Line ' + (i+1) + ': ' + "模式包含嵌套量词（存在ReDoS风险）" + ' — ' + esc(line)); continue; }
  }

  if (errors.length > 0) {
    errorEl.innerHTML = errors.join('<br>');
    errorEl.style.display = 'block';
    statusEl.style.display = 'none';
    isSaving = false;
    return;
  }

  // Get existing rules
  const existing = (DATA && DATA.regexRules) || [];
  const existingMap = new Map(existing.map(r => [r.pattern, r]));

  // Find added and deleted patterns
  const newPatterns = new Set(lines);
  const toDelete = existing.filter(r => !newPatterns.has(r.pattern));
  const toAdd = lines.filter(l => !existingMap.has(l));

  // Detect no-op
  if (toDelete.length === 0 && toAdd.length === 0) {
    statusEl.textContent = "无变更";
    statusEl.className = 'regex-status noop';
    regexFadeTimer = setTimeout(() => {
      statusEl.style.opacity = '0';
      setTimeout(() => { statusEl.style.display = 'none'; }, 500);
    }, 2000);
    renderSites();
    updateStats();
    isSaving = false;
    return;
  }

  try {
    // Delete removed rules
    for (const rule of toDelete) {
      await auth.authFetch('/admin/regex-rule/' + encodeURIComponent(rule.id), { method: 'DELETE' });
    }
    // Add new rules
    for (const line of toAdd) {
      await auth.authFetch('/admin/regex-rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: line })
      });
    }
    // Reload fresh data
    const res = await auth.authFetch('/admin/regex-rules');
    if (res.ok) {
      const data = await res.json();
      DATA.regexRules = data.rules || [];
    }
    // Reload full config-data to refresh regexBlocked/isOverridden state
    const reloadRes = await auth.authFetch('/admin/config-data');
    if (reloadRes.ok) { DATA = await reloadRes.json(); }
    statusEl.textContent = "规则已保存";
    statusEl.className = 'regex-status saved';
    statusEl.style.opacity = '1';
    regexFadeTimer = setTimeout(() => {
      statusEl.style.opacity = '0';
      setTimeout(() => { statusEl.style.display = 'none'; }, 500);
    }, 3000);
    renderSites();
    updateStats();
    markDirty();
    toast("正则规则已保存");
  } catch (e) {
    statusEl.textContent = "保存失败";
    statusEl.className = 'regex-status error';
    statusEl.style.opacity = '1';
    // Error persists until next interaction — no auto-fade
  } finally {
    isSaving = false;
  }
}

// Auto-save when leaving textarea
function setupRegexAutoSave() {
  const ta = $('regexTextarea');
  if (!ta) return;
  // Remove previous listener to prevent accumulation
  if (regexBlurHandler) {
    ta.removeEventListener('blur', regexBlurHandler);
  }
  regexBlurHandler = () => {
    if (regexSaveTimer) clearTimeout(regexSaveTimer);
    regexSaveTimer = setTimeout(saveRegexRules, 500);
  };
  ta.addEventListener('blur', regexBlurHandler);
}

// Preview matching sites for regex patterns
function toggleRegexPreview() {
  const ta = $('regexTextarea');
  const errorEl = $('regexError');
  const previewEl = $('regexPreview');
  const btn = $('regexPreviewBtn');

  if (previewVisible) {
    previewVisible = false;
    previewEl.style.display = 'none';
    btn.textContent = "预览匹配";
    return;
  }

  const lines = ta.value.split(String.fromCharCode(10)).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    errorEl.textContent = "模式不能为空";
    errorEl.style.display = 'block';
    return;
  }

  for (const line of lines) {
    try { new RegExp(line, 'u'); } catch {
      errorEl.textContent = "正则语法无效" + String.fromCharCode(8212) + ' ' + esc(line);
      errorEl.style.display = 'block';
      return;
    }
  }
  errorEl.style.display = 'none';

  const allMatches = [];
  for (const line of lines) {
    try {
      const re = new RegExp(line, 'u');
      const matches = (DATA && DATA.sites || []).filter(s => re.test(s.name || ''));
      allMatches.push(...matches.map(s => s.name || s.key));
    } catch { /* skip */ }
  }

  const unique = [...new Set(allMatches)];
  $('regexPreviewCount').textContent = unique.length;
  const listEl = $('regexPreviewList');
  if (unique.length === 0) {
    listEl.innerHTML = '<div class="regex-preview-empty">' + "没有站点匹配此模式" + '</div>';
  } else {
    listEl.innerHTML = unique.map(n => '<div class="regex-preview-item">' + esc(n) + '</div>').join('');
  }
  previewEl.style.display = 'block';
  previewVisible = true;
  btn.textContent = "隐藏预览";
}

// Restore a regex-blocked site
async function unblockRegexBlocked(siteName) {
  try {
    const res = await auth.authFetch('/admin/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'regexOverrides', id: siteName })
    });
    if (!res.ok) { alert('添加白名单失败: ' + await extractErrorMessage(res, '服务器返回 ' + res.status)); return; }
    // Reload config-data to get server-computed isOverridden state
    const reloadRes = await auth.authFetch('/admin/config-data');
    if (reloadRes.ok) { DATA = await reloadRes.json(); }
    toast("已添加白名单");
    renderSites();
    updateStats();
    markDirty();
  } catch (e) { alert("网络错误: " + (e && e.message ? e.message : String(e))); }
}

// Re-block a regex-restored site
async function reblockRegex(siteName) {
  try {
    const res = await auth.authFetch('/admin/blacklist', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'regexOverrides', id: siteName })
    });
    if (!res.ok) { alert('移除白名单失败: ' + await extractErrorMessage(res, '服务器返回 ' + res.status)); return; }
    const s = DATA.sites.find(s => (s.name || s.key) === siteName);
    if (s && DATA.regexRules) {
      const matches = DATA.regexRules.some(r => {
        try { return new RegExp(r.pattern, 'u').test(s.name || ''); }
        catch { return false; }
      });
      if (matches) {
        s.isOverridden = false;
        s.regexBlocked = true;
        s.blocked = true;
      } else {
        s.isOverridden = false;
      }
    }
    toast("已移除白名单");
    renderSites();
    updateStats();
    markDirty();
  } catch (e) { alert("网络错误: " + (e && e.message ? e.message : String(e))); }
}

applyTheme(getTheme());

// ─── Phase 14: Instant Apply ──────────────────────────
// D-15: dirty 状态仅内存，刷新后丢失
let _dirty = false;
let _syncing = true; // default true; cleared by first /status-data response. Prevents mutation window on page load.
let _syncPollTimer = null;

// 14-08: Custom in-page leave guard (replaces unstyled beforeunload dialog for in-app navigation)
let _pendingLeaveHref = null;

function showLeaveModal(href) {
  _pendingLeaveHref = href;
  const m = document.getElementById('leaveModal');
  if (m) m.classList.add('open');
}

function hideLeaveModal() {
  _pendingLeaveHref = null;
  const m = document.getElementById('leaveModal');
  if (m) m.classList.remove('open');
}

function markDirty() {
  _dirty = true;
  sessionStorage.setItem('configEditorDirty', 'true');
  updateApplyBar();
}

function clearDirty() {
  _dirty = false;
  sessionStorage.removeItem('configEditorDirty');
  updateApplyBar();
}

function updateApplyBar() {
  const bar = document.getElementById('applyBar');
  if (!bar) return;
  // D-14: 只有 dirty 且非同步中才显示
  if (_dirty && !_syncing) {
    bar.classList.add('dirty');
  } else {
    bar.classList.remove('dirty');
  }
  const batchBar = document.getElementById('batchBar');
  if (batchBar) {
    if (_dirty && !_syncing) batchBar.classList.add('with-apply');
    else batchBar.classList.remove('with-apply');
  }
}

async function applyChanges() {
  const btn = document.getElementById('applyChangesBtn');
  if (!btn) return;
  btn.disabled = true;
  toast("应用中，请检查日志");
  try {
    const res = await auth.authFetch('/admin/patch-config', { method: 'POST' });
    if (res.status === 409) {
      alert("同步进行中，请稍候");
      return;
    }
    if (!res.ok) {
      let msg = "应用失败";
      try { const j = await res.json(); if (j && j.error) msg += ': ' + j.error; } catch {}
      alert(msg);
      return;
    }
    // Check for ok:false in response body (patch skipped)
    try {
      const j = await res.json();
      if (j && !j.ok && j.error) {
        alert("应用失败" + ': ' + j.error);
        return;
      }
    } catch {}
    clearDirty();
  } catch (e) {
    alert("应用失败");
  } finally {
    btn.disabled = false;
  }
}

// D-16: 同步状态轮询 + UI 应用
function applySyncingState(running) {
  _syncing = !!running;
  // 禁用 regex toggle bar
  const rb = document.querySelector('.regex-toggle-bar');
  if (rb) {
    if (_syncing) rb.classList.add('syncing');
    else rb.classList.remove('syncing');
  }
  // flat-list 遮罩
  document.querySelectorAll('.flat-list').forEach(el => {
    if (_syncing) el.classList.add('syncing');
    else el.classList.remove('syncing');
  });
  updateApplyBar();
}

async function pollSyncStatus() {
  try {
    const res = await auth.authFetch('/status-data');
    if (!res.ok) return;
    const j = await res.json();
    applySyncingState(!!j.syncRunning);
    // If server says no dirty marker but client thinks it's dirty,
    // aggregation already ran and cleared it — sync client state
    if (!j.dirtyMarker && _dirty) {
      _dirty = false;
      sessionStorage.removeItem('configEditorDirty');
      updateApplyBar();
    }
  } catch { /* network blip; retry next tick */ }
}

function startSyncPolling() {
  if (_syncPollTimer) return;
  pollSyncStatus();
  _syncPollTimer = setInterval(pollSyncStatus, 1000);
}


function stopSyncPolling() {
  if (_syncPollTimer) {
    clearInterval(_syncPollTimer);
    _syncPollTimer = null;
  }
}
</script>
</body>
</html>`;
