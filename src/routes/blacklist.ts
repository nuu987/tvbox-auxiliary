// 黑名单管理 + 即时补丁 + Dirty marker

import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth';
import type { RuntimeState } from './admin-auth';
import {
  siteFingerprint, loadBlacklist, saveBlacklist,
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

  // ─── Blacklist CRUD ─────────────────────────────────────
  router.post('/admin/blacklist', async (c) => {
    let body: { type?: string; id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, id } = body;
    if (!type || !id) return c.json({ error: 'type and id are required' }, 400);
    if (!['sites', 'parses', 'lives', 'regexOverrides'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, lives, or regexOverrides' }, 400);
    }

    const t0 = performance.now();
    try {
      const blacklist = await loadBlacklist(storage);
      if (type === 'regexOverrides') {
        const beforeSize = blacklist.regexBlockOverrides.length;
        if (!blacklist.regexBlockOverrides.includes(id)) {
          blacklist.regexBlockOverrides.push(id);
        }
        await saveBlacklist(storage, blacklist);
        await setDirtyMarker(storage);
        const afterSize = blacklist.regexBlockOverrides.length;
        logger.debugFields('blacklist', 'block', {
          type, id, beforeSize, afterSize,
          added: afterSize > beforeSize,
          durationMs: Math.round(performance.now() - t0),
        });
        return c.json({ success: true });
      }
      const key = type as 'sites' | 'parses' | 'lives';
      const list = blacklist[key];
      const beforeSize = list.length;
      if (!list.includes(id)) {
        list.push(id);
      }
      await saveBlacklist(storage, blacklist);
      await setDirtyMarker(storage);
      const afterSize = list.length;
      logger.debugFields('blacklist', 'block', {
        type, id, beforeSize, afterSize,
        added: afterSize > beforeSize,
        durationMs: Math.round(performance.now() - t0),
      });

      return c.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warnFields('blacklist', 'block-failed', {
        type, id, error: msg,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ error: 'Server error: ' + msg }, 500);
    }
  });

  router.post('/admin/blacklist/batch', async (c) => {
    let body: { type?: string; ids?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, ids } = body;
    if (!type || !Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: 'type and ids[] are required' }, 400);
    }
    if (ids.length > 500) {
      return c.json({ error: 'Too many ids (max 500)' }, 400);
    }
    if (!['sites', 'parses', 'lives', 'regexOverrides'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, lives, or regexOverrides' }, 400);
    }

    const t0 = performance.now();
    const blacklist = await loadBlacklist(storage);
    const beforeSize = (blacklist[type as keyof typeof blacklist] as string[]).length;
    if (type === 'regexOverrides') {
      let added = 0;
      for (const id of ids) {
        if (typeof id === 'string' && !blacklist.regexBlockOverrides.includes(id)) {
          blacklist.regexBlockOverrides.push(id);
          added++;
        }
      }
      await saveBlacklist(storage, blacklist);
      await setDirtyMarker(storage);
      const afterSize = blacklist.regexBlockOverrides.length;
      logger.debugFields('blacklist', 'batch-block', {
        type, requested: ids.length, added, beforeSize, afterSize,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ success: true, added });
    }
    const list = blacklist[type as keyof typeof blacklist] as string[];
    let added = 0;
    for (const id of ids) {
      if (typeof id === 'string' && !list.includes(id)) {
        list.push(id);
        added++;
      }
    }
    await saveBlacklist(storage, blacklist);
    await setDirtyMarker(storage);
    const afterSize = list.length;
    logger.debugFields('blacklist', 'batch-block', {
      type, requested: ids.length, added, beforeSize, afterSize,
      durationMs: Math.round(performance.now() - t0),
    });

    return c.json({ success: true, added });
  });

  router.delete('/admin/blacklist', async (c) => {
    let body: { type?: string; id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, id } = body;
    if (!type || !id) return c.json({ error: 'type and id are required' }, 400);
    if (!['sites', 'parses', 'lives', 'regexOverrides'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, lives, or regexOverrides' }, 400);
    }

    const t0 = performance.now();
    try {
      const blacklist = await loadBlacklist(storage);
      if (type === 'regexOverrides') {
        const beforeSize = blacklist.regexBlockOverrides.length;
        blacklist.regexBlockOverrides = blacklist.regexBlockOverrides.filter(v => v !== id);
        await saveBlacklist(storage, blacklist);
        await setDirtyMarker(storage);
        const afterSize = blacklist.regexBlockOverrides.length;
        logger.debugFields('blacklist', 'unblock', {
          type, id, beforeSize, afterSize,
          removed: afterSize < beforeSize,
          durationMs: Math.round(performance.now() - t0),
        });
        return c.json({ success: true });
      }
      const key = type as 'sites' | 'parses' | 'lives';
      const beforeSize = blacklist[key].length;
      blacklist[key] = blacklist[key].filter(v => v !== id);
      await saveBlacklist(storage, blacklist);
      await setDirtyMarker(storage);
      const afterSize = blacklist[key].length;
      logger.debugFields('blacklist', 'unblock', {
        type, id, beforeSize, afterSize,
        removed: afterSize < beforeSize,
        durationMs: Math.round(performance.now() - t0),
      });

      return c.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warnFields('blacklist', 'unblock-failed', {
        type, id, error: msg,
        durationMs: Math.round(performance.now() - t0),
      });
      return c.json({ error: 'Server error: ' + msg }, 500);
    }
  });

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
