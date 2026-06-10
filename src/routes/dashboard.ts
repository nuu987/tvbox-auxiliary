// 监控面板数据路由

import { Hono } from 'hono';
import { LAST_UPDATE, MANUAL_SOURCES, MACCMS_SOURCES, LIVE_SOURCES, MERGED_CONFIG, SOURCE_HEALTH } from '../core/config';
import { getDirtyMarker } from '../core/dirty-marker';
import type { RuntimeState } from './admin-auth';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';

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
    const records = raw ? JSON.parse(raw) : [];
    return c.json(records);
  });

  return router;
}
