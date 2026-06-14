// 同步流程编排

import type { Storage } from './storage/interface';
import type { AppConfig, SourceEntry, SourcedConfig, MacCMSSourceEntry, SourceFetchResult, SourceHealthRecord } from './core/types';
import { fetchConfigs } from './core/fetcher';
import { mergeConfigs, cleanLocalRefs, cleanEmptyEntries } from './core/merger';
import { batchSiteSpeedTest, appendSpeedToName, filterUnreachableSites } from './core/speedtest';
import { macCMSToTVBoxSites, processMacCMSForLocal } from './core/maccms';
import { rewriteJarUrls, rewriteNonJarUrls, parseSpiderString, collectAllSiteResources, downloadResource, writeResourceCache, urlToKey, sortResourcesByPriority, isMd5Key } from './core/jar-proxy';
import { mergeLivesToNative, type LiveSourceInput } from './core/live-merger';
import { loadSpeedMap as loadChannelSpeedMap } from './core/channel-probe';
import { MERGED_CONFIG, MERGED_CONFIG_FULL, SOURCE_URLS, LAST_UPDATE, MANUAL_SOURCES, MACCMS_SOURCES, LIVE_SOURCES, BLACKLIST, INLINE_PREFIX, NAME_TRANSFORM, SOURCE_HEALTH, SPEED_TEST_ENABLED, EDGE_PROXIES, SEARCH_QUOTA_REPORT, CHANNEL_MERGED_TREE, BASE_URL_PLACEHOLDER, LIVE_DISABLED, SYNC_STATUS } from './core/config';
import { loadBlacklist, applyBlacklist, pruneBlacklist, saveBlacklist } from './core/blacklist';
import { transformSiteNames } from './core/cleaner';
import { parseConfigJson, type FetchProxyConfig } from './core/fetcher';
import { scrapeSourceList, scrapeMacCMSSources, type ScrapeSourceConfig, type ScrapeMacCMSConfig } from './core/source-scraper';
import { loadSearchQuota, applySearchQuota } from './core/search-quota';
import { loadCredentials } from './core/credential-store';
import { loadCredentialPolicy } from './core/credential-store';
import { injectCredentials } from './core/credential-injector';
import { logger } from './core/logger';
import { getSiteResourceDir, siteIndexToDirName, getTmpSitesDir, cleanStaleTempDir, swapSiteDirectories, cleanupZombieFiles, cleanupOrphanedStaticSources } from './core/site-store';
import * as fs from 'fs';
import * as path from 'path';
import type { NameTransformConfig, EdgeProxyConfig } from './core/types';

