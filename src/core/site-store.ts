// 站点目录结构管理：路径生成、安全文件名、目录创建与整理

import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';
import type { Storage } from '../storage/interface';
import { MANUAL_SOURCES, MACCMS_SOURCES } from './config';
import type { SourceEntry, MacCMSSourceEntry, TVBoxConfig, TVBoxSite } from './types';

const DATA_DIR_ENV = 'DATA_DIR';

/**
 * 返回数据根目录
 */
export function getDataDir(): string {
  return path.resolve(process.env[DATA_DIR_ENV] || path.join(process.cwd(), 'data'));
}

/**
 * 将 0-based 源索引转换为 1-based 零填充目录名
 * 0 → "01", 1 → "02", ..., 98 → "99"
 */
export function siteIndexToDirName(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/**
 * 返回站点资源子目录完整路径
 * {getDataDir()}/sites/{index}/{type}/
 */
export function getSiteResourceDir(index: number, type: string): string {
  return path.join(getDataDir(), 'sites', siteIndexToDirName(index), type);
}

/**
 * 从 URL 提取最后路径段并过滤不安全字符
 * 白名单：字母数字 _ . -
 * 路径遍历防御：过滤 ../ \0 等危险序列
 * 空结果返回 "resource"
 */
export function safeFileName(url: string): string {
  const segments = url.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  const filtered = last.replace(/[^a-zA-Z0-9_.-]/g, '');
  return filtered || 'resource';
}

/**
 * 生成资源文件名：{hash}-{originalName}
 */
export function getResourceFileName(hash: string, originalName: string): string {
  const safe = originalName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${hash}-${safe}`;
}

/**
 * 确保站点资源目录存在
 */
export function ensureSiteDir(index: number, type: string): string {
  const dir = getSiteResourceDir(index, type);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns temp directory path under data/ for atomic swap during sync.
 * Same filesystem as data/sites/ so renameSync is atomic (per D-05).
 */
export function getTmpSitesDir(): string {
  return path.join(getDataDir(), '.tmp-sites');
}

/**
 * Cleans any leftover temp directory from a previous crashed sync.
 * Run at the start of every sync to avoid EEXIST and partial state.
 */
export function cleanStaleTempDir(): void {
  const tmpDir = getTmpSitesDir();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logger.info('site-store', 'Cleaned stale temp directory');
  }
}

/**
 * Atomically swaps temp directory into place using rename-to-backup pattern.
 *
 * Per CR-01/CR-05: 旧的 delete-then-rename 实现存在两个问题：
 * 1. 若 renameSync 在 rmSync 成功后失败，整个 sites/ 缓存永久丢失，无恢复路径
 * 2. 删除与重命名之间的窗口内，路由层 mkdirSync({recursive:true}) 可能重建 sites/，
 *    导致后续 renameSync 抛 EEXIST，破坏一致性
 *
 * 新方案（rename-over-backup）保证 sites/ 在任一时刻都以旧名或新名存在：
 *   - 先将当前 sites/ 重命名为 .sites-backup/（原子操作）
 *   - 再将 .tmp-sites/ 重命名为 sites/
 *   - 成功后异步清理 backup；失败时从 backup 恢复后再抛出
 */
export function swapSiteDirectories(): void {
  const sitesDir = path.join(getDataDir(), 'sites');
  const tmpDir = getTmpSitesDir();
  const backupDir = path.join(getDataDir(), '.sites-backup');

  // Remove stale backup from a previous crashed swap
  if (fs.existsSync(backupDir)) {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn('site-store', `Failed to remove stale .sites-backup: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (fs.existsSync(sitesDir)) {
    // Move current sites/ aside (rename is atomic on same FS — sites/ disappears instantly)
    try {
      fs.renameSync(sitesDir, backupDir);
    } catch (e) {
      // If rename fails, fall back to rmSync (data loss risk, but better than sync failure)
      logger.warn('site-store', `Rename to backup failed, falling back to rmSync: ${e instanceof Error ? e.message : String(e)}`);
      fs.rmSync(sitesDir, { recursive: true, force: true });
    }

    // Now rename tmp into the just-vacated sites/ slot
    try {
      fs.renameSync(tmpDir, sitesDir);
      // Success — clean up backup asynchronously (don't block sync)
      setImmediate(() => {
        try {
          fs.rmSync(backupDir, { recursive: true, force: true });
        } catch (e) {
          logger.warn('site-store', `Background cleanup of .sites-backup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } catch (e) {
      // CRITICAL: tmp->sites rename failed. Attempt restore from backup so sites/ exists again.
      logger.error('site-store', `CRITICAL: tmp->sites rename failed; attempting restore from backup: ${e instanceof Error ? e.message : String(e)}`);
      try {
        if (fs.existsSync(backupDir)) {
          fs.renameSync(backupDir, sitesDir);
          logger.warn('site-store', 'Restored sites/ from backup after swap failure');
        }
      } catch (restoreErr) {
        logger.error('site-store', `FATAL: restore from backup also failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
      }
      throw e; // surface to caller — sync will fail and SYNC_STATUS will record failure
    }
  } else {
    // No existing sites/ — direct rename
    fs.renameSync(tmpDir, sitesDir);
  }

  logger.info('site-store', 'Swapped temp directory to sites');
}

/**
 * 在目录中查找以 `{key}-` 开头的缓存文件（用于 TTL 检查）。
 * 找不到时返回 null，扫描错误也返回 null（非致命）。
 *
 * WR-06: 此前同一份 findCacheFile 实现存在于 src/routes/jar-proxy.ts 和
 * src/syncer.ts 中，重复定义导致 bug 修复（如 CR-02 的 TOCTOU try/catch）
 * 必须同步两处。提取到 site-store.ts 作为单一实现，两处调用点共享。
 */
export function findCacheFile(dir: string, key: string): string | null {
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
 * Cleans files in data/sites/ not referenced by any jar-source or static-source KV key.
 * Builds a whitelist of `{hash}-{name}` file names from KV, then walks site directories
 * and removes any file not in the whitelist. Empty subdirectories are left in place;
 * organizeSiteDirectories() handles inactive site-index cleanup.
 *
 * Per T-03-01: file names are derived from KV `name` field (already filtered by
 * safeFileName on write) and KV keys are written by own sync code, not user input.
 */
export async function cleanupZombieFiles(storage: Storage): Promise<void> {
  try {
    const sitesDir = path.join(getDataDir(), 'sites');
    if (!fs.existsSync(sitesDir)) return;

    const whitelist = new Set<string>();

    const jarKeys = await storage.list('jar-source:');
    for (const key of jarKeys) {
      const raw = await storage.get(key);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw) as { name?: string };
        if (entry.name) {
          const hash = key.substring('jar-source:'.length);
          whitelist.add(`${hash}-${entry.name}`);
        }
      } catch {
        // Skip unparseable entries — defensive JSON parsing per project convention
      }
    }

    const staticKeys = await storage.list('static-source:');
    for (const key of staticKeys) {
      const raw = await storage.get(key);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw) as { name?: string };
        if (entry.name) {
          const hash = key.substring('static-source:'.length);
          whitelist.add(`${hash}-${entry.name}`);
        }
      } catch {
        // Skip unparseable entries
      }
    }

    let removed = 0;
    const indexEntries = fs.readdirSync(sitesDir, { withFileTypes: true });
    for (const indexDir of indexEntries) {
      if (!indexDir.isDirectory()) continue;
      const indexPath = path.join(sitesDir, indexDir.name);
      const typeEntries = fs.readdirSync(indexPath, { withFileTypes: true });
      for (const typeDir of typeEntries) {
        if (!typeDir.isDirectory()) continue;
        const typePath = path.join(indexPath, typeDir.name);
        for (const file of fs.readdirSync(typePath)) {
          if (whitelist.has(file)) continue;
          const filePath = path.join(typePath, file);
          fs.rmSync(filePath, { force: true });
          removed++;
          logger.info('site-store', `Zombie file removed: ${indexDir.name}/${typeDir.name}/${file}`);
        }
      }
    }

    logger.info('site-store', `Zombie cleanup complete: ${removed} files removed`);
  } catch (e) {
    logger.warn('site-store', `cleanupZombieFiles failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 扫描 TVBoxSite 列表，推断实际引用的资源类型集合
 * 检查 site.jar (->'jar')、site.api (-> 按 URL 后缀识别 .js/.py/.json/.txt)、
 * site.ext (字符串或对象 -> 扫描 URL 后缀)
 */
export function inferResourceTypesFromSites(sites: TVBoxSite[]): Set<string> {
  const types = new Set<string>();

  for (const site of sites) {
    // site.jar -> 'jar'
    if (site.jar) {
      types.add('jar');
    }

    // site.api: 检查 URL 后缀识别 js/py/json/txt
    if (site.api) {
      const apiLower = site.api.toLowerCase();
      if (apiLower.endsWith('.js')) {
        types.add('js');
      } else if (apiLower.endsWith('.py')) {
        types.add('py');
      } else if (apiLower.endsWith('.json')) {
        types.add('json');
      } else if (apiLower.endsWith('.txt')) {
        types.add('txt');
      }
    }

    // site.ext: 扫描 JS/PY/JAR/JSON/TXT URL
    if (site.ext) {
      if (typeof site.ext === 'string') {
        const extLower = site.ext.toLowerCase();
        if (extLower.endsWith('.js') || extLower.includes('.js?')) types.add('js');
        if (extLower.endsWith('.py') || extLower.includes('.py?')) types.add('py');
        if (extLower.endsWith('.jar') || extLower.includes('.jar?')) types.add('jar');
        if (extLower.endsWith('.json') || extLower.includes('.json?')) types.add('json');
        if (extLower.endsWith('.txt') || extLower.includes('.txt?')) types.add('txt');
      } else if (typeof site.ext === 'object' && site.ext !== null) {
        for (const val of Object.values(site.ext)) {
          if (typeof val === 'string') {
            const vLower = val.toLowerCase();
            if (vLower.endsWith('.js') || vLower.includes('.js?')) types.add('js');
            if (vLower.endsWith('.py') || vLower.includes('.py?')) types.add('py');
            if (vLower.endsWith('.jar') || vLower.includes('.jar?')) types.add('jar');
            if (vLower.endsWith('.json') || vLower.includes('.json?')) types.add('json');
            if (vLower.endsWith('.txt') || vLower.includes('.txt?')) types.add('txt');
          }
        }
      }
    }
  }

  return types;
}

/**
 * 同步时整理站点目录结构
 *
 * 1. 计算当前源列表中应存在的目录索引
 * 2. 为每个源按需创建资源子目录（传入 mergedSites 时仅创建实际引用的类型）
 * 3. 删除 data/sites/ 中不存在的旧目录
 */
export async function organizeSiteDirectories(storage: Storage, mergedSites?: TVBoxSite[]): Promise<void> {
  try {
    const sitesDir = path.join(getDataDir(), 'sites');

    // 读取源列表
    let manualSources: SourceEntry[] = [];
    let maccmsSources: MacCMSSourceEntry[] = [];

    try {
      const manualRaw = await storage.get(MANUAL_SOURCES);
      if (manualRaw) manualSources = JSON.parse(manualRaw);
    } catch (e) {
      logger.warn('site-store', `Failed to load MANUAL_SOURCES: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const maccmsRaw = await storage.get(MACCMS_SOURCES);
      if (maccmsRaw) maccmsSources = JSON.parse(maccmsRaw);
    } catch (e) {
      logger.warn('site-store', `Failed to load MACCMS_SOURCES: ${e instanceof Error ? e.message : String(e)}`);
    }

    const totalSources = manualSources.length + (maccmsSources.length > 0 ? 1 : 0);
    const activeDirs = new Set<string>();

    // 确定资源类型：传入 mergedSites 时按需推断，否则回退硬编码
    let resourceTypes: string[];
    if (mergedSites && mergedSites.length > 0) {
      const inferredTypes = inferResourceTypesFromSites(mergedSites);
      resourceTypes = inferredTypes.size > 0
        ? Array.from(inferredTypes)
        : ['jar', 'js', 'py'];
    } else {
      resourceTypes = ['jar', 'js', 'py'];
    }

    // 为每个源创建目录
    for (let i = 0; i < totalSources; i++) {
      const dirName = siteIndexToDirName(i);
      activeDirs.add(dirName);

      for (const type of resourceTypes) {
        ensureSiteDir(i, type);
      }
    }

    // 清理不活跃目录
    try {
      if (fs.existsSync(sitesDir)) {
        const entries = fs.readdirSync(sitesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !activeDirs.has(entry.name)) {
            const fullPath = path.join(sitesDir, entry.name);
            fs.rmSync(fullPath, { recursive: true, force: true });
            logger.info('site-store', `Removed inactive site directory: ${entry.name}`);
          }
        }
      }
    } catch (e) {
      logger.warn('site-store', `Failed to clean inactive directories: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    logger.error('site-store', `organizeSiteDirectories failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 清理不再存在的站点的 static-source KV 条目。
 * 在僵尸文件清理之前调用，确保白名单不包含已删除站点的文件。
 */
export async function cleanupOrphanedStaticSources(storage: Storage, merged: TVBoxConfig): Promise<void> {
  try {
    const activeIndexes = new Set<number>();
    if (merged.sites) {
      for (let i = 0; i < merged.sites.length; i++) {
        activeIndexes.add(i);
      }
    }

    const staticKeys = await storage.list('static-source:');
    let removed = 0;
    for (const key of staticKeys) {
      const raw = await storage.get(key);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw) as { index?: number };
        if (entry.index !== undefined && !activeIndexes.has(entry.index)) {
          // 这个 KV 条目对应的站点已被删除（黑名单或其他原因），清理它
          // Per CR-01: 使用 storage.delete() 而非 put(key, '')
          // 旧实现 put(key, '') 会留下空字符串值，导致后续 JSON.parse('') 抛错
          // 被 cleanupZombieFiles 静默吞掉，且 /static/{key}/{type} 路由会 500
          await storage.delete(key);
          removed++;
        }
      } catch { /* skip unparseable */ }
    }

    if (removed > 0) {
      logger.info('site-store', `Cleaned ${removed} orphaned static-source KV entries`);
    }
  } catch (e) {
    logger.warn('site-store', `cleanupOrphanedStaticSources failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
