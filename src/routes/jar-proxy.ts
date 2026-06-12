// JAR 代理：文件系统缓存 + 并发下载锁

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import { lookupJarUrl, isMd5Key } from '../core/jar-proxy';
import { getSiteResourceDir, safeFileName, ensureSiteDir } from '../core/site-store';
import { logger } from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';

// 并发下载锁：防止同一 JAR 被多个请求同时下载（模块级作用域，不在 deps 中共享）
const downloadLocks = new Map<string, Promise<Buffer | null>>();

export interface JarProxyRouteDeps {
  storage: Storage;
  config: AppConfig;
}

/**
 * 查询 JAR key 对应的站点资源目录
 */
async function getJarSourceDir(key: string, storage: Storage): Promise<string | null> {
  try {
    const mapping = await storage.get(`jar-source:${key}`);
    if (!mapping) return null;
    const { index } = JSON.parse(mapping) as { index: number; hash: string; name: string };
    return ensureSiteDir(index, 'jar');
  } catch (e) {
    logger.warn('jar-proxy', `getJarSourceDir failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * 在站点目录中查找匹配 key 前缀的缓存文件
 */
function findCacheFile(dir: string, key: string, isMd5: boolean): string | null {
  try {
    const files = fs.readdirSync(dir);
    const prefix = isMd5 ? key.substring(0, 8) + '-' : key + '-';
    const match = files.find(f => f.startsWith(prefix));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

export function createJarProxyRouter(deps: JarProxyRouteDeps): Hono {
  const router = new Hono();
  const { storage, config } = deps;

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
      // 尝试写入站点目录缓存
      try {
        const sourceDir = await getJarSourceDir(key, storage);
        if (sourceDir) {
          const name = safeFileName(originalUrl);
          fs.writeFileSync(path.join(sourceDir, `${key}-${name}`), buf);
          logger.debug('jar-proxy', `Cached ${key}-${name} in ${sourceDir} (${(buf.length / 1024).toFixed(1)} KB)`);
        }
      } catch (writeErr) {
        logger.warn('jar-proxy', `Failed to write cache for ${key}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
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

    // 2. 查文件缓存（站点目录）
    const sourceDir = await getJarSourceDir(key, storage);
    if (sourceDir) {
      const md5Key = isMd5Key(key);
      const cacheFile = findCacheFile(sourceDir, key, md5Key);
      if (cacheFile && fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        const ttl = md5Key ? 86400_000 : 21600_000;
        if (Date.now() - stat.mtimeMs < ttl) {
          const buf = fs.readFileSync(cacheFile);
          return new Response(buf, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Cache-Control': `public, max-age=${ttl / 1000}`,
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
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
