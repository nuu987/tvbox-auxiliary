// JAR 代理：将 spider/jar URL 改写为代理路由

import type { TVBoxConfig, TVBoxSite } from './types';
import type { Storage } from '../storage/interface';
import { safeFileName } from './site-store';
import { logger } from './logger';
import * as fs from 'fs';

const JAR_PREFIX = 'jar:';

/**
 * 解析 spider/jar 字符串
 *
 * 格式：{prefix}{url};md5;{hash}  或  {prefix}{url}
 * prefix 可能是 "img+" 或空
 */
export function parseSpiderString(spider: string): {
  prefix: string;
  url: string;
  md5: string | null;
  raw: string;
} {
  let prefix = '';
  let rest = spider;

  // 提取 img+ 前缀
  if (rest.startsWith('img+')) {
    prefix = 'img+';
    rest = rest.substring(4);
  }

  // 分离 ;md5;hash
  const md5Idx = rest.indexOf(';md5;');
  if (md5Idx !== -1) {
    const url = rest.substring(0, md5Idx);
    const md5 = rest.substring(md5Idx + 5);
    return { prefix, url, md5, raw: spider };
  }

  return { prefix, url: rest, md5: null, raw: spider };
}

/**
 * 为 URL 生成短 key（无 MD5 时使用）
 * 用 Web Crypto 的 SHA-256 取前 16 位 hex
 */
export async function urlToKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 根据 spider 串生成改写后的字符串（纯内存，不写 KV）
 */
function buildRewrittenSpider(
  spider: string,
  baseUrl: string,
  urlKeyMap: Map<string, string>,
): string | null {
  if (!spider) return null;

  const parsed = parseSpiderString(spider);
  if (!parsed.url.startsWith('http://') && !parsed.url.startsWith('https://')) {
    return null;
  }

  const key = urlKeyMap.get(parsed.url);
  if (!key) return null;

  const proxyUrl = `${baseUrl.replace(/\/$/, '')}/jar/${key}`;
  if (parsed.md5) {
    return `${parsed.prefix}${proxyUrl};md5;${parsed.md5}`;
  }
  return `${parsed.prefix}${proxyUrl}`;
}

/**
 * 改写合并后配置中的所有 JAR URL
 *
 * 两步走：
 * 1. 收集所有唯一 JAR URL → 生成 key → 批量写 KV（~10 次写入）
 * 2. 纯内存改写 spider/jar 字段（不再触发 KV 写入）
 */
export async function rewriteJarUrls(
  config: TVBoxConfig,
  baseUrl: string,
  storage: Storage,
  sourceIndexMap?: Map<string, number>,
): Promise<TVBoxConfig> {
  // Step 1: 收集所有唯一 JAR URL
  const uniqueJars = new Map<string, { md5: string | null }>(); // url → {md5}

  if (config.spider) {
    const parsed = parseSpiderString(config.spider);
    if (parsed.url.startsWith('http://') || parsed.url.startsWith('https://')) {
      uniqueJars.set(parsed.url, { md5: parsed.md5 });
    }
  }

  for (const site of config.sites || []) {
    if (site.jar) {
      const parsed = parseSpiderString(site.jar);
      if (parsed.url.startsWith('http://') || parsed.url.startsWith('https://')) {
        if (!uniqueJars.has(parsed.url)) {
          uniqueJars.set(parsed.url, { md5: parsed.md5 });
        }
      }
    }
  }

  if (uniqueJars.size === 0) {
    logger.info('jar-proxy', 'No JAR URLs to rewrite');
    return config;
  }

  // Step 2: 为每个唯一 URL 生成 key + 批量写 KV + jar-source 映射
  const urlKeyMap = new Map<string, string>(); // url → key

  for (const [url, { md5 }] of uniqueJars) {
    const key = md5 || (await urlToKey(url));
    urlKeyMap.set(url, key);
    await storage.put(`${JAR_PREFIX}${key}`, url);
    if (sourceIndexMap?.has(url)) {
      const index = sourceIndexMap.get(url)!;
      const name = safeFileName(url);
      await storage.put(`jar-source:${key}`, JSON.stringify({ index, hash: key.substring(0, 8), name }));
    }
    logger.info('jar-proxy', `Mapped ${key} → ${url.substring(0, 60)}...`);
  }

  logger.info('jar-proxy', `Wrote ${urlKeyMap.size} KV mappings`);

  // Step 3: 纯内存改写
  const result = { ...config };

  if (result.spider) {
    const rewritten = buildRewrittenSpider(result.spider, baseUrl, urlKeyMap);
    if (rewritten) result.spider = rewritten;
  }

  if (result.sites) {
    result.sites = result.sites.map((site) => {
      if (!site.jar) return site;
      const rewritten = buildRewrittenSpider(site.jar, baseUrl, urlKeyMap);
      if (rewritten) return { ...site, jar: rewritten };
      return site;
    });
  }

  logger.info('jar-proxy', `Rewrote ${urlKeyMap.size} unique JAR URLs across config`);
  return result;
}

