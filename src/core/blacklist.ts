// 黑名单管理：加载/保存/指纹计算/过滤/自动清理

import type { Storage } from '../storage/interface';
import type { TVBoxSite, TVBoxParse, TVBoxLive, TVBoxConfig, RegexRule, RegexValidationResult } from './types';
import { BLACKLIST, BASE_URL_PLACEHOLDER, MERGED_CONFIG_FULL } from './config';
import { withSourceGate } from './source-gate';
import { effectiveSiteJar } from './jar-identity';
import { readAggregateOutputs, publishAggregatePatch } from './aggregate-output';
import { applyStoredLivePolicy, type LivePolicy } from './live-policy';
import { rewriteJarUrls } from './jar-proxy';
import { logger } from './logger';

export interface Blacklist {
  sites: string[];
  siteIdentityVersion?: 2;
  legacySiteAliases?: Record<string, string[]>;
  unresolvedLegacySites?: string[];
  parses: string[];               // parse url
  lives: string[];                // live url
  regexRules: RegexRule[];        // 正则屏蔽规则
  regexBlockOverrides: string[];  // 正则屏蔽手动恢复的站点名称
}

const EMPTY_BLACKLIST: Blacklist = {
  sites: [], parses: [], lives: [],
  regexRules: [], regexBlockOverrides: [],
};

export interface BlacklistRemovedItem {
  kind: 'site' | 'parse' | 'live' | 'regex-site';
  key?: string;
  name?: string;
  url?: string;
  fingerprint?: string;
  pattern?: string;
}

/**
 * 计算站点稳定指纹
 * Fingerprints stay independent of generated key/name suffixes.
 */
async function fingerprintText(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf).slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function legacySiteFingerprint(site: TVBoxSite): Promise<string> {
  const ext = typeof site.ext === 'string' ? site.ext : JSON.stringify(site.ext || '');
  return fingerprintText(`${site.api}|${ext}|${site.jar || ''}`);
}

export async function siteFingerprint(site: TVBoxSite, spider?: string): Promise<string> {
  const jar = effectiveSiteJar(site, spider);
  if (!jar) return legacySiteFingerprint(site);
  const ext = typeof site.ext === 'string' ? site.ext : JSON.stringify(site.ext || '');
  return 'j2:' + await fingerprintText(JSON.stringify([site.api, ext, jar.identity]));
}

