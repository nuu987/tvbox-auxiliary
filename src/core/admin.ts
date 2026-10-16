import { sharedStyles } from './shared-styles';
import { sharedUi } from './shared-ui';
import { footerHtml } from './shared-footer';

export const adminHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TVBox Auxiliary - Admin</title>
<style>
${sharedStyles}

/* Admin-specific: action bar in header */
.agg-bar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  margin-top:16px;
  padding:12px 16px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;
  font-family:var(--mono);
  font-size:0.75rem;
  color:var(--text-dim);
}

.agg-bar .status-text{font-family:var(--mono);font-size:0.75rem;color:var(--text-dim)}
.agg-bar .status-text.success{color:var(--green)}
.agg-bar .status-text.error{color:var(--red)}

/* Inline form label */
.form-label{
  font-family:var(--mono);
  font-size:0.65rem;
  color:var(--text-dim);
  text-transform:uppercase;
  letter-spacing:0.1em;
  display:block;
  margin-bottom:4px;
}

/* Name transform grid */
.nt-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px;
  margin-bottom:10px;
}

.nt-input{
  width:100%;
  font-family:var(--mono);
  font-size:0.8rem;
  padding:8px 12px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  outline:none;
  transition:border-color 0.2s;
}

.nt-input:focus{border-color:var(--green)}

.nt-textarea{
  width:100%;
  min-height:60px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:8px 12px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
  outline:none;
}

.nt-textarea:focus{border-color:var(--green)}


/* Complete operation diagnostics; no ellipsis or fixed-height clipping. */
.source-operation-result{white-space:pre-wrap;overflow-wrap:anywhere;overflow:visible;min-width:0;margin:12px 0 16px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text-dim);font-family:var(--mono);font-size:0.75rem;line-height:1.6}
.source-operation-result:empty{display:none}
.source-operation-result.error{color:var(--red);background:var(--red-dim);border-color:var(--red-dim)}
.source-operation-result.success{color:var(--green);background:var(--green-dim);border-color:var(--green-dim)}
.compact-source-form input{min-width:0;max-width:100%}
.compact-source-form .name-input{flex:0 0 12%;width:12%;min-width:72px;max-width:none;padding-inline:8px}
@media(max-width:560px){
  .compact-source-form{display:grid;grid-template-columns:minmax(72px,12%) minmax(0,1fr)}
  .compact-source-form .name-input{width:100%}
  .compact-source-form .btn{grid-column:2;justify-self:end}
}
#panelSources .source-import-toggle{width:100%;border:0;background:transparent;text-align:left;padding:17px 0;margin-top:8px;font-size:0.75rem;font-weight:600;letter-spacing:normal;color:var(--text)}
#panelSources .source-import-toggle:hover{color:var(--text-bright)}
#panelSources .source-import-toggle:focus-visible{outline:2px solid var(--green);outline-offset:2px;border-radius:4px}
.source-import-panel{margin-top:0;margin-bottom:12px}
.source-add-description,.source-import-description{font-family:var(--mono);font-size:0.75rem;font-weight:400;line-height:1.6;color:var(--text-dim);padding:0 0 12px;margin:0;overflow-wrap:anywhere}
.source-import-actions{display:flex;align-items:center;gap:8px;margin:8px 0 15px}

/* Import textarea */
.import-textarea{
  width:100%;
  min-height:190px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:10px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;
  color:var(--text-bright);
  resize:vertical;
  box-sizing:border-box;
}
.import-textarea:focus{outline:none;border-color:var(--green)}

/* Batch textarea */
.batch-textarea{
  width:100%;
  margin-top:8px;
  min-height:120px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:10px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
}

/* Source health dot in list items */
.source-health-dot{
  width:8px;height:8px;
  border-radius:50%;
  flex-shrink:0;
  position:relative;
  cursor:default;
}

.source-health-dot.ok{
  background:var(--green);
  box-shadow:0 0 4px var(--green-glow);
}

.source-health-dot.warn{
  background:var(--amber);
  box-shadow:0 0 4px var(--amber-dim);
}

.source-health-dot.error{
  background:var(--red);
  box-shadow:0 0 4px var(--red-dim);
}

.source-health-dot.unknown{
  background:var(--text-dim);
}

.source-item{position:relative}

