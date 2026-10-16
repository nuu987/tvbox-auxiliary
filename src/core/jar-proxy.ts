// JAR 代理：将 spider/jar URL 改写为代理路由

import type { TVBoxConfig, TVBoxSite, TVBoxParse } from './types';
import type { Storage } from '../storage/interface';
import { safeFileName } from './site-store';
import { logger } from './logger';
import { retryDownload, DOWNLOAD_DEADLINE_MS } from './download-retry';
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
 * 用 Web Crypto 的 SHA-256 取前 16 字节 hex（32 字符）
 *
 * WR-03: 旧实现截断到 8 字节（16 hex），生日悖论下 ~2^32 个 URL 即有 50% 碰撞概率，
 * 碰撞会让 /static/{key}/{type} 静默返回错误内容（无 md5 兜底）。
 * 改为 16 字节（与 md5 长度一致），碰撞概率远低于实际使用量。
 */
export async function urlToKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 16))
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

export interface JarResource {
  url: string;
  key: string;
  md5: string | null;
  index: number;
}

/** Plan original JAR identities once, before any URL is rewritten. */
export async function createJarResourcePlan(config: TVBoxConfig, storage: Storage): Promise<JarResource[]> {
  const declarations = new Map<string, { md5: string | null; index: number }>();
  const add = (value: string | undefined, index: number) => {
    if (!value) return;
    const { url, md5 } = parseSpiderString(value);
    if ((url.startsWith('http://') || url.startsWith('https://')) && !declarations.has(url)) {
      declarations.set(url, { md5, index });
    }
  };
  // The shared spider has no required site.jar declaration; give it a cache directory too.
  add(config.spider, 0);
  (config.sites || []).forEach((site, index) => add(site.jar, index));

  const resources: JarResource[] = [];
  for (const [url, declaration] of declarations) {
    const { md5 } = declaration;
    const key = md5 || await urlToKey(url);
    let index = declaration.index;
    const previous = await storage.get(`jar-source:${key}`);
    if (previous) {
      try {
        const mapping: unknown = JSON.parse(previous);
        if (mapping && typeof mapping === 'object' && 'index' in mapping
          && typeof mapping.index === 'number' && Number.isSafeInteger(mapping.index) && mapping.index >= 0) {
          index = mapping.index;
        }
      } catch { /* Use the current owner when the previous mapping is malformed. */ }
    }
    resources.push({ url, key, md5, index });
  }
  return resources;
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
  resources?: readonly JarResource[],
): Promise<TVBoxConfig> {
  const planned = resources ?? await createJarResourcePlan(config, storage);

  if (planned.length === 0) {
    logger.info('jar-proxy', 'No JAR URLs to rewrite');
    return config;
  }

  // Step 2: 为每个唯一 URL 生成 key + 批量写 KV + jar-source 映射
  const urlKeyMap = new Map<string, string>(); // url → key

  for (const { url, key, index } of planned) {
    urlKeyMap.set(url, key);
    await storage.put(`${JAR_PREFIX}${key}`, url);
    const name = safeFileName(url);
    await storage.put(`jar-source:${key}`, JSON.stringify({ index, hash: key.substring(0, 8), name }));
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

  // 确保 spider 在 JSON 输出中排在首位（对象字面量属性顺序）
  const { spider, ...rest } = result;
  const finalResult: TVBoxConfig = spider
    ? { spider, ...rest }
    : rest;
  return finalResult;
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
 * Collect original resource URLs and owner indices, including the shared spider.
 * Inspects site.jar (via parseSpiderString), site.api (type detection via extension
 * or HTTP URL), site.ext (string or object), parse.url, parse.ext.
 * Deduplicates by URL while retaining the index used by proxy mappings.
 */
export interface SiteResource {
  url: string;
  type: string;
  index: number;
}

export function collectAllSiteResources(sites: TVBoxSite[], parses?: TVBoxParse[], spider?: string): SiteResource[] {
  const seen = new Map<string, SiteResource>();
  const resources: SiteResource[] = [];
  const add = (url: string, type: string, index: number) => {
    const existing = seen.get(url);
    if (existing) {
      // Non-JAR rewriting writes mappings in traversal order; the last owner wins.
      if (existing.type !== 'jar' && type !== 'jar') existing.index = index;
      return;
    }
    const resource = { url, type, index };
    seen.set(url, resource);
    resources.push(resource);
  };

  if (spider) {
    const { url } = parseSpiderString(spider);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      add(url, 'jar', 0);
    }
  }

  for (const [index, site] of sites.entries()) {
    // site.jar via parseSpiderString
    if (site.jar) {
      const parsed = parseSpiderString(site.jar);
      if (parsed.url.startsWith('http://') || parsed.url.startsWith('https://')) {
        add(parsed.url, 'jar', index);
      }
    }

    // site.api: type detection via extension
    if (site.api) {
      const type = getResourceUrlType(site.api);
      if (type) add(site.api, type, index);
    }

    // site.ext: String or Object
    if (site.ext) {
      extractExtUrls(site.ext, (url, type) => add(url, type, index));
    }
  }

  // parse.url / parse.ext
  if (parses) {
    for (const [index, parse] of parses.entries()) {
      if (parse.url) {
        const type = getResourceUrlType(parse.url);
        if (type) add(parse.url, type, index);
      }
      if (parse.ext) {
        extractExtUrls(parse.ext, (url, type) => add(url, type, index));
      }
    }
  }

  return resources;
}

/**
 * Helper: extract HTTP(S) URLs from ext field (string or object) into resources array.
 */
function extractExtUrls(
  ext: string | Record<string, unknown>,
  add: (url: string, type: string) => void,
): void {
  if (typeof ext === 'string') {
    const extParts = ext.split(/[\s$;|]+/);
    for (const part of extParts) {
      if (!part.startsWith('http://') && !part.startsWith('https://')) continue;
      const type = getResourceUrlType(part);
      if (type) add(part, type);
    }
  } else if (typeof ext === 'object' && ext !== null) {
    for (const val of Object.values(ext)) {
      if (typeof val !== 'string') continue;
      if (!val.startsWith('http://') && !val.startsWith('https://')) continue;
      const type = getResourceUrlType(val);
      if (type) add(val, type);
    }
  }
}

/**
 * 改写非 JAR 静态资源 URL 为本地代理地址
 *
 * 遍历 config.sites 中的 site.api/site.ext 以及 config.parses 中的 parse.url/parse.ext，
 * 将 JS/PY/JSON/TXT URL 改写为 {baseUrl}/{type}/{key}.{type} 格式，
 * 同时写入 static-source:{key} KV 映射。
 *
 * JAR URL 不在此函数中处理（已在 rewriteJarUrls 处理）。
 */
export async function rewriteNonJarUrls(
  config: TVBoxConfig,
  baseUrl: string,
  storage: Storage,
): Promise<TVBoxConfig> {
  const result = { ...config };
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  let rewriteCount = 0;

  // 改写 site.api / site.ext
  if (result.sites) {
    for (let i = 0; i < result.sites.length; i++) {
      const site = result.sites[i];

      // site.api: if it's a non-JAR static resource URL
      if (site.api) {
        const apiType = getResourceUrlType(site.api);
        if (apiType && apiType !== 'jar' && (site.api.startsWith('http://') || site.api.startsWith('https://'))) {
          const key = await urlToKey(site.api);
          const name = safeFileName(site.api);
          await storage.put(`static-source:${key}`, JSON.stringify({
            index: i,
            hash: key.substring(0, 8),
            name,
            type: apiType,
            url: site.api,
          }));
          result.sites[i] = { ...site, api: `${cleanBaseUrl}/${apiType}/${key}.${apiType}` };
          rewriteCount++;
          logger.info('jar-proxy', `Rewrote site.api ${key} → ${apiType} (site ${i + 1})`);
        }
      }

      // site.ext: string or object containing non-JAR URLs
      const currentSite = result.sites[i];
      if (currentSite.ext) {
        const rewrittenExt = await rewriteExtFieldAsync(currentSite.ext, cleanBaseUrl, i, storage);
        if (rewrittenExt !== null) {
          result.sites[i] = { ...currentSite, ext: rewrittenExt };
          rewriteCount++;
        }
      }
    }
  }

  // 改写 parse.url / parse.ext
  if (result.parses) {
    for (let i = 0; i < result.parses.length; i++) {
      const parse = result.parses[i];

      // parse.url
      if (parse.url) {
        const urlType = getResourceUrlType(parse.url);
        if (urlType && urlType !== 'jar' && (parse.url.startsWith('http://') || parse.url.startsWith('https://'))) {
          const key = await urlToKey(parse.url);
          const name = safeFileName(parse.url);
          await storage.put(`static-source:${key}`, JSON.stringify({
            index: i,
            hash: key.substring(0, 8),
            name,
            type: urlType,
            url: parse.url,
          }));
          result.parses[i] = { ...parse, url: `${cleanBaseUrl}/${urlType}/${key}.${urlType}` };
          rewriteCount++;
          logger.info('jar-proxy', `Rewrote parse.url ${key} → ${urlType} (parse ${i + 1})`);
        }
      }

      // parse.ext
      const currentParse = result.parses[i];
      if (currentParse.ext) {
        const rewrittenExt = await rewriteExtFieldAsync(currentParse.ext, cleanBaseUrl, i, storage);
        if (rewrittenExt !== null) {
          result.parses[i] = { ...currentParse, ext: rewrittenExt };
          rewriteCount++;
        }
      }
    }
  }

  logger.info('jar-proxy', `Rewrote ${rewriteCount} non-JAR URLs across config`);
  return result;
}

/**
 * Helper: rewrite non-JAR URLs in an ext field (string or object).
 * Returns the rewritten ext if any URL was rewritten, or null if no changes needed.
 * KV writes are performed for each rewritten URL.
 */
async function rewriteExtFieldAsync(
  ext: string | Record<string, unknown>,
  baseUrl: string,
  index: number,
  storage: Storage,
): Promise<string | Record<string, unknown> | null> {
  if (typeof ext === 'string') {
    // Split while preserving delimiters so we can reassemble
    const parts = ext.split(/([\s$;|]+)/);
    let didRewrite = false;

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      if (!part.startsWith('http://') && !part.startsWith('https://')) continue;
      const type = getResourceUrlType(part);
      if (!type || type === 'jar') continue;

      const key = await urlToKey(part);
      const name = safeFileName(part);
      await storage.put(`static-source:${key}`, JSON.stringify({
        index,
        hash: key.substring(0, 8),
        name,
        type,
        url: part,
      }));
      parts[j] = `${baseUrl}/${type}/${key}.${type}`;
      didRewrite = true;
    }

    return didRewrite ? parts.join('') : null;
  }

  if (typeof ext === 'object' && ext !== null) {
    const newObj: Record<string, unknown> = {};
    let didRewrite = false;

    for (const [k, val] of Object.entries(ext)) {
      if (typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://'))) {
        const type = getResourceUrlType(val);
        if (type && type !== 'jar') {
          const key = await urlToKey(val);
          const name = safeFileName(val);
          await storage.put(`static-source:${key}`, JSON.stringify({
            index,
            hash: key.substring(0, 8),
            name,
            type,
            url: val,
          }));
          newObj[k] = `${baseUrl}/${type}/${key}.${type}`;
          didRewrite = true;
          continue;
        }
      }
      newObj[k] = val;
    }

    return didRewrite ? newObj : null;
  }

  return null;
}

