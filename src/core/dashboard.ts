import { sharedStyles } from './shared-styles';
import { sharedUi } from './shared-ui';

export const dashboardHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TVBox Auxiliary</title>
<style>
${sharedStyles}

/* Dashboard-specific */
.header{margin-bottom:28px}

.stats-grid{
  display:grid;
  grid-template-columns:repeat(2, 1fr);
  gap:16px;
  margin-bottom:20px;
}

@media(max-width:560px){
  .stats-grid{grid-template-columns:1fr}
}

.stat-card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:8px;
  padding:24px;
  position:relative;
  overflow:hidden;
  transition:border-color 0.3s, transform 0.2s;
  animation:fadeSlideUp 0.5s ease-out both;
}

.stat-card:nth-child(1){animation-delay:0.15s}
.stat-card:nth-child(2){animation-delay:0.2s}
.stat-card:nth-child(3){animation-delay:0.25s}
.stat-card:nth-child(4){animation-delay:0.3s}

.stat-card:hover{
  border-color:var(--border-glow);
  transform:translateY(-2px);
}

.stat-card::before{
  content:'';
  position:absolute;
  top:0;left:0;right:0;
  height:1px;
  background:linear-gradient(90deg, transparent, var(--green-dim), transparent);
}

.stat-label{
  font-family:var(--mono);
  font-size:0.7rem;
  letter-spacing:0.15em;
  text-transform:uppercase;
  color:var(--text-dim);
  margin-bottom:12px;
  display:flex;
  align-items:center;
  gap:6px;
}

.stat-icon{
  width:14px;height:14px;
  opacity:0.5;
}

.stat-value{
  font-family:var(--mono);
  font-size:2.2rem;
  font-weight:700;
  color:var(--text-bright);
  line-height:1;
  letter-spacing:-0.02em;
}

.stat-value .unit{
  font-size:0.8rem;
  font-weight:400;
  color:var(--text-dim);
  margin-left:4px;
}

.stat-card.highlight .stat-value{
  color:var(--green);
  text-shadow:0 0 20px var(--green-dim);
}

/* Update time section */
.update-section{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:8px;
  padding:20px 24px;
  margin-bottom:20px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  animation:fadeSlideUp 0.5s ease-out both;
}

@media(max-width:560px){
  .update-section{flex-direction:column;align-items:flex-start}
}

.update-info{
  display:flex;flex-direction:column;gap:4px;
}

.update-label{
  font-family:var(--mono);
  font-size:0.7rem;
  letter-spacing:0.15em;
  text-transform:uppercase;
  color:var(--text-dim);
}

.update-time{
  font-family:var(--mono);
  font-size:0.95rem;
  color:var(--text-bright);
  font-weight:500;
}

.update-time.stale{color:var(--amber)}
.update-time.never{color:var(--red)}

/* Source Health Section */
.health-section{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:8px;
  padding:20px 24px;
  margin-bottom:20px;
  animation:fadeSlideUp 0.5s ease-out 0.37s both;
}

.health-summary{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  margin-bottom:8px;
}

.health-label{
  font-family:var(--mono);
  font-size:0.7rem;
  letter-spacing:0.15em;
  text-transform:uppercase;
  color:var(--text-dim);
}

.health-counts{
  display:flex;
  gap:16px;
  font-family:var(--mono);
  font-size:0.75rem;
}

.health-count{
  display:flex;
  align-items:center;
  gap:4px;
}

.health-count.ok{color:var(--green)}
.health-count.warn{color:var(--amber)}
.health-count.error{color:var(--red)}

.health-dot{
  width:6px;height:6px;
  border-radius:50%;
  display:inline-block;
}

.health-dot.ok{background:var(--green);box-shadow:0 0 6px var(--green-glow)}
.health-dot.warn{background:var(--amber);box-shadow:0 0 6px var(--amber-dim)}
.health-dot.error{background:var(--red);box-shadow:0 0 6px var(--red-dim)}

.health-table-wrap{
  overflow-x:auto;
  margin-top:12px;
}

.health-table{
  width:100%;
  border-collapse:collapse;
  font-family:var(--mono);
  font-size:0.7rem;
}

.health-table th{
  text-align:left;
  padding:8px 10px;
  font-size:0.6rem;
  letter-spacing:0.12em;
  text-transform:uppercase;
  color:var(--text-dim);
  border-bottom:1px solid var(--border);
  white-space:nowrap;
}

.health-table td{
  padding:8px 10px;
  border-bottom:1px solid var(--border);
  color:var(--text);
  white-space:nowrap;
}

.health-table tr:last-child td{border-bottom:none}

