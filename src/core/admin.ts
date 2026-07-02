import { sharedStyles } from './shared-styles';
import { sharedUi } from './shared-ui';

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


/* Import textarea */
.import-textarea{
  width:100%;
  min-height:100px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:10px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
  margin-bottom:8px;
}

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

.source-item .source-health-dot::after{
  content:attr(data-tooltip);
  position:absolute;
  left:0;
  bottom:calc(100% + 8px);
  padding:6px 10px;
  background:var(--surface-2);
  border:1px solid var(--border);
  border-radius:4px;
  font-family:var(--mono);
  font-size:0.6rem;
  color:var(--text);
  white-space:nowrap;
  pointer-events:none;
  opacity:0;
  transition:opacity 0.2s;
  z-index:100;
}

.source-item:hover .source-health-dot::after{
  opacity:1;
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
      <div class="header-label">管理控制台</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()">🌙</button>
        </div>
    </div>
    <h1 class="header-title">TVBox <span>Auxiliary</span></h1>
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
      <div class="section-title">添加接口</div>
      <div class="add-form">
        <input class="name-input" type="text" id="addName" placeholder="名称（可选）">
        <input type="url" id="addUrl" placeholder="TVBox 配置 JSON 地址">
        <input class="name-input" type="text" id="addConfigKey" placeholder="Config Key (optional, for AES ECB)">
        <button class="btn" id="addBtn" onclick="addSource()">添加</button>
      </div>
      <!-- Import (collapsible) -->
      <div class="collapsible-toggle" onclick="toggleCollapsible(this)">导入配置</div>
      <div class="collapsible-body">
        <textarea id="importInput" class="import-textarea" placeholder="粘贴 TVBox JSON 内容或 URL..."></textarea>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm" id="importBtn" onclick="importConfig()">导入</button>
          <span class="status-text" id="importResult" style="font-family:var(--mono);font-size:0.75rem"></span>
        </div>
      </div>
    </div>

    <!-- Source list -->
    <div class="section">
      <div class="section-title">
        <span>接口列表</span>
        <span class="count" id="sourceCount">0</span>
      </div>
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
      <div class="add-form">
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

    <!-- Channel Probe (Node/Docker only) -->
    <div class="section" id="channelProbeSection">
      <div class="section-title">频道级测速（仅 Node/Docker）</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="channelProbeCheck" onchange="toggleChannelProbe()">
          <span>启用定时频道测速（每 12 小时）</span>
        </label>
        <button class="btn btn-sm" id="channelProbeTriggerBtn" onclick="triggerChannelProbe()">立即执行</button>
        <button class="btn btn-sm" onclick="loadChannelProbe()">刷新</button>
      </div>
      <div id="channelProbeStatus" style="font-size:0.85rem;color:var(--text-secondary);line-height:1.6"></div>
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
        <span class="status-text" id="syncStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div id="syncEnvNotice" style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary);display:none">
        环境变量已设定，禁用手动设置聚合时间
      </div>
    </div>

    <div class="section">
      <div class="section-title">站点测速</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="speedTestCheck" onchange="saveSpeedTest()" checked>
          <span>启用站点测速与不可达剔除</span>
        </label>
        <span class="status-text" id="speedTestStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary)">关闭后保留所有站点，不进行可达性检测</div>
    </div>

    <div class="section">
      <div class="section-title">高级设置</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="smartJarUrlCheck" onchange="saveSmartJarUrl()">
          <span>智能响应静态资源地址</span>
        </label>
        <span class="status-text" id="smartJarUrlStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary)">实验性功能，复用访问接口时的头部信息动态地为该客户端生成静态资源地址，注意潜在的安全风险。</div>

      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="liveDisabledCheck" onchange="saveLiveDisabled()">
          <span>禁用直播功能</span>
        </label>
        <span class="status-text" id="liveDisabledStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
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
        <button class="btn btn-sm" onclick="saveEdgeProxies()">保存</button>
        <span class="status-text" id="edgeProxiesStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">搜索配额</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="form-label" style="margin:0">可搜索源上限</label>
        <input type="number" id="maxSearchableInput" class="nt-input" style="width:80px" min="0" max="1000" value="0">
        <button class="btn btn-sm" id="searchQuotaSaveBtn" onclick="saveSearchQuota()">保存</button>
        <span class="status-text" id="searchQuotaStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
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
        <span class="status-text" id="ntStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
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

  <div class="footer">
    <span>TVBox Auxiliary</span>
  </div>
</div>

<script>
${sharedUi}


// --- Auth ---
const auth = initAuth('loginInput', 'loginError', 'loginOverlay', 'mainContent', '/admin/sources', loadAll);

// --- Tab switching ---
function switchTab(tab) {
  if (tab === 'live' && $('liveDisabledCheck')?.checked) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => {
    const id = 'panel' + tab.charAt(0).toUpperCase() + tab.slice(1);
    p.classList.toggle('active', p.id === id);
  });
  // Phase 6 VIEWER-03 (Plan 03): logs tab SSE 生命周期管理（D-17）
  // 切到 logs 时延迟初始化 SSE 连接，切走时主动 abort 释放（Pitfall 4 防泄漏）
  if (tab === 'logs') startLogStream();
  else if (logSseHandle) stopLogStream();
}

