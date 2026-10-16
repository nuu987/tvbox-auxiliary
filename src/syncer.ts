// 同步流程编排

import type { Storage } from './storage/interface';
import type { AppConfig, SourceEntry, SourcedConfig, MacCMSSourceEntry, SourceFetchResult, SourceHealthRecord, TVBoxConfig, SyncResult } from './core/types';
import { fetchConfigs } from './core/fetcher';
import { classifyStatus } from './core/status-classifier';
import { mergeConfigs, cleanLocalRefs, cleanEmptyEntries } from './core/merger';
import { macCMSToTVBoxSites, processMacCMSForLocal } from './core/maccms';
import { createJarResourcePlan, rewriteJarUrls, rewriteNonJarUrls, parseSpiderString, collectAllSiteResources, downloadResource, writeResourceCache, urlToKey, sortResourcesByPriority, isMd5Key } from './core/jar-proxy';
import { refreshLiveCache, pruneLiveCache, liveCacheProviders } from './core/live-cache';
import { supportedLives, liveAddress } from './core/live-source';
import { MERGED_CONFIG, MANUAL_SOURCES, MACCMS_SOURCES, BLACKLIST, INLINE_PREFIX, NAME_TRANSFORM, SOURCE_HEALTH, EDGE_PROXIES, SEARCH_QUOTA_REPORT, BASE_URL_PLACEHOLDER } from './core/config';
import { loadLivePolicy } from './core/live-policy';
import { loadBlacklist, applyBlacklist, pruneStoredBlacklist, generateExportConfig } from './core/blacklist';
import { transformSiteNames } from './core/cleaner';
import { parseConfigJson } from './core/fetcher';
import { scrapeSourceList, scrapeMacCMSSources, type ScrapeSourceConfig, type ScrapeMacCMSConfig } from './core/source-scraper';
import { loadSearchQuota, applySearchQuota } from './core/search-quota';
import { loadCredentials } from './core/credential-store';
import { loadCredentialPolicy } from './core/credential-store';
import { injectCredentials } from './core/credential-injector';
import { logger } from './core/logger';
import { getSiteResourceDir, siteIndexToDirName, getTmpSitesDir, cleanStaleTempDir, swapSiteDirectories, cleanupZombieFiles, cleanupOrphanedStaticSources, findCacheFile } from './core/site-store';
import * as fs from 'fs';
import * as path from 'path';
import type { NameTransformConfig, EdgeProxyConfig } from './core/types';
import { SourceFallbackRound, withSourceGate, saveSourceRoots, beginSourceOutputRun } from './core/source-fallback';
import { selectDataSources, sourceCapacity, sourceLimit } from './core/source-capacity';
import { publishAggregateOutputs, isCurrentAggregateRun, recordAggregateFailure, type OutputRunTicket } from './core/aggregate-output';
import { prepareImportOnlyRun } from './core/source-import-policy';
import { loadFetchProxy } from './core/fetch-proxy';
import { ImportCacheRound } from './core/source-import-cache';
import { captureSourceBaseline } from './core/source-fallback';

