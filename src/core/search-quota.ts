// 搜索配额控制（简化版）

import type { TVBoxSite, SearchQuotaConfig, SearchQuotaReport } from './types';
import type { Storage } from '../storage/interface';
import { SEARCH_QUOTA } from './config';

/** 从 KV 加载搜索配额配置 */
export async function loadSearchQuota(storage: Storage): Promise<SearchQuotaConfig> {
  const raw = await storage.get(SEARCH_QUOTA);
  if (raw) {
    try {
      return JSON.parse(raw) as SearchQuotaConfig;
    } catch {}
  }
  return { maxSearchable: 0, pinnedKeys: [] };
}

/** 保存搜索配额配置 */
export async function saveSearchQuota(storage: Storage, config: SearchQuotaConfig): Promise<void> {
  await storage.put(SEARCH_QUOTA, JSON.stringify(config));
}

/**
 * 搜索配额控制（简化版）
 *
 * 1. JS/URL 源排除：type=3 + api 是 URL → searchable=0
 * 2. 置顶排序：pinnedKeys 的源移到 sites 数组最前面
 * 3. 可选截断：maxSearchable > 0 时，超出的 searchable=0
 */
export function applySearchQuota(
  sites: TVBoxSite[],
  config: SearchQuotaConfig,
): { sites: TVBoxSite[]; quotaReport: SearchQuotaReport } {
  const limit = config.maxSearchable;
  const totalSites = sites.length;

  // 1. JS/URL 源排除：type=3 + api 是 HTTP URL → searchable=0
  let jsExcluded = 0;
  sites = sites.map(site => {
    if (site.type === 3 && site.searchable === 1 && /^https?:\/\//.test(site.api)) {
      jsExcluded++;
      return { ...site, searchable: 0 };
    }
    return site;
  });

  // 2. 置顶排序：pinned 源按 pinnedKeys 顺序排到数组最前（顺序 = TVBox 搜索执行顺序）
  const siteByKey = new Map(sites.map(s => [s.key, s]));
  const pinned: TVBoxSite[] = [];
  for (const key of config.pinnedKeys) {
    const site = siteByKey.get(key);
    if (site) pinned.push(site);
  }
  const pinnedKeySet = new Set(pinned.map(s => s.key));
  const rest = sites.filter(s => !pinnedKeySet.has(s.key));
  sites = [...pinned, ...rest];

  // 3. 可选截断
  let truncated = 0;
  if (limit > 0) {
    let count = 0;
    sites = sites.map(site => {
      if (site.searchable !== 1) return site;
      count++;
      if (count > limit) {
        truncated++;
        return { ...site, searchable: 0 };
      }
      return site;
    });
  }

  const searchable = sites.filter(s => s.searchable === 1).length;
  const pinnedCount = pinned.filter(s => s.searchable === 1).length;

  return {
    sites,
    quotaReport: { totalSites, jsExcluded, searchable, pinnedCount, truncated },
  };
}