.health-table .url-cell{
  max-width:200px;
  overflow:hidden;
  text-overflow:ellipsis;
  color:var(--text-dim);
}

.health-table .status-ok{color:var(--green)}
.health-table .status-warn{color:var(--amber)}
.health-table .status-error{color:var(--red)}

.health-table tr.row-error td{background:var(--red-dim)}
.health-table tr.row-warn td{background:var(--amber-dim)}

@media(max-width:560px){
  .health-summary{flex-direction:column;align-items:flex-start}
  .health-table{font-size:0.6rem}
  .health-table .url-cell{max-width:120px}
}

/* Config URL section */

.config-section{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:8px;
  padding:20px 24px;
  margin-bottom:20px;
  animation:fadeSlideUp 0.5s ease-out 0.1s both;
}

.config-label{
  font-family:var(--mono);
  font-size:0.7rem;
  letter-spacing:0.15em;
  text-transform:uppercase;
  color:var(--text-dim);
  margin-bottom:10px;
}

.config-url-row{
  display:flex;
  align-items:center;
  gap:10px;
}

.config-url{
  flex:1;
  font-family:var(--mono);
  font-size:0.8rem;
  color:var(--green);
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  padding:10px 14px;
  overflow-x:auto;
  white-space:nowrap;
  user-select:all;
}

.copy-btn{
  font-family:var(--mono);
  font-size:0.7rem;
  font-weight:500;
  letter-spacing:0.08em;
  text-transform:uppercase;
  padding:10px 16px;
  background:var(--surface-2);
  border:1px solid var(--border);
  color:var(--text-dim);
  border-radius:4px;
  cursor:pointer;
  transition:all 0.2s;
  white-space:nowrap;
}

.copy-btn:hover{
  border-color:var(--text-dim);
  color:var(--text);
}

.copy-btn.copied{
  color:var(--green);
  border-color:var(--green);
}