:is(#sourceList, #liveList) .source-status,
:is(#sourceList, #liveList) .source-reason,
:is(#sourceList, #liveList) .source-cache-time{
  font-family:var(--mono);
  font-size:0.7rem;
  color:var(--text-dim);
}
:is(#sourceList, #liveList) .source-info{overflow:visible}
.source-capacity-hint{margin-bottom:12px;color:var(--text-dim);font-family:var(--mono);font-size:0.7rem;line-height:1.8;overflow-wrap:anywhere}
:is(#sourceList, #liveList) :is(.source-name, .source-url, .source-status, .source-reason, .source-cache-time){
  white-space:normal;
  overflow:visible;
  text-overflow:clip;
  overflow-wrap:anywhere;
}

@media(max-width:560px){
  .nt-grid{grid-template-columns:1fr}
  .tabs{overflow-x:auto;flex-wrap:nowrap}
  .tab{padding:12px 14px;font-size:0.65rem}
}

.tab.disabled{color:var(--text-dim);opacity:0.4;cursor:not-allowed;pointer-events:none}
</style>
<script>(function(){var t=localStorage.getItem('theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
</head>
<body>

<!-- Login -->
<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h2>管理登录</h2>
    <p>TVBox Auxiliary 管理</p>
    <div class="error-msg" id="loginError">无效的令牌</div>
    <input type="password" id="loginInput" placeholder="请输入管理令牌" autocomplete="off">
    <button class="btn" style="width:100%" onclick="auth.doLogin()">登录</button>
  </div>
</div>

<!-- Main content -->
<div class="container" id="mainContent" style="display:none">
  <header class="header">
    <div class="header-top">
      <h1 class="header-title">TVBox <span>Auxiliary</span></h1>
      <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()">🌙</button>
    </div>
    <nav class="header-nav">
      <a href="/status">首页</a>
      <a href="/admin" class="active">接口管理</a>
      <a href="/admin/config-editor">配置编辑</a>
    </nav>
  </header>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" data-tab="sources" onclick="switchTab('sources')"><span>接口</span> <span class="badge" id="badgeSources">0</span></div>
    <div class="tab" data-tab="maccms" onclick="switchTab('maccms')"><span>MacCMS</span> <span class="badge" id="badgeMacCMS">0</span></div>
    <div class="tab" data-tab="live" onclick="switchTab('live')"><span>直播</span> <span class="badge" id="badgeLive">0</span></div>
    <div class="tab" data-tab="searchQuota" onclick="switchTab('searchQuota')" id="tabSearchQuota" style="display:none"><span>搜索</span> <span class="badge" id="badgeSearchQuota">0</span></div>
    <div class="tab" data-tab="settings" onclick="switchTab('settings')"><span>设置</span></div>
    <div class="tab" data-tab="logs" onclick="switchTab('logs')"><span>日志</span></div>
  </div>

  <!-- Sources Tab -->
  <div class="tab-panel active" id="panelSources">
    <!-- Add source -->
    <div class="section">
      <div class="section-title">添加单仓接口</div>
      <p class="source-add-description" id="sourceAddDescription">配置接口名称后，在配置编辑页面中将显示点播站点对应的来源接口</p>
      <div class="add-form compact-source-form">
        <input class="name-input" type="text" id="addName" placeholder="名称(可选)" aria-describedby="sourceAddDescription">
        <input type="url" id="addUrl" placeholder="接口网址">
        <button class="btn" id="addBtn" onclick="addSource()" disabled>添加</button>
      </div>
      <div id="addResult" class="source-operation-result" role="status" aria-live="polite"></div>
      <!-- Import (collapsible) -->
      <button type="button" class="collapsible-toggle source-import-toggle" aria-expanded="false" aria-controls="sourceImportPanel" onclick="toggleCollapsible(this);this.setAttribute('aria-expanded',this.classList.contains('open'))">高级添加</button>
      <div class="collapsible-body source-import-panel" id="sourceImportPanel">
        <p class="source-import-description" id="sourceImportDescription">支持多条单仓、多条多仓或原始多仓 JSON 三种格式的分别导入。不支持嵌套多仓。</p>
        <textarea id="importInput" class="import-textarea" aria-label="接口导入内容" aria-describedby="sourceImportDescription"></textarea>
        <div id="importResult" class="source-operation-result" role="status" aria-live="polite"></div>
        <div class="source-import-actions">
          <button class="btn btn-sm" id="importBtn" onclick="importConfig()" disabled>导入</button>
        </div>
      </div>
    </div>

    <!-- Source list -->
    <div class="section">
      <div class="section-title">
        <span>接口列表</span>
        <span class="count" id="sourceCount">0</span>
      </div>
      <div id="sourceCapacityHint" class="source-capacity-hint" hidden></div>
      <div class="source-list" id="sourceList">
        <div class="empty">Loading sources...</div>
      </div>
    </div>
  </div>

  <!-- MacCMS Tab -->
  <div class="tab-panel" id="panelMaccms">
    <!-- Add MacCMS -->
    <div class="section">
      <div class="section-title">添加 MacCMS 源</div>
      <div class="add-form">
        <input class="name-input" type="text" id="mcKey" placeholder="Key（如 hongniuzy）">
        <input class="name-input" type="text" id="mcName" placeholder="名称">
        <input type="url" id="mcApi" placeholder="MacCMS API 地址">
        <button class="btn" id="mcAddBtn" onclick="addMacCMS()">添加</button>
      </div>
      <!-- Batch import (collapsible) -->
      <div class="collapsible-toggle" onclick="toggleCollapsible(this)">批量导入</div>
      <div class="collapsible-body">
        <textarea id="mcBatchInput" class="batch-textarea" placeholder='[{"key":"...","name":"...","api":"..."}]'></textarea>
        <button class="btn btn-sm" style="margin-top:8px" id="mcBatchBtn" onclick="batchImportMacCMS()">提交批量</button>
      </div>
    </div>

    <!-- MacCMS list -->
    <div class="section">
      <div class="section-title">
        <span>MacCMS 源列表</span>
        <span class="count" id="mcCount">0</span>
      </div>
      <div class="source-list" id="mcList">
        <div class="empty">Loading MacCMS sources...</div>
      </div>
    </div>
  </div>

  <!-- Live Tab -->
  <div class="tab-panel" id="panelLive">
    <!-- Add live source -->
    <div class="section">
      <div class="section-title">添加直播源</div>
      <div class="add-form compact-source-form">
        <input class="name-input" type="text" id="liveName" placeholder="名称（如 iptv365）">
        <input type="url" id="liveUrl" placeholder="m3u/txt 地址">
        <button class="btn" id="liveAddBtn" onclick="addLive()">添加</button>
      </div>
    </div>

    <!-- Live list -->
    <div class="section">
      <div class="section-title">
        <span>直播源列表</span>
        <span class="count" id="liveCount">0</span>
      </div>
      <div class="source-list" id="liveList">
        <div class="empty">Loading live sources...</div>
      </div>
    </div>

  </div>

  <!-- Search Quota Tab -->
  <div class="tab-panel" id="panelSearchQuota">
    <div class="section">
      <div class="section-title">活跃搜索源</div>
      <div id="sqSelectedInfo" style="margin-bottom:8px;font-size:0.8rem;color:var(--text-secondary)"></div>
      <div id="sqSelectedTable" style="max-height:500px;overflow:auto">
        <div style="color:var(--text-secondary);font-size:0.85rem">执行同步后查看结果</div>
      </div>
    </div>
  </div>


  <!-- Settings Tab -->
  <div class="tab-panel" id="panelSettings">
    <!-- Sync Schedule -->
    <div class="section">
      <div class="section-title">同步频率</div>
      <div id="syncScheduleForm" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="syncPeriod" class="nt-input" style="width:auto;min-width:120px" onchange="onSyncPeriodChange()">
          <option value="disabled">禁用</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
        </select>
        <input type="time" id="syncTime" value="05:00" class="nt-input" style="width:auto">
        <select id="syncDayOfWeek" class="nt-input" style="width:auto;min-width:90px;display:none">
          <option value="1">周一</option>
          <option value="2">周二</option>
          <option value="3">周三</option>
          <option value="4">周四</option>
          <option value="5">周五</option>
          <option value="6">周六</option>
          <option value="0">周日</option>
        </select>
        <button class="btn btn-sm" id="syncSaveBtn" onclick="saveSyncSchedule()">保存</button>
      </div>
      <div id="syncEnvNotice" style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary);display:none">
        环境变量已设定，禁用手动设置聚合时间
      </div>
    </div>

    <div class="section">
      <div class="section-title">高级设置</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="smartJarUrlCheck" onchange="saveSmartJarUrl()">
          <span>智能响应静态资源地址</span>
        </label>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary)">使用请求体头部中的主机信息为该客户端动态生成静态资源地址，注意潜在的安全风险，默认不支持非局域网访问（请设置环境变量：DMZ=0）</div>

      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="liveDisabledCheck" onchange="saveLiveDisabled()">
          <span>禁用接口提供的直播源</span>
        </label>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary)">启用后忽略接口提供的直播源并锁定配置编辑，手动添加的不受影响</div>
    </div>

    <div class="section">
      <div class="section-title">边缘函数代理</div>
      <div style="margin-bottom:6px;font-size:0.8rem;color:var(--text-secondary)">配置边缘函数 URL，用于本地 Docker 模式的请求代理回退和图片 CDN 加速</div>
      <div class="nt-grid">
        <div>
          <label class="form-label">Fetch Proxy URL</label>
          <input type="text" id="edgeFetchProxyUrl" class="nt-input" placeholder="https://tvbox.example.com">
        </div>
        <div>
          <label class="form-label">Vercel Proxy URL</label>
          <input type="text" id="edgeVercelUrl" class="nt-input" placeholder="https://fetch.example.com">
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button class="btn btn-sm" id="edgeProxiesSaveBtn" onclick="saveEdgeProxies()">保存</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">搜索配额</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="form-label" style="margin:0">可搜索源上限</label>
        <input type="number" id="maxSearchableInput" class="nt-input" style="width:80px" min="0" max="1000" value="0">
        <button class="btn btn-sm" id="searchQuotaSaveBtn" onclick="saveSearchQuota()">保存</button>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary)">限制可搜索源数量，减少 TVBox 搜索崩溃。0 = 不限制。置顶源在搜索页签管理。</div>
    </div>

    <div class="section">
      <div class="section-title">名称定制</div>
      <div class="nt-grid">
        <div>
          <label class="form-label">前缀</label>
          <input type="text" id="ntPrefix" class="nt-input" placeholder="如 【RioTV】">
        </div>
        <div>
          <label class="form-label">后缀</label>
          <input type="text" id="ntSuffix" class="nt-input" placeholder="如  · 精选">
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" id="ntSaveBtn" onclick="saveNameTransform()">保存</button>
      </div>
    </div>
  </div>

  <!-- Logs Tab (Phase 6 VIEWER-03 / Plan 03) -->
  <div class="tab-panel" id="panelLogs">
    <div class="section">
      <div class="section-title">实时日志</div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="logAutoScroll" checked>
          <span>自动滚动</span>
        </label>
        <span class="status-text" id="logConnStatus" style="font-family:var(--mono);font-size:0.75rem">未连接</span>
      </div>
      <div id="logViewer" class="log-viewer"></div>
    </div>
  </div>

  ${footerHtml}
</div>

<script>
${sharedUi}


// --- Auth ---
const auth = initAuth('loginInput', 'loginError', 'loginOverlay', 'mainContent', '/admin/sources', loadAll);

// --- Tab switching ---
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => {
    const id = 'panel' + tab.charAt(0).toUpperCase() + tab.slice(1);
    p.classList.toggle('active', p.id === id);
  });
  // Phase 6 VIEWER-03 (Plan 03): logs tab SSE 生命周期管理（D-17）
  // 切到 logs 时延迟初始化 SSE 连接，切走时主动 abort 释放（Pitfall 4 防泄漏）
  if (tab === 'logs') startLogStream();
  else stopLogStream();
  if (tab === 'live') loadLives();
}

