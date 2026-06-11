// 刷新端点（双 Token 鉴权）

import { Hono } from 'hono';
import type { RuntimeState } from './admin-auth';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';

export interface RefreshRouteDeps {
  storage: Storage;
  config: AppConfig;
  runtime: RuntimeState;
  triggerRefresh: (opts?: { source?: 'cron' | 'manual' }) => Promise<{ ran: boolean }>;
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

  return router;
}
