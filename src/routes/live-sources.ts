// 直播源 CRUD

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import { LIVE_SOURCES, LIVE_CACHE_STATE } from '../core/config';
import { adminAuthMiddleware } from './admin-auth';
import { withSourceGate } from '../core/source-gate';
import { loadLiveCache, liveCacheView, manualLiveCacheValue } from '../core/live-cache';
import { decodeLiveSources } from '../core/live-policy';

export interface LiveSourcesRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createLiveSourcesRouter(deps: LiveSourcesRouteDeps): Hono {
  const { storage, config } = deps;
  const router = new Hono();

  // All endpoints require admin auth
  router.use('/admin/*', adminAuthMiddleware(config));

  router.get('/admin/lives', async (c) => {
    return withSourceGate(storage, async () => {
      const entries = decodeLiveSources(await storage.get(LIVE_SOURCES));
      const { state } = await loadLiveCache(storage);
      return c.json(entries.map(entry => ({ ...entry, cacheStatus: liveCacheView({ ...entry, type: 0 }, state) })));
    });
  });

  router.post('/admin/lives', async (c) => {
    let body: { name?: string; url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url) return c.json({ error: 'URL is required' }, 400);

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    if (body.name !== undefined && typeof body.name !== 'string') return c.json({ error: 'Invalid name' }, 400);
    const name = body.name?.trim() || '';
    return withSourceGate(storage, async () => {
      const entries = decodeLiveSources(await storage.get(LIVE_SOURCES));
      if (entries.some(e => e.url === url)) return c.json({ error: 'Live source already exists' }, 409);
      entries.push({ name, url });
      const cache = await manualLiveCacheValue(storage, entries);
      await storage.putMany({ [LIVE_SOURCES]: JSON.stringify(entries), ...(cache === undefined ? {} : { [LIVE_CACHE_STATE]: cache }) });
      return c.json({ success: true });
    });
  });

  router.delete('/admin/lives', async (c) => {
    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url) return c.json({ error: 'URL is required' }, 400);

    return withSourceGate(storage, async () => {
      const entries = decodeLiveSources(await storage.get(LIVE_SOURCES));
      const next = entries.filter(e => e.url !== url);
      const cache = await manualLiveCacheValue(storage, next);
      await storage.putMany({ [LIVE_SOURCES]: JSON.stringify(next), ...(cache === undefined ? {} : { [LIVE_CACHE_STATE]: cache }) });
      return c.json({ success: true });
    });
  });

  return router;
}