/** Gate held by caller. Persist the one-time conversion before FULL can change. */
async function loadBlacklistUnlocked(storage: Storage, loadedRaw?: string): Promise<Blacklist> {
  const raw = loadedRaw === undefined ? await storage.get(BLACKLIST) : loadedRaw;
  const value: unknown = raw ? JSON.parse(raw) : { ...EMPTY_BLACKLIST };
  const strings = (input: unknown): input is string[] => Array.isArray(input) && input.every(item => typeof item === 'string');
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('sites' in value) || !('parses' in value)
    || !('lives' in value) || !strings(value.sites) || !strings(value.parses) || !strings(value.lives)) {
    throw new Error('Invalid blacklist structure');
  }
  const fields = value as Record<string, unknown>;
  const legacySiteAliases: Record<string, string[]> = Object.create(null);
  if (fields.siteIdentityVersion === 2) {
    const aliases = fields.legacySiteAliases;
    if (aliases !== undefined) {
      if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) throw new Error('Invalid blacklist aliases');
      for (const [id, targets] of Object.entries(aliases)) {
        if (!strings(targets)) throw new Error('Invalid blacklist alias targets');
        legacySiteAliases[id] = targets;
      }
    }
    if (fields.unresolvedLegacySites !== undefined && !strings(fields.unresolvedLegacySites)) throw new Error('Invalid legacy blacklist records');
  }
  const blacklist: Blacklist = { sites: [...value.sites], parses: [...value.parses], lives: [...value.lives],
    regexRules: Array.isArray(fields.regexRules) ? [...fields.regexRules] : [],
    regexBlockOverrides: strings(fields.regexBlockOverrides) ? [...fields.regexBlockOverrides] : [],
    ...(fields.siteIdentityVersion === 2 ? { siteIdentityVersion: 2 as const, legacySiteAliases,
      unresolvedLegacySites: strings(fields.unresolvedLegacySites) ? [...fields.unresolvedLegacySites] : [] } : {}) };
  if (blacklist.siteIdentityVersion === 2) {
    // New non-JAR rows still use legacy-shaped fingerprints. Authorize only
    // those exact current rows; never bind an unresolved old JAR record anew.
    const fullRaw = await storage.get(MERGED_CONFIG_FULL);
    try {
      const full: TVBoxConfig | null = fullRaw ? JSON.parse(fullRaw) : null;
      if (full && Array.isArray(full.sites)) for (const site of full.sites) {
        if (effectiveSiteJar(site, full.spider)) continue;
        const id = await legacySiteFingerprint(site);
        if (!blacklist.unresolvedLegacySites?.includes(id)) {
          const aliases = blacklist.legacySiteAliases ||= {};
          if (!Object.prototype.hasOwnProperty.call(aliases, id)) aliases[id] = [id];
        }
      }
    } catch { /* No new alias can be established from damaged optional FULL. */ }
    return blacklist;
  }
  const aliases: Record<string, string[]> = Object.create(null);
  const fullRaw = await storage.get(MERGED_CONFIG_FULL);
  let full: TVBoxConfig | undefined;
  try {
    const parsed = fullRaw ? JSON.parse(fullRaw) : null;
    if (parsed && Array.isArray(parsed.sites)) full = parsed;
  } catch { /* Unknown old records are preserved, never rebound to a new global JAR. */ }
  if (full) for (const site of full.sites || []) {
    const old = await legacySiteFingerprint(site);
    const current = await siteFingerprint(site, full.spider);
    const ids = aliases[old] ||= [];
    if (!ids.includes(current)) ids.push(current);
  }
  const unresolved: string[] = [];
  const sites = new Set<string>();
  for (const id of blacklist.sites) {
    if (id.startsWith('j2:')) sites.add(id);
    else if (aliases[id]) aliases[id].forEach(current => sites.add(current));
    else unresolved.push(id);
  }
  const next: Blacklist = { ...blacklist, sites: [...sites], siteIdentityVersion: 2,
    legacySiteAliases: aliases, unresolvedLegacySites: unresolved };
  await saveBlacklist(storage, next);
  if (unresolved.length) logger.warn('blacklist', `保留 ${unresolved.length} 条无法确认原站点归属的旧屏蔽记录，未扩大匹配`);
  return next;
}

export async function loadBlacklist(storage: Storage): Promise<Blacklist> {
  const raw = await storage.get(BLACKLIST);
  // Ordinary reads do not occupy the mutation gate. Only a pending format
  // conversion needs a fresh read and write under it.
  if (raw && JSON.parse(raw)?.siteIdentityVersion === 2) return loadBlacklistUnlocked(storage, raw);
  return withSourceGate(storage, () => loadBlacklistUnlocked(storage));
}

export async function saveBlacklist(storage: Storage, blacklist: Blacklist): Promise<void> {
  await storage.put(BLACKLIST, JSON.stringify(blacklist));
}

export function mutateBlacklist<T>(storage: Storage, work: (blacklist: Blacklist) => T | Promise<T>): Promise<T> {
  return withSourceGate(storage, async () => {
    const blacklist = await loadBlacklistUnlocked(storage);
    const result = await work(blacklist);
    await saveBlacklist(storage, blacklist);
    return result;
  });
}

export class StaleSiteFingerprint extends Error {}
export function resolveSiteIds(blacklist: Blacklist, id: string): string[] {
  const aliases = blacklist.legacySiteAliases;
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, id)) return aliases[id];
  if (/^[a-f0-9]{16}$/i.test(id) || blacklist.unresolvedLegacySites?.includes(id)) {
    throw new StaleSiteFingerprint('站点信息已更新，请刷新页面后重试');
  }
  return [id];
}

/** Prune the latest value under the same gate as Admin mutations. */
export function pruneStoredBlacklist(storage: Storage, config: TVBoxConfig): Promise<Blacklist> {
  return mutateBlacklist(storage, async blacklist => {
    const pruned = await pruneBlacklist(blacklist, config);
    Object.assign(blacklist, pruned);
    return blacklist;
  });
}

const MAX_PATTERN_LENGTH = 200;