export async function runSync(storage: Storage, config: AppConfig): Promise<void> {
  const startTime = Date.now();
  logger.infoFields('sync', 'run-start', {
    fetchTimeoutMs: config.fetchTimeoutMs,
    siteTimeoutMs: config.siteTimeoutMs,
    speedTimeoutMs: config.speedTimeoutMs,
  });

  try {
    await _runSync(storage, config, startTime);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : '';
    logger.error('sync', `FATAL ERROR: ${msg}`);
    logger.error('sync', `Stack: ${stack}`);
    // 写入错误信息方便调试
    await storage.put(LAST_UPDATE, `ERROR @ ${new Date().toISOString()}: ${msg}`);
    // D-12: 记录同步失败状态，不清空缓存
    try {
      await storage.put(SYNC_STATUS, JSON.stringify({
        success: false,
        timestamp: new Date().toISOString(),
        error: msg,
      }));
    } catch (statusErr) {
      logger.warn('sync', `Failed to record SYNC_STATUS failure: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`);
    }
    // D-06: 同步失败删除临时目录，确保现有缓存不受影响
    try {
      cleanStaleTempDir();
    } catch (cleanupErr) {
      logger.warn('sync', `Failed to clean temp directory after sync failure: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
  }
}

async function _runSync(storage: Storage, config: AppConfig, startTime: number): Promise<void> {
  let step71FailedCount = 0;

  // Step 0: 自动抓取源（需配置 SCRAPE_SOURCE_URL 环境变量）
  if (config.scrapeSourceUrl && config.scrapeSourceReferer) {
    logger.info('sync', 'Step 0: Auto-scraping sources...');
    try {
      const scrapeCfg: ScrapeSourceConfig = { url: config.scrapeSourceUrl, referer: config.scrapeSourceReferer };
      const scraped = await scrapeSourceList(scrapeCfg);
      if (scraped.length > 0) {
        const existingRaw = await storage.get(MANUAL_SOURCES);
        const existingSources: SourceEntry[] = existingRaw ? JSON.parse(existingRaw) : [];
        const existingUrls = new Set(existingSources.map(s => s.url));

        let added = 0;
        const addedSources: SourceEntry[] = [];
        for (const source of scraped) {
          if (!existingUrls.has(source.url)) {
            existingSources.push(source);
            existingUrls.add(source.url);
            added++;
            addedSources.push(source);
          }
        }

        if (added > 0) {
          await storage.put(MANUAL_SOURCES, JSON.stringify(existingSources));
          logger.infoFields('sync', 'auto-scrape-added', { added, total: existingSources.length });
          addedSources.forEach((source, index) => logger.infoFields('sync', 'auto-scrape-source', {
            index: index + 1,
            name: source.name,
            url: source.url,
            added: true,
          }));
        } else {
          logger.infoFields('sync', 'auto-scrape-none-added', { scraped: scraped.length, reason: 'all_exist' });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('sync', `Auto-scrape failed (non-blocking): ${msg}`);
    }
  }

  // Step 0.5: MacCMS 资源站自动抓取（需配置 MACCMS_API_URL 环境变量）
  if (config.maccmsApiUrl && config.maccmsAesKey && config.maccmsAesIv) {
    logger.info('sync', 'Step 0.5: Auto-scraping MacCMS sources...');
    try {
      const maccmsCfg: ScrapeMacCMSConfig = { apiUrl: config.maccmsApiUrl, aesKey: config.maccmsAesKey, aesIv: config.maccmsAesIv };
      const scraped = await scrapeMacCMSSources(maccmsCfg);
      if (scraped.length > 0) {
        await storage.put(MACCMS_SOURCES, JSON.stringify(scraped));
        logger.infoFields('sync', 'maccms-auto-scraped', { count: scraped.length });
        scraped.forEach((source, index) => logger.infoFields('sync', 'maccms-auto-source', {
          index: index + 1,
          key: source.key,
          name: source.name,
          api: source.api,
        }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('sync', `MacCMS auto-scrape failed (non-blocking): ${msg}`);
    }
  }

  // Step 1: 读取手动配置的源（含自动抓取合并后的）
  logger.info('sync', 'Step 1: Loading sources...');
  const raw = await storage.get(MANUAL_SOURCES);
  const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

  // 检查是否有 MacCMS 源（即使没有 config 源也可以继续）
  const macCMSRaw = await storage.get(MACCMS_SOURCES);
  const hasMacCMS = macCMSRaw ? JSON.parse(macCMSRaw).length > 0 : false;

  if (sources.length === 0 && !hasMacCMS) {
    logger.warn('sync', 'No sources configured, nothing to do');
    return;
  }

  logger.infoFields('sync', 'config-sources-loaded', { count: sources.length });
  sources.forEach((source, index) => {
    logger.infoFields('sync', 'config-source', {
      index: index + 1,
      name: source.name,
      url: source.url,
      kind: source.url.startsWith('inline://') ? 'inline' : 'remote',
      key: source.configKey ? 'present' : 'none',
    });
  });
  await storage.put(SOURCE_URLS, JSON.stringify(sources));

  // Step 1.5: 处理 MacCMS 源
  logger.info('sync', 'Step 1.5: Processing MacCMS sources...');
  const macCMSConfigs = await processMacCMSSources(storage, config);

  // Step 1.6: 直播源频道级合并移至 Step 6.5（方案 D+）

  // Step 1.8: 分离 inline:// 源，从 KV 直接加载
  const remoteSources = sources.filter(s => !s.url.startsWith('inline://'));
  const inlineSources = sources.filter(s => s.url.startsWith('inline://'));
  const inlineConfigs: SourcedConfig[] = [];
  logger.infoFields('sync', 'source-split', {
    remote: remoteSources.length,
    inline: inlineSources.length,
  });

  for (const src of inlineSources) {
    const kvKey = src.url.replace('inline://', '');
    const raw = await storage.get(kvKey);
    if (raw) {
      const parsed = parseConfigJson(raw);
      if (parsed.ok) {
        inlineConfigs.push({ sourceUrl: src.url, sourceName: src.name || 'Inline', config: parsed.config! });
        logger.infoFields('sync', 'inline-loaded', {
          name: src.name || 'Inline',
          key: kvKey,
          sites: parsed.config!.sites?.length || 0,
          parses: parsed.config!.parses?.length || 0,
          lives: parsed.config!.lives?.length || 0,
        });
      } else {
        logger.warnFields('sync', 'inline-parse-failed', {
          name: src.name,
          key: kvKey,
          errorCategory: parsed.errorCategory,
          message: parsed.message,
        });
      }
    } else {
      logger.warnFields('sync', 'inline-missing', { name: src.name, key: kvKey });
    }
  }

  // Step 2: 批量 fetch 配置 JSON（本地模式可通过边缘代理回退）
  logger.info('sync', 'Step 2: Fetching configs...');
  let proxyConfig: FetchProxyConfig | undefined;
  // 读取边缘代理配置
  const edgeRaw = await storage.get(EDGE_PROXIES);
  if (edgeRaw) {
    const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
    const urls: string[] = [];
    if (edge.fetchProxy) urls.push(`${edge.fetchProxy}/fetch-proxy`);
    if (edge.vercel) urls.push(`${edge.vercel}/api/proxy`);
    if (urls.length > 0) {
      proxyConfig = { urls, token: config.adminToken };
      logger.info('sync', `Edge proxies configured: ${urls.join(', ')}`);
    }
  }
  const { configs: sourcedConfigs, fetchResults } = await fetchConfigs(remoteSources, config.fetchTimeoutMs, proxyConfig);
  fetchResults.forEach((result) => {
    logger.infoFields('sync', 'fetch-result', {
      name: result.name,
      url: result.url,
      status: result.status,
      speedMs: result.speedMs,
      error: result.errorMessage,
    });
  });

  // D-04: 详细记录验证失败信息（非 verbose 模式可见）
  fetchResults.filter(r => r.validationError).forEach(result => {
    const ve = result.validationError!;
    logger.infoFields('sync', 'source-validation-error', {
      name: result.name,
      url: result.url,
      errorCategory: ve.errorCategory,
      message: ve.message,
      preview: ve.preview,
    });
  });

  // 更新源健康状态
  await updateSourceHealth(storage, fetchResults);

  if (sourcedConfigs.length === 0 && inlineConfigs.length === 0 && macCMSConfigs.length === 0) {
    logger.warn('sync', 'No valid configs fetched and no MacCMS/inline sources, keeping previous cache');
    return;
  }

  // Step 3: 用 fetch 耗时筛选配置源
  let filteredConfigs: SourcedConfig[] = sourcedConfigs;

  const configsWithSpeed = sourcedConfigs.filter((c) => c.speedMs != null);
  if (configsWithSpeed.length > 0) {
    logger.info('sync', 'Step 3: Filtering configs by fetch speed...');
    filteredConfigs = sourcedConfigs.filter((c) => {
      if (c.speedMs == null) {
        logger.infoFields('sync', 'speed-filter-keep', {
          name: c.sourceName,
          url: c.sourceUrl,
          reason: 'no_speed_data',
        });
        return true;
      }
      if (c.speedMs <= config.speedTimeoutMs) {
        logger.infoFields('sync', 'speed-filter-keep', {
          name: c.sourceName,
          url: c.sourceUrl,
          speedMs: c.speedMs,
          thresholdMs: config.speedTimeoutMs,
        });
        return true;
      }
      logger.infoFields('sync', 'speed-filter-remove', {
        name: c.sourceName,
        url: c.sourceUrl,
        speedMs: c.speedMs,
        thresholdMs: config.speedTimeoutMs,
      });
      return false;
    });

    if (filteredConfigs.length === 0) {
      logger.warn('sync', 'All configs failed speed filter, using all fetched configs');
      filteredConfigs = sourcedConfigs;
    } else {
      logger.info('sync', `${filteredConfigs.length}/${sourcedConfigs.length} configs passed speed filter`);
    }
  } else {
    logger.info('sync', 'Step 3: No speed data available, skipping filter');
  }

  // Step 4: 合并（包含 MacCMS 源，投票制 spider 分配）
  logger.info('sync', 'Step 4: Merging configs...');
  const allConfigs = [...filteredConfigs, ...inlineConfigs, ...macCMSConfigs];
  logger.infoFields('sync', 'merge-inputs', {
    remote: filteredConfigs.length,
    inline: inlineConfigs.length,
    maccms: macCMSConfigs.length,
    total: allConfigs.length,
  });
  allConfigs.forEach((source, index) => logger.infoFields('sync', 'merge-source', {
    index: index + 1,
    name: source.sourceName,
    url: source.sourceUrl,
    sites: source.config.sites?.length || 0,
    parses: source.config.parses?.length || 0,
    lives: source.config.lives?.length || 0,
  }));
  const mergeResult = mergeConfigs(allConfigs);
  let merged = mergeResult.config;
  logger.infoFields('sync', 'merge-output', configCounts(merged));

  // Step 4.5: 黑名单过滤
  logger.info('sync', 'Step 4.5: Applying blacklist...');
  const blacklist = await loadBlacklist(storage);
  const hasBlacklist = blacklist.sites.length > 0 || blacklist.parses.length > 0 || blacklist.lives.length > 0 || blacklist.regexRules.length > 0;
  logger.infoFields('sync', 'blacklist-inventory', {
    sites: blacklist.sites.length,
    parses: blacklist.parses.length,
    lives: blacklist.lives.length,
    regexRules: blacklist.regexRules.length,
    overrides: blacklist.regexBlockOverrides.length,
  });

  // 保存过滤前的完整配置（供配置编辑器显示已屏蔽项）
  await storage.put(MERGED_CONFIG_FULL, JSON.stringify(merged));

  if (hasBlacklist) {
    // 自动清理黑名单中已不存在的条目（必须在过滤前比对，否则被屏蔽的条目会被误判为"过时"而清掉）
    const pruned = await pruneBlacklist(blacklist, merged);
    if (JSON.stringify(pruned) !== JSON.stringify(blacklist)) {
      await saveBlacklist(storage, pruned);
      logger.infoFields('sync', 'blacklist-pruned', {
        sitesBefore: blacklist.sites.length,
        sitesAfter: pruned.sites.length,
        parsesBefore: blacklist.parses.length,
        parsesAfter: pruned.parses.length,
        livesBefore: blacklist.lives.length,
        livesAfter: pruned.lives.length,
      });
    }

    const { config: filtered, removedSites, removedParses, removedLives, removedByRegex, removedItems } = await applyBlacklist(merged, pruned);
    merged = filtered;
    removedItems.forEach((item) => logger.infoFields('sync', 'blacklist-removed-item', {
      kind: item.kind,
      key: item.key,
      name: item.name,
      url: item.url,
      fingerprint: item.fingerprint,
      pattern: item.pattern,
    }));
    if (removedByRegex > 0) {
      logger.info('sync', `Blacklist removed: ${removedSites} sites, ${removedParses} parses, ${removedLives} lives; regex removed ${removedByRegex} sites`);
    } else {
      logger.info('sync', `Blacklist removed: ${removedSites} sites, ${removedParses} parses, ${removedLives} lives`);
    }
  } else {
    logger.info('sync', 'Step 4.5: No blacklist entries, skipping');
  }

  // Step 4.6: 清洗无效数据（空条目 + 本地引用）— 必须在搜索配额前，避免配额分给随后被清理的站点
  logger.info('sync', 'Step 4.6: Cleaning invalid entries...');
  const beforeClean = configCounts(merged);
  merged = cleanEmptyEntries(merged);
  merged = cleanLocalRefs(merged);
  logger.infoFields('sync', 'cleanup-complete', {
    ...beforeAfterCounts(beforeClean, configCounts(merged)),
  });

  // Step 4.7: 搜索配额（JS 排除 + 置顶排序 + 可选截断）
  const quotaConfig = await loadSearchQuota(storage);
  if (merged.sites) {
    const { sites: quotaSites, quotaReport } = applySearchQuota(merged.sites, quotaConfig);
    merged.sites = quotaSites;
    logger.infoFields('sync', 'search-quota-complete', {
      totalSites: quotaReport.totalSites,
      jsExcluded: quotaReport.jsExcluded,
      pinned: quotaReport.pinnedCount,
      truncated: quotaReport.truncated,
      searchable: quotaReport.searchable,
    });
    await storage.put(SEARCH_QUOTA_REPORT, JSON.stringify({
      updatedAt: new Date().toISOString(),
      ...quotaReport,
    }));
  }

  // Step 5.5: 名称定制（前缀后缀）
  const ntRaw = await storage.get(NAME_TRANSFORM);
  const nameTransform: NameTransformConfig = ntRaw ? JSON.parse(ntRaw) : {};
  if (nameTransform.prefix || nameTransform.suffix) {
    logger.infoFields('sync', 'name-transform-start', {
      prefix: Boolean(nameTransform.prefix),
      suffix: Boolean(nameTransform.suffix),
      sites: merged.sites?.length || 0,
    });
    merged = transformSiteNames(merged, nameTransform);
  }

  // Step 5.7: 网盘凭证注入
  const credentials = await loadCredentials(storage);
  if (credentials.size > 0 && merged.sites && merged.sites.length > 0) {
    logger.infoFields('sync', 'credential-injection-start', {
      credentials: credentials.size,
      sites: merged.sites.length,
    });
    const credentialPolicy = await loadCredentialPolicy(storage);
    const { sites: injectedSites, report: injReport } = injectCredentials(
      merged.sites, credentials, credentialPolicy, BASE_URL_PLACEHOLDER,
    );
    merged.sites = injectedSites;
    logger.infoFields('sync', 'credential-injection-complete', {
      injected: injReport.injected,
      skippedSafe: injReport.skippedSafe,
      skippedHighRisk: injReport.skippedHighRisk,
      skippedUnaudited: injReport.skippedUnaudited,
      skippedNoRule: injReport.skippedNoRule,
      skippedNoCredential: injReport.skippedNoCredential,
    });
  } else {
    logger.info('sync', 'Step 5.7: No cloud credentials configured, skipping');
  }

  // Step 6: 站点测速 + 不可达过滤 + name 标记
  const speedTestRaw = await storage.get(SPEED_TEST_ENABLED);
  const speedTestEnabled = speedTestRaw !== 'false'; // 默认启用

  if (!speedTestEnabled) {
    logger.info('sync', 'Step 6: Speed test disabled, skipping');
  } else if (merged.sites && merged.sites.length > 0) {
    logger.infoFields('sync', 'site-speed-start', {
      sites: merged.sites.length,
      timeoutMs: config.siteTimeoutMs,
    });
    const speedMap = await batchSiteSpeedTest(merged.sites, config.siteTimeoutMs);

    if (speedMap.size > 0) {
      // 过滤不可达站点（含安全阀）
      const { sites: filteredSites, filtered } = filterUnreachableSites(merged.sites, speedMap);
      merged.sites = filteredSites;
      logger.infoFields('sync', 'site-speed-filter-complete', {
        tested: speedMap.size,
        filtered,
        remaining: merged.sites.length,
      });

      // 追加延迟标签到站点名称
      merged.sites = appendSpeedToName(merged.sites, speedMap);
    }
  } else {
    logger.info('sync', 'Step 6: No sites to test');
  }

  // Step 6.5: 直播源频道级合并（方案 D+）
  logger.info('sync', 'Step 6.5: Channel-level live merging...');
  {
    // 检查直播功能禁用开关
    const liveDisabledRaw = await storage.get(LIVE_DISABLED);
    const liveDisabled = liveDisabledRaw !== 'false';
    if (liveDisabled) {
      logger.info('sync', 'Step 6.5: live_disabled=true, skipping live merge and clearing lives');
      merged.lives = [];
    } else {
    const liveInputs: LiveSourceInput[] = [];

    // 配置源合并来的 lives（FongMi 格式）
    for (const l of (merged.lives || []) as Array<{ name?: string; url?: string; api?: string; ua?: string; header?: Record<string, string>; group?: string }>) {
      // 跳过已经是 Native 格式的（含 group 字段无 url）
      if (l.group && !l.url && !l.api) continue;
      const u = l.url || l.api;
      if (!u || !/^https?:\/\//i.test(u)) continue;
      if (u.includes('127.0.0.1') || u.includes('localhost')) continue;
      liveInputs.push({
        name: l.name || 'source',
        url: u,
        ua: l.ua,
        header: l.header,
      });
    }

    // admin 手动源
    const liveRaw = await storage.get(LIVE_SOURCES);
    if (liveRaw) {
      try {
        const manual: Array<{ name: string; url: string }> = JSON.parse(liveRaw);
        for (const m of manual) {
          if (!m.url || !/^https?:\/\//i.test(m.url)) continue;
          if (m.url.includes('127.0.0.1') || m.url.includes('localhost')) continue;
          liveInputs.push({ name: m.name || 'manual', url: m.url });
        }
      } catch {
        /* ignore */
      }
    }

    // URL 去重
    const seen = new Set<string>();
    const uniqueInputs = liveInputs.filter((i) => {
      if (seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    });

    if (uniqueInputs.length === 0) {
      logger.info('sync', 'Step 6.5: No live sources to merge');
      merged.lives = [];
    } else {
      logger.infoFields('sync', 'live-merge-inputs', { unique: uniqueInputs.length });
      uniqueInputs.forEach((input, index) => logger.infoFields('sync', 'live-source', {
        index: index + 1,
        name: input.name,
        url: input.url,
        ua: input.ua ? 'present' : 'none',
        header: input.header ? 'present' : 'none',
      }));

      // 加载频道级测速缓存（仅 Node/Docker 有）
      const channelSpeedMap = await loadChannelSpeedMap(storage);

      const mergeResult = await mergeLivesToNative(uniqueInputs, config.fetchTimeoutMs, channelSpeedMap);
      merged.lives = mergeResult.groups;

      // 保存合并树供 channel-probe 使用
      await storage.put(CHANNEL_MERGED_TREE, JSON.stringify(mergeResult.groups));

      logger.infoFields('sync', 'live-merge-complete', {
        sourcesDownloaded: mergeResult.sourcesDownloaded,
        sourcesTotal: uniqueInputs.length,
        groups: mergeResult.groups.length,
        channels: mergeResult.totalChannels,
        urls: mergeResult.totalUrls,
      });
    }
    } // end of else (liveDisabled=false)
  }

  // Step 6.8: Build JAR URL → source index map
  const jarSourceIndexMap = new Map<string, number>();
  if (merged.sites) {
    for (const site of merged.sites) {
      if (site.jar) {
        const parsed = parseSpiderString(site.jar);
        if (parsed.url.startsWith('http://') || parsed.url.startsWith('https://')) {
          if (!jarSourceIndexMap.has(parsed.url)) {
            jarSourceIndexMap.set(parsed.url, jarSourceIndexMap.size);
          }
        }
      }
    }
  }

  // Step 7: JAR URL 改写
  logger.info('sync', 'Step 7: Rewriting JAR URLs for proxy (placeholder)...');
  const beforeJar = configCounts(merged);
  merged = await rewriteJarUrls(merged, BASE_URL_PLACEHOLDER, storage, jarSourceIndexMap);
  logger.infoFields('sync', 'jar-rewrite-complete', {
    ...beforeJar,
    placeholder: BASE_URL_PLACEHOLDER,
    spider: merged.spider ? 'present' : 'none',
  });

  // Step 7.1: 预下载静态资源（JAR/JS/PY/JSON/TXT）到临时目录，按 spider 优先级排序
  // 流程：清理旧临时目录 → 创建新临时目录 → 排序 → 逐项 TTL 检查（命中则从 live 目录复制）或下载
  logger.info('sync', 'Step 7.1: Downloading static resources...');
  if (merged.sites && merged.sites.length > 0) {
    // D-05/D-06: 清理上次崩溃可能残留的临时目录，避免 EEXIST 或部分状态污染
    cleanStaleTempDir();
    fs.mkdirSync(getTmpSitesDir(), { recursive: true });

    const resources = collectAllSiteResources(merged.sites, merged.parses);
    // D-01/D-02: spider JAR 优先下载
    const sorted = sortResourcesByPriority(resources, merged.spider);

    if (sorted.length > 0) {
      logger.infoFields('sync', 'static-resources-found', { count: sorted.length });
      const downloadTimeout = config.fetchTimeoutMs || 10000;
      let downloaded = 0;
      let failed = 0;
      let copiedFromLive = 0;

      for (const { url, type } of sorted) {
        let key: string | null = null;

        if (type === 'jar') {
          const parsed = parseSpiderString(url);
          key = parsed.md5 || (await urlToKey(url));
        } else {
          key = await urlToKey(url);
        }

        if (!key) {
          failed++;
          continue;
        }

        let resourceIndex = 0;
        if (type === 'jar') {
          const jarSourceRaw = await storage.get(`jar-source:${key}`);
          if (jarSourceRaw) {
            try { resourceIndex = JSON.parse(jarSourceRaw).index; } catch { /* ignore */ }
          } else {
            const siteIdx = merged.sites.findIndex(s =>
              s.jar && parseSpiderString(s.jar).url === url
            );
            resourceIndex = siteIdx >= 0 ? siteIdx : 0;
          }
        } else {
          // 非 JAR 资源：优先从 static-source KV 获取 index
          const staticSourceRaw = await storage.get(`static-source:${key}`);
          if (staticSourceRaw) {
            try { resourceIndex = JSON.parse(staticSourceRaw).index; } catch { /* ignore */ }
          }
          // KV 中也没有时，从 resources 数组的原始位置确定 index
          if (!staticSourceRaw) {
            const originalIdx = resources.findIndex(r => r.url === url);
            if (originalIdx >= 0 && originalIdx < merged.sites.length) {
              resourceIndex = originalIdx;
            }
            // 如果还没找到，保持 resourceIndex = 0 作为最后兜底（但不应发生）
          }
        }

        // 计算临时目录下的目标路径：data/.tmp-sites/{index}/{type}/
        const tmpDir = path.join(getTmpSitesDir(), siteIndexToDirName(resourceIndex), type);
        fs.mkdirSync(tmpDir, { recursive: true });

        // D-07: TTL 检查 live 目录中是否已有有效缓存文件
        // MD5 key → 24h，URL hash key → 6h
        const liveDir = getSiteResourceDir(resourceIndex, type);
        const liveFilePath = findCacheFile(liveDir, key);
        const md5Key = isMd5Key(key);
        const ttlMs = md5Key ? 86_400_000 : 21_600_000;

        if (liveFilePath && isCacheFileValid(liveFilePath, ttlMs)) {
          // 命中且未过期：从 live 目录复制到临时目录，避免重复下载
          try {
            const fileName = path.basename(liveFilePath);
            fs.copyFileSync(liveFilePath, path.join(tmpDir, fileName));
            copiedFromLive++;
            logger.infoFields('sync', 'resource-copied-from-live', {
              type,
              key,
              site: resourceIndex + 1,
              fileName,
            });
            // 静态资源 KV 映射在首次写入时已落库，复制场景无需重写
            continue;
          } catch (copyErr) {
            // 复制失败 → 回退到下载路径
            logger.warn('sync', `Failed to copy valid cache ${key}: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}, falling back to download`);
          }
        }

        // 缓存未命中或 TTL 过期：从远程下载
        try {
          const data = await downloadResource(url, downloadTimeout);
          if (!data) {
            failed++;
            logger.warn('sync', `Failed to download ${type}: ${url.substring(0, 60)}...`);
            continue;
          }

          // 写入临时目录 + 写 KV 映射（KV 中包含原始 URL，供 /static/:key/:type 兜底）
          // CR-03: 单项写入失败不应中断整个 sync —— 包在 try/catch 内隔离错误
          try {
            await writeResourceCache(key, data, tmpDir, url, storage, resourceIndex, type);
            downloaded++;
          } catch (writeErr) {
            failed++;
            logger.warn('sync', `Failed to write resource ${type} ${key}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
            continue;
          }

          logger.infoFields('sync', 'resource-downloaded', {
            type,
            key,
            sizeKB: (data.length / 1024).toFixed(1),
            site: resourceIndex + 1,
          });
        } catch (downloadErr) {
          // 防御性：downloadResource 已经内部 catch 返回 null，但 fetch 抛出未预期异常时仍兜底
          failed++;
          logger.warn('sync', `Unexpected error downloading ${type} ${key}: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`);
          continue;
        }
      }

      logger.infoFields('sync', 'static-resource-download-complete', { downloaded, copiedFromLive, failed, total: sorted.length });
      step71FailedCount = failed;
    } else {
      logger.info('sync', 'Step 7.1: No static resources found');
    }
  } else {
    logger.info('sync', 'Step 7.1: No sites to scan');
  }

  // Step 7.1.5: 改写非 JAR 静态资源 URL 为本地代理地址
  // 对 site.api/site.ext/parse.url/parse.ext 中的 JS/PY/JSON/TXT URL
  // 改写为 {baseUrl}/static/{key}/{type}，并写入 static-source KV 映射
  logger.info('sync', 'Step 7.1.5: Rewriting non-JAR resource URLs...');
  merged = await rewriteNonJarUrls(merged, BASE_URL_PLACEHOLDER, storage);

  // 清理已删除站点的 static-source KV 条目，确保僵尸文件清理正确
  await cleanupOrphanedStaticSources(storage, merged);

  // Step 7.2: 原子交换临时目录到正式目录（D-05, CR-01/CR-05）
  // 新实现使用 rename-to-backup 模式：sites/ 在任一时刻都以旧名或新名存在，
  // 消除了之前 delete-then-rename 之间的 ~1ms 窗口（路由 mkdirSync 可能竞争重建 sites/）。
  // 若 tmp->sites rename 失败，会自动从 backup 恢复后再抛出。
  logger.info('sync', 'Step 7.2: Atomic swap temp directory to live...');
  swapSiteDirectories();

  // Step 7.3: 清理僵尸文件（D-10）
  // 以 jar-source:* 和 static-source:* KV 键集合为白名单，删除不在白名单的文件
  logger.info('sync', 'Step 7.3: Cleaning zombie files...');
  await cleanupZombieFiles(storage);

  // Step 7.5: 注入图片代理前缀（本地模式用边缘代理）
  const edgeRaw2 = await storage.get(EDGE_PROXIES);
  if (edgeRaw2) {
    const edge: EdgeProxyConfig = JSON.parse(edgeRaw2);
    if (edge.fetchProxy) {
      merged.pic = `${edge.fetchProxy.replace(/\/$/, '')}/img/`;
      logger.infoFields('sync', 'pic-proxy-injected', { pic: merged.pic });
    }
  }

  // Step 8: 存入存储
  const mergedJson = JSON.stringify(merged);
  await storage.put(MERGED_CONFIG, mergedJson);
  await storage.put(LAST_UPDATE, new Date().toISOString());
  logger.infoFields('sync', 'storage-write-complete', {
    key: MERGED_CONFIG,
    bytes: Buffer.byteLength(mergedJson, 'utf8'),
    ...configCounts(merged),
  });

  // Step 9: 记录同步成功状态（D-12）
  // 旧的 organizeSiteDirectories 步骤已被原子交换取代：临时目录在下载阶段已建好正确的结构
  logger.info('sync', 'Step 9: Recording sync success status...');
  await storage.put(SYNC_STATUS, JSON.stringify({
    success: true,
    timestamp: new Date().toISOString(),
    lastSyncMs: Date.now() - startTime,
    downloadFailed: step71FailedCount,
  }));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.infoFields('sync', 'run-complete', {
    elapsedSeconds: elapsed,
    ...configCounts(merged),
  });
}

