// 批量 fetch TVBox JSON 配置

import { DEFAULT_FETCH_TIMEOUT_MS, TVBOX_UA, BROWSER_UA } from './config';
import { decodeConfigResponse } from './decoder';
import { logger } from './logger';
import type { TVBoxConfig, SourcedConfig, SourceEntry, SourceFetchResult, ParseValidationResult } from './types';

const MAX_MULTI_REPO_DEPTH = 3; // 多仓最大展开深度

export interface FetchConfigsResult {
  configs: SourcedConfig[];
  fetchResults: SourceFetchResult[];
}

/**
 * 批量获取配置 JSON，并发执行，带超时
 * 自动检测多仓格式（storeHouse / urls），递归展开（最多 3 层）
 * 返回成功获取的配置列表 + 每个源的 fetch 结果（含失败原因）
 */
export interface FetchProxyConfig {
  urls: string[];   // 代理端点列表，如 ["https://tvbox.rio.edu.kg/fetch-proxy", "https://fetch.riowang.win/api/proxy"]
  token?: string;   // 认证 token（fetch-proxy 需要）
}

export async function fetchConfigs(
  sources: SourceEntry[],
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  proxyConfig?: FetchProxyConfig,
): Promise<FetchConfigsResult> {
  const configs: SourcedConfig[] = [];
  const fetchResults: SourceFetchResult[] = [];
  const seen = new Set<string>(); // URL 去重，防循环引用

  await expandSources(sources, configs, fetchResults, seen, timeoutMs, 0, proxyConfig);

  logger.infoFields('fetcher', 'fetch-complete', {
    configs: configs.length,
    topLevelSources: sources.length,
    results: fetchResults.length,
  });
  return { configs, fetchResults };
}

/**
 * 递归展开多仓源
 */
async function expandSources(
  sources: SourceEntry[],
  configs: SourcedConfig[],
  fetchResults: SourceFetchResult[],
  seen: Set<string>,
  timeoutMs: number,
  depth: number,
  proxyConfig?: FetchProxyConfig,
): Promise<void> {
  // 去重
  const uniqueSources = sources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  if (uniqueSources.length === 0) return;

  const tag = depth === 0 ? '' : ` (depth ${depth})`;
  logger.infoFields('fetcher', 'fetch-batch', {
    count: uniqueSources.length,
    depth,
    label: tag || 'top-level',
  });
  uniqueSources.forEach((source, index) => {
    logger.infoFields('fetcher', 'source-queued', {
      index: index + 1,
      depth,
      name: source.name,
      url: source.url,
      key: source.configKey ? 'present' : 'none',
    });
  });

  const results = await Promise.allSettled(
    uniqueSources.map((source) => fetchSingleConfig(source, timeoutMs, proxyConfig, depth)),
  );

  const multiRepoChildren: SourceEntry[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const source = uniqueSources[i];
    if (result.status === 'fulfilled' && result.value) {
      const { config: fetchedConfig, fetchResult } = result.value;
      fetchResults.push(fetchResult);

      if (fetchResult.status !== 'ok') {
        // 失败的，已记录到 fetchResults，跳过
        continue;
      }

      if (isMultiRepoConfig(fetchedConfig!)) {
        const children = extractMultiRepoEntries(fetchedConfig!, fetchResult.name);
        logger.debugFields('fetcher', 'multi-repo-detected', {
          parent: source.name,
          url: source.url,
          depth,
          children: children.length,
        });
        children.forEach((child, childIndex) => {
          logger.debugFields('fetcher', 'multi-repo-child', {
            parent: source.name,
            index: childIndex + 1,
            name: child.name,
            url: child.url,
          });
        });
        if (depth < MAX_MULTI_REPO_DEPTH) {
          multiRepoChildren.push(...children);
        } else {
          logger.debugFields('fetcher', 'multi-repo-max-depth', {
            parent: source.name,
            url: source.url,
            depth,
            maxDepth: MAX_MULTI_REPO_DEPTH,
          });
        }
      } else {
        configs.push({
          sourceUrl: source.url,
          sourceName: source.name,
          config: fetchedConfig!,
          speedMs: fetchResult.speedMs,
        });
      }
    } else if (result.status === 'rejected') {
      logger.warnFields('fetcher', 'source-failed', {
        name: source.name,
        url: source.url,
        depth,
        status: 'network_error',
        error: result.reason,
      });
      fetchResults.push({
        url: source.url,
        name: source.name,
        status: 'network_error',
        errorMessage: String(result.reason),
      });
    }
  }

  // 递归展开子多仓
  if (multiRepoChildren.length > 0) {
    await expandSources(multiRepoChildren, configs, fetchResults, seen, timeoutMs, depth + 1, proxyConfig);
  }
}