// ReDoS protection: reject patterns with nested quantifiers
// Matches: a quantified group containing a quantified element
// Catches: (a+)+, (a*)*, (a|b)+, (a+?)+, etc.
const NESTED_QUANTIFIER_RE = /\([^)]*[+*{][^)]*\)[+*{]/u;

/**
 * 验证正则模式（语法 + ReDoS 防护 + 长度限制）
 */
export function validateRegexPattern(pattern: string): RegexValidationResult {
  if (!pattern) {
    return { valid: false, error: '正则模式不能为空' };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, error: `正则模式长度不能超过${MAX_PATTERN_LENGTH}字符` };
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    return { valid: false, error: '正则语法无效' };
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return { valid: false, error: '正则包含嵌套量词，存在ReDoS风险' };
  }
  return { valid: true };
}

/**
 * 保存正则屏蔽规则（验证 + 持久化）
 */
export async function saveRegexRule(storage: Storage, pattern: string): Promise<{ success: boolean; rule?: RegexRule; error?: string }> {
  const validation = validateRegexPattern(pattern);
  if (!validation.valid) return { success: false, error: validation.error };
  return mutateBlacklist(storage, blacklist => {
    const rule: RegexRule = { id: crypto.randomUUID(), pattern, createdAt: new Date().toISOString() };
    blacklist.regexRules.push(rule);
    return { success: true, rule };
  });
}

/**
 * 删除正则屏蔽规则
 */
export async function deleteRegexRule(storage: Storage, ruleId: string): Promise<{ success: boolean; error?: string }> {
  return mutateBlacklist(storage, blacklist => {
    const index = blacklist.regexRules.findIndex(r => r.id === ruleId);
    if (index === -1) return { success: false, error: '规则不存在' };
    blacklist.regexRules.splice(index, 1);
    return { success: true };
  });
}

/**
 * 应用正则屏蔽过滤 sites（在指纹屏蔽之后执行，per D-02）
 * - 编译所有正则规则，跳过无效 pattern
 * - override 中的站点名不会被正则屏蔽
 */
function applyRegexFilter(
  sites: TVBoxSite[],
  regexRules: RegexRule[],
  regexBlockOverrides: string[],
): { sites: TVBoxSite[]; removedByRegex: number; removedItems: BlacklistRemovedItem[] } {
  if (regexRules.length === 0) {
    return { sites, removedByRegex: 0, removedItems: [] };
  }

  const overrideSet = new Set(regexBlockOverrides);

  // 预编译正则，跳过无效 pattern
  const compiled: RegExp[] = [];
  for (const rule of regexRules) {
    try {
      compiled.push(new RegExp(rule.pattern, 'u'));
    } catch {
      logger.warn('blacklist', 'Skipping invalid regex pattern: ' + rule.pattern);
    }
  }

  const filtered: TVBoxSite[] = [];
  let removedByRegex = 0;
  const removedItems: BlacklistRemovedItem[] = [];

  for (const site of sites) {
    const name = site.name || '';
    // D-04: override 中的站点绕过正则屏蔽
    if (overrideSet.has(name)) {
      filtered.push(site);
      continue;
    }
    let blocked = false;
    for (const re of compiled) {
      if (re.test(name)) {
        removedByRegex++;
        blocked = true;
        removedItems.push({
          kind: 'regex-site',
          key: site.key,
          name: site.name,
          url: site.api,
          pattern: re.source,
        });
        break;
      }
    }
    if (!blocked) {
      filtered.push(site);
    }
  }

  return { sites: filtered, removedByRegex, removedItems };
}

/**
 * 应用黑名单过滤 merged config
 * 返回过滤后的 config + 过滤统计
 */