/**
 * 处理 MacCMS 源：
 * - 本地版：并发验证 + 过滤不可达站点 + 收集延迟
 */
async function processMacCMSSources(
  storage: Storage,
  config: AppConfig,
): Promise<SourcedConfig[]> {
  const raw = await storage.get(MACCMS_SOURCES);
  const entries: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];

  if (entries.length === 0) {
    logger.info('sync', 'No MacCMS sources configured');
    return [];
  }

  logger.infoFields('sync', 'maccms-sources-found', { count: entries.length });
  entries.forEach((entry, index) => logger.infoFields('sync', 'maccms-source', {
    index: index + 1,
    key: entry.key,
    name: entry.name,
    api: entry.api,
  }));

  let validEntries: MacCMSSourceEntry[];
  let speedMap: Map<string, number> | undefined;

  const edgeProxiesRaw = await storage.get(EDGE_PROXIES);

  if (edgeProxiesRaw) {
    // 有 edge proxy：跳过验证，运行时代理兜底
    logger.info('sync', 'Skipping MacCMS validation (edge proxy configured)');
    validEntries = entries;
  } else {
    // 本地版无 edge proxy：并发验证，过滤不可达站点
    logger.info('sync', 'Local mode (no edge proxy): validating MacCMS sources...');
    const result = await processMacCMSForLocal(entries, config.siteTimeoutMs);
    validEntries = result.passed;
    speedMap = result.speedMap;
  }

  if (validEntries.length === 0) {
    logger.warn('sync', 'No valid MacCMS sources after processing');
    return [];
  }

  const sites = macCMSToTVBoxSites(validEntries, BASE_URL_PLACEHOLDER, speedMap);
  logger.infoFields('sync', 'maccms-converted', { sites: sites.length });

  return [{
    sourceUrl: 'maccms://builtin',
    sourceName: 'MacCMS Sources',
    config: { sites },
  }];
}

