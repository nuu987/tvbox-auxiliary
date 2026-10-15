// 监控面板数据路由

import { Hono } from 'hono';
import { readAggregateOutputs } from '../core/aggregate-output';
import { LAST_UPDATE, MANUAL_SOURCES, MACCMS_SOURCES, LIVE_SOURCES, SOURCE_HEALTH } from '../core/config';
import { getDirtyMarker } from '../core/dirty-marker';
import { classifyStatus, STATUS_LABELS } from '../core/status-classifier';
import type { RuntimeState } from './admin-auth';
import type { Storage } from '../storage/interface';
import type { AppConfig, SourceFetchStatus, SourceHealthRecord } from '../core/types';
import { sourceAggregationStatuses, type SourceAggregationStatus } from '../core/source-fallback';
import { projectLiveJson } from '../core/live-policy';

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
    const outputs = await readAggregateOutputs(storage);
    const cached = outputs?.merged;

    let siteCount = 0;
    let parseCount = 0;
    let liveCount = 0;
    if (outputs && cached) {
      try {
        const parsed = JSON.parse(projectLiveJson(cached, outputs.livePolicy));
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
    const auth = c.req.header('Authorization');
    const isAdmin = config.adminToken && auth === 'Bearer ' + config.adminToken;
    if (isAdmin) {
      adminFields.syncRunning = runtime.isSyncing();
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
  router.get('/source-status', async (c) => {
    const raw = await storage.get(SOURCE_HEALTH);
    // unknown[] because the KV may contain old-format records (latestStatus, no status)
    const records: unknown[] = raw ? JSON.parse(raw) : [];

    // Migrate old-format records (has latestStatus but no status).
    // (r as any) supports old-format KV records that have latestStatus instead of fetchStatus —
    // removed once all records migrated (post-deploy) per PATTERNS.md line 469.
    const normalized: SourceHealthRecord[] = records.map((r: any) => {
      if ('latestStatus' in r && !('status' in r)) {
        // Old-format KV may carry coarse 'http_error'/'network_error' values that
        // Plan 03.1-02 removed from the SourceFetchStatus union. Cast through string
        // so the legacy-value comparison compiles while we migrate to granular subtypes.
        const rawStatus = r.latestStatus as string;
        const failures = (r.consecutiveFailures as number) || 0;
        const fetchStatus: SourceFetchStatus = rawStatus === 'http_error' ? 'http_4xx'
          : rawStatus === 'network_error' ? 'fetch_failed'
          : rawStatus as SourceFetchStatus;
        // Strip legacy latestStatus field so the response carries only the new schema
        const { latestStatus: _omit, ...rest } = r;
        return {
          ...rest,
          status: classifyStatus(fetchStatus, failures),
          fetchStatus,
        };
      }
      return r as SourceHealthRecord;
    });

    const aggregation = await sourceAggregationStatuses(storage);
    const withLabels: Array<SourceHealthRecord & { label: string; aggregation?: SourceAggregationStatus; local?: boolean }> = normalized.map(r => ({
      ...r,
      label: STATUS_LABELS[r.fetchStatus] || 'ERR',
      aggregation: aggregation.get(r.url)?.aggregation,
    }));
    // Local reads have no remote fetch status or fabricated HTTP success/failure count.
    const localRecords = [...aggregation.entries()].filter(([url, value]) => value.local && !withLabels.some(r => r.url === url))
      .map(([url, value]) => ({
        url, name: value.name, local: true,
        status: value.aggregation.latest?.reason ? 'ERR' : 'OK',
        consecutiveFailures: 0,
        label: value.aggregation.latest?.reason ? 'LOCAL UNAVAILABLE' : 'LOCAL OK',
        aggregation: value.aggregation,
      }));
    const responseRecords = [...withLabels, ...localRecords];

    // Compute summary
    let ok = 0, warn = 0, err = 0;
    for (const r of responseRecords) {
      if (r.status === 'OK') ok++;
      else if (r.status === 'WARN') warn++;
      else err++;
    }

    return c.json({
      records: responseRecords,
      summary: { ok, warn, err },
    });
  });

  return router;
}