export async function applyBlacklist(
  config: TVBoxConfig,
  blacklist: Blacklist,
): Promise<{ config: TVBoxConfig; removedSites: number; removedParses: number; removedLives: number; removedByRegex: number; removedItems: BlacklistRemovedItem[] }> {
  const siteSet = new Set(blacklist.sites);
  const parseSet = new Set(blacklist.parses);
  const liveSet = new Set(blacklist.lives);

  let removedSites = 0;
  let removedParses = 0;
  let removedLives = 0;
  const removedItems: BlacklistRemovedItem[] = [];

  // 过滤 sites
  let sites = config.sites || [];
  if (siteSet.size > 0) {
    const filtered: TVBoxSite[] = [];
    for (const site of sites) {
      const fp = await siteFingerprint(site, config.spider);
      if (siteSet.has(fp)) {
        removedSites++;
        removedItems.push({
          kind: 'site',
          key: site.key,
          name: site.name,
          url: site.api,
          fingerprint: fp,
        });
      } else {
        filtered.push(site);
      }
    }
    sites = filtered;
  }

  // 正则过滤 sites (after fingerprint, per D-02)
  let removedByRegex = 0;
  if (blacklist.regexRules.length > 0) {
    const regexResult = applyRegexFilter(sites, blacklist.regexRules, blacklist.regexBlockOverrides);
    sites = regexResult.sites;
    removedByRegex = regexResult.removedByRegex;
    removedItems.push(...regexResult.removedItems);
  }

  // 过滤 parses
  let parses = config.parses || [];
  if (parseSet.size > 0) {
    parses = parses.filter((p) => {
      if (parseSet.has(p.url)) {
        removedParses++;
        removedItems.push({
          kind: 'parse',
          name: p.name,
          url: p.url,
        });
        return false;
      }
      return true;
    });
  }

  // 过滤 lives
  let lives = config.lives || [];
  if (liveSet.size > 0) {
    lives = lives.filter((l) => {
      const url = l.url || l.api || '';
      if (url && liveSet.has(url)) {
        removedLives++;
        removedItems.push({
          kind: 'live',
          name: l.name,
          url,
        });
        return false;
      }
      return true;
    });
  }

  return {
    config: { ...config, sites, parses, lives },
    removedSites,
    removedParses,
    removedLives,
    removedByRegex,
    removedItems,
  };
}

/**
 * 生成导出快照配置：应用黑名单、直播策略、删除 pic 前缀，
 * URL 保持原始（不调用 rewriteJarUrls）。供 syncer Step 4.6.5 和 patchMergedConfig 共用 (D-03)。
 *
 * - D-01: 不调用 rewriteJarUrls，URL 保持原始
 * - D-02: 调用 applyBlacklist 复用黑名单过滤（与 MERGED_CONFIG 屏蔽状态一致）
 * - 快照只保存接口直播结果，手动地址由输出路由实时组合
 * - D-05: 删除 pic 字段
 * - D-06: 返回完整 TVBoxConfig 字段集，不引入 _meta
 *
 * @param merged       MERGED_CONFIG_FULL 解析后的完整配置（含原始 URL）
 * @param blacklist    当前黑名单
 * @param livePolicy   当前直播输出策略快照
 * @returns            导出快照 TVBoxConfig
 */
export async function generateExportConfig(
  merged: TVBoxConfig,
  blacklist: Blacklist,
  livePolicy: LivePolicy,
): Promise<TVBoxConfig> {
  const { config: filtered } = await applyBlacklist(merged, blacklist);

  const result = applyStoredLivePolicy(filtered, livePolicy);
  delete result.pic;
  return result;
}

/**
 * 即时应用黑名单 patch：
 *  - 从 MERGED_CONFIG_FULL 加载完整配置
 *  - 加载当前黑名单（含正则规则、白名单覆盖）
 *  - 调用 applyBlacklist 重新过滤
 *  - 调用 rewriteJarUrls 用 BASE_URL_PLACEHOLDER 重新改写 JAR 代理 URL（输出时由路由层替换为实际 host）
 *  - 写回 MERGED_CONFIG，并更新 LAST_UPDATE 时间戳
 *
 * 不发起任何网络 I/O（仅 storage.put/get + crypto.subtle.digest）。
 * MERGED_CONFIG_FULL 不存在时静默返回（不修改 MERGED_CONFIG）。
 *
 * @param storage  存储抽象
 *
 * 已知局限（D-05）：MERGED_CONFIG_FULL 在管道 Step 4.5 暂存、最后统一发布，patch 后的配置
 * 与完整聚合结果可能不同（例如名称变换 Step 5.5、凭证注入 Step 5.7、搜索配额
 * Step 4.7、空条目清理 Step 4.6、图片代理前缀 Step 7.5 等仍被跳过），下次完整聚合后恢复正常。
 */
