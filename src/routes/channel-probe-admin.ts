// 频道测速 admin 路由（方案 D+ 运维独立模块）

import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import {
  isProbeEnabled,
  setProbeEnabled,
  loadStatus,
  runChannelProbe,
  isRunning,
} from '../core/channel-probe';
import { logger } from '../core/logger';

export interface ChannelProbeRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createChannelProbeRouter(deps: ChannelProbeRouteDeps): Hono {
  const router = new Hono();
  const { storage, config } = deps;

  const auth = adminAuthMiddleware(config);

  // GET /admin/channel-probe/status — 查询状态 + 开关
  router.get('/admin/channel-probe/status', auth, async (c) => {
    const [enabled, status] = await Promise.all([
      isProbeEnabled(storage),
      loadStatus(storage),
    ]);
    return c.json({
      enabled,
      running: isRunning(),
      status,
    });
  });

  // PUT /admin/channel-probe/toggle — 开关
  router.put('/admin/channel-probe/toggle', auth, async (c) => {
    let body: { enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    await setProbeEnabled(storage, body.enabled);
    return c.json({ success: true, enabled: body.enabled });
  });

  // POST /admin/channel-probe/trigger — 手动触发（异步启动，不阻塞响应）
  router.post('/admin/channel-probe/trigger', auth, async (c) => {
    if (isRunning()) {
      return c.json({ success: false, error: 'Already running' }, 409);
    }
    if (!(await isProbeEnabled(storage))) {
      return c.json({ success: false, error: 'Probe is disabled, enable it first' }, 400);
    }
    // 异步启动
    runChannelProbe(storage).catch((err) => {
      logger.error('channel-probe-admin', 'Trigger error: ' + (err instanceof Error ? err.message : String(err)));
    });
    return c.json({ success: true, message: 'Probe started' });
  });

  return router;
}

