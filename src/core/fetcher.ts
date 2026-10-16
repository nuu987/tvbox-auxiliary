// 批量 fetch TVBox JSON 配置

import { DEFAULT_FETCH_TIMEOUT_MS, TVBOX_UA, BROWSER_UA } from './config';
import { decodeConfigResponse } from './decoder';
import { logger } from './logger';
import { retryDownload, DOWNLOAD_DEADLINE_MS } from './download-retry';
import type { DownloadAttemptResult } from './download-retry';
import type { TVBoxConfig, SourcedConfig, SourceEntry, SourceFetchResult, ParseValidationResult, SourceFetchStatus } from './types';

export interface FetchConfigsResult {
  configs: SourcedConfig[];
  fetchResults: SourceFetchResult[];
}

export interface SourceConfigResolver {
  source(source: SourceEntry): SourceEntry;
  acquire?(source: SourceEntry): SingleFetchResult | undefined;
  resolve(source: SourceEntry, config: TVBoxConfig | null, result: SourceFetchResult, depth: number): { config: TVBoxConfig; prepared?: boolean } | null;
}

/**
 * 批量获取配置 JSON，串行重试，带超时
 * 仅处理独立单仓；多仓只能在添加/导入时使用
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
  resolver?: SourceConfigResolver,
): Promise<FetchConfigsResult> {
  const configs: SourcedConfig[] = [];
  const fetchResults: SourceFetchResult[] = [];
  const seen = new Set<string>(); // URL 去重，防循环引用

  await fetchSources(sources, configs, fetchResults, seen, timeoutMs, 0, proxyConfig, resolver);

  logger.infoFields('fetcher', 'fetch-complete', {
    configs: configs.length,
    topLevelSources: sources.length,
    results: fetchResults.length,
  });
  return { configs, fetchResults };
}

/**
 * 串行获取独立单仓源
 */
async function fetchSources(
  sources: SourceEntry[],
  configs: SourcedConfig[],
  fetchResults: SourceFetchResult[],
  seen: Set<string>,
  timeoutMs: number,
  depth: number,
  proxyConfig?: FetchProxyConfig,
  resolver?: SourceConfigResolver,
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

  // D-08: 串行化逐源拉取（有意偏离 CLAUDE.md 'Promise.allSettled for 批量部分失败' 约定——
  // 仅此调用点改为串行，CLAUDE.md 约定不全局废弃，见 CONTEXT.md D-08）。
  // 串行 + 重试使同时只有 1 源在拉取/重试，避免多源重试风暴对同一远端聚集（T-07-02）。

  for (const queuedSource of uniqueSources) {
    const source = resolver ? resolver.source(queuedSource) : queuedSource;
    const { config: fetchedConfig, fetchResult } = resolver?.acquire?.(source)
      || await fetchSingleConfig(source, timeoutMs, proxyConfig, depth);
    fetchResults.push(fetchResult);
    const resolved = resolver ? resolver.resolve(source, fetchedConfig, fetchResult, depth)
      : fetchResult.status === 'ok' && fetchedConfig ? { config: fetchedConfig, prepared: false } : null;
    if (!resolved) continue;

    if (isMultiRepoConfig(resolved.config)) {
      logger.warn('fetcher', `Directory is import-only; skipped: ${source.url}`);
      continue;
    }
    configs.push({
      sourceUrl: source.url,
      sourceName: source.name,
      config: resolved.config,
      prepared: resolved.prepared,
      speedMs: fetchResult.speedMs,
    });
  }
}

/** Legacy migration only: direct inspection without changing its historical retry policy. */
export async function inspectSourceOnce(source: SourceEntry, timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): Promise<SingleFetchResult> {
  return fetchWithUA(source, timeoutMs, 'okhttp/3.12.0', 'import', 0);
}

export interface SingleFetchResult {
  config: TVBoxConfig | null;
  fetchResult: SourceFetchResult;
}

/**
 * 获取单个配置 JSON（不重试）——从原 fetchSingleConfig 体抽取的内层核心拉取函数。
 * 双 UA 回退 + 边缘代理回退逻辑全部保留不变。
 * HTTP helpers return structured results; retain the primary failure while
 * reporting any unrecovered fallback timeout to the shared retry owner.
 * 模块私有不 export——重试包装器调用之避免递归（Pitfall 1）。
 */
