// 频道测速 admin 路由（方案 D+ 运维独立模块）

import type { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import {
  isProbeEnabled,
  setProbeEnabled,
  loadStatus,
  runChannelProbe,
  isRunning,
} from '../core/channel-probe';

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${token}`;
}

export interface ChannelProbeRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function mountChannelProbeRoutes(app: Hono, deps: ChannelProbeRouteDeps): void {
  const { storage, config } = deps;

  // GET /admin/channel-probe/status — 查询状态 + 开关
  app.get('/admin/channel-probe/status', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
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
  app.put('/admin/channel-probe/toggle', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
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
  app.post('/admin/channel-probe/trigger', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (isRunning()) {
      return c.json({ success: false, error: 'Already running' }, 409);
    }
    if (!(await isProbeEnabled(storage))) {
      return c.json({ success: false, error: 'Probe is disabled, enable it first' }, 400);
    }
    // 异步启动
    runChannelProbe(storage).catch((err) => {
      console.error('[channel-probe-admin] Trigger error:', err);
    });
    return c.json({ success: true, message: 'Probe started' });
  });
}