interface SingleFetchResult {
  config: TVBoxConfig | null;
  fetchResult: SourceFetchResult;
}

/**
 * 获取单个配置 JSON，返回结构化结果（成功或失败原因）
 */
async function fetchSingleConfig(
  source: SourceEntry,
  timeoutMs: number,
  proxyConfig?: FetchProxyConfig,
  depth = 0,
): Promise<SingleFetchResult> {
  // 双 UA 回退：先用 okhttp（TVBox 原生），解析失败换浏览器 UA 重试
  const result = await fetchWithUA(source, timeoutMs, TVBOX_UA, 'tvbox', depth);
  if (result.config) return result;

  // okhttp 失败 → 浏览器 UA 重试（部分源只接受浏览器 UA）
  if (result.fetchResult.status === 'parse_error' || result.fetchResult.status === 'decode_error') {
    logger.debugFields('fetcher', 'retry-browser-ua', {
      name: source.name,
      url: source.url,
      previousStatus: result.fetchResult.status,
    });
    const browserResult = await fetchWithUA(source, timeoutMs, BROWSER_UA, 'browser', depth);
    if (browserResult.config) return browserResult;
  }

  // 直连失败（timeout/network_error/http_error）→ 通过边缘代理重试
  if (proxyConfig?.urls.length && isProxyRetriable(result.fetchResult.status)) {
    for (let i = 0; i < proxyConfig.urls.length; i++) {
      const proxyUrl = proxyConfig.urls[i];
      logger.debugFields('fetcher', 'retry-proxy', {
        name: source.name,
        url: source.url,
        proxyIndex: i + 1,
        proxyHost: safeHost(proxyUrl),
        previousStatus: result.fetchResult.status,
      });
      const proxyResult = await fetchViaProxy(source, timeoutMs, proxyUrl, proxyConfig.token);
      if (proxyResult.config) return proxyResult;
    }
  } else {
    logger.debugFields('fetcher', 'retry-skipped', {
      name: source.name,
      url: source.url,
      status: result.fetchResult.status,
      proxyConfigured: Boolean(proxyConfig?.urls.length),
    });
  }

  return result;
}

function isProxyRetriable(status: string): boolean {
  return status === 'timeout' || status === 'network_error' || status === 'http_error';
}

