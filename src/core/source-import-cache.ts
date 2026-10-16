import { randomUUID } from 'crypto';
import type { Storage } from '../storage/interface';
import type { SourceEntry, TVBoxConfig } from './types';
import type { SingleFetchResult } from './fetcher';
import { SOURCE_IMPORT_CACHE } from './config';
import { withSourceGate } from './source-gate';
import { logger } from './logger';

export const IMPORT_CACHE_TTL_MS = 300_000;
export interface AcceptedImport { entry: SourceEntry; config: TVBoxConfig; acquiredAt: number }
export interface ImportIdentity { fingerprint: string; generation: string }
interface CacheEntry extends ImportIdentity {
  recordId: string;
  acquiredAt: number;
  cachedAt: number;
  expiresAt: number;
  config: TVBoxConfig;
}
interface ImportCache { version: 1; entries: Record<string, CacheEntry> }
interface Identities { roots: Record<string, string>; nodes: Record<string, ImportIdentity> }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function read(raw: string | null): ImportCache {
  const cache: ImportCache = { version: 1, entries: {} };
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!object(value) || value.version !== 1 || !object(value.entries)) return cache;
    for (const [url, e] of Object.entries(value.entries)) {
      if (!object(e) || !['recordId', 'fingerprint', 'generation'].every(k => typeof e[k] === 'string' && e[k])
        || ![e.acquiredAt, e.cachedAt, e.expiresAt].every(t => typeof t === 'number' && Number.isFinite(t))
        || Number(e.acquiredAt) > Number(e.cachedAt) || Number(e.cachedAt) < 0
        || Number(e.expiresAt) !== Number(e.cachedAt) + IMPORT_CACHE_TTL_MS
        || !object(e.config) || !Array.isArray(e.config.sites) || !e.config.sites.length) continue;
      cache.entries[url] = e as unknown as CacheEntry;
    }
  } catch { /* A damaged optional cache is a normal acquisition miss. */ }
  return cache;
}
function matches(e: CacheEntry, identity?: ImportIdentity): boolean {
  return !!identity && e.fingerprint === identity.fingerprint && e.generation === identity.generation;
}
function prune(cache: ImportCache, identities: Identities): void {
  for (const [url, entry] of Object.entries(cache.entries)) {
    if (!identities.roots[url] || !matches(entry, identities.nodes[url])) delete cache.entries[url];
  }
}

/** Caller holds source gate; return a value to include in the declaration batch. */
export async function importCacheValue(storage: Storage, identities: Identities, accepted: AcceptedImport[] = [], now = Date.now()): Promise<string | undefined> {
  const raw = await storage.get(SOURCE_IMPORT_CACHE);
  if (!raw && !accepted.length) return undefined;
  const cache = read(raw);
  prune(cache, identities);
  for (const item of accepted) {
    const identity = identities.nodes[item.entry.url];
    if (!identity) throw new Error('Missing imported source identity');
    cache.entries[item.entry.url] = { fingerprint: identity.fingerprint, generation: identity.generation,
      recordId: randomUUID(), acquiredAt: item.acquiredAt, cachedAt: now, expiresAt: now + IMPORT_CACHE_TTL_MS,
      config: copy(item.config) };
  }
  return JSON.stringify(cache);
}

export class ImportCacheRound {
  private used = new Map<string, CacheEntry>();
  private constructor(private storage: Storage, private entries: Record<string, CacheEntry>) {}
  /** Caller holds gate. Freeze before any remote migration/scraping work. */
  static async begin(storage: Storage, identitySource: Identities | (() => Promise<Identities>), startedAt: number): Promise<ImportCacheRound> {
    let raw: string | null;
    try { raw = await storage.get(SOURCE_IMPORT_CACHE); }
    catch { return new ImportCacheRound(storage, {}); }
    if (!raw) return new ImportCacheRound(storage, {});
    const cache = read(raw);
    let identities: Identities;
    try { identities = typeof identitySource === 'function' ? await identitySource() : identitySource; }
    catch { return new ImportCacheRound(storage, {}); }
    prune(cache, identities);
    for (const [url, entry] of Object.entries(cache.entries)) if (startedAt >= entry.expiresAt || startedAt < entry.cachedAt) delete cache.entries[url];
    if (raw !== JSON.stringify(cache)) {
      try { await storage.put(SOURCE_IMPORT_CACHE, JSON.stringify(cache)); }
      catch (error) { logger.warn('source-import', `暂存清理失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    return new ImportCacheRound(storage, copy(cache.entries));
  }
  acquire(source: SourceEntry, identity?: ImportIdentity): SingleFetchResult | undefined {
    const entry = this.entries[source.url];
    if (!entry || !matches(entry, identity)) return undefined;
    return { config: copy(entry.config), fetchResult: { url: source.url, name: source.name, status: 'ok',
      acquisition: 'import-cache', acquiredAt: new Date(entry.acquiredAt).toISOString() } };
  }
  accepted(source: SourceEntry): void {
    const entry = this.entries[source.url];
    if (entry) this.used.set(source.url, entry);
  }
  /** Only after real output publication. Never erase a replacement record. */
  async consume(): Promise<void> {
    if (!this.used.size) return;
    await withSourceGate(this.storage, async () => {
      const cache = read(await this.storage.get(SOURCE_IMPORT_CACHE));
      for (const [url, used] of this.used) if (cache.entries[url]?.recordId === used.recordId) delete cache.entries[url];
      await this.storage.put(SOURCE_IMPORT_CACHE, JSON.stringify(cache));
    });
  }
}
