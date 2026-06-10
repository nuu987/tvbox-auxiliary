// Admin auth middleware + RuntimeState interface

import type { Context, Next } from 'hono';
import type { AppConfig } from '../core/types';

export function adminAuthMiddleware(config: AppConfig) {
  return async (c: Context, next: Next) => {
    if (!config.adminToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const auth = c.req.header('Authorization');
    if (auth !== `Bearer ${config.adminToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}

export interface RuntimeState {
  getPatchLock: () => boolean;
  setPatchLock: (locked: boolean) => void;
  isSyncing: () => boolean;
}