// --- Source health ---
let healthMap = {};
let sourceListRequest = 0;
let sourceLimitValue = null;
let sourceTotal = 0;
let sourceOperationBusy = false;
function updateSourceCapacityControls() {
  const full = sourceLimitValue !== null && sourceLimitValue > 0 && sourceTotal >= sourceLimitValue;
  const disabled = sourceOperationBusy || sourceLimitValue === null || full;
  $('addBtn').disabled = disabled;
  $('importBtn').disabled = disabled;
  document.querySelectorAll('#sourceList [data-source-delete]').forEach(button => { button.disabled = sourceOperationBusy; });
  const hint = $('sourceCapacityHint');
  hint.hidden = !full;
  hint.textContent = full ? '接口数量已达到上限（' + sourceLimitValue + '），请删除至上限以下后再添加。'
    + (sourceTotal > sourceLimitValue ? ' 本轮仅聚合列表前 ' + sourceLimitValue + ' 条；旧结果在新聚合成功前保持。' : '') : '';
}
function sourceCapacityFeedback(data) {
  const capacity = data.capacity;
  if (capacity && Number.isSafeInteger(capacity.limit) && capacity.limit >= 0
      && Number.isSafeInteger(capacity.current) && capacity.current >= 0) {
    ++sourceListRequest; // A pre-mutation GET cannot overwrite the confirmed capacity.
    sourceLimitValue = capacity.limit;
    sourceTotal = capacity.current;
    $('sourceCount').textContent = capacity.limit > 0 ? capacity.current + '/' + capacity.limit : capacity.current;
    $('badgeSources').textContent = capacity.current;
    updateSourceCapacityControls();
  }
  if (data.code === 'source_limit_exceeded' || (data.capacity && data.capacity.rejected > 0)) {
    toast('接口数量超出上限（' + data.capacity.limit + '），未添加接口。', 'error');
  }
}

