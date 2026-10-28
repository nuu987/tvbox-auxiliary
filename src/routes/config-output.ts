// 配置输出路由（主配置 + 纯直播配置）

import { Hono } from 'hono';
import { readAggregateOutputs } from '../core/aggregate-output';
import { getRequestBaseUrl, applyBaseUrlPlaceholder, assertHostAllowed } from '../core/base-url';
import { SITE_NAME_EMOJI_REMOVAL, SMART_JAR_URL_ENABLED } from '../core/config';
import { projectLiveJson } from '../core/live-policy';
import { removeEmojiFromSiteNames } from '../core/cleaner';
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
    const outputs = await readAggregateOutputs(storage);
    const cached = outputs?.merged;

    if (!outputs || !cached) {
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

    const emojiRemovalEnabled = await storage.get(SITE_NAME_EMOJI_REMOVAL) === 'true';
    let body: string;
    try {
      // Insert declared URLs after host substitution so their literal values stay intact.
      body = projectLiveJson(
        cached,
        outputs.livePolicy,
        base => applyBaseUrlPlaceholder(base, actualBase, fallback),
        actualBase,
        emojiRemovalEnabled ? removeEmojiFromSiteNames : undefined,
      );
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }

    return c.body(body, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  });

  // ─── 纯直播配置 ────────────────────────────────────────
  router.get('/live-config', async (c) => {
    const outputs = await readAggregateOutputs(storage);
    const cached = outputs?.merged;

    if (!outputs || !cached) {
      return c.json({ error: 'No config available yet.' }, 503);
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
      const full = JSON.parse(projectLiveJson(cached, outputs.livePolicy,
        base => applyBaseUrlPlaceholder(base, actualBaseEarly, fallbackEarly), actualBaseEarly));
      const liveConfig = { lives: full.lives || [] };
      const liveBody = JSON.stringify(liveConfig);
      return c.body(liveBody, 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }
  });

  return router;
}
