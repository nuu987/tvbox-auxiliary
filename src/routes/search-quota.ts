// 搜索配额管理（混合模块：admin + public endpoints）

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, SearchQuotaConfig } from '../core/types';
import { SEARCH_QUOTA_REPORT } from '../core/config';
import { loadSearchQuota, saveSearchQuota } from '../core/search-quota';
import { adminAuthMiddleware } from './admin-auth';

export interface SearchQuotaRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createSearchQuotaRouter(deps: SearchQuotaRouteDeps): Hono {
  const { storage, config } = deps;
  const router = new Hono();
  const auth = adminAuthMiddleware(config);

  // ─── Admin endpoints (with auth) ────────────────────────

  router.get('/admin/search-quota', auth, async (c) => {
    const quota = await loadSearchQuota(storage);
    return c.json(quota);
  });

  router.put('/admin/search-quota', auth, async (c) => {
    let body: Partial<SearchQuotaConfig>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const current = await loadSearchQuota(storage);
    if (typeof body.maxSearchable === 'number') current.maxSearchable = body.maxSearchable;
    if (Array.isArray(body.pinnedKeys)) current.pinnedKeys = body.pinnedKeys;

    await saveSearchQuota(storage, current);
    return c.json({ success: true, ...current });
  });

  router.post('/admin/search-quota/pinned', auth, async (c) => {
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const set = new Set(current.pinnedKeys);
    for (const key of body.keys) set.add(key);
    current.pinnedKeys = [...set];
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  // 重排 pinned 顺序（整体替换）
  router.put('/admin/search-quota/pinned', auth, async (c) => {
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    current.pinnedKeys = body.keys;
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  router.delete('/admin/search-quota/pinned', auth, async (c) => {
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const removeSet = new Set(body.keys);
    current.pinnedKeys = current.pinnedKeys.filter(k => !removeSet.has(k));
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  // 报告（admin 需鉴权）
  router.get('/admin/search-quota/report', auth, async (c) => {
    const raw = await storage.get(SEARCH_QUOTA_REPORT);
    if (!raw) return c.json({ error: 'No report yet. Run sync first.' }, 404);
    return c.json(JSON.parse(raw));
  });

  // ─── Public endpoint (no auth) ──────────────────────────

  // 报告精简版（dashboard 无需鉴权）
  router.get('/search-quota/summary', async (c) => {
    const raw = await storage.get(SEARCH_QUOTA_REPORT);
    if (!raw) return c.json({ enabled: false });
    return c.json({ enabled: true, ...JSON.parse(raw) });
  });

  return router;
}
