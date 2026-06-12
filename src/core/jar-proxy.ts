// JAR 代理：将 spider/jar URL 改写为代理路由

import type { TVBoxConfig } from './types';
import type { Storage } from '../storage/interface';
import { safeFileName } from './site-store';

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
    console.log('[jar-proxy] No JAR URLs to rewrite');
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
    console.log(`[jar-proxy] Mapped ${key} → ${url.substring(0, 60)}...`);
  }

  console.log(`[jar-proxy] Wrote ${urlKeyMap.size} KV mappings`);

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

  console.log(`[jar-proxy] Rewrote ${urlKeyMap.size} unique JAR URLs across config`);
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