/**
 * 从 KV 查询 JAR key 对应的原始 URL
 */
export async function lookupJarUrl(key: string, storage: Storage): Promise<string | null> {
  return storage.get(`${JAR_PREFIX}${key}`);
}

/**
 * 判断 JAR key 是否为 MD5（32 位 hex）
 * 用于决定 Cache TTL：MD5 key → 24h，URL hash key → 6h
 */
export function isMd5Key(key: string): boolean {
  return /^[0-9a-f]{32}$/i.test(key);
}

export function uint8ArrayToBase64(data: Uint8Array): string {
  const chars = new Array<string>(data.length);
  for (let i = 0; i < data.length; i++) {
    chars[i] = String.fromCharCode(data[i]);
  }
  return btoa(chars.join(''));
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Determines the resource type of a URL based on its file extension.
 * Strips query strings (# and ?) before extension check.
 * @returns 'jar', 'js', 'py', 'json', 'txt' or null if not recognized.
 */
export function getResourceUrlType(url: string): string | null {
  try {
    const cleaned = url.split('?')[0].split('#')[0];
    if (cleaned.endsWith('.jar')) return 'jar';
    if (cleaned.endsWith('.js')) return 'js';
    if (cleaned.endsWith('.py')) return 'py';
    if (cleaned.endsWith('.json')) return 'json';
    if (cleaned.endsWith('.txt')) return 'txt';
    return null;
  } catch {
    return null;
  }
}

/**
 * Collects all static resource URLs (JAR, JS, PY, JSON, TXT) from TVBoxSite[].
 * Inspects site.jar (via parseSpiderString), site.api (type detection via extension
 * or HTTP URL), site.ext (string or object). Deduplicates via URL set.
 */
export function collectAllSiteResources(sites: TVBoxSite[]): Array<{ url: string; type: string }> {
  const seen = new Set<string>();
  const resources: Array<{ url: string; type: string }> = [];

  for (const site of sites) {
    // site.jar via parseSpiderString
    if (site.jar) {
      const parsed = parseSpiderString(site.jar);
      if (parsed.url.startsWith('http://') || parsed.url.startsWith('https://')) {
        if (!seen.has(parsed.url)) {
          seen.add(parsed.url);
          resources.push({ url: parsed.url, type: 'jar' });
        }
      }
    }

    // site.api: Typ-Erkennung via Endung
    if (site.api) {
      if (!seen.has(site.api)) {
        const type = getResourceUrlType(site.api);
        if (type) {
          seen.add(site.api);
          resources.push({ url: site.api, type });
        }
      }
    }

    // site.ext: String oder Object
    if (site.ext) {
      if (typeof site.ext === 'string') {
        // String ext kann Trennzeichen enthalten ($ | ; etc.)
        const extParts = site.ext.split(/[\s$;|]+/);
        for (const part of extParts) {
          if (!part.startsWith('http://') && !part.startsWith('https://')) continue;
          if (seen.has(part)) continue;
          const type = getResourceUrlType(part);
          if (type) {
            seen.add(part);
            resources.push({ url: part, type });
          }
        }
      } else if (typeof site.ext === 'object' && site.ext !== null) {
        for (const val of Object.values(site.ext)) {
          if (typeof val !== 'string') continue;
          if (!val.startsWith('http://') && !val.startsWith('https://')) continue;
          if (seen.has(val)) continue;
          const type = getResourceUrlType(val);
          if (type) {
            seen.add(val);
            resources.push({ url: val, type });
          }
        }
      }
    }
  }

  return resources;
}

/**
 * Sorts resources so that config.spider JAR is downloaded first.
 * Per D-01/D-02: priority is given to the JAR matching the parsed spider URL,
 * then all other resources in their original order. This ensures the
 * spider JAR is available before any site that depends on it loads.
 */
export function sortResourcesByPriority(
  resources: Array<{ url: string; type: string }>,
  spiderUrl: string | undefined,
): Array<{ url: string; type: string }> {
  if (!spiderUrl) return resources;

  const parsed = parseSpiderString(spiderUrl);
  const priority: Array<{ url: string; type: string }> = [];
  const rest: Array<{ url: string; type: string }> = [];

  for (const r of resources) {
    if (r.type === 'jar' && r.url === parsed.url) {
      priority.push(r);
    } else {
      rest.push(r);
    }
  }

  return [...priority, ...rest];
}

/**
 * Validates that a URL is safe to fetch.
 *
 * Per CR-04 (SSRF protection):
 * - Rejects non-http/https protocols (file://, ftp://, data:, etc.)
 * - When DMZ != '0' (LAN-only mode), blocks private/internal hosts:
 *   - localhost, 127.0.0.1, ::1, 0.0.0.0
 *   - .local / .internal TLDs (mDNS / internal DNS)
 *   - RFC1918 private ranges (10.x, 192.168.x, 172.16-31.x)
 *   - Link-local / AWS metadata (169.254.x)
 *   - IPv6 link-local (fe80::) and unique-local (fc00::/7)
 *
 * Returns false on parse failure or any unsafe condition.
 */
export function isUrlSafe(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // DMZ='0' explicitly opts out of LAN-only validation — operator accepts SSRF risk
  if (process.env.DMZ !== '0') {
    // Strip surrounding [] from IPv6 hostname (Node's URL keeps brackets for IPv6 literals)
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return false;
    if (host.endsWith('.local') || host.endsWith('.internal')) return false;
    // Block RFC1918 + link-local (AWS metadata 169.254.x)
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/.test(host)) return false;
    // IPv6 link-local (fe80::/10) and unique-local (fc00::/7)
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  }
  return true;
}

/**
 * Downloads a resource from a URL and returns a Buffer.
 * Uses AbortController for timeout. Returns null on failure.
 *
 * Per CR-04: SSRF guard via isUrlSafe runs before fetch — unsafe URLs
 * (private hosts, non-http protocols) return null and log a security event.
 */
export async function downloadResource(url: string, timeoutMs: number): Promise<Buffer | null> {
  if (!isUrlSafe(url)) {
    logger.security(`downloadResource blocked unsafe URL: ${url.length > 60 ? url.substring(0, 60) + '...' : url}`);
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'okhttp/3.12.0' },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes cached resource data to the site directory and creates static-source KV mapping.
 * File name format: {key}-{safeFileName(url)}.
 * Per D-11, the original URL is stored in the KV mapping so that /static/:key/:type
 * can re-download from origin on cache miss.
 */
export async function writeResourceCache(
  key: string,
  data: Buffer,
  sourceDir: string,
  url: string,
  storage: Storage,
  index: number,
  type: string,
): Promise<void> {
  const safeIndex = Number.isFinite(index) && index >= 0 ? index : 0;
  const safeName = safeFileName(url);
  const fileName = `${key}-${safeName}`;
  const filePath = sourceDir.endsWith('/') || sourceDir.endsWith('\\')
    ? sourceDir + fileName
    : sourceDir + '/' + fileName;
  fs.writeFileSync(filePath, data);
  await storage.put(`static-source:${key}`, JSON.stringify({ index: safeIndex, hash: key.substring(0, 8), name: safeName, type, url }));
  logger.info('jar-proxy', `Cached ${type} ${key} in site ${safeIndex + 1}: ${fileName}`);
}
