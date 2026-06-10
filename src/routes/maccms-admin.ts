// MacCMS Admin CRUD + 验证

import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth';
import type { Storage } from '../storage/interface';
import type { AppConfig, MacCMSSourceEntry } from '../core/types';
import { validateMacCMS } from '../core/maccms';
import { MACCMS_SOURCES } from '../core/config';

export interface MaccmsAdminRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createMaccmsAdminRouter(deps: MaccmsAdminRouteDeps): Hono {
  const router = new Hono();
  const { storage, config } = deps;

  // 所有路由需要 admin 鉴权
  router.use('*', adminAuthMiddleware(config));

  // 列表
  router.get('/admin/maccms', async (c) => {
    const raw = await storage.get(MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources);
  });

  // 新增（支持批量）
  router.post('/admin/maccms', async (c) => {
    let body: MacCMSSourceEntry | MacCMSSourceEntry[];
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const newEntries = Array.isArray(body) ? body : [body];

    // 验证字段
    for (const entry of newEntries) {
      if (!entry.key?.trim() || !entry.name?.trim() || !entry.api?.trim()) {
        return c.json({ error: 'Each entry requires key, name, and api' }, 400);
      }
      try {
        new URL(entry.api);
      } catch {
        return c.json({ error: `Invalid URL: ${entry.api}` }, 400);
      }
    }

    const raw = await storage.get(MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingKeys = new Set(sources.map((s) => s.key));

    let added = 0;
    for (const entry of newEntries) {
      if (!existingKeys.has(entry.key)) {
        sources.push({ key: entry.key.trim(), name: entry.name.trim(), api: entry.api.trim() });
        existingKeys.add(entry.key);
        added++;
      }
    }

    await storage.put(MACCMS_SOURCES, JSON.stringify(sources));
    return c.json({ success: true, added, total: sources.length });
  });

  // 删除
  router.delete('/admin/maccms', async (c) => {
    let body: { key?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const key = body.key?.trim();
    if (!key) return c.json({ error: 'key is required' }, 400);

    const raw = await storage.get(MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = sources.filter((s) => s.key !== key);
    await storage.put(MACCMS_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  // 验证 MacCMS API URL
  router.post('/admin/maccms/validate', async (c) => {
    let body: { api?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const api = body.api?.trim();
    if (!api) return c.json({ error: 'api is required' }, 400);

    const ok = await validateMacCMS(api, config.siteTimeoutMs);
    return c.json({ api, valid: ok });
  });

  return router;
}
