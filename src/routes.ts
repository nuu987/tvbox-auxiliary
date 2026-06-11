// Hono 统一路由层 — 组合根

import { Hono } from 'hono';
import type { Storage } from './storage/interface';
import type { AppConfig, SyncSchedule } from './core/types';
import type { RuntimeState } from './routes/admin-auth';
import { createConfigOutputRouter } from './routes/config-output';
import { createDashboardRouter } from './routes/dashboard';
import { createUiPagesRouter } from './routes/ui-pages';
import { createStaticAssetsRouter } from './routes/static-assets';
import { createSourceMgmtRouter } from './routes/source-management';
import { createSettingsRouter } from './routes/settings';
import { createSearchQuotaRouter } from './routes/search-quota';
import { createCloudCredRouter } from './routes/cloud-credentials';
import { createMaccmsAdminRouter } from './routes/maccms-admin';
import { createBlacklistRouter } from './routes/blacklist';
import { createConfigEditorRouter } from './routes/config-editor';
import { createLiveSourcesRouter } from './routes/live-sources';
import { createMaccmsProxyRouter } from './routes/maccms-proxy';
import { createJarProxyRouter } from './routes/jar-proxy';
import { createRefreshRouter } from './routes/refresh';
import { createChannelProbeRouter } from './routes/channel-probe-admin';

export interface AppDeps {
  storage: Storage;
  config: AppConfig;
  triggerRefresh: (opts?: { source?: 'cron' | 'manual' }) => Promise<{ ran: boolean }>;
  onCronScheduleChange?: (schedule: SyncSchedule) => void;
  cronEnvSchedule?: SyncSchedule | null;
  enableChannelProbe?: boolean;
  runtime: RuntimeState;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { storage, config, runtime } = deps;

  // ─── Public sub-apps ──────────────────────────────────────
  app.route('/', createConfigOutputRouter({ storage, config }));
  app.route('/', createDashboardRouter({ storage, config, runtime }));
  app.route('/', createUiPagesRouter({ config }));
  app.route('/', createStaticAssetsRouter());

  // ─── Admin sub-apps ───────────────────────────────────────
  app.route('/', createSourceMgmtRouter({ storage, config }));
  app.route('/', createSettingsRouter({
    storage, config, runtime,
    onCronScheduleChange: deps.onCronScheduleChange,
    cronEnvSchedule: deps.cronEnvSchedule,
  }));
  app.route('/', createSearchQuotaRouter({ storage, config }));
  app.route('/', createCloudCredRouter({ storage, config }));
  app.route('/', createMaccmsAdminRouter({ storage, config }));
  app.route('/', createBlacklistRouter({ storage, config, runtime }));
  app.route('/', createConfigEditorRouter({ storage, config }));
  app.route('/', createLiveSourcesRouter({ storage, config }));

  // ─── Conditional proxy routes ─────────────────────────────
  if (config.localBaseUrl) {
    app.route('/', createMaccmsProxyRouter({ storage, config }));
    app.route('/', createJarProxyRouter({ storage, config }));
  }

  // ─── Refresh (dual-token auth) ────────────────────────────
  app.route('/', createRefreshRouter({
    storage, config, runtime,
    triggerRefresh: deps.triggerRefresh,
  }));

  // ─── Channel probe (conditional) ──────────────────────────
  if (deps.enableChannelProbe) {
    app.route('/', createChannelProbeRouter({ storage, config }));
  }

  return app;
}