async function fetchViaProxy(
  source: SourceEntry,
  timeoutMs: number,
  proxyUrl: string,
  token?: string,
): Promise<SingleFetchResult> {
  const url = `${proxyUrl}?url=${encodeURIComponent(source.url)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startTime = Date.now();
    const headers: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'X-Proxy-UA': TVBOX_UA,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    logger.debugFields('fetcher', 'proxy-attempt-start', {
      name: source.name,
      url: source.url,
      proxyHost: safeHost(proxyUrl),
      timeoutMs,
      token: token ? 'present' : 'none',
    });
    const response = await fetch(url, { signal: controller.signal, headers });
    logger.debugFields('fetcher', 'proxy-response', {
      name: source.name,
      url: source.url,
      proxyHost: safeHost(proxyUrl),
      status: response.status,
      contentType: response.headers.get('content-type') || '(none)',
    });

    if (!response.ok) {
      return {
        config: null,
        fetchResult: { url: source.url, name: source.name, status: 'http_error', errorMessage: `Proxy: HTTP ${response.status}` },
      };
    }

    const buffer = await response.arrayBuffer();
    const decoded = await decodeConfigResponse(buffer, source.configKey, {
      sourceName: source.name,
      sourceUrl: source.url,
    });
    if (!decoded) {
      return {
        config: null,
        fetchResult: { url: source.url, name: source.name, status: 'decode_error', errorMessage: 'Proxy: Undecodable' },
      };
    }

    const result = parseConfigJson(decoded);
    if (!result.ok) {
      logger.debugFields('fetcher', 'parse-failed', {
        name: source.name,
        url: source.url,
        via: 'proxy',
        bytes: buffer.byteLength,
        errorCategory: result.errorCategory,
      });
      return {
        config: null,
        fetchResult: { url: source.url, name: source.name, status: 'parse_error', errorMessage: `Proxy: ${result.errorCategory}: ${result.message}`, validationError: result },
      };
    }
    const config = result.config!;

    const speedMs = Date.now() - startTime;
    logger.debugFields('fetcher', 'proxy-success', {
      name: source.name,
      url: source.url,
      proxyHost: safeHost(proxyUrl),
      speedMs,
      sites: config.sites?.length || 0,
      parses: config.parses?.length || 0,
      lives: config.lives?.length || 0,
    });
    return {
      config,
      fetchResult: { url: source.url, name: source.name, status: 'ok', speedMs },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      config: null,
      fetchResult: { url: source.url, name: source.name, status: 'network_error', errorMessage: `Proxy: ${msg}` },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithUA(
  source: SourceEntry,
  timeoutMs: number,
  userAgent: string,
  uaLabel: string,
  depth: number,
): Promise<SingleFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startTime = Date.now();
    logger.debugFields('fetcher', 'direct-attempt-start', {
      name: source.name,
      url: source.url,
      depth,
      ua: uaLabel,
      timeoutMs,
    });
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': userAgent,
      },
    });
    logger.debugFields('fetcher', 'direct-response', {
      name: source.name,
      url: source.url,
      depth,
      ua: uaLabel,
      status: response.status,
      contentType: response.headers.get('content-type') || '(none)',
    });

    if (!response.ok) {
      logger.warnFields('fetcher', 'source-http-error', {
        name: source.name,
        url: source.url,
        ua: uaLabel,
        status: response.status,
      });
      return {
        config: null,
        fetchResult: { url: source.url, name: source.name, status: 'http_error', errorMessage: `HTTP ${response.status}` },
      };
    }

    const buffer = await response.arrayBuffer();
    const decoded = await decodeConfigResponse(buffer, source.configKey, {
      sourceName: source.name,
      sourceUrl: source.url,
    });
    if (!decoded) {
      logger.warnFields('fetcher', 'source-decode-error', {
        name: source.name,
        url: source.url,
        ua: uaLabel,
        bytes: buffer.byteLength,
      });
      return {
        config: null,
        fetchResult: { url: source.url, name: source.name, status: 'decode_error', errorMessage: 'Undecodable content' },
      };
    }

    const result = parseConfigJson(decoded);
    if (!result.ok) {
      logger.warnFields('fetcher', 'source-parse-error', {
        name: source.name,
        url: source.url,
        ua: uaLabel,
        bytes: buffer.byteLength,
        errorCategory: result.errorCategory,
      });
      return {
        config: null,
        fetchResult: { url: source.url, name: source.name, status: 'parse_error', errorMessage: `${result.errorCategory}: ${result.message}`, validationError: result },
      };
    }
    const config = result.config!;

    const speedMs = Date.now() - startTime;
    logger.debugFields('fetcher', 'direct-success', {
      name: source.name,
      url: source.url,
      depth,
      ua: uaLabel,
      speedMs,
      bytes: buffer.byteLength,
      sites: config.sites?.length || 0,
      parses: config.parses?.length || 0,
      lives: config.lives?.length || 0,
    });
    return {
      config,
      fetchResult: { url: source.url, name: source.name, status: 'ok', speedMs },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('abort')) {
      logger.warnFields('fetcher', 'source-timeout', {
        name: source.name,
        url: source.url,
        ua: uaLabel,
        timeoutMs,
      });
      return {
        config: null,
        fetchResult: { url: source.url, name: source.name, status: 'timeout', errorMessage: `Timeout (${timeoutMs}ms)` },
      };
    }
    logger.warnFields('fetcher', 'source-network-error', {
      name: source.name,
      url: source.url,
      ua: uaLabel,
      error: msg,
    });
    return {
      config: null,
      fetchResult: { url: source.url, name: source.name, status: 'network_error', errorMessage: msg },
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.host;
  } catch {
    return rawUrl.slice(0, 40);
  }
}

/**
 * 解析配置 JSON，容错处理
 * 有些配置可能有 BOM 头、注释或其他非标准格式
 */
export function parseConfigJson(text: string): ParseValidationResult {
  // 去掉 BOM
  let cleaned = text.replace(/^﻿/, '');

  // 去掉首尾空白
  cleaned = cleaned.trim();

  if (!cleaned) {
    return { ok: false, errorCategory: 'empty', message: 'Empty response after BOM/whitespace removal', preview: '' };
  }

  // 有些配置可能被包在 callback 函数里
  const jsonpMatch = cleaned.match(/^w+(([sS]+))$/);
  if (jsonpMatch) {
    cleaned = jsonpMatch[1];
  }

  // 尝试直接解析
  const first = tryParseJsonWithMessage(cleaned);
  let parsed = first.parsed;

  // 如果失败，尝试去掉行尾注释后再解析
  if (!parsed) {
    const stripped = stripJsonComments(cleaned);
    const second = tryParseJsonWithMessage(stripped);
    parsed = second.parsed;
    if (!parsed) {
      const errMsg = second.error || first.error || 'Unknown JSON parse error';
      return { ok: false, errorCategory: 'syntax', message: errMsg, preview: text.slice(0, 200) };
    }
  }

  // 结构验证：必须是对象
  if (parsed === null) {
    return { ok: false, errorCategory: 'structure', message: 'Parsed value is null, expected object', preview: text.slice(0, 200) };
  }
  if (Array.isArray(parsed)) {
    return { ok: false, errorCategory: 'structure', message: 'Parsed value is an array, expected object', preview: text.slice(0, 200) };
  }
  if (typeof parsed !== 'object') {
    return { ok: false, errorCategory: 'structure', message: `Parsed value is ${typeof parsed}, expected object`, preview: text.slice(0, 200) };
  }

  return { ok: true, config: parsed as TVBoxConfig };
}

function tryParseJsonWithMessage(text: string): { parsed: Record<string, unknown> | null; error?: string } {
  try {
    return { parsed: JSON.parse(text) as Record<string, unknown> };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { parsed: null, error: msg };
  }
}

/**
 * 检测是否为多仓格式（索引 JSON 而非单仓 TVBoxConfig）
 * 支持两种格式：
 * - storeHouse: {"storeHouse": [{"sourceName": "...", "sourceUrl": "..."}]}
 * - urls: {"urls": [{"name": "...", "url": "..."}]}（需排除有 sites 的单仓）
 */
export function isMultiRepoConfig(config: TVBoxConfig): boolean {
  const raw = config as Record<string, unknown>;
  if (Array.isArray(raw.storeHouse)) return true;
  if (Array.isArray(raw.urls) && !config.sites) return true;
  return false;
}

/**
 * 从多仓 JSON 中提取子源 URL 列表
 */
export function extractMultiRepoEntries(config: TVBoxConfig, parentName: string): SourceEntry[] {
  const raw = config as Record<string, unknown>;
  const entries: SourceEntry[] = [];

  if (Array.isArray(raw.storeHouse)) {
    for (const item of raw.storeHouse as Record<string, unknown>[]) {
      const url = item?.sourceUrl;
      if (typeof url === 'string' && url.trim()) {
        entries.push({
          name: typeof item.sourceName === 'string' ? item.sourceName : parentName,
          url: url.trim(),
        });
      }
    }
  } else if (Array.isArray(raw.urls)) {
    for (const item of raw.urls as Record<string, unknown>[]) {
      const url = item?.url;
      if (typeof url === 'string' && url.trim()) {
        entries.push({
          name: typeof item.name === 'string' ? item.name : parentName,
          url: url.trim(),
        });
      }
    }
  }

  return entries;
}

/**
 * 安全地去掉 JSON 中的单行注释
 * 只处理不在字符串引号内的 // 注释
 */
function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      result += ch;
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      result += ch;
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (!inString && ch === '/' && text[i + 1] === '/') {
      // 跳到行尾
      const newline = text.indexOf('\n', i);
      if (newline === -1) break;
      i = newline - 1; // for 循环会 +1
      continue;
    }

    result += ch;
  }

  return result;
}