async function fetchSingleConfigNoRetry(
  source: SourceEntry,
  timeoutMs: number,
  proxyConfig?: FetchProxyConfig,
  depth = 0,
  remainingMs?: () => number,
): Promise<DownloadAttemptResult<SingleFetchResult>> {
  const requestTimeout = () => Math.min(timeoutMs, Math.max(remainingMs?.() ?? timeoutMs, 1));
  const hasBudget = () => !remainingMs || remainingMs() > 0;
  let timeoutResult: SingleFetchResult | undefined;
  const trackTimeout = (value: SingleFetchResult) => {
    if (value.fetchResult.status === 'timeout') timeoutResult = value;
    return value;
  };
  // 双 UA 回退：先用 okhttp（TVBox 原生），解析失败换浏览器 UA 重试
  const result = trackTimeout(await fetchWithUA(source, requestTimeout(), TVBOX_UA, 'tvbox', depth));
  if (result.config) return { value: result, status: 'ok' };

  // okhttp 失败 → 浏览器 UA 重试（部分源只接受浏览器 UA）
  if (hasBudget() && (result.fetchResult.status === 'parse_error' || result.fetchResult.status === 'decode_error')) {
    logger.debugFields('fetcher', 'retry-browser-ua', {
      name: source.name,
      url: source.url,
      previousStatus: result.fetchResult.status,
    });
    const browserResult = trackTimeout(await fetchWithUA(source, requestTimeout(), BROWSER_UA, 'browser', depth));
    if (browserResult.config) return { value: browserResult, status: 'ok' };
  }

  // 直连失败（timeout/network_error/http_error）→ 通过边缘代理重试
  if (proxyConfig?.urls.length && isProxyRetriable(result.fetchResult.status)) {
    for (let i = 0; i < proxyConfig.urls.length; i++) {
      if (!hasBudget()) break;
      const proxyUrl = proxyConfig.urls[i];
      logger.debugFields('fetcher', 'retry-proxy', {
        name: source.name,
        url: source.url,
        proxyIndex: i + 1,
        proxyHost: safeHost(proxyUrl),
        previousStatus: result.fetchResult.status,
      });
      const proxyResult = trackTimeout(await fetchViaProxy(source, requestTimeout(), proxyUrl, proxyConfig.token));
      if (proxyResult.config) return { value: proxyResult, status: 'ok' };
    }
  } else {
    logger.debugFields('fetcher', 'retry-skipped', {
      name: source.name,
      url: source.url,
      status: result.fetchResult.status,
      proxyConfigured: Boolean(proxyConfig?.urls.length),
    });
  }

  return { value: result, status: timeoutResult ? 'timeout' : 'failed',
    reason: timeoutResult?.fetchResult.errorMessage || result.fetchResult.errorMessage || result.fetchResult.status };
}

/**
 * 获取单个配置 JSON，返回结构化结果（成功或失败原因）
 *
 * Uses the shared static-resource retry policy: three rounds, 1s/2s waits,
 * no outer retry after timeout and a 30s overall budget. Each round keeps the
 * existing UA/proxy fallbacks, constrained by the remaining budget.
 */
export async function fetchSingleConfig(
  source: SourceEntry,
  timeoutMs: number,
  proxyConfig?: FetchProxyConfig,
  depth = 0,
): Promise<SingleFetchResult> {
  const run = await retryDownload<SingleFetchResult>({
    timeoutMs,
    execute: context => fetchSingleConfigNoRetry(source, context.timeoutMs, proxyConfig, depth, context.remainingMs),
    onFailure: event => {
      logger.warnFields('fetcher', 'source-download-attempt-failed', {
        name: source.name, url: source.url, attempt: event.attempt, maxAttempts: event.maxAttempts,
        status: event.status, reason: event.reason,
      });
      if (event.delayMs) logger.infoFields('fetcher', 'source-retry-attempt', {
        name: source.name, url: source.url, attempt: event.attempt, reason: event.reason, backoffMs: event.delayMs,
      });
    },
    onDeadline: attempts => logger.warnFields('fetcher', 'source-download-deadline', {
      name: source.name, url: source.url, attempts, deadlineMs: DOWNLOAD_DEADLINE_MS,
    }),
  });
  if (run.outcome === 'success' && run.attempts > 1) logger.infoFields('fetcher', 'source-retry-recovered', {
    name: source.name, url: source.url, attempt: run.attempts - 1, recovered: true,
  });
  if (run.outcome === 'exhausted') logger.infoFields('fetcher', 'source-retry-exhausted', {
    name: source.name, url: source.url, attempts: run.attempts,
    finalReason: run.value.fetchResult.errorMessage || run.value.fetchResult.status,
  });
  return run.value;
}

function isProxyRetriable(status: string): boolean {
  return status === 'timeout'
    || status.startsWith('http_')
    || ['dns_error', 'conn_refused', 'conn_reset', 'tls_error',
        'host_unreachable', 'net_unreachable', 'fetch_failed'].includes(status);
}

