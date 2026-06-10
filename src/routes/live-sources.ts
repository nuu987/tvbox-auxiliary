// 直播源 CRUD

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, LiveSourceEntry } from '../core/types';
import { LIVE_SOURCES } from '../core/config';
import { adminAuthMiddleware } from './admin-auth';

export interface LiveSourcesRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createLiveSourcesRouter(deps: LiveSourcesRouteDeps): Hono {
  const { storage, config } = deps;
  const router = new Hono();

  // All endpoints require admin auth
  router.use('*', adminAuthMiddleware(config));

  router.get('/admin/lives', async (c) => {
    const raw = await storage.get(LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(entries);
  });

  router.post('/admin/lives', async (c) => {
    let body: { name?: string; url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const name = body.name?.trim() || '';
    const raw = await storage.get(LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];

    if (entries.some((e) => e.url === url)) {
      return c.json({ error: 'Live source already exists' }, 409);
    }

    entries.push({ name, url });
    await storage.put(LIVE_SOURCES, JSON.stringify(entries));

    return c.json({ success: true });
  });

  router.delete('/admin/lives', async (c) => {
    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = entries.filter((e) => e.url !== url);
    await storage.put(LIVE_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  return router;
}