async function loadSourceHealth() {
  try {
    const res = await fetch('/source-status');
    // Plan 03.1 D-11: 后端返回 { records, summary }，前端只取 records
    const { records } = await res.json();
    healthMap = {};
    records.forEach(r => { healthMap[r.url] = r; });
  } catch {
    healthMap = {};
  }
}

// --- Load data ---
async function loadAll() {
  await loadSourceHealth();
  loadSources();
  loadMacCMS();
  loadLives();
  loadNameTransform();
  loadSyncSchedule();
  loadSmartJarUrl();
  loadLiveDisabled();
  loadEdgeProxies();
  loadSearchQuota();
}

async function loadSources() {
  const request = ++sourceListRequest;
  const list = $('sourceList');
  try {
    const res = await auth.authFetch('/admin/sources');
    if (!res.ok) throw new Error('Load failed');
    const rawLimit = res.headers.get('X-Max-Data-Sources');
    if (rawLimit === null || !/^\\d+$/.test(rawLimit)) throw new Error('Missing capacity');
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit)) throw new Error('Invalid capacity');
    const sources = await res.json();
    if (request !== sourceListRequest) return;
    if (!Array.isArray(sources)) throw new Error('Invalid sources');
    sourceLimitValue = limit;
    sourceTotal = sources.length;
    $('sourceCount').textContent = limit > 0 ? sources.length + '/' + limit : sources.length;
    $('badgeSources').textContent = sources.length;
    updateSourceCapacityControls();

    if (sources.length === 0) {
      list.innerHTML = '<div class="empty">' + "暂无源。请在上方添加。" + '</div>';
      return;
    }

    list.innerHTML = sources.map((s, index) => {
      const h = limit > 0 && index >= limit ? null : healthMap[s.url];
      // Plan 03.1 D-10: 后端已分类，直接使用 h.status
      const level = h && h.waiting ? 'unknown' : h && h.aggregation && h.aggregation.latest && h.aggregation.latest.reason ? 'error' : !h ? 'unknown'
        : h.status === 'ERR' ? 'error'
        : h.status === 'WARN' ? 'warn'
        : 'ok';
      const a = h && h.aggregation;
      const latest = a && a.latest;
      const saved = a && a.lastSuccessful;
      const reason = (latest && latest.reason) || (h && h.status !== 'OK' && h.lastFailReason) || '';
      const cached = !!(reason && latest && latest.mode === 'restored');
      const status = !h ? '暂无数据'
        : h.waiting ? '等待聚合'
        : h.local ? (reason || h.status !== 'OK' ? '本地配置不可用' : '本地配置正常')
        : h.status === 'OK' && reason ? '配置不可用（获取 OK）' : h.label || h.status;
      const statusLine = '<div class="source-status">状态：' + esc(status) +
        (h && !h.waiting && !h.local && h.status !== 'OK' ? ' · 连续失败 ' + esc(String(h.consecutiveFailures || 0)) : '') + '</div>';
      const reasonLine = reason ? '<div class="source-reason">原因：' + esc(reason) + (cached ? ' · 已缓存' : '') + '</div>' : '';
      const cacheTime = cached && saved && saved.fallbackApplied && saved.snapshotTime
        ? '<div class="source-cache-time">已缓存的最后成功聚合时间：' + esc(saved.snapshotTime) + '</div>' : '';

      return \`<div class="source-item">
        <span class="source-health-dot \${level}"></span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name || s.url)}\${s.configKey ? ' 🔑' : ''}</div>
          <div class="source-url">\${esc(s.url)}</div>
          \${statusLine}\${reasonLine}\${cacheTime}
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-danger" data-source-delete data-url="\${esc(s.url)}" onclick="removeSource(this.dataset.url)" \${sourceOperationBusy ? 'disabled' : ''}>\${"删除"}</button>
        </div>
      </div>\`;
    }).join('');
  } catch {
    if (request !== sourceListRequest) return;
    if (sourceLimitValue === null) list.innerHTML = '<div class="empty">' + "加载源失败" + '</div>';
    updateSourceCapacityControls();
  }
}

// --- Final operation results ---
function renderSourceImportResult(element, data) {
  element.className = 'source-operation-result' + (data.error || data.outcome === 'none' ? ' error' : ' success');
  if (data.error) { element.textContent = '导入出错：' + data.error; return; }
  const lines = [(data.type === 'multi' ? '多仓导入：' : '') + '新增 ' + data.added + '，重复 ' + data.duplicates + '，跳过 ' + (data.skipped || []).length];
  if (data.outcome === 'none') lines.unshift('导入出错：未能导入任何接口');
  for (const item of data.skipped || []) lines.push([item.name, item.url].filter(Boolean).join(' · ') + '：' + item.reason);
  element.textContent = lines.join('\\n');
}
// --- Add source ---
async function addSource() {
  const btn = $('addBtn');
  if (btn.disabled || sourceOperationBusy) return;
  const url = $('addUrl').value.trim();
  if (!url) { $('addUrl').focus(); return; }
  const name = $('addName').value.trim() || '';
  const result = $('addResult');
  sourceOperationBusy = true;
  updateSourceCapacityControls();
  btn.textContent = '检查中';
  btn.className = 'btn loading';
  result.className = 'source-operation-result';
  result.textContent = '检查中，请等待完成';
  try {
    const res = await auth.authFetch('/admin/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url })
    });
    const d = await res.json();
    sourceCapacityFeedback(d);
    renderSourceImportResult(result, res.ok ? d : { error: d.error || '添加失败' });
    if (res.ok && d.added > 0) {
      if (!(d.skipped || []).length) {
        $('addUrl').value = ''; $('addName').value = '';
      }
      await loadSourceHealth();
      await loadSources();
    }
    else if (res.status === 409) await loadSources();
  } catch { renderSourceImportResult(result, { error: '网络错误' }); }
  finally { sourceOperationBusy = false; btn.textContent = '添加'; btn.className = 'btn'; updateSourceCapacityControls(); }
}

// --- Remove source ---
async function removeSource(url) {
  if (sourceOperationBusy) return;
  sourceOperationBusy = true;
  updateSourceCapacityControls();
  try {
    const res = await auth.authFetch('/admin/sources', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) {
      sourceCapacityFeedback(await res.json());
      toast("源已删除");
      await loadSources();
    } else {
      const d = await res.json();
      toast(d.error || "删除", 'error');
    }
  } catch {
    toast("网络错误", 'error');
  } finally { sourceOperationBusy = false; updateSourceCapacityControls(); }
}

// --- MacCMS ---
async function loadMacCMS() {
  const list = $('mcList');
  try {
    const res = await auth.authFetch('/admin/maccms');
    const sources = await res.json();
    $('mcCount').textContent = sources.length;
    $('badgeMacCMS').textContent = sources.length;

    if (sources.length === 0) {
      list.innerHTML = '<div class="empty">' + "暂无 MacCMS 源。请在上方添加。" + '</div>';
      return;
    }

    list.innerHTML = sources.map(s => \`
      <div class="source-item">
        <span class="source-tag manual">\${esc(s.key)}</span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name)}</div>
          <div class="source-url">\${esc(s.api)}</div>
        </div>
        <div class="source-actions" style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="validateMC('\${esc(s.api)}')">\${"测试"}</button>
          <button class="btn btn-sm btn-danger" onclick="removeMC('\${esc(s.key)}')">\${"删除"}</button>
        </div>
      </div>
    \`).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + "加载 MacCMS 源失败" + '</div>';
  }
}

async function addMacCMS() {
  const key = $('mcKey').value.trim();
  const name = $('mcName').value.trim();
  const api = $('mcApi').value.trim();
  if (!key || !name || !api) { toast("所有字段必填", 'error'); return; }

  const btn = $('mcAddBtn');
  btn.textContent = "添加中...";
  btn.className = 'btn loading';

  try {
    const res = await auth.authFetch('/admin/maccms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, name, api })
    });
    const d = await res.json();
    if (res.ok) {
      toast('Added ' + (d.added || 1) + ' MacCMS source(s)');
      $('mcKey').value = '';
      $('mcName').value = '';
      $('mcApi').value = '';
      loadMacCMS();
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch { toast("网络错误", 'error'); }

  btn.textContent = "添加";
  btn.className = 'btn';
}

async function removeMC(key) {
  try {
    const res = await auth.authFetch('/admin/maccms', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    if (res.ok) { toast('Removed'); loadMacCMS(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch { toast("网络错误", 'error'); }
}

async function validateMC(api) {
  toast("测试中...");
  try {
    const res = await auth.authFetch('/admin/maccms/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api })
    });
    const d = await res.json();
    toast(d.valid ? "有效" : "无效/不可达", d.valid ? 'success' : 'error');
  } catch { toast("网络错误", 'error'); }
}

async function batchImportMacCMS() {
  const raw = $('mcBatchInput').value.trim();
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch { toast("无效的 JSON", 'error'); return; }
  if (!Array.isArray(data)) { toast("必须是 JSON 数组", 'error'); return; }

  try {
    const res = await auth.authFetch('/admin/maccms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const d = await res.json();
    if (res.ok) {
      toast('Imported ' + (d.added || 0) + ' source(s)');
      $('mcBatchInput').value = '';
      loadMacCMS();
    } else {
      toast(d.error || "导入失败", 'error');
    }
  } catch { toast("网络错误", 'error'); }
}

// --- Live Sources ---
let liveListRequest = 0;
function liveSourceRow(s) {
  const status = s.cacheStatus || { level: 'unknown', label: '等待聚合' };
  const level = ['ok', 'warn', 'error', 'unknown'].includes(status.level) ? status.level : 'unknown';
  const reason = status.reason && level !== 'ok' ? status.reason : '';
  const count = level !== 'ok' && status.failures > 0 ? ' · 连续失败 ' + esc(String(status.failures)) : '';
  return '<div class="source-item">'
    + '<span class="source-health-dot ' + level + '"></span>'
    + '<div class="source-info">'
    + '<div class="source-name">' + esc(s.name || 'Unnamed') + '</div>'
    + '<div class="source-url">' + esc(s.url) + '</div>'
    + '<div class="source-status">状态：' + esc(status.label) + count + '</div>'
    + (reason ? '<div class="source-reason">原因：' + esc(reason) + (status.cached ? ' · 已缓存' : '') + '</div>' : '')
    + (reason && status.cached && status.cacheTime ? '<div class="source-cache-time">最后缓存时间：' + esc(status.cacheTime) + '</div>' : '')
    + '</div><div class="source-actions">'
    + '<button class="btn btn-sm btn-danger" data-url="' + escAttr(s.url) + '" onclick="removeLive(this.dataset.url)">删除</button>'
    + '</div></div>';
}
async function loadLives() {
  const request = ++liveListRequest;
  const list = $('liveList');
  try {
    const res = await auth.authFetch('/admin/lives');
    if (!res.ok) throw new Error('Load failed');
    const entries = await res.json();
    if (request !== liveListRequest) return;
    $('liveCount').textContent = entries.length;
    $('badgeLive').textContent = entries.length;
    list.innerHTML = entries.length ? entries.map(liveSourceRow).join('')
      : '<div class="empty">暂无直播源。请在上方添加。</div>';
  } catch {
    if (request === liveListRequest && !list.querySelector('.source-item')) {
      list.innerHTML = '<div class="empty">加载直播源失败</div>';
    }
  }
}

async function addLive() {
  const url = $('liveUrl').value.trim();
  if (!url) { $('liveUrl').focus(); return; }
  const name = $('liveName').value.trim() || '';

  const btn = $('liveAddBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "添加中...";
  btn.className = 'btn loading';

  try {
    const res = await auth.authFetch('/admin/lives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url })
    });
    const d = await res.json();
    if (res.ok) {
      toast("直播源已添加");
      $('liveUrl').value = '';
      $('liveName').value = '';
      loadLives();
    } else {
      toast(d.error || 'Failed to add', 'error');
    }
  } catch {
    toast("网络错误", 'error');
  }

  btn.textContent = "添加";
  btn.className = 'btn';
  btn.disabled = false;
}

async function removeLive(url) {
  try {
    const res = await auth.authFetch('/admin/lives', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) { toast("已删除"); loadLives(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch { toast("网络错误", 'error'); }
}

// --- Import Config ---
async function importConfig() {
  const btn = $('importBtn');
  if (btn.disabled || sourceOperationBusy) return;
  const input = $('importInput').value.trim();
  if (!input) { $('importInput').focus(); return; }
  const result = $('importResult');
  sourceOperationBusy = true;
  updateSourceCapacityControls();
  btn.textContent = '检查中';
  btn.className = 'btn btn-sm loading';
  result.className = 'source-operation-result';
  result.textContent = '检查中，请等待完成';
  try {
    const res = await auth.authFetch('/admin/sources/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input })
    });
    const d = await res.json();
    sourceCapacityFeedback(d);
    renderSourceImportResult(result, res.ok ? d : { error: d.error || '解析失败' });
    if (res.ok && d.added > 0) {
      if (!(d.skipped || []).length) $('importInput').value = '';
      await loadSourceHealth();
      await loadSources();
    }
    else if (res.status === 409) await loadSources();
  } catch { renderSourceImportResult(result, { error: '网络错误' }); }
  finally { sourceOperationBusy = false; btn.textContent = '导入'; btn.className = 'btn btn-sm'; updateSourceCapacityControls(); }
}

// Settings saves are silent; the disabled control prevents overlapping writes.
async function saveSetting(control, url, data) {
  if (control.disabled) return false;
  control.disabled = true;
  try {
    const res = await auth.authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    control.disabled = false;
  }
}

// --- Name Transform ---
async function loadNameTransform() {
  try {
    const res = await auth.authFetch('/admin/name-transform');
    if (!res.ok) return;
    const d = await res.json();
    $('ntPrefix').value = d.prefix || '';
    $('ntSuffix').value = d.suffix || '';
  } catch {}
}

async function saveNameTransform() {
  await saveSetting($('ntSaveBtn'), '/admin/name-transform', {
    prefix: $('ntPrefix').value || '',
    suffix: $('ntSuffix').value || '',
  });
}

// --- Sync Schedule ---
function onSyncPeriodChange() {
  const period = $('syncPeriod').value;
  $('syncTime').style.display = period === 'disabled' ? 'none' : '';
  $('syncDayOfWeek').style.display = period === 'weekly' ? '' : 'none';
}

async function loadSyncSchedule() {
  try {
    const res = await auth.authFetch('/admin/cron-interval');
    if (!res.ok) return;
    const d = await res.json();
    const s = d.schedule || { period: 'disabled', hour: 5, minute: 0 };
    $('syncPeriod').value = s.period || 'disabled';
    const hh = String(s.hour != null ? s.hour : 5).padStart(2, '0');
    const mm = String(s.minute != null ? s.minute : 0).padStart(2, '0');
    $('syncTime').value = hh + ':' + mm;
    if (s.dayOfWeek !== undefined) $('syncDayOfWeek').value = String(s.dayOfWeek);
    onSyncPeriodChange();
    if (d.hasEnvOverride) {
      $('syncEnvNotice').style.display = '';
      $('syncPeriod').disabled = true;
      $('syncTime').disabled = true;
      $('syncDayOfWeek').disabled = true;
      $('syncSaveBtn').style.display = 'none';
    }
  } catch {}
}

async function saveSyncSchedule() {
  const period = $('syncPeriod').value;
  const parts = ($('syncTime').value || '05:00').split(':');
  const schedule = { period, hour: Number(parts[0]), minute: Number(parts[1]) };
  if (period === 'weekly') schedule.dayOfWeek = parseInt($('syncDayOfWeek').value);
  await saveSetting($('syncSaveBtn'), '/admin/cron-interval', { schedule });
}

// --- Smart JAR URL Toggle ---
async function loadSmartJarUrl() {
  try {
    const res = await auth.authFetch('/admin/smart-jar-url');
    if (res.ok) {
      const d = await res.json();
      $('smartJarUrlCheck').checked = d.enabled;
    }
  } catch {}
}

async function saveSmartJarUrl() {
  const check = $('smartJarUrlCheck');
  if (check.disabled) return;
  const enabled = check.checked;
  if (!await saveSetting(check, '/admin/smart-jar-url', { enabled })) {
    check.checked = !enabled;
  }
}

// --- Live Disabled Toggle ---
async function loadLiveDisabled() {
  try {
    const res = await auth.authFetch('/admin/live-disabled');
    if (res.ok) {
      const d = await res.json();
      $('liveDisabledCheck').checked = d.disabled;
      updateLiveTabState(d.disabled);
    }
  } catch {}
}

function updateLiveTabState(disabled) {
  const liveTab = document.querySelector('.tab[data-tab="live"]');
  if (liveTab) liveTab.classList.remove('disabled');
}

async function saveLiveDisabled() {
  const check = $('liveDisabledCheck');
  if (check.disabled) return;
  const disabled = check.checked;
  if (await saveSetting(check, '/admin/live-disabled', { disabled })) {
    updateLiveTabState(disabled);
  } else {
    check.checked = !disabled;
  }
}

// --- Edge Proxies ---
async function loadEdgeProxies() {
  try {
    const res = await auth.authFetch('/admin/edge-proxies');
    if (res.ok) {
      const d = await res.json();
      $('edgeFetchProxyUrl').value = d.fetchProxy || '';
      $('edgeVercelUrl').value = d.vercel || '';
    }
  } catch {}
}

async function saveEdgeProxies() {
  await saveSetting($('edgeProxiesSaveBtn'), '/admin/edge-proxies', {
    fetchProxy: $('edgeFetchProxyUrl').value.trim(),
    vercel: $('edgeVercelUrl').value.trim(),
  });
}


// --- Search Quota ---
let sqPinnedKeys = new Set();

async function loadSearchQuota() {
  try {
    const res = await auth.authFetch('/admin/search-quota');
    if (!res.ok) return;
    const d = await res.json();
    $('maxSearchableInput').value = d.maxSearchable;
    sqPinnedKeys = new Set(d.pinnedKeys || []);
    loadSearchQuotaReport();
  } catch {}
}

async function saveSearchQuota() {
  await saveSetting($('searchQuotaSaveBtn'), '/admin/search-quota', {
    maxSearchable: parseInt($('maxSearchableInput').value) || 0,
    pinnedKeys: [...sqPinnedKeys],
  });
}

async function loadSearchQuotaReport() {
  try {
    const res = await auth.authFetch('/admin/search-quota/report');
    if (!res.ok) return;
    const d = await res.json();
    if (d.searchable == null) return;

    // 显示 Search 页签
    $('tabSearchQuota').style.display = '';
    $('sqSelectedInfo').textContent = d.totalSites + ' sites → ' + d.jsExcluded + ' JS excluded → ' + d.searchable + ' searchable' + (d.truncated > 0 ? ' (' + d.truncated + ' truncated)' : '') + (d.pinnedCount > 0 ? ', ' + d.pinnedCount + ' pinned' : '');
    $('badgeSearchQuota').textContent = d.searchable;

    // 加载站点列表
    const cfgRes = await fetch('/');
    if (!cfgRes.ok) return;
    const cfg = await cfgRes.json();
    const allSites = (cfg.sites || []).filter(s => s.searchable === 1);
    sqAllSites = allSites;
    renderSearchSources();
  } catch {}
}

let sqAllSites = [];

function renderSearchSources() {
  const pinnedArr = [...sqPinnedKeys];
  const siteMap = new Map(sqAllSites.map(s => [s.key, s]));
  let html = '';

  // 1. Pinned 源（有序，可排序）
  if (pinnedArr.length > 0) {
    html += '<div style="margin-bottom:12px"><strong style="color:var(--primary)">' + "置顶源" + ' (' + pinnedArr.length + ')</strong>';
    html += ' <span style="font-size:0.75rem;color:var(--text-secondary)">— ' + "上下移动排序，排在前面的源在 TVBox 搜索时优先执行" + '</span></div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:0.8rem">';
    pinnedArr.forEach((key, i) => {
      const s = siteMap.get(key);
      const name = s ? (s.name || s.key) : key;
      html += '<tr style="border-bottom:1px solid var(--border);background:var(--bg-hover)">';
      html += '<td style="padding:4px;width:30px;color:var(--text-secondary)">' + (i + 1) + '</td>';
      html += '<td style="padding:4px;font-family:var(--mono);font-size:0.75rem">' + escHtml(key) + '</td>';
      html += '<td style="padding:4px">' + escHtml(name) + '</td>';
      html += '<td style="padding:4px;width:100px;text-align:right;white-space:nowrap">';
      if (i > 0) html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="movePinned(' + i + ',-1)">▲</button> ';
      if (i < pinnedArr.length - 1) html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="movePinned(' + i + ',1)">▼</button> ';
      html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem;color:var(--red)" onclick="togglePin(&quot;' + escHtml(key) + '&quot;)">' + "取消置顶" + '</button>';
      html += '</td></tr>';
    });
    html += '</table>';
  }

  // 2. 其他源（可 pin）
  const unpinned = sqAllSites.filter(s => !sqPinnedKeys.has(s.key));
  html += '<div style="margin-top:16px;margin-bottom:8px"><strong>' + "其他源" + ' (' + unpinned.length + ')</strong></div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:0.8rem">';
  unpinned.slice(0, 200).forEach(s => {
    html += '<tr style="border-bottom:1px solid var(--border)">';
    html += '<td style="padding:4px;font-family:var(--mono);font-size:0.75rem">' + escHtml(s.key) + '</td>';
    html += '<td style="padding:4px">' + escHtml(s.name || s.key) + '</td>';
    html += '<td style="padding:4px;width:50px;text-align:right"><button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="togglePin(&quot;' + escHtml(s.key) + '&quot;)">' + "置顶" + '</button></td>';
    html += '</tr>';
  });
  if (unpinned.length > 200) html += '<tr><td colspan="3" style="padding:4px;color:var(--text-secondary)">... +' + (unpinned.length - 200) + ' more</td></tr>';
  html += '</table>';

  $('sqSelectedTable').innerHTML = html;
}

async function movePinned(index, direction) {
  const arr = [...sqPinnedKeys];
  const target = index + direction;
  if (target < 0 || target >= arr.length) return;
  [arr[index], arr[target]] = [arr[target], arr[index]];
  try {
    const res = await auth.authFetch('/admin/search-quota/pinned', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: arr }),
    });
    if (res.ok) {
      const d = await res.json();
      sqPinnedKeys = new Set(d.pinnedKeys);
      renderSearchSources();
    }
  } catch {}
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function togglePin(key) {
  const isPinned = sqPinnedKeys.has(key);
  try {
    const res = await auth.authFetch('/admin/search-quota/pinned', {
      method: isPinned ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key] }),
    });
    if (res.ok) {
      const d = await res.json();
      sqPinnedKeys = new Set(d.pinnedKeys);
      renderSearchSources();
    }
  } catch {}
}

// --- Refresh ---
async function triggerRefresh() {
  const btn = $('refreshBtn');
  btn.textContent = "运行中...";
  btn.className = 'btn btn-sm loading';

  try {
    const res = await auth.authFetch('/refresh', { method: 'POST' });
    const d = await res.json();
    if (d.success) {
      toast("同步已开始");
      setTimeout(() => { loadSourceHealth(); loadSources(); loadLives(); }, 3000);
    } else {
      toast("刷新失败", 'error');
    }
  } catch {
    toast("网络错误", 'error');
  }

  setTimeout(() => {
    btn.textContent = "刷新";
    btn.className = 'btn btn-sm';
  }, 3000);
}

// --- Phase 6 VIEWER-03 (Plan 03): 实时日志 SSE 客户端 ---
// D-13~D-18 锁定决策：不级别过滤 / DOM 500 / auto-scroll 底部跟随 / 持续实时流 / tab 集成 / 布局
// 端点路径 /admin/logs 与 Plan 02 D-09 一致；token 走 Authorization 头（D-11）
let logSseHandle = null;
let logStreamGeneration = 0;
let logRetryTimer = null;
const LOG_DOM_MAX = 500;       // D-14: DOM 渲染上限

function startLogStream() {
  if (logSseHandle || !$('panelLogs').classList.contains('active')) return;
  if (logRetryTimer !== null) { clearTimeout(logRetryTimer); logRetryTimer = null; }
  var generation = ++logStreamGeneration;
  var statusEl = $('logConnStatus');
  statusEl.textContent = '连接中...';
  // Reserve ownership before opening; callbacks may run before the handle is returned.
  logSseHandle = { abort: function() {} };
  function isCurrent() {
    return generation === logStreamGeneration && $('panelLogs').classList.contains('active');
  }
  // D-11: streamSse 用 fetch + Authorization 头（不用 EventSource，无法设头）
  var handle = streamSse('/admin/logs', auth.getToken(),
    function(data) { if (isCurrent()) onLogEntry(data); },
    function() {
      if (!isCurrent()) return;
      // Each connection replays full history. Replace only after a successful open.
      var viewer = $('logViewer');
      viewer.textContent = '';
      viewer.scrollTop = 0;
      statusEl.textContent = '已连接';
    },
    function() {
      if (!isCurrent()) return;
      stopLogStream();
      statusEl.textContent = '已断开';
      var retryGeneration = logStreamGeneration;
      logRetryTimer = setTimeout(function() {
        if (retryGeneration !== logStreamGeneration) return;
        logRetryTimer = null;
        if ($('panelLogs').classList.contains('active')) startLogStream();
      }, 3000);
    }
  );
  if (isCurrent()) logSseHandle = handle;
  else handle.abort();
}

function stopLogStream() {
  ++logStreamGeneration; // Invalidate callbacks before aborting the old transport.
  if (logRetryTimer !== null) { clearTimeout(logRetryTimer); logRetryTimer = null; }
  var handle = logSseHandle;
  logSseHandle = null;
  if (handle) handle.abort();
  $('logConnStatus').textContent = '未连接';
}

function onLogEntry(data) {
  // T-06-json-parse (V5 Input Validation): 畸形 JSON 静默跳过不崩溃
  var entry;
  try { entry = JSON.parse(data); } catch (e) { return; }
  appendLogLine(entry);
}

function appendLogLine(entry) {
  var viewer = $('logViewer');
  // D-15: 底部判定阈值 30px——上滚时不抢断 tail -f
  var wasAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 30;
  var line = document.createElement('div');
  // 复用 Task 1 .log-line.log-* 样式（info/warn/error/security/debug）
  line.className = 'log-line log-' + entry.level;
  // D-18: 每行 ts level message 格式（scope 已隐含在 message 内或可后续追加）
  line.textContent = entry.ts + ' ' + entry.level.toUpperCase().padEnd(8) + ' ' + entry.message;
  viewer.appendChild(line);
  // D-14: DOM 上限 500，超限丢最旧
  while (viewer.children.length > LOG_DOM_MAX) {
    viewer.removeChild(viewer.firstChild);
  }
  // D-15: 仅当已在底部且 auto-scroll 开启时跟随
  if (wasAtBottom && $('logAutoScroll').checked) {
    viewer.scrollTop = viewer.scrollHeight;
  }
}


applyTheme(getTheme());
</script>
</body>
</html>`;