// ─── 错误分类辅助 ─────────────────────────────────────────
// Plan 03.1 D-08: 将粗粒度 'http_error' / 'network_error' 细分为具体子类型
// classifyHttpError 按状态码映射到 http_403/http_404/.../http_4xx/http_5xx，兜底 fetch_failed
function classifyHttpError(status: number): SourceFetchStatus {
  switch (status) {
    case 403: return 'http_403';
    case 404: return 'http_404';
    case 429: return 'http_429';
    case 502: return 'http_502';
    case 503: return 'http_503';
    case 504: return 'http_504';
    default:
      if (status >= 400 && status < 500) return 'http_4xx';
      if (status >= 500 && status < 600) return 'http_5xx';
      return 'fetch_failed';
  }
}

// classifyNetworkError 按 Node.js error.cause.code 映射到 dns_error/conn_refused/...，兜底 fetch_failed
export function classifyNetworkError(error: unknown): SourceFetchStatus {
  // AbortController.abort() 抛出 AbortError —— 分类为 timeout (WARN) 而非 fetch_failed (ERR)
  // 修复 VERIFICATION.md Truth #7 / REVIEW.md CR-02：proxy 路径此前缺此守卫
  // 直接 fetch 路径 (fetchWithUA:468) 有内联 msg.includes('abort') 守卫，proxy 路径此前无等价保护
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  const cause = (error as { cause?: { code?: string } })?.cause;
  const code = cause?.code || '';
  switch (code) {
    case 'ABORT_ERR':     return 'timeout';
    case 'ENOTFOUND':     return 'dns_error';
    case 'ECONNREFUSED':  return 'conn_refused';
    case 'ECONNRESET':    return 'conn_reset';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'ERR_TLS_PROTOCOL_VERSION':
    case 'ERR_TLS_HANDSHAKE_TIMEOUT':
                          return 'tls_error';
    case 'EHOSTUNREACH':  return 'host_unreachable';
    case 'ENETUNREACH':   return 'net_unreachable';
    default:              return 'fetch_failed';
  }
}