/**
 * 更新源健康状态：读取历史 → merge 本次 fetch 结果 → 写回
 */
async function updateSourceHealth(storage: Storage, fetchResults: SourceFetchResult[]): Promise<void> {
  if (fetchResults.length === 0) return;

  const now = new Date().toISOString();

  // 读取历史健康记录
  const raw = await storage.get(SOURCE_HEALTH);
  const oldRecords: SourceHealthRecord[] = raw ? JSON.parse(raw) : [];
  const oldMap = new Map(oldRecords.map(r => [r.url, r]));

  // 本次参与 fetch 的 URL 集合
  const fetchedUrls = new Set(fetchResults.map(r => r.url));

  // Merge 逻辑
  const newRecords: SourceHealthRecord[] = [];

  for (const fr of fetchResults) {
    const old = oldMap.get(fr.url);

    if (fr.status === 'ok') {
      newRecords.push({
        url: fr.url,
        name: fr.name,
        latestStatus: 'ok',
        consecutiveFailures: 0,
        lastSuccessTime: now,
        lastFailTime: old?.lastFailTime,
        lastFailReason: old?.lastFailReason,
        lastSpeedMs: fr.speedMs,
      });
    } else {
      newRecords.push({
        url: fr.url,
        name: fr.name,
        latestStatus: fr.status,
        consecutiveFailures: (old?.consecutiveFailures ?? 0) + 1,
        lastSuccessTime: old?.lastSuccessTime,
        lastFailTime: now,
        lastFailReason: fr.errorMessage,
        lastSpeedMs: old?.lastSpeedMs,
      });
    }
  }

  // 保留未参与本次 fetch 的历史记录（源可能被临时排除但还在列表中）
  // 但已被用户删除的源不应保留——这由 fetchResults 只包含当前源列表来保证
  // 如果老记录的 URL 不在本次 fetch 中，丢弃（源已被删除）
  // 注：inline:// 源不经过 fetcher，不会出现在 fetchResults 中，也不需要追踪

  const failCount = newRecords.filter(r => r.consecutiveFailures > 0).length;
  if (failCount > 0) {
    logger.info('sync', `Source health: ${newRecords.length - failCount} ok, ${failCount} failing`);
  }

  await storage.put(SOURCE_HEALTH, JSON.stringify(newRecords));
}

