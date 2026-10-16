// 刷新端点（双 Token 鉴权）

import { Hono } from 'hono';
import type { RuntimeState } from './admin-auth';
import type { Storage } from '../storage/interface';
import type { AppConfig, SyncRunResult } from '../core/types';

export interface RefreshRouteDeps {
  storage: Storage;
  config: AppConfig;
  runtime: RuntimeState;
  triggerRefresh: (opts?: { source?: 'cron' | 'manual' }) => Promise<SyncRunResult>;
}

export function createRefreshRouter(deps: RefreshRouteDeps): Hono {
  const router = new Hono();
  const { config, runtime } = deps;

  router.post('/refresh', async (c) => {
    if (config.refreshToken || config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      const validTokens = [config.refreshToken, config.adminToken].filter(Boolean);
      if (!validTokens.some((t) => auth === `Bearer ${t}`)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    if (runtime.getPatchLock()) {
      return c.json({ success: false, ran: false, outcome: 'busy', message: '正在应用屏蔽设置，请稍后重试',
        syncRunning: runtime.isSyncing() }, 409);
    }

    try {
      const result = await deps.triggerRefresh({ source: 'manual' });
      const status = result.outcome === 'timeout' ? 504 : result.outcome === 'failed' ? 500 : 200;
      return c.json({ ...result, success: result.outcome === 'saved', syncRunning: runtime.isSyncing() }, status);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ success: false, ran: true, outcome: 'failed', message: msg, syncRunning: runtime.isSyncing() }, 500);
    }
  });

  return router;
}
