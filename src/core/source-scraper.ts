// 自动抓取源列表
// 1. 可配置的 TVBox 配置源抓取
// 2. MacCMS 萌芽采集插件资源站抓取
// 通过环境变量控制：未配置则不启用

import type { SourceEntry, MacCMSSourceEntry } from './types';
import { logger } from './logger';

const MAX_PAGES = 10;

export interface ScrapeSourceConfig {
  url: string;      // 抓取 API 地址
  referer: string;  // Referer header
}

export interface ScrapeMacCMSConfig {
  apiUrl: string;   // API 地址
  aesKey: string;   // AES-128-CBC 密钥
  aesIv: string;    // AES-128-CBC IV
}

/**
 * 抓取 TVBox 源列表
 */
export async function scrapeSourceList(cfg: ScrapeSourceConfig): Promise<SourceEntry[]> {
  const allSources: SourceEntry[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const html = await fetchPage(cfg, page);
      if (!html || !html.trim()) break;

      const sources = parsePage(html);
      if (sources.length === 0) break;

      allSources.push(...sources);
      logger.debug('source-scraper', `Page ${page}: ${sources.length} sources`);
      sources.forEach((source, index) => logger.debugFields('source-scraper', 'page-source', {
        page,
        index: index + 1,
        name: source.name,
        url: source.url,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('source-scraper', `Page ${page} failed: ${msg}`);
      break;
    }
  }

  logger.info('source-scraper', `Total scraped: ${allSources.length} sources`);
  return allSources;
}

async function fetchPage(cfg: ScrapeSourceConfig, page: number): Promise<string> {
  const resp = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'okhttp/3.12.0',
      'Referer': cfg.referer,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: `action=load&page=source&type=one&paged=${page}`,
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

function parsePage(html: string): SourceEntry[] {
  const sources: SourceEntry[] = [];
  const nameRegex = /col-form-label">([^<]+)</g;
  const urlRegex = /value="([^"]+)"/g;

  const names: string[] = [];
  const urls: string[] = [];

  let m;
  while ((m = nameRegex.exec(html)) !== null) names.push(m[1].trim());
  while ((m = urlRegex.exec(html)) !== null) urls.push(m[1].trim());

  for (let i = 0; i < names.length && i < urls.length; i++) {
    const url = urls[i];
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      sources.push({ name: names[i], url });
    }
  }

  return sources;
}

// ============================================================
// MacCMS 萌芽采集资源站自动抓取
// ============================================================

interface MycjRow {
  flag?: string;
  name?: string;
  apis?: string;
  xml_api?: string;
  rema?: string;
  mid?: number;
  type?: number;
}

/**
 * 从 MacCMS 采集插件 API 抓取资源站列表
 * AES-128-CBC 解密 → 提取 zanzhu+m3u8 → 按 flag 去重
 */
export async function scrapeMacCMSSources(cfg: ScrapeMacCMSConfig): Promise<MacCMSSourceEntry[]> {
  logger.info('maccms-scraper', 'Fetching from API...');

  const url = `${cfg.apiUrl}?t=${Math.floor(Date.now() / 1000)}`;
  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error(`MacCMS API HTTP ${resp.status}`);
  }

  const json = await resp.json() as { code?: number; data?: string };
  if (json.code !== 200 || !json.data) {
    throw new Error(`MacCMS API error: code=${json.code}`);
  }

  const decrypted = await decryptData(json.data, cfg.aesKey, cfg.aesIv);
  const parsed = JSON.parse(decrypted) as {
    list?: Record<string, { rows?: MycjRow[] }>;
  };

  if (!parsed.list) {
    throw new Error('Decrypted data has no list field');
  }

  const sections = ['zanzhu', 'm3u8'] as const;
  const seen = new Map<string, MacCMSSourceEntry>();

  for (const section of sections) {
    const rows = parsed.list[section]?.rows || [];
    for (const row of rows) {
      if (!row.flag || !row.apis || !row.name) continue;
      if (!seen.has(row.flag)) {
        seen.set(row.flag, {
          key: row.flag,
          name: row.name,
          api: row.apis,
        });
      }
    }
  }

  const entries = Array.from(seen.values());
  logger.info('maccms-scraper', `Scraped ${entries.length} unique sources`);
  entries.forEach((entry, index) => logger.infoFields('maccms-scraper', 'source-scraped', {
    index: index + 1,
    key: entry.key,
    name: entry.name,
    api: entry.api,
  }));
  return entries;
}

async function decryptData(base64Data: string, key: string, iv: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key);
  const ivBytes = new TextEncoder().encode(iv);

  const binaryStr = atob(base64Data);
  const ciphertext = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    ciphertext[i] = binaryStr.charCodeAt(i);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt'],
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: ivBytes }, cryptoKey, ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}
