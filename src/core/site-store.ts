// 站点目录结构管理：路径生成、安全文件名、目录创建与整理

import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';
import type { Storage } from '../storage/interface';
import { MANUAL_SOURCES, MACCMS_SOURCES } from './config';
import type { SourceEntry, MacCMSSourceEntry } from './types';

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
  return `${hash}-${originalName}`;
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
 * 同步时整理站点目录结构
 *
 * 1. 计算当前源列表中应存在的目录索引
 * 2. 为每个源创建 jar/js/py 子目录
 * 3. 删除 data/sites/ 中不存在的旧目录
 */
export async function organizeSiteDirectories(storage: Storage): Promise<void> {
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

    // 为每个源创建目录
    for (let i = 0; i < totalSources; i++) {
      const dirName = siteIndexToDirName(i);
      activeDirs.add(dirName);

      for (const type of ['jar', 'js', 'py']) {
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
