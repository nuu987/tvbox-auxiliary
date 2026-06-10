// 源管理 CRUD + JSON 导入

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, SourceEntry } from '../core/types';
import { MANUAL_SOURCES, INLINE_PREFIX } from '../core/config';
import { parseConfigJson, isMultiRepoConfig, extractMultiRepoEntries } from '../core/fetcher';
import { decodeConfigResponse } from '../core/decoder';
import { adminAuthMiddleware } from './admin-auth';

export interface SourceMgmtRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createSourceMgmtRouter(deps: SourceMgmtRouteDeps): Hono {
  const { storage, config } = deps;
  const router = new Hono();

  // All endpoints require admin auth
  router.use('*', adminAuthMiddleware(config));

  router.get('/admin/sources', async (c) => {
    const raw = await storage.get(MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources);
  });

  router.post('/admin/sources', async (c) => {
    let body: { name?: string; url?: string; configKey?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    let url = body.url?.trim() || '';
    if (!url) return c.json({ error: 'URL is required' }, 400);

    // 自动提取 ;pk; 密钥
    let configKey = body.configKey?.trim() || '';
    const pkMatch = url.match(/;pk;(.+)$/);
    if (pkMatch) {
      configKey = configKey || pkMatch[1];
      url = url.replace(/;pk;.+$/, '');
    }

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const name = body.name?.trim() || '';
    const raw = await storage.get(MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

    if (sources.some((s) => s.url === url)) {
      return c.json({ error: 'Source already exists' }, 409);
    }

    const entry: SourceEntry = { name, url };
    if (configKey) entry.configKey = configKey;
    sources.push(entry);
    await storage.put(MANUAL_SOURCES, JSON.stringify(sources));

    return c.json({ success: true });
  });

  router.delete('/admin/sources', async (c) => {
    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = sources.filter((s) => s.url !== url);
    await storage.put(MANUAL_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  // ─── JSON 导入 ─────────────────────────────────────────
  router.post('/admin/sources/import', async (c) => {
    let body: { input?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const input = body.input?.trim();
    if (!input) return c.json({ error: 'input is required' }, 400);

    // 判断是 URL 还是 JSON 内容
    const isUrl = /^https?:\/\//i.test(input);
    let jsonText: string;
    let sourceUrl: string | null = null;

    // 自动提取 ;pk; 密钥
    let configKey: string | undefined;
    let fetchUrl = input;
    if (isUrl) {
      const pkMatch = input.match(/;pk;(.+)$/);
      if (pkMatch) {
        configKey = pkMatch[1];
        fetchUrl = input.replace(/;pk;.+$/, '');
      }
      sourceUrl = fetchUrl;
      try {
        const resp = await fetch(fetchUrl, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'okhttp/3.12.0' },
        });
        if (!resp.ok) return c.json({ error: `Fetch failed: HTTP ${resp.status}` }, 502);
        const buffer = await resp.arrayBuffer();
        const decoded = await decodeConfigResponse(buffer, configKey);
        jsonText = decoded || '';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Fetch failed: ${msg}` }, 502);
      }
    } else {
      jsonText = input;
    }

    const parsed = parseConfigJson(jsonText);
    if (!parsed.ok) return c.json({ error: `Failed to parse JSON: ${parsed.errorCategory}: ${parsed.message}` }, 400);

    // 读取现有源
    const raw = await storage.get(MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingUrls = new Set(sources.map(s => s.url));

    let added = 0;
    let duplicates = 0;
    const addedSources: string[] = [];

    if (isMultiRepoConfig(parsed.config!)) {
      // 多仓：提取子 URL 批量添加
      const entries = extractMultiRepoEntries(parsed.config!, 'Imported');
      for (const entry of entries) {
        if (existingUrls.has(entry.url)) {
          duplicates++;
        } else {
          sources.push(entry);
          existingUrls.add(entry.url);
          addedSources.push(entry.url);
          added++;
        }
      }
      await storage.put(MANUAL_SOURCES, JSON.stringify(sources));
      return c.json({ type: 'multi', added, duplicates, sources: addedSources });
    } else {
      // 单仓
      if (sourceUrl) {
        // 来自 URL：直接添加
        if (existingUrls.has(sourceUrl)) {
          return c.json({ type: 'single', added: 0, duplicates: 1, sources: [] });
        }
        const entry: SourceEntry = { name: 'Imported', url: sourceUrl };
        if (configKey) entry.configKey = configKey;
        sources.push(entry);
        await storage.put(MANUAL_SOURCES, JSON.stringify(sources));
        return c.json({ type: 'single', added: 1, duplicates: 0, sources: [sourceUrl] });
      } else {
        // 粘贴的内容：存 KV 用 inline:// 引用
        const key = `${INLINE_PREFIX}${Date.now()}`;
        await storage.put(key, jsonText);
        const inlineUrl = `inline://${key}`;
        sources.push({ name: 'Inline Config', url: inlineUrl });
        await storage.put(MANUAL_SOURCES, JSON.stringify(sources));
        return c.json({ type: 'single', added: 1, duplicates: 0, sources: [inlineUrl] });
      }
    }
  });

  return router;
}
