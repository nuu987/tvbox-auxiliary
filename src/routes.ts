// Hono 统一路由层

import { Hono } from 'hono';
import type { Storage } from './storage/interface';
import type { AppConfig, SourceEntry, MacCMSSourceEntry, LiveSourceEntry, NameTransformConfig, EdgeProxyConfig, SourceHealthRecord, SyncSchedule, SyncPeriod } from './core/types';
import { MERGED_CONFIG, MERGED_CONFIG_FULL, MANUAL_SOURCES, LAST_UPDATE, MACCMS_SOURCES, LIVE_SOURCES, BLACKLIST, LIVE_PROXY_TTL, IMG_PROXY_TTL, INLINE_PREFIX, NAME_TRANSFORM, CRON_INTERVAL, DEFAULT_SYNC_SCHEDULE, SOURCE_HEALTH, SPEED_TEST_ENABLED, EDGE_PROXIES, SEARCH_QUOTA_REPORT, SMART_JAR_URL_ENABLED, LIVE_DISABLED } from './core/config';
import { parseConfigJson, isMultiRepoConfig, extractMultiRepoEntries } from './core/fetcher';
import { decodeConfigResponse } from './core/decoder';
import { validateMacCMS } from './core/maccms';
import { lookupJarUrl, isMd5Key, base64ToUint8Array } from './core/jar-proxy';
import { getRequestBaseUrl, applyBaseUrlPlaceholder, assertHostAllowed } from './core/base-url';
import { lookupLiveUrl } from './core/live-source';
import { adminHtml } from './core/admin';
import { dashboardHtml } from './core/dashboard';
import { configEditorHtml } from './core/config-editor';
import { siteFingerprint, loadBlacklist, saveBlacklist, saveRegexRule, deleteRegexRule, patchMergedConfig } from './core/blacklist';
import { setDirtyMarker, getDirtyMarker, clearDirtyMarker } from './core/dirty-marker';
import { loadSearchQuota, saveSearchQuota } from './core/search-quota';
import { loadCredentials, saveCredential, deleteCredential, loadCredentialPolicy, saveCredentialPolicy } from './core/credential-store';
import { generateQR, pollQRStatus, passwordLogin, PLATFORM_NAMES, QR_PLATFORMS, PASSWORD_PLATFORMS } from './core/cloud-login';
import { assessAllSources } from './core/credential-risk';
import { generateTokenJson } from './core/credential-injector';
import type { TVBoxConfig, SearchQuotaConfig, CloudPlatform, CloudCredential } from './core/types';
import { mountChannelProbeRoutes } from './routes/channel-probe-admin';
import { logger } from './core/logger';

export interface AppDeps {
  storage: Storage;
  config: AppConfig;
  triggerRefresh: (opts?: { source?: 'cron' | 'manual' }) => Promise<{ ran: boolean }>;
  onCronScheduleChange?: (schedule: SyncSchedule) => void;
  cronEnvSchedule?: SyncSchedule | null;
  enableChannelProbe?: boolean; // 仅 Node/Docker 入口启用
  /** 返回当前同步是否正在运行；用于 /status-data 与 /admin/patch-config 409 检测 */
  isSyncing?: () => boolean;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { storage, config } = deps;

  // In-memory mutex to prevent concurrent MERGED_CONFIG writes between
  // patch-config and sync (CR-02 race condition guard)
  let patchLock = false;

  // ─── 本地字体文件 ──────────────────────────────────────────
  const FONTS: Record<string, { path: string; type: string }> = {
    'jetbrains-mono-latin-ext.woff2': { path: 'static/fonts/jetbrains-mono-latin-ext.woff2', type: 'font/woff2' },
    'jetbrains-mono-latin.woff2':     { path: 'static/fonts/jetbrains-mono-latin.woff2',     type: 'font/woff2' },
    'outfit-latin-ext.woff2':         { path: 'static/fonts/outfit-latin-ext.woff2',         type: 'font/woff2' },
    'outfit-latin.woff2':             { path: 'static/fonts/outfit-latin.woff2',             type: 'font/woff2' },
  };