// --- Source health ---
let healthMap = {};

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
  loadSpeedTest();
  loadSmartJarUrl();
  loadLiveDisabled();
  loadEdgeProxies();
  loadSearchQuota();
  loadChannelProbe();
}

async function loadSources() {
  const list = $('sourceList');
  try {
    const res = await auth.authFetch('/admin/sources');
    const sources = await res.json();
    $('sourceCount').textContent = sources.length;
    $('badgeSources').textContent = sources.length;

    if (sources.length === 0) {
      list.innerHTML = '<div class="empty">' + "暂无源。请在上方添加。" + '</div>';
      return;
    }

    list.innerHTML = sources.map(s => {
      const h = healthMap[s.url];
      // Plan 03.1 D-10: 后端已分类，直接使用 h.status
      const level = !h ? 'unknown'
        : h.status === 'ERR' ? 'error'
        : h.status === 'WARN' ? 'warn'
        : 'ok';
      // Plan 03.1 D-12: tooltip 优先显示具体错误原因（lastFailReason），无则显示分类标签
      // 修复：OK 状态下不展示历史 lastFailReason（写入层会保留作为历史档案）
      const tip = !h ? "暂无数据"
        : h.status === 'OK' ? h.status
        : (h.lastFailReason || h.status);

      return \`<div class="source-item">
        <span class="source-health-dot \${level}" data-tooltip="\${esc(tip)}"></span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name || 'Unnamed')}\${s.configKey ? ' 🔑' : ''}</div>
          <div class="source-url">\${esc(s.url)}</div>
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-danger" onclick="removeSource('\${esc(s.url)}')">\${"删除"}</button>
        </div>
      </div>\`;
    }).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + "加载源失败" + '</div>';
  }
}

// --- Add source ---
async function addSource() {
  const url = $('addUrl').value.trim();
  if (!url) { $('addUrl').focus(); return; }
  const name = $('addName').value.trim() || '';
  const configKey = $('addConfigKey').value.trim() || '';

  const btn = $('addBtn');
  btn.textContent = "添加中...";
  btn.className = 'btn loading';

  try {
    const payload = { name, url };
    if (configKey) payload.configKey = configKey;
    const res = await auth.authFetch('/admin/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (res.ok) {
      toast("源已添加");
      $('addUrl').value = '';
      $('addName').value = '';
      $('addConfigKey').value = '';
      loadSources();
    } else {
      toast(d.error || "加载源失败", 'error');
    }
  } catch {
    toast("网络错误", 'error');
  }

  btn.textContent = "添加";
  btn.className = 'btn';
}

// --- Remove source ---
async function removeSource(url) {
  try {
    const res = await auth.authFetch('/admin/sources', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) {
      toast("源已删除");
      loadSources();
    } else {
      const d = await res.json();
      toast(d.error || "删除", 'error');
    }
  } catch {
    toast("网络错误", 'error');
  }
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
async function loadLives() {
  const list = $('liveList');
  try {
    const res = await auth.authFetch('/admin/lives');
    const entries = await res.json();
    $('liveCount').textContent = entries.length;
    $('badgeLive').textContent = entries.length;

    if (entries.length === 0) {
      list.innerHTML = '<div class="empty">' + "暂无直播源。请在上方添加。" + '</div>';
      return;
    }

    list.innerHTML = entries.map(s => \`
      <div class="source-item">
        <span class="source-tag manual">LIVE</span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name || 'Unnamed')}</div>
          <div class="source-url">\${esc(s.url)}</div>
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-danger" onclick="removeLive('\${esc(s.url)}')">\${"删除"}</button>
        </div>
      </div>
    \`).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + "加载直播源失败" + '</div>';
  }
}

async function addLive() {
  const url = $('liveUrl').value.trim();
  if (!url) { $('liveUrl').focus(); return; }
  const name = $('liveName').value.trim() || '';

  const btn = $('liveAddBtn');
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
  const input = $('importInput').value.trim();
  if (!input) { $('importInput').focus(); return; }

  const btn = $('importBtn');
  const result = $('importResult');
  btn.textContent = "导入中...";
  btn.className = 'btn btn-sm loading';
  result.textContent = '';

  try {
    const res = await auth.authFetch('/admin/sources/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });
    const d = await res.json();
    if (res.ok) {
      const typeLabel = d.type === 'multi' ? "检测到多仓" : "检测到单仓";
      result.textContent = typeLabel + ': ' + d.added + ' ' + "已添加" + (d.duplicates > 0 ? ', ' + d.duplicates + ' ' + "重复跳过" : '');
      result.className = 'status-text success';
      if (d.added > 0) {
        $('importInput').value = '';
        loadSources();
      }
    } else {
      result.textContent = d.error || "解析失败";
      result.className = 'status-text error';
    }
  } catch {
    result.textContent = "网络错误";
    result.className = 'status-text error';
  }

  btn.textContent = "导入";
  btn.className = 'btn btn-sm';
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
  const btn = $('ntSaveBtn');
  const status = $('ntStatus');
  btn.textContent = "保存中...";
  btn.className = 'btn loading';
  status.textContent = '';

  try {
    const res = await auth.authFetch('/admin/name-transform', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix: $('ntPrefix').value || '',
        suffix: $('ntSuffix').value || '',
      })
    });
    const d = await res.json();
    if (res.ok) {
      status.textContent = "已保存";
      status.className = 'status-text success';
    } else {
      status.textContent = d.error || "保存失败";
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = "网络错误";
    status.className = 'status-text error';
  }

  btn.textContent = "保存";
  btn.className = 'btn';
  setTimeout(() => { status.textContent = ''; }, 3000);
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
  const btn = $('syncSaveBtn');
  const status = $('syncStatus');
  btn.textContent = "保存中...";
  btn.className = 'btn btn-sm loading';
  status.textContent = '';

  const period = $('syncPeriod').value;
  const timeVal = $('syncTime').value || '05:00';
  const parts = timeVal.split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const schedule = {
    period,
    hour: hh,
    minute: mm,
  };
  if (period === 'weekly') {
    schedule.dayOfWeek = parseInt($('syncDayOfWeek').value);
  }

  try {
    const res = await auth.authFetch('/admin/cron-interval', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule })
    });
    const d = await res.json();
    if (res.ok) {
      status.textContent = "已保存";
      status.className = 'status-text success';
    } else {
      status.textContent = d.error || "保存失败";
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = "网络错误";
    status.className = 'status-text error';
  }

  btn.textContent = "保存";
  btn.className = 'btn btn-sm';
  setTimeout(() => { status.textContent = ''; }, 3000);
}

// --- Speed Test Toggle ---
async function loadSpeedTest() {
  try {
    const res = await auth.authFetch('/admin/speed-test');
    if (res.ok) {
      const d = await res.json();
      $('speedTestCheck').checked = d.enabled;
    }
  } catch {}
}

async function saveSpeedTest() {
  const status = $('speedTestStatus');
  const enabled = $('speedTestCheck').checked;
  status.textContent = '';

  try {
    const res = await auth.authFetch('/admin/speed-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (res.ok) {
      status.textContent = "已保存";
      status.className = 'status-text success';
    } else {
      const d = await res.json();
      status.textContent = d.error || "保存失败";
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = "网络错误";
    status.className = 'status-text error';
  }

  setTimeout(() => { status.textContent = ''; }, 3000);
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
  const status = $('smartJarUrlStatus');
  const enabled = $('smartJarUrlCheck').checked;
  status.textContent = '';

  try {
    const res = await auth.authFetch('/admin/smart-jar-url', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (res.ok) {
      status.textContent = "已保存";
      status.className = 'status-text success';
    } else {
      const d = await res.json();
      status.textContent = d.error || "保存失败";
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = "网络错误";
    status.className = 'status-text error';
  }

  setTimeout(() => { status.textContent = ''; }, 3000);
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
  if (!liveTab) return;
  if (disabled) {
    liveTab.classList.add('disabled');
    if (liveTab.classList.contains('active')) switchTab('sources');
  } else {
    liveTab.classList.remove('disabled');
  }
}

async function saveLiveDisabled() {
  const status = $('liveDisabledStatus');
  const disabled = $('liveDisabledCheck').checked;
  status.textContent = "应用中...";
  status.className = 'status-text';

  try {
    const res = await auth.authFetch('/admin/live-disabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled })
    });
    if (res.ok) {
      const d = await res.json();
      status.textContent = disabled ? "已禁用直播" : "已启用直播";
      status.className = 'status-text success';
      updateLiveTabState(disabled);
    } else {
      const d = await res.json();
      status.textContent = d.error || "保存失败";
      status.className = 'status-text error';
      $('liveDisabledCheck').checked = !disabled;
    }
  } catch {
    status.textContent = "网络错误";
    status.className = 'status-text error';
    $('liveDisabledCheck').checked = !disabled;
  }

  setTimeout(() => { status.textContent = ''; }, 3000);
}

// --- Channel Probe (Node/Docker) ---
async function loadChannelProbe() {
  const box = $('channelProbeStatus');
  try {
    const res = await auth.authFetch('/admin/channel-probe/status');
    if (res.status === 404) {
      $('channelProbeSection').style.display = 'none';
      return;
    }
    if (!res.ok) {
      box.textContent = "仅 Node/Docker 支持频道级测速";
      return;
    }
    const d = await res.json();
    $('channelProbeCheck').checked = !!d.enabled;
    const s = d.status || {};
    const stateLabel = { idle: "空闲", running: "运行中", done: "已完成", error: "失败" }[s.state] || s.state || '-';
    const lines = [];
    lines.push("状态" + ': ' + stateLabel + (d.running ? ' ⏳' : ''));
    if (s.totalUrls) {
      lines.push("进度" + ': ' + (s.probed || 0) + ' / ' + s.totalUrls + ' | ' + "覆盖率" + ': ' + (s.coverage || 0) + '% | ' + "频道数" + ': ' + (s.totalChannels || 0));
    }
    if (s.durationMs) {
      lines.push("耗时" + ': ' + (s.durationMs / 1000).toFixed(1) + 's');
    }
    if (s.finishedAt) {
      lines.push("完成时间" + ': ' + new Date(s.finishedAt).toLocaleString());
    }
    if (s.error) {
      lines.push('⚠️ ' + s.error);
    }
    box.innerHTML = lines.map(l => '<div>' + l.replace(/</g,'&lt;') + '</div>').join('');
  } catch {
    box.textContent = "网络错误";
  }
}

async function toggleChannelProbe() {
  const enabled = $('channelProbeCheck').checked;
  try {
    await auth.authFetch('/admin/channel-probe/toggle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    toast("已保存");
    loadChannelProbe();
  } catch {
    toast("网络错误", 'error');
  }
}

async function triggerChannelProbe() {
  const btn = $('channelProbeTriggerBtn');
  btn.disabled = true;
  try {
    const res = await auth.authFetch('/admin/channel-probe/trigger', { method: 'POST' });
    const d = await res.json();
    if (res.ok) {
      toast("测速已启动");
      setTimeout(loadChannelProbe, 500);
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch {
    toast("网络错误", 'error');
  } finally {
    btn.disabled = false;
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
  const status = $('edgeProxiesStatus');
  try {
    const res = await auth.authFetch('/admin/edge-proxies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fetchProxy: $('edgeFetchProxyUrl').value.trim(), vercel: $('edgeVercelUrl').value.trim() })
    });
    if (res.ok) {
      status.textContent = "已保存";
      status.className = 'status-text success';
    } else {
      status.textContent = "保存失败";
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = "网络错误";
    status.className = 'status-text error';
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
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
  const status = $('searchQuotaStatus');
  status.textContent = '';
  const data = {
    maxSearchable: parseInt($('maxSearchableInput').value) || 0,
    pinnedKeys: [...sqPinnedKeys],
  };
  try {
    const res = await auth.authFetch('/admin/search-quota', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      status.textContent = "已保存";
      status.className = 'status-text success';
    } else {
      status.textContent = "保存失败";
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = "网络错误";
    status.className = 'status-text error';
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
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
      setTimeout(() => loadSourceHealth(), 3000);
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
const LOG_DOM_MAX = 500;       // D-14: DOM 渲染上限

function startLogStream() {
  if (logSseHandle) return; // 防重复连接
  var statusEl = $('logConnStatus');
  statusEl.textContent = '连接中...';
  // D-11: streamSse 用 fetch + Authorization 头（不用 EventSource，无法设头）
  logSseHandle = streamSse('/admin/logs', auth.getToken(),
    function(data) { onLogEntry(data); },
    function() { statusEl.textContent = '已连接'; },
    function(err) {
      statusEl.textContent = '已断开';
      logSseHandle = null;
      // 固定 3s 重连（仅当 logs 面板仍激活——切走时 stopLogStream 已置 logSseHandle=null）
      setTimeout(function() {
        if ($('panelLogs').classList.contains('active')) startLogStream();
      }, 3000);
    }
  );
}

function stopLogStream() {
  if (logSseHandle) { logSseHandle.abort(); logSseHandle = null; }
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
