// 源管理 CRUD + 单层配置导入
import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, SourceEntry } from '../core/types';
import { MANUAL_SOURCES } from '../core/config';
import { adminAuthMiddleware } from './admin-auth';
import { withSourceGate, saveSourceRoots, captureSourceBaseline, type SourceBaseline } from '../core/source-fallback';
import { externalSourceEntry, planSourceImport, SourceImportError, type SourceImportPlan } from '../core/source-import';
import { sourceActivity, activityBusyMessage, type SourceActivity } from '../core/source-activity';
import { loadFetchProxy } from '../core/fetch-proxy';
import { sourceDisplayName } from '../core/source-name';
import { sourceMigrationReport } from '../core/source-import-policy';
import { sourceCapacity, sourceLimit, sourceLimitMessage } from '../core/source-capacity';

export interface SourceMgmtRouteDeps { storage: Storage; config: AppConfig; activity?: SourceActivity }
function importErrorBody(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error),
    ...(error instanceof SourceImportError && error.capacity ? { code: 'source_limit_exceeded', capacity: error.capacity } : {}) };
}

export function createSourceMgmtRouter({ storage, config, activity = sourceActivity(storage) }: SourceMgmtRouteDeps): Hono {
  const router = new Hono();
  const limit = sourceLimit(config);
  router.use('/admin/*', adminAuthMiddleware(config));
  router.use('/admin/*', async (c, next) => {
    if (c.req.method !== 'POST' || !['/admin/sources', '/admin/sources/import'].includes(c.req.path)) return next();
    const release = activity.acquire('import');
    if (!release) return c.json({ error: activityBusyMessage(activity) }, 409);
    try { await next(); } finally { release(); }
  });
  router.get('/admin/sources', async c => {
    const raw = await storage.get(MANUAL_SOURCES);
    c.header('X-Max-Data-Sources', String(limit));
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources.map(source => ({ ...source, name: sourceDisplayName(source) })));
  });
  router.get('/admin/sources/migration-result', async c => c.json({ report: await sourceMigrationReport(storage) }));

  const baseline = () => withSourceGate(storage, () => captureSourceBaseline(storage));
  const commit = (before: SourceBaseline, plan: SourceImportPlan) => withSourceGate(storage, async () => {
    const current = await captureSourceBaseline(storage);
    if (current.token !== before.token) throw new SourceImportError('Sources changed during checking; please retry', 409);
    const capacity = sourceCapacity(current.sources.length, limit);
    if (capacity.remaining !== null && plan.entries.length > capacity.remaining) throw new SourceImportError(sourceLimitMessage(limit), 409);
    if (plan.entries.length) await saveSourceRoots(storage, [...current.sources, ...plan.entries],
      {}, plan.entries.map(entry => entry.url), plan.accepted);
    return plan.result;
  });

  router.post('/admin/sources', async c => {
    let body: { name?: string; url?: string; configKey?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (typeof body?.url !== 'string' || !body.url.trim()) return c.json({ error: 'URL is required' }, 400);
    if ((body.name !== undefined && typeof body.name !== 'string')
      || (body.configKey !== undefined && typeof body.configKey !== 'string')) return c.json({ error: 'Invalid name or configKey' }, 400);
    try {
      const source = externalSourceEntry(body);
      const before = await baseline();
      if (sourceCapacity(before.sources.length, limit).remaining === 0) return c.json({ error: sourceLimitMessage(limit), code: 'source_limit_exceeded', capacity: sourceCapacity(before.sources.length, limit) }, 409);
      const plan = await planSourceImport({ source }, { sources: before.sources, timeoutMs: config.fetchTimeoutMs,
        maxDataSources: limit, proxyConfig: await loadFetchProxy(storage, config) });
      return c.json(await commit(before, plan));
    } catch (error) {
      return c.json(importErrorBody(error), error instanceof SourceImportError ? error.status : 500);
    }
  });

  router.delete('/admin/sources', async c => {
    let body: { url?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url) return c.json({ error: 'URL is required' }, 400);
    return withSourceGate(storage, async () => {
      const raw = await storage.get(MANUAL_SOURCES);
      const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
      const next = sources.filter(source => source.url !== url);
      await saveSourceRoots(storage, next);
      return c.json({ success: true, capacity: sourceCapacity(next.length, limit) });
    });
  });

  router.post('/admin/sources/import', async c => {
    let body: { input?: string; configKey?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const input = typeof body?.input === 'string' ? body.input.trim() : '';
    if (!input) return c.json({ error: 'input is required' }, 400);
    if (body.configKey !== undefined && typeof body.configKey !== 'string') return c.json({ error: '无效的独立解密字段' }, 400);
    if (typeof body.configKey === 'string' && body.configKey.trim()) return c.json({ error: '不支持独立解密的接口' }, 400);
    try {
      const before = await baseline();
      if (sourceCapacity(before.sources.length, limit).remaining === 0) return c.json({ error: sourceLimitMessage(limit), code: 'source_limit_exceeded', capacity: sourceCapacity(before.sources.length, limit) }, 409);
      const plan = await planSourceImport({ text: input },
        { sources: before.sources, timeoutMs: config.fetchTimeoutMs, maxDataSources: limit,
          proxyConfig: await loadFetchProxy(storage, config) });
      return c.json(await commit(before, plan));
    } catch (error) {
      return c.json(importErrorBody(error), error instanceof SourceImportError ? error.status : 500);
    }
  });
  return router;
}