/**
 * Sorts resources so that config.spider JAR is downloaded first.
 * Per D-01/D-02: priority is given to the JAR matching the parsed spider URL,
 * then all other resources in their original order. This ensures the
 * spider JAR is available before any site that depends on it loads.
 */
export function sortResourcesByPriority<T extends { url: string; type: string }>(
  resources: T[],
  spiderUrl: string | undefined,
): T[] {
  if (!spiderUrl) return resources;

  const parsed = parseSpiderString(spiderUrl);
  const priority: T[] = [];
  const rest: T[] = [];

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
    // IPv6 link-local (fe80::/10) — WR-05: covers fe80::–febf:: not just fe80::
    // Per RFC 4291, link-local is the full /10 range; old startsWith('fe80:') missed fe90::–febf::
    if (/^fe[89ab][0-9a-f]?:/i.test(host)) return false;
    // IPv6 unique-local (fc00::/7) — covers fc* and fd* prefixes
    if (host.startsWith('fc') || host.startsWith('fd')) return false;
  }
  return true;
}

/**
 * Downloads a resource from a URL and returns a Buffer.
 * Uses AbortController for timeout. Returns null on failure.
 *
 * Per CR-04: SSRF guard via isUrlSafe runs before fetch — unsafe URLs
 * (private hosts, non-http protocols) return null and log a security event.
 *
 * Per CR-04 (timeout/retry): does NOT retry on AbortError (timeout) — slow
 * origins don't speed up on retry, and the retry just adds wall time without
 * improving success rate. Also enforces an overall deadline of ~30s so that
 * many slow resources can't cumulatively stall sync for minutes.
 */
