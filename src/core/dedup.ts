// 去重逻辑

import type { TVBoxSite, TVBoxParse, TVBoxLive, TVBoxDoh, TVBoxRule } from './types';
import { effectiveSiteJar } from './jar-identity';

export function siteDedupKey(site: TVBoxSite, jarIdentity = effectiveSiteJar(site)?.identity || ''): string {
  return JSON.stringify([site.key, site.api, jarIdentity]);
}

/**
 * 站点去重
 * Preserve JAR declaration variants; reserve original keys before generating suffixes.
 */
export function deduplicateSites(sites: TVBoxSite[], keyFor: (site: TVBoxSite) => string = siteDedupKey): TVBoxSite[] {
  const result: TVBoxSite[] = [];
  const seen = new Set<string>();
  const reserved = new Set(sites.map(site => site.key));
  const used = new Set<string>();
  const suffixes = new Map<string, number>();

  for (const site of sites) {
    const dk = keyFor(site);
    if (seen.has(dk)) continue;
    seen.add(dk);

    if (used.has(site.key)) {
      const original = site.key;
      let count = suffixes.get(original) || 1;
      do { count++; } while (reserved.has(`${original}_${count}`) || used.has(`${original}_${count}`));
      suffixes.set(original, count);
      site.key = `${original}_${count}`;
      if (site.name) site.name = `${site.name}(${count})`;
    }
    used.add(site.key);
    result.push(site);
  }

  return result;
}

/**
 * 解析器去重 (url + type)
 * 按 url+type 去重而非 name+url，同一 URL 不同 name 视为同一解析
 * 保留 type 维度防止嗅探(0)和 JSON(1)解析被误合并
 */
export function deduplicateParses(parses: TVBoxParse[]): TVBoxParse[] {
  const seen = new Set<string>();
  return parses.filter((parse) => {
    const key = `${parse.url}|${parse.type ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 直播源去重 (url)
 */
export function deduplicateLives(lives: TVBoxLive[]): TVBoxLive[] {
  const seen = new Set<string>();
  return lives.filter((live) => {
    const url = live.url || live.api || '';
    if (!url) return true; // 无 URL 的保留
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

/**
 * DOH 去重 (url)
 */
export function deduplicateDoh(dohs: TVBoxDoh[]): TVBoxDoh[] {
  const seen = new Set<string>();
  return dohs.filter((doh) => {
    if (seen.has(doh.url)) return false;
    seen.add(doh.url);
    return true;
  });
}

/**
 * Rules 合并：相同 host/hosts 的规则合并 regex/rule/filter/script
 */
export function mergeRules(rules: TVBoxRule[]): TVBoxRule[] {
  const hostMap = new Map<string, TVBoxRule>();

  for (const rule of rules) {
    const hostKey = rule.host || (rule.hosts || []).sort().join(',');
    if (!hostKey) {
      // 无法归类的规则直接保留
      hostMap.set(`__anon_${hostMap.size}`, rule);
      continue;
    }

    if (hostMap.has(hostKey)) {
      const existing = hostMap.get(hostKey)!;
      if (rule.rule) existing.rule = [...new Set([...(existing.rule || []), ...rule.rule])];
      if (rule.filter) existing.filter = [...new Set([...(existing.filter || []), ...rule.filter])];
      if (rule.regex) existing.regex = [...new Set([...(existing.regex || []), ...rule.regex])];
      if (rule.script) existing.script = [...new Set([...(existing.script || []), ...rule.script])];
    } else {
      hostMap.set(hostKey, { ...rule });
    }
  }

  return [...hostMap.values()];
}

/**
 * Hosts 去重：同 domain 后者覆盖
 */
export function deduplicateHosts(hosts: string[]): string[] {
  const map = new Map<string, string>();
  for (const entry of hosts) {
    const eqIndex = entry.indexOf('=');
    if (eqIndex > 0) {
      const domain = entry.substring(0, eqIndex);
      map.set(domain, entry);
    }
  }
  return [...map.values()];
}

/**
 * 字符串数组去重 (ads, flags)
 */
export function deduplicateStrings(arr: string[]): string[] {
  return [...new Set(arr)];
}
