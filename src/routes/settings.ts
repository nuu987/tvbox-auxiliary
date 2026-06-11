// 设置管理：名称定制、同步频率、测速开关、智能 JAR、直播禁用、边缘代理
// 按 D-02 合并所有小设置区段为一个模块

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, NameTransformConfig, SyncSchedule, SyncPeriod, EdgeProxyConfig } from '../core/types';
import {
  NAME_TRANSFORM,
  CRON_INTERVAL,
  DEFAULT_SYNC_SCHEDULE,
  SPEED_TEST_ENABLED,
  SMART_JAR_URL_ENABLED,
  LIVE_DISABLED,
  EDGE_PROXIES,
} from '../core/config';
import { patchMergedConfig } from '../core/blacklist';
import { adminAuthMiddleware } from './admin-auth';
import type { RuntimeState } from './admin-auth';
import { logger } from '../core/logger';

export interface SettingsRouteDeps {
  storage: Storage;
  config: AppConfig;
  runtime: RuntimeState;
  onCronScheduleChange?: (schedule: SyncSchedule) => void;
  cronEnvSchedule?: SyncSchedule | null;
}

export function createSettingsRouter(deps: SettingsRouteDeps): Hono {
  const { storage, config } = deps;
  const router = new Hono();

  // All endpoints require admin auth
  router.use('/admin/*', adminAuthMiddleware(config));

  // ─── 名称定制 API ──────────────────────────────────────
  router.get('/admin/name-transform', async (c) => {
    const raw = await storage.get(NAME_TRANSFORM);
    const transform: NameTransformConfig = raw ? JSON.parse(raw) : {};
    return c.json(transform);
  });

  router.put('/admin/name-transform', async (c) => {
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
  router.get('/admin/cron-interval', async (c) => {
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

  router.put('/admin/cron-interval', async (c) => {
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
  router.get('/admin/speed-test', async (c) => {
    const raw = await storage.get(SPEED_TEST_ENABLED);
    return c.json({ enabled: raw !== 'false' });
  });

  router.put('/admin/speed-test', async (c) => {
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
  router.get('/admin/smart-jar-url', async (c) => {
    const raw = await storage.get(SMART_JAR_URL_ENABLED);
    return c.json({ enabled: raw === 'true' }); // 默认关闭（D-10）
  });

  router.put('/admin/smart-jar-url', async (c) => {
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
  router.get('/admin/live-disabled', async (c) => {
    const raw = await storage.get(LIVE_DISABLED);
    return c.json({ disabled: raw !== 'false' }); // 默认已禁用
  });

  router.put('/admin/live-disabled', async (c) => {
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
  router.get('/admin/edge-proxies', async (c) => {
    const raw = await storage.get(EDGE_PROXIES);
    return c.json(raw ? JSON.parse(raw) : {});
  });

  router.put('/admin/edge-proxies', async (c) => {
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

  return router;
}