export async function downloadResource(url: string, timeoutMs: number): Promise<Buffer | null> {
  if (!isUrlSafe(url)) {
    logger.security(`downloadResource blocked unsafe URL: ${url.length > 60 ? url.substring(0, 60) + '...' : url}`);
    return null;
  }
  const run = await retryDownload<Buffer | null>({
    timeoutMs,
    execute: async context => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), context.timeoutMs);
      try {
        const resp = await fetch(url, { headers: { 'User-Agent': 'okhttp/3.12.0' }, signal: controller.signal });
        if (!resp.ok) return { value: null, status: 'failed', reason: `HTTP ${resp.status}` };
        return { value: Buffer.from(await resp.arrayBuffer()), status: 'ok' };
      } catch (error) {
        return { value: null, status: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'failed',
          reason: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    },
    onFailure: event => {
      if (event.status === 'timeout') {
        logger.warn('jar-proxy', `Download timed out after ${event.timeoutMs}ms (no retry): ${url.substring(0, 60)}...`);
      } else {
        const retry = event.delayMs ? `, retrying in ${event.delayMs}ms` : '';
        logger.warn('jar-proxy', `Download attempt ${event.attempt}/${event.maxAttempts} failed (${event.reason})${retry}: ${url.substring(0, 60)}...`);
      }
    },
    onDeadline: attempts => logger.warn('jar-proxy',
      `Download aborted — exceeded ${DOWNLOAD_DEADLINE_MS}ms aggregate deadline after ${attempts} attempts: ${url.substring(0, 60)}...`),
  });
  return run.value;
}

/**
 * Writes cached resource data to the site directory and creates static-source KV mapping.
 * File name format: {key}.{type} (F-01).
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
  // F-01: 使用 {key}.{type} 命名，不再依赖 safeName 和分隔符 "-"
  const fileName = `${key}.${type}`;
  const filePath = sourceDir.endsWith('/') || sourceDir.endsWith('\\')
    ? sourceDir + fileName
    : sourceDir + '/' + fileName;
  fs.writeFileSync(filePath, data);
  await storage.put(`static-source:${key}`, JSON.stringify({ index: safeIndex, hash: key.substring(0, 8), name: safeName, type, url }));
  logger.info('jar-proxy', `Cached ${type} ${key} in site ${safeIndex + 1}: ${fileName}`);
}
