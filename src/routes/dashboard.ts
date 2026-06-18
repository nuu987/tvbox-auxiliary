// 监控面板数据路由

import { Hono } from 'hono';
import { LAST_UPDATE, MANUAL_SOURCES, MACCMS_SOURCES, LIVE_SOURCES, MERGED_CONFIG, SOURCE_HEALTH, SYNC_STATUS } from '../core/config';
import { getDirtyMarker } from '../core/dirty-marker';
import { classifyStatus, STATUS_LABELS } from '../core/status-classifier';
import type { RuntimeState } from './admin-auth';
import type { Storage } from '../storage/interface';
import type { AppConfig, SourceFetchStatus, SourceHealthRecord } from '../core/types';

export interface DashboardRouteDeps {
  storage: Storage;
  config: AppConfig;
  runtime: RuntimeState;
}

export function createDashboardRouter(deps: DashboardRouteDeps): Hono {
  const router = new Hono();
  const { storage, config, runtime } = deps;

  // ─── 监控面板数据 ──────────────────────────────────────
  router.get('/status-data', async (c) => {
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

    // 读取同步状态
    let syncSuccess: boolean | null = null;
    let syncFailedDownloads = 0;
    const syncStatusRaw = await storage.get(SYNC_STATUS);
    if (syncStatusRaw) {
      try {
        const syncStatus = JSON.parse(syncStatusRaw);
        syncSuccess = syncStatus.success ?? null;
        syncFailedDownloads = syncStatus.downloadFailed || 0;
      } catch { /* ignore */ }
    }

    const warnings: string[] = [];
    if (config.dockerMissingBaseUrl) {
      warnings.push('docker_no_base_url');
    }

    const adminFields: Record<string, unknown> = {};
    const auth = c.req.header('Authorization');
    const isAdmin = config.adminToken && auth === 'Bearer ' + config.adminToken;
    if (isAdmin) {
      adminFields.syncRunning = runtime.isSyncing();
      adminFields.dirtyMarker = await getDirtyMarker(storage);
      // 管理员可见完整同步状态
      if (syncStatusRaw) {
        try {
          adminFields.syncStatus = JSON.parse(syncStatusRaw);
        } catch { /* ignore */ }
      }
    }

    return c.json({
      lastUpdate: lastUpdate || 'never',
      sourceCount: sources ? JSON.parse(sources).length : 0,
      macCMSCount: macCMSSources ? JSON.parse(macCMSSources).length : 0,
      liveSourceCount: liveSources ? JSON.parse(liveSources).length : 0,
      sites: siteCount,
      parses: parseCount,
      lives: liveCount,
      syncSuccess,
      syncFailedDownloads,
      ...adminFields,
      warnings,
    });
  });

  // ─── 源健康状态（无认证，Dashboard 需要访问）─────────────
  router.get('/source-status', async (c) => {
    const raw = await storage.get(SOURCE_HEALTH);
    // unknown[] because the KV may contain old-format records (latestStatus, no status)
    const records: unknown[] = raw ? JSON.parse(raw) : [];

    // Migrate old-format records (has latestStatus but no status).
    // (r as any) supports old-format KV records that have latestStatus instead of fetchStatus —
    // removed once all records migrated (post-deploy) per PATTERNS.md line 469.
    const normalized: SourceHealthRecord[] = records.map((r: any) => {
      if ('latestStatus' in r && !('status' in r)) {
        const rawStatus = r.latestStatus as SourceFetchStatus;
        const failures = (r.consecutiveFailures as number) || 0;
        // Map old coarse types to valid granular types
        const fetchStatus: SourceFetchStatus = rawStatus === 'http_error' ? 'http_4xx'
          : rawStatus === 'network_error' ? 'fetch_failed'
          : rawStatus;
        return {
          ...r,
          status: classifyStatus(fetchStatus, failures),
          fetchStatus,
        };
      }
      return r as SourceHealthRecord;
    });

    // Compute summary
    let ok = 0, warn = 0, err = 0;
    for (const r of normalized) {
      if (r.status === 'OK') ok++;
      else if (r.status === 'WARN') warn++;
      else err++;
    }

    // Add computed label field per record
    const withLabels = normalized.map(r => ({
      ...r,
      label: STATUS_LABELS[r.fetchStatus] || 'ERR',
    }));

    return c.json({
      records: withLabels,
      summary: { ok, warn, err },
    });
  });

  return router;
}