export async function patchMergedConfig(storage: Storage): Promise<{ patched: boolean; reason?: string; warning?: string }> {
  const outputs = await readAggregateOutputs(storage);
  if (!outputs?.full) {
    logger.warn('blacklist', 'patchMergedConfig: MERGED_CONFIG_FULL is null, skipping');
    return { patched: false, reason: 'MERGED_CONFIG_FULL not available' };
  }
  const fullRaw = outputs.full;

  let full: TVBoxConfig;
  try {
    full = JSON.parse(fullRaw);
  } catch (e) {
    logger.error('blacklist', `patchMergedConfig: failed to parse MERGED_CONFIG_FULL, skipping: ${e instanceof Error ? e.message : String(e)}`);
    return { patched: false, reason: 'Failed to parse MERGED_CONFIG_FULL' };
  }

  const blacklist = await loadBlacklist(storage);
  const { config: blacklisted } = await applyBlacklist(full, blacklist);
  const livePolicy = outputs.livePolicy;
  const filtered = applyStoredLivePolicy(blacklisted, livePolicy);

  // Reapply JAR proxy URL rewrite with placeholder (mirrors sync Step 7)
  logger.info('blacklist', 'patchMergedConfig: reapplying JAR rewrite with placeholder');
  const result = await rewriteJarUrls(filtered, BASE_URL_PLACEHOLDER, storage);

  // D-03: 同步更新 EXPORT_CONFIG（含原始 URL，供 /admin/export-config 下载）
  // result 含改写后的代理 URL（写入 MERGED_CONFIG），exportConfig 含原始 URL（写入 EXPORT_CONFIG）
  const exportConfig = await generateExportConfig(full, blacklist, livePolicy);
  delete (exportConfig as TVBoxConfig).pic; // D-05: 删除图片代理前缀（防御性，generateExportConfig 已删）
  const patched = await publishAggregatePatch(storage, outputs.token, JSON.stringify(result), JSON.stringify(exportConfig));
  if (!patched) return { patched: false, reason: 'Aggregate output changed or became unavailable; retry after sync' };
  logger.infoFields('blacklist', 'export-config-patched', {
    sites: exportConfig.sites?.length || 0,
    parses: exportConfig.parses?.length || 0,
    lives: exportConfig.lives?.length || 0,
  });

  // Build warning string reflecting what was and wasn't reapplied
  const skipped = ['name transforms (Step 5.5)', 'credential injection (Step 5.7)', 'search quota (Step 4.7)', 'empty-entry cleanup (Step 4.6)', 'image proxy prefix (Step 7.5)'];
  const liveNote = livePolicy.disabled ? '; interface lives disabled; output uses current manual addresses' : '';
  return { patched: true, warning: `Instant patch reapplied blacklist + JAR rewrite${liveNote}. Skipped: ${skipped.join(', ')}; full sync will resolve differences` };
}

/**
 * 清理黑名单中已不存在的条目（防膨胀）
 * 对比当前 merged config 中的实际 fingerprint/url，移除过时的黑名单条目
 */
export async function pruneBlacklist(
  blacklist: Blacklist,
  currentConfig: TVBoxConfig,
): Promise<Blacklist> {
  // 收集当前所有 site fingerprint
  const currentSiteFps = new Set<string>();
  for (const site of currentConfig.sites || []) {
    currentSiteFps.add(await siteFingerprint(site, currentConfig.spider));
  }

  // 收集当前所有 parse url
  const currentParseUrls = new Set((currentConfig.parses || []).map(p => p.url));

  // 收集当前所有 live url
  const currentLiveUrls = new Set(
    (currentConfig.lives || []).map(l => l.url || l.api || '').filter(Boolean),
  );

  const prunedSites = blacklist.sites.filter(fp => currentSiteFps.has(fp));
  const prunedParses = blacklist.parses.filter(url => currentParseUrls.has(url));
  const prunedLives = blacklist.lives.filter(url => currentLiveUrls.has(url));

  const removed =
    (blacklist.sites.length - prunedSites.length) +
    (blacklist.parses.length - prunedParses.length) +
    (blacklist.lives.length - prunedLives.length);

  if (removed > 0) {
    logger.info('blacklist', `Pruned ${removed} stale entries`);
  }

  return {
    ...blacklist,
    sites: prunedSites,
    parses: prunedParses,
    lives: prunedLives,
    regexRules: blacklist.regexRules,
    regexBlockOverrides: blacklist.regexBlockOverrides,
  };
}
