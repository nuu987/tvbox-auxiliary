// MacCMS 源验证与 TVBoxSite 转换

import { logger } from './logger';
import type { MacCMSSourceEntry, TVBoxSite } from './types';

export interface MacCMSValidation {
  ok: boolean;
  speedMs: number;
}

/**
 * 验证单个 MacCMS API 可用性，返回结果和延迟
 * 发 ?ac=list 请求，检查响应包含 class 或 list 字段
 */
export async function validateMacCMS(
  api: string,
  timeoutMs: number,
): Promise<MacCMSValidation> {
  const url = api.includes('?') ? `${api}&ac=list` : `${api}?ac=list`;
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    const speedMs = Date.now() - start;

    if (!resp.ok) return { ok: false, speedMs };

    const data = (await resp.json()) as Record<string, unknown>;
    // MacCMS 标准响应包含 class（分类）或 list（视频列表）
    const ok = !!(data && (data.class || data.list));
    return { ok, speedMs };
  } catch {
    return { ok: false, speedMs: Date.now() - start };
  }
}

/**
 * 将 MacCMS 源条目转换为 TVBoxSite 数组
 * - 有 proxyBaseUrl（localBaseUrl）：使用代理 URL
 * - 无 proxyBaseUrl：使用原始 API URL
 * - speedMap 有值时追加延迟标记到 name
 */
export function macCMSToTVBoxSites(
  entries: MacCMSSourceEntry[],
  proxyBaseUrl?: string,
  speedMap?: Map<string, number>,
): TVBoxSite[] {
  return entries.map((entry) => {
    let name = entry.name;
    const speedMs = speedMap?.get(entry.key);
    if (speedMs != null) {
      const seconds = (speedMs / 1000).toFixed(1);
      name = `${name} [${seconds}s]`;
    }

    return {
      key: entry.key,
      name,
      type: 1,
      api: proxyBaseUrl
        ? `${proxyBaseUrl.replace(/\/$/, '')}/api/${entry.key}`
        : entry.api,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    };
  });
}

/**
 * 本地版：并发验证所有 MacCMS 源，返回通过验证的条目 + 延迟映射
 */
export async function processMacCMSForLocal(
  entries: MacCMSSourceEntry[],
  timeoutMs: number,
): Promise<{ passed: MacCMSSourceEntry[]; speedMap: Map<string, number> }> {
  if (entries.length === 0) return { passed: [], speedMap: new Map() };

  logger.infoFields('maccms', 'validation-start', { count: entries.length, timeoutMs });
  entries.forEach((entry, index) => {
    logger.infoFields('maccms', 'source-queued', {
      index: index + 1,
      key: entry.key,
      name: entry.name,
      api: entry.api,
    });
  });

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const validation = await validateMacCMS(entry.api, timeoutMs);
      return { entry, validation };
    }),
  );

  const passed: MacCMSSourceEntry[] = [];
  const speedMap = new Map<string, number>();

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { entry, validation } = result.value;
      if (validation.ok) {
        passed.push(entry);
        speedMap.set(entry.key, validation.speedMs);
        logger.infoFields('maccms', 'source-valid', {
          key: entry.key,
          name: entry.name,
          api: entry.api,
          speedMs: validation.speedMs,
        });
      } else {
        logger.infoFields('maccms', 'source-filtered', {
          key: entry.key,
          name: entry.name,
          api: entry.api,
          reason: 'validation_failed',
          speedMs: validation.speedMs,
        });
      }
    } else {
      logger.warnFields('maccms', 'source-error', { error: result.reason });
    }
  }

  logger.infoFields('maccms', 'validation-complete', {
    passed: passed.length,
    total: entries.length,
  });
  return { passed, speedMap };
}
