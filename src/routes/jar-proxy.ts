// JAR 代理：文件系统缓存 + 并发下载锁

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import { lookupJarUrl, isMd5Key, getResourceUrlType, downloadResource } from '../core/jar-proxy';
import { getSiteResourceDir, safeFileName, ensureSiteDir } from '../core/site-store';
import { logger } from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';

// 并发下载锁：防止同一 JAR 被多个请求同时下载（模块级作用域，不在 deps 中共享）
const downloadLocks = new Map<string, Promise<Buffer | null>>();

// CR-02: /static/:key/:type 路由允许的资源类型白名单
// 阻止通过 :type 参数（例如 ".."）进行路径遍历攻击
const ALLOWED_STATIC_TYPES = new Set(['jar', 'js', 'py', 'json', 'txt']);

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
    const prefix = key + '-';
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
    // CR-04 / WR-02: SSRF guard — delegate to downloadResource which already enforces
    // isUrlSafe() + AbortController timeout + bounded retry. Previously this helper
    // used a raw fetch() with no signal — a hanging origin would hold the connection
    // open indefinitely and wedge every concurrent client waiting on the same JAR key
    // via the downloadLocks map.
    const buf = await downloadResource(originalUrl, 30_000);
    if (!buf) return null;
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
      // CR-02: TOCTOU race — existsSync/statSync/readFileSync span the atomic-swap window.
      // swapSiteDirectories() renames sites/ aside and tmp/ into place; a sync firing mid-read
      // causes ENOENT/EACCES that would otherwise propagate as a 500 with stack trace.
      // Wrap in try/catch and fall through to the download path on race-induced errors.
      if (cacheFile) {
        try {
          if (!fs.existsSync(cacheFile)) {
            // fall through to download path
          } else {
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
        } catch (e) {
          // File vanished mid-read during atomic swap — fall through to download
          logger.warn('jar-proxy', `Cache file vanished during read for ${key}: ${e instanceof Error ? e.message : String(e)}`);
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

  // GET /static/:key/:type — 静态资源代理（非 JAR：JS/PY/JSON/TXT 等）
  // 缓存命中直接返回；缓存未命中时通过 KV 中的 url 字段从远程下载兜底（D-11）
  router.get('/static/:key/:type', async (c) => {
    const key = c.req.param('key');
    const type = c.req.param('type');

    // CR-02: validate :type against whitelist before any path operation to prevent traversal
    if (!ALLOWED_STATIC_TYPES.has(type)) {
      return c.json({ error: 'Invalid resource type' }, 400);
    }

    // 1. 查 KV mapping
    const mappingRaw = await storage.get(`static-source:${key}`);
    if (!mappingRaw) {
      return c.json({ error: 'Unknown static resource key' }, 404);
    }

    let mapping: { index: number; hash: string; name: string; type?: string; url?: string };
    try {
      mapping = JSON.parse(mappingRaw);
    } catch {
      return c.json({ error: 'Invalid mapping data' }, 500);
    }

    // Content-Type 解析（js/py/jar/json/txt + 默认 octet-stream）
    const contentType = getStaticContentType(type);

    const sourceDir = getSiteResourceDir(mapping.index, type);
    const filePath = path.join(sourceDir, `${key}-${mapping.name}`);

    // 2. 缓存命中：直接读取并返回
    // CR-02: TOCTOU race — existsSync/readFileSync span the atomic-swap window.
    // Wrap in try/catch and fall through to the on-demand download path on
    // ENOENT/EACCES induced by swapSiteDirectories mid-read.
    try {
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        return new Response(buf, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    } catch (e) {
      logger.warn('jar-proxy', `Cache file vanished during read for static ${key}/${type}: ${e instanceof Error ? e.message : String(e)}`);
      // fall through to on-demand download path
    }

    // 3. 缓存未命中：D-11 远程下载兜底
    //    静态资源 sync 可能因网络问题下载失败或原子交换窗口内文件暂时缺失，
    //    此时通过 KV mapping.url 字段从源重新下载
    const originalUrl = mapping.url;
    if (!originalUrl) {
      logger.warn('jar-proxy', `Static resource ${key} not cached and no original URL in KV mapping`);
      return c.json({ error: 'Resource not cached and original URL unknown' }, 404);
    }

    const downloadTimeout = config.fetchTimeoutMs || 10000;
    const data = await downloadResource(originalUrl, downloadTimeout);
    if (!data) {
      logger.warn('jar-proxy', `On-demand download failed for ${type} ${key} from ${originalUrl.substring(0, 60)}...`);
      return c.json({ error: 'Failed to download from origin' }, 502);
    }

    // 写回缓存供后续请求复用（mkdir 容错：目录可能在原子交换窗口中暂时缺失）
    try {
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(filePath, data);
      logger.info('jar-proxy', `On-demand cached ${type} ${key} (${(data.length / 1024).toFixed(1)} KB)`);
    } catch (writeErr) {
      logger.warn('jar-proxy', `Failed to cache ${key} on demand: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
    }

    return new Response(data, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=21600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  return router;
}

/**
 * 静态资源 Content-Type 映射
 * 用于 /static/:key/:type 路由的缓存命中和未命中分支
 */
function getStaticContentType(type: string): string {
  switch (type) {
    case 'js': return 'application/javascript';
    case 'py': return 'text/x-python';
    case 'jar': return 'application/octet-stream';
    case 'json': return 'application/json';
    case 'txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}
