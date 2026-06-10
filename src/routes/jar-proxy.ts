// JAR 代理：文件系统缓存 + 并发下载锁

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import { lookupJarUrl, isMd5Key } from '../core/jar-proxy';
import { logger } from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';

// 并发下载锁：防止同一 JAR 被多个请求同时下载（模块级作用域，不在 deps 中共享）
const downloadLocks = new Map<string, Promise<Buffer | null>>();

export interface JarProxyRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createJarProxyRouter(deps: JarProxyRouteDeps): Hono {
  const router = new Hono();
  const { storage, config } = deps;

  const jarCacheDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'jars');
  if (!fs.existsSync(jarCacheDir)) fs.mkdirSync(jarCacheDir, { recursive: true });

  async function fetchAndCacheJar(key: string, originalUrl: string): Promise<Buffer | null> {
    try {
      const resp = await fetch(originalUrl, {
        headers: { 'User-Agent': 'okhttp/3.12.0' },
      });
      if (!resp.ok) {
        logger.warn('jar-proxy', `Origin returned ${resp.status} for ${key}`);
        return null;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(path.join(jarCacheDir, `${key}.jar`), buf);
      logger.debug('jar-proxy', `Cached ${key}.jar (${(buf.length / 1024).toFixed(1)} KB)`);
      return buf;
    } catch (error: unknown) {
      logger.warn('jar-proxy', `Fetch error for ${key}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  router.get('/jar/:key', async (c) => {
    const key = c.req.param('key');

    // 1. 查 storage 拿原始 URL
    const originalUrl = await lookupJarUrl(key, storage);
    if (!originalUrl) {
      return c.json({ error: 'Unknown JAR key' }, 404);
    }

    // 2. 查文件缓存
    const cachePath = path.join(jarCacheDir, `${key}.jar`);
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      const ttl = isMd5Key(key) ? 86400_000 : 21600_000;
      if (Date.now() - stat.mtimeMs < ttl) {
        const buf = fs.readFileSync(cachePath);
        return new Response(buf, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': `public, max-age=${ttl / 1000}`,
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    // 3. 下载（带并发锁）
    let downloading = downloadLocks.get(key);
    if (!downloading) {
      downloading = fetchAndCacheJar(key, originalUrl).finally(() => downloadLocks.delete(key));
      downloadLocks.set(key, downloading);
    }

    const buf = await downloading;
    if (buf) {
      return new Response(buf, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': `public, max-age=${isMd5Key(key) ? 86400 : 21600}`,
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return c.json({ error: 'JAR unavailable from origin' }, 502);
  });

  return router;
}
