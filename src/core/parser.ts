// 解析和规范化 TVBox JSON 配置

import type { TVBoxConfig, TVBoxSite, TVBoxLive, SourcedConfig } from './types';

/**
 * 从 SourcedConfig 中提取规范化的数据
 * 确保所有字段有合理的默认值
 */
export function normalizeConfig(sourced: SourcedConfig): SourcedConfig {
  const config = sourced.config;

  return {
    ...sourced,
    config: {
      spider: normalizeSpider(config.spider, sourced.sourceUrl),
      sites: normalizeSites(config.sites || [], config.spider, sourced.sourceUrl),
      parses: normalizeParses(config.parses, sourced.sourceUrl),
      lives: normalizeLives(config.lives || [], sourced.sourceUrl),
      hosts: config.hosts || [],
      rules: config.rules || [],
      doh: config.doh || [],
      ads: config.ads || [],
      flags: config.flags || [],
    },
  };
}

/**
 * 规范化 spider URL：相对路径转绝对路径
 */
function normalizeSpider(spider: string | undefined, sourceUrl: string): string | undefined {
  if (!spider) return undefined;
  return resolveUrl(spider, sourceUrl);
}

/**
 * 规范化站点列表
 * - 确保必填字段存在
 * - 相对 URL 转绝对
 * - type:3 站点关联 spider JAR
 */
function normalizeSites(
  sites: TVBoxSite[],
  globalSpider: string | undefined,
  sourceUrl: string,
): TVBoxSite[] {
  return sites
    .filter((site) => site.key && site.api !== undefined)
    .map((site) => {
      const normalized: TVBoxSite = {
        ...site,
        name: site.name || site.key,
        searchable: site.searchable ?? 1,
        quickSearch: site.quickSearch ?? 1,
        filterable: site.filterable ?? 1,
      };

      // type 0/1: 规范化 api URL
      if (site.type === 0 || site.type === 1) {
        normalized.api = resolveUrl(site.api, sourceUrl);
      }

      // type 3: api 是 URL（非 csp_/py_/js_ 类名）时也做 resolve
      if (site.type === 3 && isResolvableUrl(site.api)) {
        normalized.api = resolveUrl(site.api, sourceUrl);
      }

      // jar 字段：相对路径转绝对
      if (site.jar) {
        normalized.jar = resolveUrl(site.jar, sourceUrl);
      }

      // playUrl 字段：相对路径转绝对
      if (site.playUrl) {
        normalized.playUrl = resolveUrl(site.playUrl, sourceUrl);
      }

      // ext 字段：字符串或对象内部的 URL 都做转换
      if (site.ext) {
        normalized.ext = resolveExt(site.ext, sourceUrl);
      }

      return normalized;
    });
}

/**
 * 处理 ext 字段的 URL 补全
 * ext 可能是字符串（直接 resolve）或对象（递归 resolve 内部值）
 */
function resolveExt(
  ext: string | Record<string, unknown>,
  sourceUrl: string,
): string | Record<string, unknown> {
  if (typeof ext === 'string') {
    return isResolvableUrl(ext) ? resolveUrl(ext, sourceUrl) : ext;
  }

  // ext 是对象，遍历所有值，对字符串类型的 URL 做 resolve
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ext)) {
    if (typeof value === 'string' && isResolvableUrl(value)) {
      resolved[key] = resolveUrl(value, sourceUrl);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * 解析相对 URL 为绝对 URL
 * 支持 ./path 和 //host/path 格式
 */
function resolveUrl(url: string, baseUrl: string): string {
  if (!url) return url;

  // 已经是绝对 URL
  if (url.startsWith('http://') || url.startsWith('https://')) return url;

  // 协议相对 URL
  if (url.startsWith('//')) {
    try {
      const base = new URL(baseUrl);
      return `${base.protocol}${url}`;
    } catch {
      return `https:${url}`;
    }
  }

  // 相对路径
  if (url.startsWith('./') || url.startsWith('../')) {
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  }

  // 以 csp_ 开头的是 JAR class 引用，不是 URL
  if (url.startsWith('csp_') || url.startsWith('py_') || url.startsWith('js_')) {
    return url;
  }

  // 其他情况尝试解析
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/**
 * 规范化解析列表：相对路径转绝对路径
 */
function normalizeParses(parses: TVBoxConfig['parses'], sourceUrl: string): TVBoxConfig['parses'] {
  if (!parses) return [];
  return parses.map((parse) => {
    const normalized = { ...parse };

    if (parse.url) {
      normalized.url = resolveUrl(parse.url, sourceUrl);
    }

    if (parse.ext) {
      normalized.ext = resolveExt(parse.ext, sourceUrl);
    }

    return normalized;
  });
}

/**
 * 规范化直播列表：相对路径转绝对路径
 */
function normalizeLives(lives: TVBoxLive[], sourceUrl: string): TVBoxLive[] {
  return lives.map((live) => {
    const normalized = { ...live };

    if (live.url && isResolvableUrl(live.url)) {
      normalized.url = resolveUrl(live.url, sourceUrl);
    }

    if (live.api) {
      normalized.api = resolveUrl(live.api, sourceUrl);
    }

    if (live.jar) {
      normalized.jar = resolveUrl(live.jar, sourceUrl);
    }

    if (live.epg) {
      normalized.epg = resolveUrl(live.epg, sourceUrl);
    }

    if (live.ext) {
      normalized.ext = resolveExt(live.ext, sourceUrl);
    }

    return normalized;
  });
}

/**
 * 判断 URL 是否需要 resolve（是 URL 或相对路径，不是类名引用）
 */
function isResolvableUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('http://') || url.startsWith('https://')) return true;
  if (url.startsWith('./') || url.startsWith('../')) return true;
  if (url.startsWith('//')) return true;
  // csp_/py_/js_ 是 JAR 类名引用，不是 URL
  if (url.startsWith('csp_') || url.startsWith('py_') || url.startsWith('js_')) return false;
  return false;
}

/**
 * 提取配置中的 spider JAR URL（去掉 md5 后缀等）
 */
export function extractSpiderJarUrl(spider: string | undefined): string | null {
  if (!spider) return null;

  // 格式: "url;md5;checksum" → 取 url
  const parts = spider.split(';md5;');
  let url = parts[0].trim();

  // 格式: "img+url" → 取 url
  if (url.startsWith('img+')) {
    url = url.substring(4);
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return null;
  }

  return url;
}
