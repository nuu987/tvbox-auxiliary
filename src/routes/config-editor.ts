// Config Editor API 路由

import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth';
import { siteFingerprint, loadBlacklist } from '../core/blacklist';
import { applyBaseUrlPlaceholder } from '../core/base-url';
import { MERGED_CONFIG_FULL, MERGED_CONFIG, LIVE_DISABLED, SOURCE_HEALTH } from '../core/config';
import type { Storage } from '../storage/interface';
import type { AppConfig, SourceHealthRecord, TVBoxConfig } from '../core/types';

export interface ConfigEditorRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createConfigEditorRouter(deps: ConfigEditorRouteDeps): Hono {
  const router = new Hono();
  const { storage, config } = deps;

  router.use('/admin/*', adminAuthMiddleware(config));

  // ─── Config Editor API ─────────────────────────────────
  router.get('/admin/config-data', async (c) => {
    // 读取过滤前的完整配置（含被屏蔽的项），降级到已过滤配置
    const full = await storage.get(MERGED_CONFIG_FULL);
    const cached = full || await storage.get(MERGED_CONFIG);
    if (!cached) {
      return c.json({ sites: [], parses: [], lives: [] });
    }

    let parsed: TVBoxConfig;
    try {
      const adminBase = (config.localBaseUrl || '').replace(/\/$/, '');
      const substituted = applyBaseUrlPlaceholder(cached, adminBase);
      parsed = JSON.parse(substituted);
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }

    const blacklist = await loadBlacklist(storage);
    const siteSet = new Set(blacklist.sites);
    const parseSet = new Set(blacklist.parses);
    const liveSet = new Set(blacklist.lives);
    const overrideSet = new Set(blacklist.regexBlockOverrides);
    // Pre-compile regex rules for annotation
    const compiledRegex: RegExp[] = [];
    for (const rule of blacklist.regexRules) {
      try { compiledRegex.push(new RegExp(rule.pattern, 'u')); } catch { /* skip invalid */ }
    }

    // Build sites with fingerprint + blocked status + group
    const sites = [];
    for (const site of parsed.sites || []) {
      const fp = await siteFingerprint(site);
      const api = site.api || '';
      let group = '其他';
      if (api.startsWith('csp_') || api.startsWith('py_') || api.startsWith('js_')) {
        group = api;
      } else if (api.startsWith('http')) {
        try { group = '远程: ' + new URL(api).hostname; } catch { group = '远程源'; }
      }
      const name = site.name || '';
      const fingerprintBlocked = siteSet.has(fp);
      const overridden = !fingerprintBlocked && overrideSet.has(name);
      const regexBlocked = !fingerprintBlocked && !overridden && compiledRegex.some(re => re.test(name));
      const isOverridden = overridden && compiledRegex.some(re => re.test(name));
      sites.push({ ...site, fingerprint: fp, blocked: fingerprintBlocked || regexBlocked, regexBlocked, isOverridden, group });
    }

    const parses = (parsed.parses || []).map(p => ({
      ...p,
      blocked: parseSet.has(p.url),
    }));

    const lives = (parsed.lives || []).map(l => ({
      ...l,
      blocked: liveSet.has(l.url || l.api || ''),
    }));

    const liveDisabledRaw = await storage.get(LIVE_DISABLED);
    const liveDisabled = liveDisabledRaw !== 'false';

    // Build validation errors from source health records
    const healthRaw = await storage.get(SOURCE_HEALTH);
    const healthRecords: SourceHealthRecord[] = healthRaw ? JSON.parse(healthRaw) : [];
    const erroredSourceNames = new Set<string>();
    const erroredSourceReasons = new Map<string, string>();
    for (const record of healthRecords) {
      if (record.latestStatus === 'parse_error' && record.lastFailReason) {
        erroredSourceNames.add(record.name);
        erroredSourceReasons.set(record.name, record.lastFailReason);
      }
    }
    // Annotate sites from errored sources
    if (erroredSourceNames.size > 0) {
      for (const site of sites) {
        const group = site.group || '';
        for (const errName of erroredSourceNames) {
          if (group.includes(errName)) {
            (site as Record<string, unknown>).errSource = true;
            (site as Record<string, unknown>).errReason = erroredSourceReasons.get(errName);
            break;
          }
        }
      }
    }

    const validationErrors = healthRecords
      .filter(r => r.latestStatus === 'parse_error' && r.lastFailReason)
      .map(r => ({ url: r.url, name: r.name, reason: r.lastFailReason }));

    return c.json({ sites, parses, lives, regexRules: blacklist.regexRules, liveDisabled, validationErrors });
  });

  return router;
}