function configCounts(config: { sites?: unknown[]; parses?: unknown[]; lives?: unknown[] }): {
  sites: number;
  parses: number;
  lives: number;
} {
  return {
    sites: config.sites?.length || 0,
    parses: config.parses?.length || 0,
    lives: config.lives?.length || 0,
  };
}

/**
 * 在目录中查找以 `{key}-` 开头的缓存文件（用于 TTL 检查）。
 * 找不到时返回 null，扫描错误也返回 null（非致命）。
 */
function findCacheFile(dir: string, key: string): string | null {
  try {
    const files = fs.readdirSync(dir);
    const prefix = key + '-';
    const match = files.find(f => f.startsWith(prefix));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

/**
 * 检查缓存文件是否仍在 TTL 窗口内（D-07）。
 * MD5 key → 24h，URL hash key → 6h，由调用方传入 ttlMs。
 */
function isCacheFileValid(filePath: string, ttlMs: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

function beforeAfterCounts(
  before: ReturnType<typeof configCounts>,
  after: ReturnType<typeof configCounts>,
): Record<string, number> {
  return {
    sitesBefore: before.sites,
    sitesAfter: after.sites,
    parsesBefore: before.parses,
    parsesAfter: after.parses,
    livesBefore: before.lives,
    livesAfter: after.lives,
  };
}
