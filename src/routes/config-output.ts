// 配置输出路由（主配置 + 纯直播配置）

import { Hono } from 'hono';
import { getRequestBaseUrl, applyBaseUrlPlaceholder, assertHostAllowed } from '../core/base-url';
import { MERGED_CONFIG, SMART_JAR_URL_ENABLED, LIVE_DISABLED } from '../core/config';
import { logger } from '../core/logger';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';

export interface ConfigOutputRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createConfigOutputRouter(deps: ConfigOutputRouteDeps): Hono {
  const router = new Hono();
  const { storage, config } = deps;

  // ─── 主配置 ────────────────────────────────────────────
  router.get('/', async (c) => {
    const cached = await storage.get(MERGED_CONFIG);

    if (!cached) {
      return c.json(
        { error: 'No config available yet. Add sources in /admin and trigger a refresh.' },
        503,
      );
    }

    const smartRaw = await storage.get(SMART_JAR_URL_ENABLED);
    const smartEnabled = smartRaw === 'true'; // 默认关闭（D-10）
    const fallback = (config.localBaseUrl || '').replace(/\/$/, '');
    const dmzEnabled = process.env.DMZ === '0';
    const actualBase = smartEnabled
      ? getRequestBaseUrl(c, fallback, dmzEnabled)
      : fallback;
    if (smartEnabled) {
      if (!assertHostAllowed(actualBase, fallback, c, dmzEnabled)) {
        logger.securityFields('host-intercept', {
          method: 'GET',
          path: '/',
          result: 'blocked',
          reason: 'non_lan_host',
          actualBase,
          fallbackBase: fallback,
          host: c.req.header('Host') || '-',
          xForwardedHost: c.req.header('X-Forwarded-Host') || '-',
          dmz: process.env.DMZ ?? '(unset)',
          smartJarUrl: smartEnabled,
        });
        return c.text('Forbidden', 403);
      }
    }

    // LIVE_DISABLED 防御性检查：同步管道中若已禁用直播，lives 字段已被清空；
    // 但为防御性保险，在主输出路由再次检查
    const liveDisabledRaw = await storage.get(LIVE_DISABLED);
    let outputData = cached;
    if (liveDisabledRaw !== 'false') {
      try {
        const parsed = JSON.parse(cached);
        parsed.lives = [];
        outputData = JSON.stringify(parsed);
      } catch { /* 解析失败就继续用原始 cached */ }
    }

    const body = applyBaseUrlPlaceholder(outputData, actualBase, fallback);

    return c.body(body, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      'Access-Control-Allow-Origin': '*',
    });
  });

  // ─── 纯直播配置 ────────────────────────────────────────
  router.get('/live-config', async (c) => {
    const cached = await storage.get(MERGED_CONFIG);

    if (!cached) {
      return c.json({ error: 'No config available yet.' }, 503);
    }

    // 直播功能禁用开关：直接返回空 lives，跳过 smart JAR 处理
    const liveDisabledRaw = await storage.get(LIVE_DISABLED);
    if (liveDisabledRaw !== 'false') {
      return c.body(JSON.stringify({ lives: [] }), 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
    }

    // WR-01: 先做 smart-jar/host 校验（与 / 路由顺序一致），避免无谓的 JSON.parse/
    // stringify 工作。若校验失败返回 403，不会浪费 CPU 周期处理 JSON。
    const smartRawEarly = await storage.get(SMART_JAR_URL_ENABLED);
    const smartEnabledEarly = smartRawEarly === 'true';
    const fallbackEarly = (config.localBaseUrl || '').replace(/\/$/, '');
    const dmzEnabledEarly = process.env.DMZ === '0';
    const actualBaseEarly = smartEnabledEarly
      ? getRequestBaseUrl(c, fallbackEarly, dmzEnabledEarly)
      : fallbackEarly;
    if (smartEnabledEarly) {
      if (!assertHostAllowed(actualBaseEarly, fallbackEarly, c, dmzEnabledEarly)) {
        logger.securityFields('host-intercept', {
          method: 'GET',
          path: '/live-config',
          result: 'blocked',
          reason: 'non_lan_host',
          actualBase: actualBaseEarly,
          fallbackBase: fallbackEarly,
          host: c.req.header('Host') || '-',
          xForwardedHost: c.req.header('X-Forwarded-Host') || '-',
          dmz: process.env.DMZ ?? '(unset)',
          smartJarUrl: smartEnabledEarly,
        });
        return c.text('Forbidden', 403);
      }
    }

    try {
      const full = JSON.parse(cached);
      const liveConfig = { lives: full.lives || [] };
      const liveBody = JSON.stringify(liveConfig);
      return c.body(applyBaseUrlPlaceholder(liveBody, actualBaseEarly, fallbackEarly), 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=1800',
        'Access-Control-Allow-Origin': '*',
      });
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }
  });

  return router;
}
