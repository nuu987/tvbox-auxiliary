// 站点目录结构管理：路径生成、安全文件名、目录创建与整理

import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';
import type { Storage } from '../storage/interface';
import { MANUAL_SOURCES, MACCMS_SOURCES } from './config';
import type { SourceEntry, MacCMSSourceEntry, TVBoxSite } from './types';

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
 * 扫描 TVBoxSite 列表，推断实际引用的资源类型集合
 * 检查 site.jar (->'jar')、site.api (-> 按 URL 后缀识别 .js/.py)、site.ext (字符串或对象 -> 扫描 URL 后缀)
 */
export function inferResourceTypesFromSites(sites: TVBoxSite[]): Set<string> {
  const types = new Set<string>();

  for (const site of sites) {
    // site.jar -> 'jar'
    if (site.jar) {
      types.add('jar');
    }

    // site.api: 检查 URL 后缀识别 js/py
    if (site.api) {
      const apiLower = site.api.toLowerCase();
      if (apiLower.endsWith('.js')) {
        types.add('js');
      } else if (apiLower.endsWith('.py')) {
        types.add('py');
      }
    }

    // site.ext: 扫描 JS/PY/JAR URL
    if (site.ext) {
      if (typeof site.ext === 'string') {
        const extLower = site.ext.toLowerCase();
        if (extLower.endsWith('.js') || extLower.includes('.js?')) types.add('js');
        if (extLower.endsWith('.py') || extLower.includes('.py?')) types.add('py');
        if (extLower.endsWith('.jar') || extLower.includes('.jar?')) types.add('jar');
      } else if (typeof site.ext === 'object' && site.ext !== null) {
        for (const val of Object.values(site.ext)) {
          if (typeof val === 'string') {
            const vLower = val.toLowerCase();
            if (vLower.endsWith('.js') || vLower.includes('.js?')) types.add('js');
            if (vLower.endsWith('.py') || vLower.includes('.py?')) types.add('py');
            if (vLower.endsWith('.jar') || vLower.includes('.jar?')) types.add('jar');
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
