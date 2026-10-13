// 源管理 CRUD + 单层配置导入
import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, SourceEntry } from '../core/types';
import { MANUAL_SOURCES } from '../core/config';
import { adminAuthMiddleware } from './admin-auth';
import { withSourceGate, saveSourceRoots, captureSourceBaseline, type SourceBaseline } from '../core/source-fallback';
import { importSourceEntry, planSourceImport, SourceImportError, type SourceImportPlan } from '../core/source-import';
import { sourceMigrationReport } from '../core/source-import-policy';

export interface SourceMgmtRouteDeps { storage: Storage; config: AppConfig }

export function createSourceMgmtRouter({ storage, config }: SourceMgmtRouteDeps): Hono {
  const router = new Hono();
  router.use('/admin/*', adminAuthMiddleware(config));
  router.get('/admin/sources', async c => {
    const raw = await storage.get(MANUAL_SOURCES);
    return c.json(raw ? JSON.parse(raw) : []);
  });
  router.get('/admin/sources/migration-result', async c => c.json({ report: await sourceMigrationReport(storage) }));

  const baseline = () => withSourceGate(storage, () => captureSourceBaseline(storage));
  const commit = (before: SourceBaseline, plan: SourceImportPlan) => withSourceGate(storage, async () => {
    const current = await captureSourceBaseline(storage);
    if (current.token !== before.token) throw new SourceImportError('Sources changed during checking; please retry', 409);
    if (plan.entries.length) await saveSourceRoots(storage, [...current.sources, ...plan.entries],
      plan.inline ? { [plan.inline.key]: plan.inline.text } : {}, plan.entries.map(entry => entry.url));
    return plan.result;
  });

  router.post('/admin/sources', async c => {
    let body: { name?: string; url?: string; configKey?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (typeof body?.url !== 'string' || !body.url.trim()) return c.json({ error: 'URL is required' }, 400);
    if ((body.name !== undefined && typeof body.name !== 'string')
      || (body.configKey !== undefined && typeof body.configKey !== 'string')) return c.json({ error: 'Invalid name or configKey' }, 400);
    try {
      const source = importSourceEntry({ name: body.name?.trim() || '', url: body.url, configKey: body.configKey });
      const before = await baseline();
      if (before.sources.some(entry => entry.url === source.url)) return c.json({ error: 'Source already exists' }, 409);
      const plan = await planSourceImport({ source }, { sources: before.sources, knownLeaves: before.knownLeaves, timeoutMs: config.fetchTimeoutMs });
      return c.json(await commit(before, plan));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, error instanceof SourceImportError ? error.status : 500);
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
      await saveSourceRoots(storage, sources.filter(source => source.url !== url));
      return c.json({ success: true });
    });
  });

  router.post('/admin/sources/import', async c => {
    let body: { input?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const input = typeof body?.input === 'string' ? body.input.trim() : '';
    if (!input) return c.json({ error: 'input is required' }, 400);
    try {
      const before = await baseline();
      const plan = await planSourceImport(/^https?:\/\//i.test(input)
        ? { source: { name: 'Imported', url: input } } : { text: input },
        { sources: before.sources, knownLeaves: before.knownLeaves, timeoutMs: config.fetchTimeoutMs });
      return c.json(await commit(before, plan));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, error instanceof SourceImportError ? error.status : 500);
    }
  });
  return router;
}