export async function runSync(storage: Storage, config: AppConfig): Promise<SyncResult> {
  const startTime = Date.now();
  let round: SourceFallbackRound | undefined;
  let ticket: OutputRunTicket | undefined;
  let failed = false;
  logger.infoFields('sync', 'run-start', {
    fetchTimeoutMs: config.fetchTimeoutMs,
    siteTimeoutMs: config.siteTimeoutMs,
  });

  try {
    ticket = await beginSourceOutputRun(storage);
    const imports = await withSourceGate(storage, () => ImportCacheRound.begin(storage,
      async () => (await captureSourceBaseline(storage)).registry, startTime));
    ticket = await prepareImportOnlyRun(storage, config, ticket);
    return await _runSync(storage, config, startTime, ticket, value => { round = value; }, imports);
  } catch (error: unknown) {
    failed = true;
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : '';
    logger.error('sync', `FATAL ERROR: ${msg}`);
    logger.error('sync', `Stack: ${stack}`);
    // 写入错误信息方便调试
    if (ticket) await recordAggregateFailure(storage, ticket, msg);
    // D-06: 同步失败删除临时目录，确保现有缓存不受影响
    try {
      cleanStaleTempDir();
    } catch (cleanupErr) {
      logger.warn('sync', `Failed to clean temp directory after sync failure: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
    return { outcome: 'failed', message: msg };
  } finally {
    await round?.finish(failed ? 'failed' : 'no_configs');
  }
}

async function _runSync(storage: Storage, config: AppConfig, startTime: number, ticket: OutputRunTicket, registerRound: (round: SourceFallbackRound) => void, imports: ImportCacheRound): Promise<SyncResult> {
  const limit = sourceLimit(config);

  // Step 0: 自动抓取源（需配置 SCRAPE_SOURCE_URL 环境变量）
  const scrapeFull = config.scrapeSourceUrl && sourceCapacity(JSON.parse(await storage.get(MANUAL_SOURCES) || '[]').length, limit).remaining === 0;
  if (config.scrapeSourceUrl && config.scrapeSourceReferer && !scrapeFull) {
    logger.info('sync', 'Step 0: Auto-scraping sources...');
    try {
      const scrapeCfg: ScrapeSourceConfig = { url: config.scrapeSourceUrl, referer: config.scrapeSourceReferer };
      const scraped = await scrapeSourceList(scrapeCfg);
      if (scraped.length > 0) {
        await withSourceGate(storage, async () => {
          const existingRaw = await storage.get(MANUAL_SOURCES);
          const existingSources: SourceEntry[] = existingRaw ? JSON.parse(existingRaw) : [];
          const existingUrls = new Set(existingSources.map(s => s.url));

          let added = 0;
          const addedSources: SourceEntry[] = [];
          for (const source of scraped) {
            if (sourceCapacity(existingSources.length, limit).remaining === 0) break;
            if (!existingUrls.has(source.url)) {
              existingSources.push(source);
              existingUrls.add(source.url);
              added++;
              addedSources.push(source);
            }
          }

          if (added > 0) {
            await saveSourceRoots(storage, existingSources);
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
        });
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
  const fallback = await SourceFallbackRound.begin(storage);
  registerRound(fallback);
  const sources = selectDataSources(fallback.sourceEntries(), limit);

  // 检查是否有 MacCMS 源（即使没有 config 源也可以继续）
  const macCMSRaw = await storage.get(MACCMS_SOURCES);
  const hasMacCMS = macCMSRaw ? JSON.parse(macCMSRaw).length > 0 : false;

  if (sources.length === 0 && !hasMacCMS) {
    logger.warn('sync', 'No sources configured, nothing to do');
    return { outcome: 'no_sources', message: '没有可聚合的接口，请先添加接口' };
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
    let current: TVBoxConfig | null = null;
    let reason = 'Inline configuration missing';
    try {
      const raw = await storage.get(kvKey);
      if (raw) {
        const parsed = parseConfigJson(raw);
        if (parsed.ok) current = parsed.config!;
        else reason = parsed.message || 'Inline parse failed';
      }
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    const resolved = fallback.resolve(src, current, { status: current ? 'ok' : 'local_unavailable', errorMessage: reason });
    if (resolved) inlineConfigs.push({ sourceUrl: src.url, sourceName: src.name || 'Inline', ...resolved });
  }

  // Step 2: 批量 fetch 配置 JSON（本地模式可通过边缘代理回退）
  logger.info('sync', 'Step 2: Fetching configs...');
  const proxyConfig = await loadFetchProxy(storage, config);
  const resolver = {
    source: fallback.source,
    acquire: (source: SourceEntry) => imports.acquire(source, fallback.identity(source)),
    resolve: (source: SourceEntry, raw: TVBoxConfig | null, result: SourceFetchResult) => {
      const resolved = fallback.resolve(source, raw, result);
      if (resolved && fallback.fresh(source) && result.acquisition === 'import-cache') imports.accepted(source);
      return resolved;
    },
  };
  const { configs: sourcedConfigs, fetchResults } = await fetchConfigs(remoteSources, config.fetchTimeoutMs, proxyConfig, resolver);
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
  await updateSourceHealth(storage, fetchResults, fallback.activeUrls(), source => fallback.identity(source));

  if (sourcedConfigs.length === 0 && inlineConfigs.length === 0 && macCMSConfigs.length === 0) {
    logger.warn('sync', 'No valid configs fetched and no MacCMS/inline sources, keeping previous cache');
    return { outcome: 'no_configs', message: '没有可用的接口配置，本轮未生成聚合结果' };
  }

  // Step 4: 合并（包含 MacCMS 源，投票制 spider 分配）
  logger.info('sync', 'Step 4: Merging configs...');
  const allConfigs = [...sourcedConfigs, ...inlineConfigs, ...macCMSConfigs];
  logger.infoFields('sync', 'merge-inputs', {
    remote: sourcedConfigs.length,
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
  for (const conflict of mergeResult.jarConflicts) logger.warnFields('merger', 'jar-md5-conflict', {
    message: '同一JAR地址存在不同MD5声明，已分别保留', url: conflict.url,
    md5s: conflict.md5s, sources: conflict.sources.map(source => source.name),
  });
  let merged = mergeResult.config;
  logger.infoFields('sync', 'merge-output', configCounts(merged));

  // Step 4.5: 黑名单过滤
  logger.info('sync', 'Step 4.5: Applying blacklist...');
  let blacklist = await loadBlacklist(storage);
  const hasBlacklist = blacklist.sites.length > 0 || blacklist.parses.length > 0 || blacklist.lives.length > 0 || blacklist.regexRules.length > 0;
  logger.infoFields('sync', 'blacklist-inventory', {
    sites: blacklist.sites.length,
    parses: blacklist.parses.length,
    lives: blacklist.lives.length,
    regexRules: blacklist.regexRules.length,
    overrides: blacklist.regexBlockOverrides.length,
  });

  // 暂存过滤前配置；与主配置、导出配置一起在最后发布。
  const fullJson = JSON.stringify(merged);

  if (hasBlacklist) {
    // 自动清理黑名单中已不存在的条目（必须在过滤前比对，否则被屏蔽的条目会被误判为"过时"而清掉）
    const pruned = await pruneStoredBlacklist(storage, merged);
    if (JSON.stringify(pruned) !== JSON.stringify(blacklist)) {
      logger.infoFields('sync', 'blacklist-pruned', {
        sitesBefore: blacklist.sites.length,
        sitesAfter: pruned.sites.length,
        parsesBefore: blacklist.parses.length,
        parsesAfter: pruned.parses.length,
        livesBefore: blacklist.lives.length,
        livesAfter: pruned.lives.length,
      });
    }

    blacklist = pruned;
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

  // Step 4.6.5: 生成 EXPORT_CONFIG 快照（含原始 URL，供 /admin/export-config 下载，D-01/D-02）
  // 必须在 Step 7 JAR URL 重写之前 — 此时 site.jar/api/ext 等仍是远程原始 URL
  logger.info('sync', 'Step 4.6.5: Generating EXPORT_CONFIG snapshot...');
  const livePolicy = await withSourceGate(storage, () => loadLivePolicy(storage));
  const exportConfig = await generateExportConfig(merged, blacklist, livePolicy);
  delete (exportConfig as TVBoxConfig).pic; // D-05: 导出版本不含图片代理前缀（防御性，generateExportConfig 已删）
  const exportJson = JSON.stringify(exportConfig);
  logger.infoFields('sync', 'export-config-staged', {
    sites: exportConfig.sites?.length || 0,
    parses: exportConfig.parses?.length || 0,
    lives: exportConfig.lives?.length || 0,
    liveDisabled: livePolicy.disabled,
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

  // Step 6.5: Cache playlist files; client config contains only address objects.
  merged.lives = livePolicy.disabled ? [] : supportedLives(merged.lives || []);
  const manualUrls = new Set(livePolicy.manualLives.map(liveAddress));
  const liveInputs = [...merged.lives.filter(entry => !manualUrls.has(liveAddress(entry))), ...livePolicy.manualLives];
  if (config.localBaseUrl) {
    const providers = await withSourceGate(storage, () => liveCacheProviders(storage, allConfigs));
    await refreshLiveCache(storage, liveInputs, config.fetchTimeoutMs, () => isCurrentAggregateRun(storage, ticket), providers);
  }

  // Step 6.8: Capture original URLs and shared JAR identities before proxy rewriting.
  const jarResources = await createJarResourcePlan(merged, storage);
  const jarResourceByIdentity = new Map(jarResources.map(resource => [resource.identity, resource]));
  const resources = collectAllSiteResources(merged.sites || [], merged.parses, merged.spider);
  const sorted = sortResourcesByPriority(resources, merged.spider);

  // Step 7: JAR URL 改写
  logger.info('sync', 'Step 7: Rewriting JAR URLs for proxy (placeholder)...');
  const beforeJar = configCounts(merged);
  merged = await rewriteJarUrls(merged, BASE_URL_PLACEHOLDER, storage, jarResources);
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

    if (sorted.length > 0) {
      logger.infoFields('sync', 'static-resources-found', { count: sorted.length });
      const downloadTimeout = config.fetchTimeoutMs || 10000;
      let downloaded = 0;
      let failed = 0;
      let copiedFromLive = 0;

      for (const { url, type, index, jarIdentity } of sorted) {
        const jarResource = jarIdentity ? jarResourceByIdentity.get(jarIdentity) : undefined;
        let key: string | null = null;

        if (type === 'jar') {
          const parsed = parseSpiderString(url);
          key = jarResource?.key || parsed.md5 || (await urlToKey(url));
        } else {
          key = await urlToKey(url);
        }

        if (!key) {
          failed++;
          continue;
        }

        // Owner indices survive sorting and must match the corresponding proxy mapping.
        const resourceIndex = jarResource?.index ?? index;

        // 计算临时目录下的目标路径：data/.tmp-sites/{index}/{type}/
        const tmpDir = path.join(getTmpSitesDir(), siteIndexToDirName(resourceIndex), type);
        fs.mkdirSync(tmpDir, { recursive: true });

        // D-07: TTL 检查 live 目录中是否已有有效缓存文件
        // MD5 key → 24h，URL hash key → 6h
        const liveDir = getSiteResourceDir(resourceIndex, type);
        // F-01: 先查新命名格式 {key}.{type}，再查旧格式 {key}-{name}（向后兼容）
        let liveFilePath: string | null = null;
        const newFilePath = path.join(liveDir, `${key}.${type}`);
        if (fs.existsSync(newFilePath)) {
          liveFilePath = newFilePath;
        } else {
          liveFilePath = findCacheFile(liveDir, key);
        }
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
    } else {
      logger.info('sync', 'Step 7.1: No static resources found');
    }
  } else {
    logger.info('sync', 'Step 7.1: No sites to scan');
  }

  // Step 7.1.5: 改写非 JAR 静态资源 URL 为本地代理地址
  // 对 site.api/site.ext/parse.url/parse.ext 中的 JS/PY/JSON/TXT URL
  // 改写为 {baseUrl}/{type}/{key}.{type}，并写入 static-source KV 映射（F-01：带上扩展名）
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
  await fallback.commit(async savedAt => {
    await publishAggregateOutputs(storage, ticket,
      { merged: mergedJson, full: fullJson, exported: exportJson, siteSourceNames: mergeResult.siteSourceNames,
        jarDiagnostics: { conflicts: mergeResult.jarConflicts, generations: Object.fromEntries(sources
          .map(source => [source.url, fallback.identity(source)?.generation || ''])) },
        liveDisabled: livePolicy.disabled }, savedAt);
  });
  try { await imports.consume(); }
  catch (error) { logger.warn('source-import', `输出已发布，导入暂存清理失败：${error instanceof Error ? error.message : String(error)}`); }
  try { await pruneLiveCache(storage); } catch (error) { logger.warn('live-cache', `缓存清理失败: ${error instanceof Error ? error.message : String(error)}`); }
  logger.infoFields('sync', 'storage-write-complete', {
    key: MERGED_CONFIG,
    bytes: Buffer.byteLength(mergedJson, 'utf8'),
    ...configCounts(merged),
  });

  // Step 9: 记录同步成功状态（D-12）
  // 旧的 organizeSiteDirectories 步骤已被原子交换取代：临时目录在下载阶段已建好正确的结构
  logger.info('sync', 'Step 9: Sync complete');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.infoFields('sync', 'run-complete', {
    elapsedSeconds: elapsed,
    ...configCounts(merged),
  });
  return { outcome: 'saved', message: '聚合完成' };
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

  return sites.map((site, index) => ({
    sourceUrl: 'maccms://builtin',
    sourceName: validEntries[index].name,
    sourceIdentity: `maccms:${validEntries[index].key}`,
    config: { sites: [site] },
  }));
}

/**
 * 更新源健康状态：读取历史 → merge 本次 fetch 结果 → 写回
 */
async function updateSourceHealth(storage: Storage, fetchResults: SourceFetchResult[], activeUrls: Set<string>, identity: (source: SourceEntry) => { generation: string; importedAt?: string } | undefined): Promise<void> {
  if (fetchResults.length === 0) return;

  const now = new Date().toISOString();

  // 读取历史健康记录
  const raw = await storage.get(SOURCE_HEALTH);
  // Plan 03.1 D-10: 兼容旧格式 KV 记录（latestStatus → fetchStatus），同一同步周期内规整为新格式
  const oldRecords: SourceHealthRecord[] = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>).map(r => {
    if ('latestStatus' in r && !('fetchStatus' in r)) {
      const legacy = r.latestStatus as SourceHealthRecord['fetchStatus'];
      const failures = (r.consecutiveFailures as number) || 0;
      const { latestStatus: _omit, ...rest } = r;
      void _omit;
      return {
        ...rest,
        fetchStatus: legacy,
        status: classifyStatus(legacy, failures),
      } as SourceHealthRecord;
    }
    return r as unknown as SourceHealthRecord;
  }) : [];
  const oldMap = new Map(oldRecords.map(r => [r.url, r]));

  // 本次参与 fetch 的 URL 集合
  const fetchedUrls = new Set(fetchResults.map(r => r.url));

  // Merge 逻辑
  const newRecords: SourceHealthRecord[] = [];

  for (const fr of fetchResults) {
    const node = identity({ url: fr.url, name: fr.name });
    const previous = oldMap.get(fr.url);
    const old = node?.importedAt && previous?.generation !== node.generation ? undefined : previous;

    if (fr.status === 'ok') {
      newRecords.push({
        url: fr.url,
        generation: node?.generation,
        name: fr.name,
        status: classifyStatus(fr.status, 0),
        fetchStatus: fr.status,
        consecutiveFailures: 0,
        lastSuccessTime: fr.acquiredAt || now,
        acquisition: fr.acquisition || 'remote',
        lastFailTime: old?.lastFailTime,
        lastFailReason: old?.lastFailReason,
        lastSpeedMs: fr.speedMs,
      });
    } else {
      const newFailCount = (old?.consecutiveFailures ?? 0) + 1;
      newRecords.push({
        url: fr.url,
        generation: node?.generation,
        name: fr.name,
        status: classifyStatus(fr.status, newFailCount),
        fetchStatus: fr.status,
        consecutiveFailures: newFailCount,
        lastSuccessTime: old?.lastSuccessTime,
        lastFailTime: now,
        lastFailReason: fr.errorMessage,
        lastSpeedMs: old?.lastSpeedMs,
      });
    }
  }

  // Retain existing health only for effective independent source identities.
  for (const old of oldRecords) {
    if (!fetchedUrls.has(old.url) && activeUrls.has(old.url)) newRecords.push(old);
  }

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
