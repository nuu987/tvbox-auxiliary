// 批量 fetch TVBox JSON 配置

import { DEFAULT_FETCH_TIMEOUT_MS, TVBOX_UA, BROWSER_UA } from './config';
import { decodeConfigResponse } from './decoder';
import { logger } from './logger';
import type { TVBoxConfig, SourcedConfig, SourceEntry, SourceFetchResult, ParseValidationResult, SourceFetchStatus } from './types';

const MAX_MULTI_REPO_DEPTH = 3; // 多仓最大展开深度

// Phase 7 同步失败重试机制：逐源失败重试 + 串行化（D-01 ~ D-11）
// D-04 口径：首轮失败后重试 3 次（exhausted 场景共 4 次 fetch 调用）
const MAX_RETRY_ATTEMPTS = 3; // 首轮失败后的最大重试次数
const RETRY_BACKOFF_MS = [5000, 10000, 20000]; // D-04 指数退避档位 5s/10s/20s
const RETRY_JITTER = 0.2; // D-04 ±20% jitter 系数，防多源节奏整齐对远端聚集

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

  // D-08: 串行化逐源拉取（有意偏离 CLAUDE.md 'Promise.allSettled for 批量部分失败' 约定——
  // 仅此调用点改为串行，CLAUDE.md 约定不全局废弃，见 CONTEXT.md D-08）。
  // 串行 + 重试使同时只有 1 源在拉取/重试，避免多源重试风暴对同一远端聚集（T-07-02）。
  const multiRepoChildren: SourceEntry[] = [];

  for (const source of uniqueSources) {
    const { config: fetchedConfig, fetchResult } = await fetchSingleConfig(source, timeoutMs, proxyConfig, depth);
    fetchResults.push(fetchResult);

    if (fetchResult.status !== 'ok') {
      // 失败已记录到 fetchResults（含重试耗尽场景），跳过多仓展开
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
 * 退避 sleep 工具：baseMs ± RETRY_JITTER 比例抖动（D-04 ±20% jitter）。
 * Math.random 运行时可用（CLAUDE.md 禁令仅针对 workflow scripts）。
 */
function sleepWithJitter(baseMs: number): Promise<void> {
  const offset = baseMs * RETRY_JITTER * (2 * Math.random() - 1); // ±baseMs*0.2
  const delay = Math.round(baseMs + offset);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 获取单个配置 JSON（不重试）——从原 fetchSingleConfig 体抽取的内层核心拉取函数。
 * 双 UA 回退 + 边缘代理回退逻辑全部保留不变。
 * 内部已 try/catch 返回结构化 SingleFetchResult，永不 reject。
 * 模块私有不 export——重试包装器调用之避免递归（Pitfall 1）。
 */
async function fetchSingleConfigNoRetry(
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

/**
 * 获取单个配置 JSON，返回结构化结果（成功或失败原因）
 *
 * Phase 7 重试包装器：首轮失败后按 RETRY_BACKOFF_MS=[5s,10s,20s] + ±20% jitter 重试
 * MAX_RETRY_ATTEMPTS=3 次（D-04 口径：exhausted 场景共 4 次 fetch 调用 = 首轮 1 + 重试 3）。
 *
 * 触发判据：status !== 'ok'（D-02，含 timeout/parse_error/http_404 等全部 fail/warn 子类型——
 * D-03 不区分瞬时 vs 确定性错误，Q5 有意偏离 downloadResource 的 AbortError 不重试守卫）。
 *
 * 日志事件（D-10，通过 emitSink → log-buffer → Phase 6 /admin/logs SSE 实时可见）：
 * - source-retry-attempt: 每次重试前发出，字段含 attempt/reason
 * - source-retry-recovered: 重试成功时发出
 * - source-retry-exhausted: 重试耗尽时发出
 *
 * 关键设计（Pitfall 1/2）：重试包装器只调 fetchSingleConfigNoRetry，永不调自身（避免无限递归）；
 * 每次 attempt 的 AbortController 由 fetchWithUA/fetchViaProxy 内部各自新建，跨 attempt 不复用。
 */
async function fetchSingleConfig(
  source: SourceEntry,
  timeoutMs: number,
  proxyConfig?: FetchProxyConfig,
  depth = 0,
): Promise<SingleFetchResult> {
  let result = await fetchSingleConfigNoRetry(source, timeoutMs, proxyConfig, depth);
  if (result.fetchResult.status === 'ok') return result;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    logger.infoFields('fetcher', 'source-retry-attempt', {
      name: source.name,
      url: source.url,
      attempt,
      reason: result.fetchResult.errorMessage || result.fetchResult.status,
    });
    await sleepWithJitter(RETRY_BACKOFF_MS[attempt - 1]);
    result = await fetchSingleConfigNoRetry(source, timeoutMs, proxyConfig, depth);
    if (result.fetchResult.status === 'ok') {
      logger.infoFields('fetcher', 'source-retry-recovered', {
        name: source.name,
        url: source.url,
        attempt,
        recovered: true,
      });
      return result;
    }
  }

  logger.infoFields('fetcher', 'source-retry-exhausted', {
    name: source.name,
    url: source.url,
    attempts: MAX_RETRY_ATTEMPTS,
    finalReason: result.fetchResult.errorMessage || result.fetchResult.status,
  });
  return result;
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
    if (msg.includes('abort')) {
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