.footer{margin-top:48px;padding-top:24px}
</style>
<script>(function(){var t=localStorage.getItem('theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
</head>
<body>

<!-- Login -->
<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h2>管理登录</h2>
    <p>TVBox Auxiliary 首页</p>
    <div class="error-msg" id="loginError">无效的令牌</div>
    <input type="password" id="loginInput" placeholder="请输入管理令牌" autocomplete="off">
    <button class="btn" style="width:100%" onclick="auth.doLogin()">登录</button>
  </div>
</div>

<!-- Main content -->
<div class="container" id="mainContent" style="display:none">
  <header class="header">
    <div class="header-top">
      <div class="header-label">系统监控</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()">🌙</button>
        </div>
    </div>
    <h1 class="header-title">TVBox <span>Auxiliary</span></h1>
    <nav class="header-nav">
      <a href="/status" class="active">首页</a>
      <a href="/admin">接口管理</a>
      <a href="/admin/config-editor">配置编辑</a>
    </nav>
  </header>

  <div id="warningBanner"></div>

  <div class="update-section">
    <div class="update-info">
      <div class="update-label">最后聚合时间</div>
      <div class="update-time" id="updateTime"><span class="skeleton">&nbsp;Loading...&nbsp;</span></div>
    </div>
    <button class="btn btn-sm" id="refreshBtn" onclick="triggerRefresh()">立即聚合</button>
  </div>

  <div class="config-section">
    <div class="config-label">接口地址</div>
    <div class="config-url-row">
      <div class="config-url" id="configUrl"></div>
      <button class="copy-btn" id="copyBtn" onclick="copyUrl('configUrl')">复制</button>
    </div>
    <div style="margin-top:12px">
      <div class="config-label">直播接口地址</div>
      <div class="config-url-row">
        <div class="config-url" id="liveConfigUrl"></div>
        <button class="copy-btn" id="copyLiveBtn" onclick="copyUrl('liveConfigUrl')">复制</button>
      </div>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card highlight">
      <div class="stat-label">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        <span>点播源</span>
      </div>
      <div class="stat-value" id="statSites"><span class="skeleton">&nbsp;000&nbsp;</span></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        <span>直播源</span>
      </div>
      <div class="stat-value" id="statLives"><span class="skeleton">&nbsp;00&nbsp;</span></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        <span>解析器</span>
      </div>
      <div class="stat-value" id="statParses"><span class="skeleton">&nbsp;00&nbsp;</span></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"/></svg>
        <span>接口数</span>
      </div>
      <div class="stat-value" id="statSources"><span class="skeleton">&nbsp;00&nbsp;</span></div>
    </div>
  </div>

  <div class="health-section">
    <div class="health-summary">
      <div class="health-label">接口健康状态</div>
      <div class="health-counts">
        <span class="health-count ok"><span class="health-dot ok"></span> <span id="healthOk">-</span> OK</span>
        <span class="health-count warn"><span class="health-dot warn"></span> <span id="healthWarn">-</span> WARN</span>
        <span class="health-count error"><span class="health-dot error"></span> <span id="healthError">-</span> ERR</span>
      </div>
    </div>
    <div class="collapsible-toggle" id="healthToggle" onclick="toggleCollapsible(this)">详情</div>
    <div class="collapsible-body" id="healthBody">
      <div class="health-table-wrap">
        <table class="health-table">
          <thead>
            <tr>
              <th></th>
              <th>名称</th>
              <th>URL</th>
              <th>状态</th>
              <th>失败</th>
              <th>最后成功</th>
            </tr>
          </thead>
          <tbody id="healthTableBody">
            <tr><td colspan="6" class="empty">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="health-section" id="searchQuotaSection" style="display:none">
    <div class="health-summary">
      <div class="health-label">搜索配额</div>
      <div class="health-counts">
        <span class="health-count ok"><span class="health-dot ok"></span> <span id="sqActiveCount">-</span> <span>活跃</span></span>
        <span class="health-count error"><span class="health-dot error"></span> <span id="sqExcludedCount">-</span> <span>排除</span></span>
      </div>
    </div>
    <div class="collapsible-toggle" id="sqToggle" onclick="toggleCollapsible(this)">详情</div>
    <div class="collapsible-body" id="sqBody">
      <div class="health-table-wrap">
        <table class="health-table">
          <thead>
            <tr>
              <th>#</th>
              <th>名称</th>
              <th>来源</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody id="sqTableBody">
            <tr><td colspan="4" class="empty">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="footer">
    <span>TVBox Auxiliary</span>
  </div>
</div>

<script>
${sharedUi}

const auth = initAuth('loginInput', 'loginError', 'loginOverlay', 'mainContent', '/admin/sources', function() {
  const configUrl = location.origin + '/';
  $('configUrl').textContent = configUrl;
  $('liveConfigUrl').textContent = location.origin + '/live-config';
  loadStatus();
  loadSourceHealth();
  loadSearchQuotaSummary();
  setInterval(loadStatus, 60000);
  setInterval(loadSourceHealth, 60000);
});

async function loadStatus() {
  try {
    const res = await fetch('/status-data');
    const d = await res.json();

    $('statSites').textContent = d.sites ?? '—';
    $('statLives').textContent = d.lives ?? '—';
    $('statParses').textContent = d.parses ?? '—';
    $('statSources').textContent = d.sourceCount ?? '—';

    const time = $('updateTime');

    if (d.lastUpdate && d.lastUpdate !== 'never') {
      const date = new Date(d.lastUpdate);
      const now = new Date();
      const diffH = (now - date) / 3.6e6;
      const fmt = date.toLocaleString('zh-CN', {
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit',
        hour12: false
      });

      time.textContent = fmt;
      time.className = 'update-time' + (diffH > 26 ? ' stale' : '');
    } else {
      time.textContent = "从未更新";
      time.className = 'update-time never';
    }

    // Render warnings
    const banner = $('warningBanner');
    const warnings = d.warnings || [];
    if (d.dirtyMarker) {
      warnings.unshift('dirty_marker');
    }
    if (warnings.length > 0) {
      const WARN_MESSAGES = {
        docker_no_base_url: '检测到 Docker 环境但未配置 BASE_URL，JAR 代理地址可能不可达。<br>请在 docker-compose.yml 中设置 <b>BASE_URL=http://宿主机IP:端口</b>',
        dirty_marker: '⏸ 配置有未应用的更改，下次聚合时将自动清除并重新聚合',
      };
      banner.innerHTML = warnings.map(w => '<div class="warning-banner">' + (WARN_MESSAGES[w] || '⚠ ' + w) + '</div>').join('');
    } else {
      banner.innerHTML = '';
    }
  } catch (e) {
    $('updateTime').textContent = "获取状态失败";
    $('updateTime').className = 'update-time never';
  }
}


function copyUrl(elementId) {
  const text = $(elementId).textContent;
  const btn = $(elementId).parentElement.querySelector('.copy-btn');
  function onOk() {
    btn.textContent = "已复制!";
    btn.className = 'copy-btn copied';
    setTimeout(() => { btn.textContent = "复制"; btn.className = 'copy-btn'; }, 2000);
  }
  function onFail() {
    btn.textContent = "失败";
    btn.className = 'copy-btn error';
    setTimeout(() => { btn.textContent = "复制"; btn.className = 'copy-btn'; }, 2000);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onOk).catch(() => {
      fallbackCopy(text) ? onOk() : onFail();
    });
  } else {
    fallbackCopy(text) ? onOk() : onFail();
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  return ok;
}

const STATUS_LABELS = {
  ok:'OK', http_error:'HTTP ERR', decode_error:'DECODE ERR',
  parse_error:'PARSE ERR', timeout:'TIMEOUT', network_error:'NET ERR'
};

async function loadSearchQuotaSummary() {
  try {
    const res = await fetch('/search-quota/summary');
    if (!res.ok) return;
    const d = await res.json();
    if (!d.enabled) {
      $('searchQuotaSection').style.display = 'none';
      return;
    }
    $('searchQuotaSection').style.display = '';
    $('sqActiveCount').textContent = d.searchable || 0;
    $('sqExcludedCount').textContent = (d.jsExcluded || 0) + (d.truncated || 0);

    const tbody = $('sqTableBody');
    let html = '';
    html += '<tr><td>Total</td><td colspan="3">' + (d.totalSites || '-') + ' sites</td></tr>';
    html += '<tr><td>JS excluded</td><td colspan="3">' + (d.jsExcluded || 0) + '</td></tr>';
    html += '<tr><td>Pinned</td><td colspan="3">' + (d.pinnedCount || 0) + '</td></tr>';
    if (d.truncated > 0) html += '<tr><td>Truncated</td><td colspan="3">' + d.truncated + '</td></tr>';
    html += '<tr style="font-weight:600"><td>Searchable</td><td colspan="3">' + (d.searchable || 0) + '</td></tr>';
    tbody.innerHTML = html;
  } catch {}
}
function escDash(s) { const d = document.createElement('div'); d.textContent = s || '-'; return d.innerHTML; }

async function loadSourceHealth() {
  try {
    const res = await fetch('/source-status');
    const records = await res.json();

    let ok = 0, warn = 0, err = 0;
    records.forEach(r => {
      if (r.latestStatus === 'parse_error' || r.consecutiveFailures >= 5) err++;
      else if (r.consecutiveFailures >= 3) warn++;
      else ok++;
    });

    $('healthOk').textContent = ok;
    $('healthWarn').textContent = warn;
    $('healthError').textContent = err;

    records.sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);
    renderHealthTable(records);

    // 智能折叠：有 error 级别时自动展开
    const toggle = $('healthToggle');
    const body = $('healthBody');
    if (err > 0 && !toggle.classList.contains('open')) {
      toggle.classList.add('open');
      body.classList.add('open');
    }
  } catch {
    $('healthTableBody').innerHTML =
      '<tr><td colspan="6" class="empty">' + "获取状态失败" + '</td></tr>';
  }
}

function renderHealthTable(records) {
  if (!records.length) {
    $('healthTableBody').innerHTML =
      '<tr><td colspan="6" class="empty">' + "暂无健康数据" + '</td></tr>';
    return;
  }

  $('healthTableBody').innerHTML = records.map(r => {
    const level = r.latestStatus === 'parse_error' ? 'error'
               : r.consecutiveFailures >= 5 ? 'error'
               : r.consecutiveFailures >= 3 ? 'warn' : 'ok';
    const statusLabel = STATUS_LABELS[r.latestStatus] || r.latestStatus;

    const lastOk = r.lastSuccessTime
      ? new Date(r.lastSuccessTime).toLocaleString('zh-CN', {
          month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
        })
      : "--";

    return '<tr class="row-' + level + '">' +
      '<td><span class="health-dot ' + level + '"></span></td>' +
      '<td>' + esc(r.name || 'Unnamed') + '</td>' +
      '<td class="url-cell" title="' + esc(r.url) + '">' + esc(r.url) + '</td>' +
      '<td class="status-' + level + '">' + statusLabel + '</td>' +
      '<td>' + r.consecutiveFailures + '</td>' +
      '<td>' + lastOk + '</td>' +
    '</tr>';
  }).join('');
}

async function triggerRefresh() {
  const btn = $('refreshBtn');
  btn.textContent = "运行中...";
  btn.className = 'btn btn-sm loading';
  try {
    const res = await auth.authFetch('/refresh', { method: 'POST' });
    const d = await res.json();
    if (d.success) {
      toast("同步已开始");
      setTimeout(loadStatus, 3000);
    } else {
      toast("刷新失败", 'error');
    }
  } catch {
    toast("网络错误", 'error');
  }
  setTimeout(() => {
    btn.textContent = "立即聚合";
    btn.className = 'btn btn-sm';
  }, 3000);
}

applyTheme(getTheme());
</script>
</body>
</html>`;