// classifyNetworkErrorMessage 生成 D-09 中文标签的细分错误详情（含 hostname/port）
export function classifyNetworkErrorMessage(error: unknown): string {
  // AbortError 优先处理 —— 返回中文标签，避免 default 分支返回英文 'The operation was aborted'
  // 修复 REVIEW.md IN-05：proxy 超时消息此前为英文，违反 CLAUDE.md 中文-only UI 约束
  if (error instanceof Error && error.name === 'AbortError') return '请求超时';
  const cause = (error as { cause?: { code?: string; hostname?: string; host?: string; port?: number | string } })?.cause;
  const code = cause?.code || '';
  const hostname = cause?.hostname || (error instanceof Error && (error as { hostname?: string }).hostname) || 'unknown host';
  const host = cause?.host || hostname;
  const port = cause?.port;
  switch (code) {
    case 'ABORT_ERR':     return '请求超时';
    case 'ENOTFOUND':     return `DNS 解析失败: ${hostname}`;
    case 'ECONNREFUSED':  return port ? `连接被拒绝: ${host}:${port}` : `连接被拒绝: ${hostname}`;
    case 'ECONNRESET':    return '连接被重置';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'ERR_TLS_PROTOCOL_VERSION':
    case 'ERR_TLS_HANDSHAKE_TIMEOUT':
                          return 'TLS 握手失败';
    case 'EHOSTUNREACH':  return `主机不可达: ${hostname}`;
    case 'ENETUNREACH':   return '网络不可达';
    default:              return error instanceof Error ? error.message : String(error);
  }
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
        fetchResult: { url: source.url, name: source.name, status: classifyHttpError(response.status), errorMessage: `Proxy: HTTP ${response.status} ${response.statusText}` },
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
    return {
      config: null,
      fetchResult: { url: source.url, name: source.name, status: classifyNetworkError(error), errorMessage: `Proxy: ${classifyNetworkErrorMessage(error)}` },
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
        fetchResult: { url: source.url, name: source.name, status: classifyHttpError(response.status), errorMessage: `HTTP ${response.status} ${response.statusText}` },
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
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError') || msg.includes('abort')) {
      logger.warnFields('fetcher', 'source-timeout', {
        name: source.name,
        url: source.url,
        ua: uaLabel,
        timeoutMs,
      });
      return {
        config: null,
        fetchResult: { url: source.url, name: source.name, status: 'timeout', errorMessage: '请求超时' },
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
      fetchResult: { url: source.url, name: source.name, status: classifyNetworkError(error), errorMessage: classifyNetworkErrorMessage(error) },
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
  let result = tryParseJsonWithMessage(cleaned);
  let compatibility: JsonCompatibilityResult | undefined;

  // Syntax-only fallback: preserve string values, normalize supported comments/wrappers.
  if (!result.ok) {
    compatibility = normalizeJsonCompatibility(cleaned);
    if (compatibility.error) {
      return { ok: false, errorCategory: 'syntax', message: compatibility.error, preview: text.slice(0, 200) };
    }
    if (!compatibility.text.trim()) {
      return { ok: false, errorCategory: 'empty', message: 'Empty response after comment removal', preview: text.slice(0, 200) };
    }
    result = tryParseJsonWithMessage(compatibility.text);
    if (!result.ok) {
      return { ok: false, errorCategory: 'syntax', message: result.error, preview: text.slice(0, 200) };
    }
  }
  const parsed = result.parsed;

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

  if (compatibility) {
    logger.infoFields('parser', 'config-compatibility-applied', {
      lineComments: compatibility.lineComments,
      blockComments: compatibility.blockComments,
      hashComments: compatibility.hashComments,
      htmlTrailers: compatibility.htmlTrailers,
      lfEscapes: compatibility.lfEscapes,
      crEscapes: compatibility.crEscapes,
    });
  }
  return { ok: true, config: parsed as TVBoxConfig };
}

type JsonParseAttempt = { ok: true; parsed: unknown } | { ok: false; error: string };

function tryParseJsonWithMessage(text: string): JsonParseAttempt {
  try {
    return { ok: true, parsed: JSON.parse(text) as unknown };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
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

interface JsonCompatibilityResult {
  text: string;
  lineComments: number;
  blockComments: number;
  hashComments: number;
  htmlTrailers: number;
  lfEscapes: number;
  crEscapes: number;
  error?: string;
}

/** String-aware syntax compatibility; JSON.parse remains the only value parser. */
function normalizeJsonCompatibility(text: string): JsonCompatibilityResult {
  const chunks: string[] = [];
  const result: JsonCompatibilityResult = { text: '', lineComments: 0, blockComments: 0, hashComments: 0, htmlTrailers: 0, lfEscapes: 0, crEscapes: 0 };
  let state: 'normal' | 'string' | 'escape' | 'line-comment' | 'block-comment' = 'normal';
  let lineWhitespace = true;
  let root: 'pending' | 'object' | 'other' = 'pending';
  let depth = 0;
  const htmlStart = /<(?:!--|!doctype(?:\s|>)|\/?[a-z][\w:-]*(?:\s|\/?>))/iy;

  scan: for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    switch (state) {
      case 'normal':
        // Some hosts append HTML to an otherwise complete JSON object. Never
        // search inside strings, accept an HTML page, or repair an unfinished root.
        if (root === 'object' && depth === 0 && ch === '<') {
          htmlStart.lastIndex = i;
          if (htmlStart.test(text)) {
            result.htmlTrailers++;
            break scan;
          }
        }
        if (ch === '#' && lineWhitespace) {
          state = 'line-comment'; result.hashComments++; chunks.push(' ');
        } else if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
          if (text[i + 1] === '/') { state = 'line-comment'; result.lineComments++; }
          else { state = 'block-comment'; result.blockComments++; }
          chunks.push('  ');
          i++;
        } else {
          if (root === 'pending' && !/\s/.test(ch)) root = ch === '{' ? 'object' : 'other';
          if (root === 'object') {
            if (ch === '{' || ch === '[') depth++;
            else if (ch === '}' || ch === ']') depth--;
          }
          chunks.push(ch);
          if (ch === '"') state = 'string';
        }
        break;
      case 'string':
        if (ch === '\n') { chunks.push('\\n'); result.lfEscapes++; }
        else if (ch === '\r') { chunks.push('\\r'); result.crEscapes++; }
        else {
          chunks.push(ch);
          if (ch === '\\') state = 'escape';
          else if (ch === '"') state = 'normal';
        }
        break;
      case 'escape':
        chunks.push(ch);
        state = 'string';
        break;
      case 'line-comment':
        if (ch === '\n' || ch === '\r') { chunks.push(ch); state = 'normal'; }
        else chunks.push(' ');
        break;
      case 'block-comment':
        if (ch === '*' && text[i + 1] === '/') {
          chunks.push('  ');
          i++;
          state = 'normal';
        } else chunks.push(ch === '\n' || ch === '\r' ? ch : ' ');
        break;
    }
    if (ch === '\r' || ch === '\n') lineWhitespace = true;
    else if (!/\s/.test(ch)) lineWhitespace = false;
  }
  if (state === 'string' || state === 'escape') result.error = 'Unterminated JSON string in compatibility input';
  else if (state === 'block-comment') result.error = 'Unterminated block comment in compatibility input';
  result.text = chunks.join('');
  return result;
}
