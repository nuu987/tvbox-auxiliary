// MacCMS API 代理（TVBox 客户端通过此代理访问 MacCMS 源）

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, MacCMSSourceEntry, EdgeProxyConfig } from '../core/types';
import { MACCMS_SOURCES, EDGE_PROXIES } from '../core/config';
import { logger } from '../core/logger';

export interface MaccmsProxyRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createMaccmsProxyRouter(deps: MaccmsProxyRouteDeps): Hono {
  const router = new Hono();
  const { storage, config } = deps;

  router.all('/api/:key', async (c) => {
    const key = c.req.param('key');
    const raw = await storage.get(MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const source = sources.find((s) => s.key === key);

    if (!source) {
      return c.json({ error: 'Unknown MacCMS source' }, 404);
    }

    const targetUrl = new URL(source.api);
    const reqUrl = new URL(c.req.url);
    reqUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

    // 构造候选请求链：优先走 edge（Vercel → fetchProxy），兜底直连
    const attempts: { label: string; url: string; headers: Record<string, string> }[] = [];

    const edgeRaw = await storage.get(EDGE_PROXIES);
    if (edgeRaw) {
      const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
      const encoded = encodeURIComponent(targetUrl.toString());
      if (edge.vercel) {
        attempts.push({
          label: 'vercel',
          url: `${edge.vercel.replace(/\/$/, '')}/api/proxy?url=${encoded}`,
          headers: {},
        });
      }
      if (edge.fetchProxy) {
        attempts.push({
          label: 'fetchProxy',
          url: `${edge.fetchProxy.replace(/\/$/, '')}/fetch-proxy?url=${encoded}`,
          headers: config.adminToken ? { Authorization: `Bearer ${config.adminToken}` } : {},
        });
      }
    }

    attempts.push({ label: 'direct', url: targetUrl.toString(), headers: {} });

    let lastError = '';
    for (const { label, url, headers } of attempts) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'okhttp/3.12.0', ...headers },
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
          lastError = `upstream ${resp.status}`;
          logger.debug('maccms-proxy', `${key} via ${label} fail: ${lastError}`);
          continue;
        }
        const data = await resp.json();
        logger.debug('maccms-proxy', `${key} via ${label} ok`);
        return c.json(data, 200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300',
        });
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        logger.warn('maccms-proxy', `${key} via ${label} fail: ${lastError}`);
      }
    }

    return c.json({ error: lastError || 'All proxies failed' }, 502);
  });

  return router;
}
