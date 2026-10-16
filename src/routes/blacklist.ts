// 黑名单管理 + 即时补丁 + Dirty marker

import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth';
import type { RuntimeState } from './admin-auth';
import {
  loadBlacklist, mutateBlacklist, resolveSiteIds, StaleSiteFingerprint,
  saveRegexRule, deleteRegexRule, patchMergedConfig,
} from '../core/blacklist';
import { setDirtyMarker, clearDirtyMarker } from '../core/dirty-marker';
import { MERGED_CONFIG, MERGED_CONFIG_FULL } from '../core/config';
import { logger } from '../core/logger';
import type { Storage } from '../storage/interface';
import type { AppConfig, SourceHealthRecord, TVBoxConfig } from '../core/types';

export interface BlacklistRouteDeps {
  storage: Storage;
  config: AppConfig;
  runtime: RuntimeState;
}

export function createBlacklistRouter(deps: BlacklistRouteDeps): Hono {
  const router = new Hono();
  const { storage, config, runtime } = deps;

  router.use('/admin/*', adminAuthMiddleware(config));

  // ─── Regex Rule CRUD ──────────────────────────────────
  router.post('/admin/regex-rule', async (c) => {
    let body: { pattern?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const pattern = body.pattern?.trim();
    if (!pattern) {
      return c.json({ error: 'Pattern cannot be empty' }, 400);
    }
    const t0 = performance.now();
    const result = await saveRegexRule(storage, pattern);
    if (!result.success) {
      logger.warnFields('regex', 'rule-save-failed', {
        pattern: pattern.length > 80 ? pattern.slice(0, 80) + '...' : pattern,
        error: result.error,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ error: result.error }, 400);
    }
    await setDirtyMarker(storage);
    logger.debugFields('regex', 'rule-save', {
      pattern: pattern.length > 80 ? pattern.slice(0, 80) + '...' : pattern,
      ruleId: result.rule?.id,
      durationMs: Math.round(performance.now() - t0),
    });
    return c.json({ success: true, rule: result.rule });
  });

  router.delete('/admin/regex-rule/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'id is required' }, 400);
    }
    const t0 = performance.now();
    const result = await deleteRegexRule(storage, id);
    if (!result.success) {
      logger.warnFields('regex', 'rule-delete-failed', {
        ruleId: id,
        error: result.error,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ error: result.error }, 404);
    }
    await setDirtyMarker(storage);
    logger.debugFields('regex', 'rule-delete', {
      ruleId: id,
      durationMs: Math.round(performance.now() - t0),
    });
    return c.json({ success: true });
  });

  router.get('/admin/regex-rules', async (c) => {
    const blacklist = await loadBlacklist(storage);
    return c.json({ rules: blacklist.regexRules });
  });

  // All read/modify/write operations share the migration's short storage gate.
  async function change(type: string, ids: string[], remove = false): Promise<number> {
    return mutateBlacklist(storage, blacklist => {
      const key = type === 'regexOverrides' ? 'regexBlockOverrides' : type as 'sites' | 'parses' | 'lives';
      const resolved = type === 'sites' ? ids.flatMap(id => resolveSiteIds(blacklist, id)) : ids;
      const before = blacklist[key].length;
      if (remove) blacklist[key] = blacklist[key].filter(id => !resolved.includes(id));
      else blacklist[key] = [...new Set([...blacklist[key], ...resolved])];
      return Math.abs(blacklist[key].length - before);
    });
  }
  for (const action of ['add', 'batch', 'remove'] as const) {
    const path = action === 'batch' ? '/admin/blacklist/batch' : '/admin/blacklist';
    const method = action === 'remove' ? 'delete' : 'post';
    router[method](path, async c => {
      let body: { type?: string; id?: string; ids?: string[] };
      try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
      const type = body?.type;
      const ids = action === 'batch' ? body?.ids : typeof body?.id === 'string' ? [body.id] : [];
      if (!type || !['sites', 'parses', 'lives', 'regexOverrides'].includes(type)) {
        return c.json({ error: 'type must be sites, parses, lives, or regexOverrides' }, 400);
      }
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) {
        return c.json({ error: action === 'batch' ? 'type and ids[] are required' : 'type and id are required' }, 400);
      }
      if (ids.length > 500) return c.json({ error: 'Too many ids (max 500)' }, 400);
      try {
        const changed = await change(type, ids, action === 'remove');
        await setDirtyMarker(storage);
        logger.debugFields('blacklist', action, { type, count: ids.length, changed });
        return c.json({ success: true, ...(action === 'batch' ? { added: changed } : {}) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('blacklist', message);
        return c.json({ error: message }, error instanceof StaleSiteFingerprint ? 409 : 500);
      }
    });
  }

  // ─── 即时补丁 ──────────────────────────────────────────
  router.post('/admin/patch-config', async (c) => {
    if (runtime.isSyncing()) {
      return c.json({ error: 'Sync in progress' }, 409);
    }
    if (runtime.getPatchLock()) {
      return c.json({ error: 'Patch in progress' }, 409);
    }
    runtime.setPatchLock(true);
    const t0 = performance.now();
    try {
      const result = await patchMergedConfig(storage);
      const durationMs = Math.round(performance.now() - t0);
      if (!result.patched) {
        logger.debugFields('blacklist', 'patch-config', {
          patched: false, durationMs, reason: result.reason,
        });
        return c.json({ ok: false, error: result.reason || 'Patch skipped' }, 200);
      }
      logger.debugFields('blacklist', 'patch-config', {
        patched: true, durationMs,
      });
      await clearDirtyMarker(storage);
      return c.json({ ok: true, warning: result.warning });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warnFields('blacklist', 'patch-config-failed', {
        error: msg,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ ok: false, error: msg }, 500);
    } finally {
      runtime.setPatchLock(false);
    }
  });

  // ─── Dirty marker 管理 ──────────────────────────────────
  router.delete('/admin/dirty-marker', async (c) => {
    const t0 = performance.now();
    await clearDirtyMarker(storage);
    logger.debugFields('blacklist', 'dirty-marker-clear', {
      durationMs: Math.round(performance.now() - t0),
    });
    return c.json({ ok: true });
  });

  return router;
}