  app.get('/fonts/:name', async (c) => {
    const entry = FONTS[c.req.param('name')];
    if (!entry) return c.text('Not Found', 404);
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(__dirname, entry.path);
    try {
      const data = await fs.promises.readFile(filePath);
      return c.body(data, 200, {
        'Content-Type': entry.type,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } catch {
      return c.text('Not Found', 404);
    }
  });

  // ─── 主配置 ────────────────────────────────────────────
  app.get('/', async (c) => {
    const cached = await storage.get(MERGED_CONFIG);

    if (!cached) {
      return c.json(
        { error: 'No config available yet. Add sources in /admin and trigger a refresh.' },
        503,
      );
    }

    const smartRaw = await storage.get(SMART_JAR_URL_ENABLED);
    const smartEnabled = smartRaw === 'true'; // 默认关闭（D-10）
    const fallback = (config.localBaseUrl || '').replace(/\/$/, '');
    const dmzEnabled = process.env.DMZ === '0';
    const actualBase = smartEnabled
      ? getRequestBaseUrl(c, fallback, dmzEnabled)
      : fallback;
    if (smartEnabled) {
      if (!assertHostAllowed(actualBase, fallback, c, dmzEnabled)) {
        logger.securityFields('host-intercept', {
          method: 'GET',
          path: '/',
          result: 'blocked',
          reason: 'non_lan_host',
          actualBase,
          fallbackBase: fallback,
          host: c.req.header('Host') || '-',
          xForwardedHost: c.req.header('X-Forwarded-Host') || '-',
          dmz: process.env.DMZ ?? '(unset)',
          smartJarUrl: smartEnabled,
        });
        return c.text('Forbidden', 403);
      }
    }
    const body = applyBaseUrlPlaceholder(cached, actualBase, fallback);

    return c.body(body, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      'Access-Control-Allow-Origin': '*',
    });
  });

  // ─── 纯直播配置 ────────────────────────────────────────
  app.get('/live-config', async (c) => {
    const cached = await storage.get(MERGED_CONFIG);

    if (!cached) {
      return c.json({ error: 'No config available yet.' }, 503);
    }

    // 直播功能禁用开关：直接返回空 lives，跳过 smart JAR 处理
    const liveDisabledRaw = await storage.get(LIVE_DISABLED);
    if (liveDisabledRaw !== 'false') {
      return c.body(JSON.stringify({ lives: [] }), 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
    }

    try {
      const full = JSON.parse(cached);
      const liveConfig = { lives: full.lives || [] };
      const liveBody = JSON.stringify(liveConfig);
      const smartRaw = await storage.get(SMART_JAR_URL_ENABLED);
      const smartEnabled = smartRaw === 'true';
      const fallback = (config.localBaseUrl || '').replace(/\/$/, '');
      const dmzEnabled = process.env.DMZ === '0';
      const actualBase = smartEnabled
        ? getRequestBaseUrl(c, fallback, dmzEnabled)
        : fallback;
      if (smartEnabled) {
        if (!assertHostAllowed(actualBase, fallback, c, dmzEnabled)) {
          logger.securityFields('host-intercept', {
            method: 'GET',
            path: '/live-config',
            result: 'blocked',
            reason: 'non_lan_host',
            actualBase,
            fallbackBase: fallback,
            host: c.req.header('Host') || '-',
            xForwardedHost: c.req.header('X-Forwarded-Host') || '-',
            dmz: process.env.DMZ ?? '(unset)',
            smartJarUrl: smartEnabled,
          });
          return c.text('Forbidden', 403);
        }
      }
      return c.body(applyBaseUrlPlaceholder(liveBody, actualBase, fallback), 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=1800',
        'Access-Control-Allow-Origin': '*',
      });
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }
  });

  // ─── 监控面板 ──────────────────────────────────────────
  app.get('/status', (c) => {
    return c.html(dashboardHtml);
  });

  app.get('/status-data', async (c) => {
    const lastUpdate = await storage.get(LAST_UPDATE);
    const sources = await storage.get(MANUAL_SOURCES);
    const macCMSSources = await storage.get(MACCMS_SOURCES);
    const liveSources = await storage.get(LIVE_SOURCES);
    const cached = await storage.get(MERGED_CONFIG);

    let siteCount = 0;
    let parseCount = 0;
    let liveCount = 0;
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        siteCount = parsed.sites?.length || 0;
        parseCount = parsed.parses?.length || 0;
        liveCount = parsed.lives?.length || 0;
      } catch {
        // ignore
      }
    }

    const warnings: string[] = [];
    if (config.dockerMissingBaseUrl) {
      warnings.push('docker_no_base_url');
    }

    const adminFields: Record<string, unknown> = {};
    if (verifyAdmin(c.req.raw, config)) {
      adminFields.syncRunning = deps.isSyncing ? deps.isSyncing() : false;
      adminFields.dirtyMarker = await getDirtyMarker(storage);
    }

    return c.json({
      lastUpdate: lastUpdate || 'never',
      sourceCount: sources ? JSON.parse(sources).length : 0,
      macCMSCount: macCMSSources ? JSON.parse(macCMSSources).length : 0,
      liveSourceCount: liveSources ? JSON.parse(liveSources).length : 0,
      sites: siteCount,
      parses: parseCount,
      lives: liveCount,
      ...adminFields,
      warnings,
    });
  });

  // ─── 源健康状态（无认证，Dashboard 需要访问）─────────────
  app.get('/source-status', async (c) => {
    const raw = await storage.get(SOURCE_HEALTH);
    const records = raw ? JSON.parse(raw) : [];
    return c.json(records);
  });

  // ─── Admin 页面 ────────────────────────────────────────
  app.get('/admin', (c) => {
    return c.html(adminHtml);
  });

  // ─── Admin API（需鉴权）────────────────────────────────
  app.get('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources);
  });

  app.post('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { name?: string; url?: string; configKey?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    let url = body.url?.trim() || '';
    if (!url) return c.json({ error: 'URL is required' }, 400);

    // 自动提取 ;pk; 密钥
    let configKey = body.configKey?.trim() || '';
    const pkMatch = url.match(/;pk;(.+)$/);
    if (pkMatch) {
      configKey = configKey || pkMatch[1];
      url = url.replace(/;pk;.+$/, '');
    }

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const name = body.name?.trim() || '';
    const raw = await storage.get(MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

    if (sources.some((s) => s.url === url)) {
      return c.json({ error: 'Source already exists' }, 409);
    }

    const entry: SourceEntry = { name, url };
    if (configKey) entry.configKey = configKey;
    sources.push(entry);
    await storage.put(MANUAL_SOURCES, JSON.stringify(sources));

    return c.json({ success: true });
  });

  app.delete('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = sources.filter((s) => s.url !== url);
    await storage.put(MANUAL_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  // ─── JSON 导入 ─────────────────────────────────────────
  app.post('/admin/sources/import', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { input?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const input = body.input?.trim();
    if (!input) return c.json({ error: 'input is required' }, 400);

    // 判断是 URL 还是 JSON 内容
    const isUrl = /^https?:\/\//i.test(input);
    let jsonText: string;
    let sourceUrl: string | null = null;

    // 自动提取 ;pk; 密钥
    let configKey: string | undefined;
    let fetchUrl = input;
    if (isUrl) {
      const pkMatch = input.match(/;pk;(.+)$/);
      if (pkMatch) {
        configKey = pkMatch[1];
        fetchUrl = input.replace(/;pk;.+$/, '');
      }
      sourceUrl = fetchUrl;
      try {
        const resp = await fetch(fetchUrl, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'okhttp/3.12.0' },
        });
        if (!resp.ok) return c.json({ error: `Fetch failed: HTTP ${resp.status}` }, 502);
        const buffer = await resp.arrayBuffer();
        const decoded = await decodeConfigResponse(buffer, configKey);
        jsonText = decoded || '';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Fetch failed: ${msg}` }, 502);
      }
    } else {
      jsonText = input;
    }

    const parsed = parseConfigJson(jsonText);
    if (!parsed.ok) return c.json({ error: `Failed to parse JSON: ${parsed.errorCategory}: ${parsed.message}` }, 400);

    // 读取现有源
    const raw = await storage.get(MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingUrls = new Set(sources.map(s => s.url));

    let added = 0;
    let duplicates = 0;
    const addedSources: string[] = [];

    if (isMultiRepoConfig(parsed.config!)) {
      // 多仓：提取子 URL 批量添加
      const entries = extractMultiRepoEntries(parsed.config!, 'Imported');
      for (const entry of entries) {
        if (existingUrls.has(entry.url)) {
          duplicates++;
        } else {
          sources.push(entry);
          existingUrls.add(entry.url);
          addedSources.push(entry.url);
          added++;
        }
      }
      await storage.put(MANUAL_SOURCES, JSON.stringify(sources));
      return c.json({ type: 'multi', added, duplicates, sources: addedSources });
    } else {
      // 单仓
      if (sourceUrl) {
        // 来自 URL：直接添加
        if (existingUrls.has(sourceUrl)) {
          return c.json({ type: 'single', added: 0, duplicates: 1, sources: [] });
        }
        const entry: SourceEntry = { name: 'Imported', url: sourceUrl };
        if (configKey) entry.configKey = configKey;
        sources.push(entry);
        await storage.put(MANUAL_SOURCES, JSON.stringify(sources));
        return c.json({ type: 'single', added: 1, duplicates: 0, sources: [sourceUrl] });
      } else {
        // 粘贴的内容：存 KV 用 inline:// 引用
        const key = `${INLINE_PREFIX}${Date.now()}`;
        await storage.put(key, jsonText);
        const inlineUrl = `inline://${key}`;
        sources.push({ name: 'Inline Config', url: inlineUrl });
        await storage.put(MANUAL_SOURCES, JSON.stringify(sources));
        return c.json({ type: 'single', added: 1, duplicates: 0, sources: [inlineUrl] });
      }
    }
  });

  // ─── 名称定制 API ──────────────────────────────────────
  app.get('/admin/name-transform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(NAME_TRANSFORM);
    const transform: NameTransformConfig = raw ? JSON.parse(raw) : {};
    return c.json(transform);
  });

  app.put('/admin/name-transform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: NameTransformConfig;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const transform: NameTransformConfig = {
      prefix: body.prefix || undefined,
      suffix: body.suffix || undefined,
    };

    await storage.put(NAME_TRANSFORM, JSON.stringify(transform));
    return c.json({ success: true });
  });

  // ─── 同步频率 API ──────────────────────────────────
  app.get('/admin/cron-interval', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(CRON_INTERVAL);
    let schedule: SyncSchedule = { ...DEFAULT_SYNC_SCHEDULE };
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.period) {
          schedule = parsed as SyncSchedule;
        }
      } catch {
        // 旧格式（纯数字），视为未配置
      }
    }
    const hasEnvOverride = !!deps.cronEnvSchedule;
    // 环境变量优先时，返回环境变量的值而非 KV 值
    const effectiveSchedule = hasEnvOverride ? deps.cronEnvSchedule! : schedule;
    return c.json({ schedule: effectiveSchedule, hasEnvOverride });
  });

  app.put('/admin/cron-interval', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { schedule?: SyncSchedule };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const schedule = body.schedule;
    if (!schedule || !schedule.period) {
      return c.json({ error: 'schedule with period is required' }, 400);
    }

    const validPeriods: SyncPeriod[] = ['daily', 'weekly', 'disabled'];
    if (!validPeriods.includes(schedule.period)) {
      return c.json({ error: `period must be one of: ${validPeriods.join(', ')}` }, 400);
    }
    if (schedule.period !== 'disabled') {
      if (typeof schedule.hour !== 'number' || schedule.hour < 0 || schedule.hour > 23) {
        return c.json({ error: 'hour must be 0-23' }, 400);
      }
      if (typeof schedule.minute !== 'number' || schedule.minute < 0 || schedule.minute > 59) {
        return c.json({ error: 'minute must be 0-59' }, 400);
      }
    }
    if (schedule.period === 'weekly') {
      if (typeof schedule.dayOfWeek !== 'number' || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6) {
        return c.json({ error: 'dayOfWeek must be 0-6 (0=Sunday)' }, 400);
      }
    }

    await storage.put(CRON_INTERVAL, JSON.stringify(schedule));

    if (deps.onCronScheduleChange) {
      deps.onCronScheduleChange(schedule);
    }

    return c.json({ success: true, schedule });
  });

  // ─── 站点测速开关 ──────────────────────────────────────
  app.get('/admin/speed-test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(SPEED_TEST_ENABLED);
    return c.json({ enabled: raw !== 'false' });
  });

  app.put('/admin/speed-test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    await storage.put(SPEED_TEST_ENABLED, String(body.enabled));
    return c.json({ success: true, enabled: body.enabled });
  });

  // ─── 智能 JAR 地址开关 ──────────────────────────────────
  app.get('/admin/smart-jar-url', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(SMART_JAR_URL_ENABLED);
    return c.json({ enabled: raw === 'true' }); // 默认关闭（D-10）
  });

  app.put('/admin/smart-jar-url', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    await storage.put(SMART_JAR_URL_ENABLED, String(body.enabled));
    return c.json({ success: true, enabled: body.enabled });
  });

  // ─── 直播功能禁用开关 ──────────────────────────────────
  app.get('/admin/live-disabled', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(LIVE_DISABLED);
    return c.json({ disabled: raw !== 'false' }); // 默认已禁用
  });

  app.put('/admin/live-disabled', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { disabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (typeof body.disabled !== 'boolean') {
      return c.json({ error: 'disabled must be a boolean' }, 400);
    }

    await storage.put(LIVE_DISABLED, String(body.disabled));
    // 立即应用：调用 patchMergedConfig 同步清空/恢复 lives
    let patched = false;
    try {
      const result = await patchMergedConfig(storage);
      patched = result.patched;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warnFields('blacklist', 'live-disabled-patch-failed', {
        disabled: body.disabled,
        error: msg,
      });
    }
    logger.debugFields('blacklist', 'live-disabled-set', {
      disabled: body.disabled,
      patched,
    });
    return c.json({ success: true, disabled: body.disabled, patched });
  });

  // ─── 边缘函数代理配置 Admin API ──────────────────────
  app.get('/admin/edge-proxies', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(EDGE_PROXIES);
    return c.json(raw ? JSON.parse(raw) : {});
  });

  app.put('/admin/edge-proxies', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { fetchProxy?: string; vercel?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    // 清理尾部斜杠
    const clean = {
      fetchProxy: body.fetchProxy?.replace(/\/+$/, '') || undefined,
      vercel: body.vercel?.replace(/\/+$/, '') || undefined,
    };
    await storage.put(EDGE_PROXIES, JSON.stringify(clean));
    return c.json({ success: true, ...clean });
  });

  // ─── 搜索配额管理 ──────────────────────────────────────
  app.get('/admin/search-quota', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const quota = await loadSearchQuota(storage);
    return c.json(quota);
  });

  app.put('/admin/search-quota', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: Partial<SearchQuotaConfig>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const current = await loadSearchQuota(storage);
    if (typeof body.maxSearchable === 'number') current.maxSearchable = body.maxSearchable;
    if (Array.isArray(body.pinnedKeys)) current.pinnedKeys = body.pinnedKeys;

    await saveSearchQuota(storage, current);
    return c.json({ success: true, ...current });
  });

  app.post('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const set = new Set(current.pinnedKeys);
    for (const key of body.keys) set.add(key);
    current.pinnedKeys = [...set];
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  // 重排 pinned 顺序（整体替换）
  app.put('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    current.pinnedKeys = body.keys;
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  app.delete('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const removeSet = new Set(body.keys);
    current.pinnedKeys = current.pinnedKeys.filter(k => !removeSet.has(k));
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  // 报告（admin 需鉴权）
  app.get('/admin/search-quota/report', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(SEARCH_QUOTA_REPORT);
    if (!raw) return c.json({ error: 'No report yet. Run sync first.' }, 404);
    return c.json(JSON.parse(raw));
  });

  // 报告精简版（dashboard 无需鉴权）
  app.get('/search-quota/summary', async (c) => {
    const raw = await storage.get(SEARCH_QUOTA_REPORT);
    if (!raw) return c.json({ enabled: false });
    return c.json({ enabled: true, ...JSON.parse(raw) });
  });

  // ─── 网盘凭证管理 API ───────────────────────────────────

  // 查看所有已登录平台状态
  app.get('/admin/cloud-credentials', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const creds = await loadCredentials(storage);
    const result: Record<string, any> = {};
    for (const [platform, cred] of creds) {
      result[platform] = {
        platform: cred.platform,
        status: cred.status,
        obtainedAt: cred.obtainedAt,
        expiresAt: cred.expiresAt,
        hasCredential: Object.keys(cred.credential).length > 0,
      };
    }
    return c.json({ platforms: PLATFORM_NAMES, credentials: result });
  });

  // 注销指定平台
  app.delete('/admin/cloud-credentials/:platform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PLATFORM_NAMES[platform]) return c.json({ error: 'Unknown platform' }, 400);
    await deleteCredential(storage, platform);
    return c.json({ success: true });
  });

  // 手动粘贴凭证
  app.post('/admin/cloud-credentials/:platform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PLATFORM_NAMES[platform]) return c.json({ error: 'Unknown platform' }, 400);

    let body: { credential?: Record<string, string> };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.credential || typeof body.credential !== 'object') {
      return c.json({ error: 'credential object is required' }, 400);
    }

    const cred: CloudCredential = {
      platform,
      credential: body.credential,
      obtainedAt: new Date().toISOString(),
      status: 'valid',
    };
    await saveCredential(storage, cred);
    return c.json({ success: true });
  });

  // 生成二维码
  app.post('/admin/cloud-login/:platform/qr', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!QR_PLATFORMS.includes(platform)) {
      return c.json({ error: `Platform ${platform} does not support QR login` }, 400);
    }

    try {
      const result = await generateQR(platform);
      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 502);
    }
  });

  // 轮询扫码状态
  app.get('/admin/cloud-login/:platform/poll', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    const token = c.req.query('token');
    if (!token) return c.json({ error: 'token is required' }, 400);

    try {
      const result = await pollQRStatus(platform, token);

      // 登录成功：自动保存凭证
      if (result.status === 'confirmed' && result.credential) {
        const cred: CloudCredential = {
          platform,
          credential: result.credential,
          obtainedAt: new Date().toISOString(),
          status: 'valid',
        };
        await saveCredential(storage, cred);
      }

      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg, status: 'error' }, 502);
    }
  });

  // 密码登录（迅雷/PikPak）
  app.post('/admin/cloud-login/:platform/password', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PASSWORD_PLATFORMS.includes(platform)) {
      return c.json({ error: `Platform ${platform} does not support password login` }, 400);
    }

    let body: { username?: string; password?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    try {
      const result = await passwordLogin(platform, body.username || '', body.password || '');
      if (result.success && result.credential) {
        const cred: CloudCredential = {
          platform,
          credential: result.credential,
          obtainedAt: new Date().toISOString(),
          status: 'valid',
        };
        await saveCredential(storage, cred);
      }
      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, message: msg }, 502);
    }
  });

  // 凭证注入策略
  app.get('/admin/credential-policy', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(await loadCredentialPolicy(storage));
  });

  app.put('/admin/credential-policy', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { allowedHighRiskKeys?: string[]; deniedKeys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const policy = await loadCredentialPolicy(storage);
    if (Array.isArray(body.allowedHighRiskKeys)) policy.allowedHighRiskKeys = body.allowedHighRiskKeys;
    if (Array.isArray(body.deniedKeys)) policy.deniedKeys = body.deniedKeys;
    await saveCredentialPolicy(storage, policy);
    return c.json({ success: true, ...policy });
  });

  // 风险分级报告
  app.get('/admin/credential-risk-report', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const configRaw = await storage.get(MERGED_CONFIG_FULL);
    if (!configRaw) return c.json({ error: 'No config available. Run sync first.' }, 404);

    const adminBase = (config.localBaseUrl || '').replace(/\/$/, '');
    const substituted = applyBaseUrlPlaceholder(configRaw, adminBase);
    const parsed: TVBoxConfig = JSON.parse(substituted);
    const sites = parsed.sites || [];
    const assessments = assessAllSources(sites);
    const policy = await loadCredentialPolicy(storage);

    const summary = { safe: 0, low: 0, high: 0, unaudited: 0 };
    for (const a of assessments) {
      summary[a.riskLevel]++;
    }

    return c.json({ summary, assessments, policy });
  });

  // 自托管 token.json
  app.get('/credential/token.json', async (c) => {
    const creds = await loadCredentials(storage);
    if (creds.size === 0) {
      return c.json({}, 200, { 'Access-Control-Allow-Origin': '*' });
    }
    const tokenJson = generateTokenJson(creds);
    return c.json(tokenJson, 200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
  });

  // ─── MacCMS API 代理 ───────────────────────────────
  if (config.localBaseUrl) {
    app.all('/api/:key', async (c) => {
      const key = c.req.param('key');
      const raw = await storage.get(MACCMS_SOURCES);
      const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
      const source = sources.find((s) => s.key === key);

      if (!source) {
        return c.json({ error: 'Unknown MacCMS source' }, 404);
      }

      const targetUrl = new URL(source.api);
      const reqUrl = new URL(c.req.url);
      reqUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

      // 构造候选请求链：优先走 edge（Vercel → fetchProxy），兜底直连
      const attempts: { label: string; url: string; headers: Record<string, string> }[] = [];

      const edgeRaw = await storage.get(EDGE_PROXIES);
      if (edgeRaw) {
        const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
        const encoded = encodeURIComponent(targetUrl.toString());
        if (edge.vercel) {
          attempts.push({
            label: 'vercel',
            url: `${edge.vercel.replace(/\/$/, '')}/api/proxy?url=${encoded}`,
            headers: {},
          });
        }
        if (edge.fetchProxy) {
          attempts.push({
            label: 'fetchProxy',
            url: `${edge.fetchProxy.replace(/\/$/, '')}/fetch-proxy?url=${encoded}`,
            headers: config.adminToken ? { Authorization: `Bearer ${config.adminToken}` } : {},
          });
        }
      }

      attempts.push({ label: 'direct', url: targetUrl.toString(), headers: {} });

      let lastError = '';
      for (const { label, url, headers } of attempts) {
        try {
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'okhttp/3.12.0', ...headers },
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) {
            lastError = `upstream ${resp.status}`;
            logger.debug('maccms-proxy', `${key} via ${label} fail: ${lastError}`);
            continue;
          }
          const data = await resp.json();
          logger.debug('maccms-proxy', `${key} via ${label} ok`);
          return c.json(data, 200, {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300',
          });
        } catch (error: unknown) {
          lastError = error instanceof Error ? error.message : String(error);
          logger.warn('maccms-proxy', `${key} via ${label} fail: ${lastError}`);
        }
      }

      return c.json({ error: lastError || 'All proxies failed' }, 502);
    });
  }

  // ─── JAR 代理 ─────────────────────────────────────────
  if (config.localBaseUrl) {
    // Node.js 版：用文件系统缓存
    const fs = require('fs');
    const pathMod = require('path');
    const jarCacheDir = pathMod.resolve(process.env.DATA_DIR || pathMod.join(process.cwd(), 'data'), 'jars');
    if (!fs.existsSync(jarCacheDir)) fs.mkdirSync(jarCacheDir, { recursive: true });

    // 并发下载锁：防止同一 JAR 被多个请求同时下载
    const downloadLocks = new Map<string, Promise<Buffer | null>>();

    async function fetchAndCacheJar(key: string, originalUrl: string): Promise<Buffer | null> {
      try {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
        });
        if (!resp.ok) {
          logger.warn('jar-proxy', `Origin returned ${resp.status} for ${key}`);
          return null;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(pathMod.join(jarCacheDir, `${key}.jar`), buf);
        logger.debug('jar-proxy', `Cached ${key}.jar (${(buf.length / 1024).toFixed(1)} KB)`);
        return buf;
      } catch (error: unknown) {
        logger.warn('jar-proxy', `Fetch error for ${key}: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    }

    app.get('/jar/:key', async (c) => {
      const key = c.req.param('key');

      // 1. 查 storage 拿原始 URL
      const originalUrl = await lookupJarUrl(key, storage);
      if (!originalUrl) {
        return c.json({ error: 'Unknown JAR key' }, 404);
      }

      // 2. 查文件缓存
      const cachePath = pathMod.join(jarCacheDir, `${key}.jar`);
      if (fs.existsSync(cachePath)) {
        const stat = fs.statSync(cachePath);
        const ttl = isMd5Key(key) ? 86400_000 : 21600_000;
        if (Date.now() - stat.mtimeMs < ttl) {
          const buf = fs.readFileSync(cachePath);
          return new Response(buf, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Cache-Control': `public, max-age=${ttl / 1000}`,
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }

      // 3. 下载（带并发锁）
      let downloading = downloadLocks.get(key);
      if (!downloading) {
        downloading = fetchAndCacheJar(key, originalUrl).finally(() => downloadLocks.delete(key));
        downloadLocks.set(key, downloading);
      }

      const buf = await downloading;
      if (buf) {
        return new Response(buf, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': `public, max-age=${isMd5Key(key) ? 86400 : 21600}`,
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      return c.json({ error: 'JAR unavailable from origin' }, 502);
    });
  }

  // ─── Live Sources Admin API ────────────────────────────
  app.get('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(entries);
  });

  app.post('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { name?: string; url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const name = body.name?.trim() || '';
    const raw = await storage.get(LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];

    if (entries.some((e) => e.url === url)) {
      return c.json({ error: 'Live source already exists' }, 409);
    }

    entries.push({ name, url });
    await storage.put(LIVE_SOURCES, JSON.stringify(entries));

    return c.json({ success: true });
  });

  app.delete('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = entries.filter((e) => e.url !== url);
    await storage.put(LIVE_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  // ─── MacCMS Admin API ─────────────────────────────────
  app.get('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources);
  });

  app.post('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: MacCMSSourceEntry | MacCMSSourceEntry[];
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const newEntries = Array.isArray(body) ? body : [body];

    // 验证字段
    for (const entry of newEntries) {
      if (!entry.key?.trim() || !entry.name?.trim() || !entry.api?.trim()) {
        return c.json({ error: 'Each entry requires key, name, and api' }, 400);
      }
      try {
        new URL(entry.api);
      } catch {
        return c.json({ error: `Invalid URL: ${entry.api}` }, 400);
      }
    }

    const raw = await storage.get(MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingKeys = new Set(sources.map((s) => s.key));

    let added = 0;
    for (const entry of newEntries) {
      if (!existingKeys.has(entry.key)) {
        sources.push({ key: entry.key.trim(), name: entry.name.trim(), api: entry.api.trim() });
        existingKeys.add(entry.key);
        added++;
      }
    }

    await storage.put(MACCMS_SOURCES, JSON.stringify(sources));
    return c.json({ success: true, added, total: sources.length });
  });

  app.delete('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { key?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const key = body.key?.trim();
    if (!key) return c.json({ error: 'key is required' }, 400);

    const raw = await storage.get(MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = sources.filter((s) => s.key !== key);
    await storage.put(MACCMS_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  app.post('/admin/maccms/validate', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { api?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const api = body.api?.trim();
    if (!api) return c.json({ error: 'api is required' }, 400);

    const ok = await validateMacCMS(api, config.siteTimeoutMs);
    return c.json({ api, valid: ok });
  });

  // ─── Regex Rule CRUD (Phase 5) ──────────────────────
  app.post('/admin/regex-rule', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let body: { pattern?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const pattern = body.pattern?.trim();
    if (!pattern) {
      return c.json({ error: 'Pattern cannot be empty' }, 400);
    }
    const t0 = performance.now();
    const result = await saveRegexRule(storage, pattern);
    if (!result.success) {
      logger.warnFields('regex', 'rule-save-failed', {
        pattern: pattern.length > 80 ? pattern.slice(0, 80) + '...' : pattern,
        error: result.error,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ error: result.error }, 400);
    }
    await setDirtyMarker(storage);
    logger.debugFields('regex', 'rule-save', {
      pattern: pattern.length > 80 ? pattern.slice(0, 80) + '...' : pattern,
      ruleId: result.rule?.id,
      durationMs: Math.round(performance.now() - t0),
    });
    return c.json({ success: true, rule: result.rule });
  });

  app.delete('/admin/regex-rule/:id', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'id is required' }, 400);
    }
    const t0 = performance.now();
    const result = await deleteRegexRule(storage, id);
    if (!result.success) {
      logger.warnFields('regex', 'rule-delete-failed', {
        ruleId: id,
        error: result.error,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ error: result.error }, 404);
    }
    await setDirtyMarker(storage);
    logger.debugFields('regex', 'rule-delete', {
      ruleId: id,
      durationMs: Math.round(performance.now() - t0),
    });
    return c.json({ success: true });
  });

  app.get('/admin/regex-rules', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const blacklist = await loadBlacklist(storage);
    return c.json({ rules: blacklist.regexRules });
  });

  // ─── Config Editor 页面 ─────────────────────────────────
  app.get('/admin/config-editor', (c) => {
    return c.html(configEditorHtml);
  });

  // ─── Config Editor API ─────────────────────────────────
  app.get('/admin/config-data', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // 读取过滤前的完整配置（含被屏蔽的项），降级到已过滤配置
    const full = await storage.get(MERGED_CONFIG_FULL);
    const cached = full || await storage.get(MERGED_CONFIG);
    if (!cached) {
      return c.json({ sites: [], parses: [], lives: [] });
    }

    let parsed: TVBoxConfig;
    try {
      const adminBase = (config.localBaseUrl || '').replace(/\/$/, '');
      const substituted = applyBaseUrlPlaceholder(cached, adminBase);
      parsed = JSON.parse(substituted);
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }

    const blacklist = await loadBlacklist(storage);
    const siteSet = new Set(blacklist.sites);
    const parseSet = new Set(blacklist.parses);
    const liveSet = new Set(blacklist.lives);
    const overrideSet = new Set(blacklist.regexBlockOverrides);
    // Pre-compile regex rules for annotation
    const compiledRegex: RegExp[] = [];
    for (const rule of blacklist.regexRules) {
      try { compiledRegex.push(new RegExp(rule.pattern, 'u')); } catch { /* skip invalid */ }
    }

    // Build sites with fingerprint + blocked status + group
    const sites = [];
    for (const site of parsed.sites || []) {
      const fp = await siteFingerprint(site);
      const api = site.api || '';
      let group = '其他';
      if (api.startsWith('csp_') || api.startsWith('py_') || api.startsWith('js_')) {
        group = api;
      } else if (api.startsWith('http')) {
        try { group = '远程: ' + new URL(api).hostname; } catch { group = '远程源'; }
      }
      const name = site.name || '';
      const fingerprintBlocked = siteSet.has(fp);
      const overridden = !fingerprintBlocked && overrideSet.has(name);
      const regexBlocked = !fingerprintBlocked && !overridden && compiledRegex.some(re => re.test(name));
      const isOverridden = overridden && compiledRegex.some(re => re.test(name));
      sites.push({ ...site, fingerprint: fp, blocked: fingerprintBlocked || regexBlocked, regexBlocked, isOverridden, group });
    }

    const parses = (parsed.parses || []).map(p => ({
      ...p,
      blocked: parseSet.has(p.url),
    }));

    const lives = (parsed.lives || []).map(l => ({
      ...l,
      blocked: liveSet.has(l.url || l.api || ''),
    }));

    const liveDisabledRaw = await storage.get(LIVE_DISABLED);
    const liveDisabled = liveDisabledRaw !== 'false';

    // Build validation errors from source health records
    const healthRaw = await storage.get(SOURCE_HEALTH);
    const healthRecords: SourceHealthRecord[] = healthRaw ? JSON.parse(healthRaw) : [];
    const erroredSourceNames = new Set<string>();
    const erroredSourceReasons = new Map<string, string>();
    for (const record of healthRecords) {
      if (record.latestStatus === 'parse_error' && record.lastFailReason) {
        erroredSourceNames.add(record.name);
        erroredSourceReasons.set(record.name, record.lastFailReason);
      }
    }
    // Annotate sites from errored sources
    if (erroredSourceNames.size > 0) {
      for (const site of sites) {
        const group = site.group || '';
        for (const errName of erroredSourceNames) {
          if (group.includes(errName)) {
            (site as Record<string, unknown>).errSource = true;
            (site as Record<string, unknown>).errReason = erroredSourceReasons.get(errName);
            break;
          }
        }
      }
    }

    const validationErrors = healthRecords
      .filter(r => r.latestStatus === 'parse_error' && r.lastFailReason)
      .map(r => ({ url: r.url, name: r.name, reason: r.lastFailReason }));

    return c.json({ sites, parses, lives, regexRules: blacklist.regexRules, liveDisabled, validationErrors });
  });

  app.post('/admin/blacklist', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, id } = body;
    if (!type || !id) return c.json({ error: 'type and id are required' }, 400);
    if (!['sites', 'parses', 'lives', 'regexOverrides'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, lives, or regexOverrides' }, 400);
    }

    const t0 = performance.now();
    try {
      const blacklist = await loadBlacklist(storage);
      if (type === 'regexOverrides') {
        const beforeSize = blacklist.regexBlockOverrides.length;
        if (!blacklist.regexBlockOverrides.includes(id)) {
          blacklist.regexBlockOverrides.push(id);
        }
        await saveBlacklist(storage, blacklist);
        await setDirtyMarker(storage);
        const afterSize = blacklist.regexBlockOverrides.length;
        logger.debugFields('blacklist', 'block', {
          type, id, beforeSize, afterSize,
          added: afterSize > beforeSize,
          durationMs: Math.round(performance.now() - t0),
        });
        return c.json({ success: true });
      }
      const key = type as 'sites' | 'parses' | 'lives';
      const list = blacklist[key];
      const beforeSize = list.length;
      if (!list.includes(id)) {
        list.push(id);
      }
      await saveBlacklist(storage, blacklist);
      await setDirtyMarker(storage);
      const afterSize = list.length;
      logger.debugFields('blacklist', 'block', {
        type, id, beforeSize, afterSize,
        added: afterSize > beforeSize,
        durationMs: Math.round(performance.now() - t0),
      });

      return c.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warnFields('blacklist', 'block-failed', {
        type, id, error: msg,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ error: 'Server error: ' + msg }, 500);
    }
  });

  app.post('/admin/blacklist/batch', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; ids?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, ids } = body;
    if (!type || !Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: 'type and ids[] are required' }, 400);
    }
    if (ids.length > 500) {
      return c.json({ error: 'Too many ids (max 500)' }, 400);
    }
    if (!['sites', 'parses', 'lives', 'regexOverrides'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, lives, or regexOverrides' }, 400);
    }

    const t0 = performance.now();
    const blacklist = await loadBlacklist(storage);
    const beforeSize = (blacklist[type as keyof typeof blacklist] as string[]).length;
    if (type === 'regexOverrides') {
      let added = 0;
      for (const id of ids) {
        if (typeof id === 'string' && !blacklist.regexBlockOverrides.includes(id)) {
          blacklist.regexBlockOverrides.push(id);
          added++;
        }
      }
      await saveBlacklist(storage, blacklist);
      await setDirtyMarker(storage);
      const afterSize = blacklist.regexBlockOverrides.length;
      logger.debugFields('blacklist', 'batch-block', {
        type, requested: ids.length, added, beforeSize, afterSize,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ success: true, added });
    }
    const list = blacklist[type as keyof typeof blacklist] as string[];
    let added = 0;
    for (const id of ids) {
      if (typeof id === 'string' && !list.includes(id)) {
        list.push(id);
        added++;
      }
    }
    await saveBlacklist(storage, blacklist);
    await setDirtyMarker(storage);
    const afterSize = list.length;
    logger.debugFields('blacklist', 'batch-block', {
      type, requested: ids.length, added, beforeSize, afterSize,
      durationMs: Math.round(performance.now() - t0),
    });

    return c.json({ success: true, added });
  });

  app.delete('/admin/blacklist', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, id } = body;
    if (!type || !id) return c.json({ error: 'type and id are required' }, 400);
    if (!['sites', 'parses', 'lives', 'regexOverrides'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, lives, or regexOverrides' }, 400);
    }

    const t0 = performance.now();
    try {
      const blacklist = await loadBlacklist(storage);
      if (type === 'regexOverrides') {
        const beforeSize = blacklist.regexBlockOverrides.length;
        blacklist.regexBlockOverrides = blacklist.regexBlockOverrides.filter(v => v !== id);
        await saveBlacklist(storage, blacklist);
        await setDirtyMarker(storage);
        const afterSize = blacklist.regexBlockOverrides.length;
        logger.debugFields('blacklist', 'unblock', {
          type, id, beforeSize, afterSize,
          removed: afterSize < beforeSize,
          durationMs: Math.round(performance.now() - t0),
        });
        return c.json({ success: true });
      }
      const key = type as 'sites' | 'parses' | 'lives';
      const beforeSize = blacklist[key].length;
      blacklist[key] = blacklist[key].filter(v => v !== id);
      await saveBlacklist(storage, blacklist);
      await setDirtyMarker(storage);
      const afterSize = blacklist[key].length;
      logger.debugFields('blacklist', 'unblock', {
        type, id, beforeSize, afterSize,
        removed: afterSize < beforeSize,
        durationMs: Math.round(performance.now() - t0),
      });

      return c.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warnFields('blacklist', 'unblock-failed', {
        type, id, error: msg,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ error: 'Server error: ' + msg }, 500);
    }
  });

  // ─── 刷新 ─────────────────────────────────────────────
  app.post('/refresh', async (c) => {
    if (config.refreshToken || config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      const validTokens = [config.refreshToken, config.adminToken].filter(Boolean);
      if (!validTokens.some((t) => auth === `Bearer ${t}`)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    if (patchLock) {
      return c.json({ error: 'Patch in progress' }, 409);
    }

    try {
      const result = await deps.triggerRefresh({ source: 'manual' });
      if (!result.ran) {
        return c.json({ success: false, message: 'Already running, skipped' });
      }
      return c.json({ success: true, message: 'Refresh completed' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ success: false, error: msg }, 500);
    }
  });

  // ─── 即时应用黑名单变更（不重新聚合）─────────────────────
  app.post('/admin/patch-config', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (deps.isSyncing && deps.isSyncing()) {
      return c.json({ error: 'Sync in progress' }, 409);
    }
    if (patchLock) {
      return c.json({ error: 'Patch in progress' }, 409);
    }
    patchLock = true;
    const t0 = performance.now();
    try {
      const result = await patchMergedConfig(storage);
      const durationMs = Math.round(performance.now() - t0);
      if (!result.patched) {
        logger.debugFields('blacklist', 'patch-config', {
          patched: false, durationMs, reason: result.reason,
        });
        return c.json({ ok: false, error: result.reason || 'Patch skipped' }, 200);
      }
      logger.debugFields('blacklist', 'patch-config', {
        patched: true, durationMs,
      });
      await clearDirtyMarker(storage);
      return c.json({ ok: true, warning: result.warning });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warnFields('blacklist', 'patch-config-failed', {
        error: msg,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ ok: false, error: msg }, 500);
    } finally {
      patchLock = false;
    }
  });

  // ─── Dirty marker 管理 ──────────────────────────────────
  app.delete('/admin/dirty-marker', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const t0 = performance.now();
    await clearDirtyMarker(storage);
    logger.debugFields('blacklist', 'dirty-marker-clear', {
      durationMs: Math.round(performance.now() - t0),
    });
    return c.json({ ok: true });
  });

  // 频道级测速 admin 路由（仅 Node/Docker 启用）
  if (deps.enableChannelProbe) {
    mountChannelProbeRoutes(app, { storage, config });
  }

  return app;
}

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${token}`;
}
