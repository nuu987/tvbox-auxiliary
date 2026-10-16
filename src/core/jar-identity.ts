import { createHash } from 'crypto';
import type { TVBoxSite } from './types';

/** Declaration identity only: no download, byte hashing or checksum validation. */
export function parseSpiderString(spider: string): { prefix: string; url: string; md5: string | null; raw: string } {
  const prefix = spider.startsWith('img+') ? 'img+' : '';
  const rest = prefix ? spider.slice(4) : spider;
  const separator = rest.indexOf(';md5;');
  return { prefix, url: separator < 0 ? rest : rest.slice(0, separator),
    md5: separator < 0 ? null : rest.slice(separator + 5), raw: spider };
}

export interface JarDeclaration {
  raw: string;
  url: string;
  md5: string | null;
  prefix: string;
  identity: string;
}

export function jarDeclaration(value?: string): JarDeclaration | null {
  if (!value) return null;
  const parsed = parseSpiderString(value.trim());
  const url = parsed.url.trim();
  if (!/^https?:\/\//.test(url)) return null;
  const checksum = parsed.md5 || null;
  const md5 = checksum && /^[a-f0-9]{32}$/i.test(checksum) ? checksum.toLowerCase() : checksum;
  return { raw: value, url, md5, prefix: parsed.prefix,
    identity: JSON.stringify(['jar-v2', url, md5, parsed.prefix]) };
}

export function effectiveSiteJar(site: TVBoxSite, sourceSpider?: string): JarDeclaration | null {
  return jarDeclaration(site.jar || (site.type === 3 ? sourceSpider : undefined));
}

export function jarCacheKey(declaration: JarDeclaration): string {
  // Keep the current 32-hex key/TTL behavior; TTL classification is a separate change.
  return createHash('sha256').update(declaration.identity).digest('hex').slice(0, 32);
}
