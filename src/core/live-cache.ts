import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Storage } from '../storage/interface';
import type { LiveSourceEntry, TVBoxLive, SourcedConfig } from './types';
import { LIVE_CACHE_STATE, LIVE_DISABLED, LIVE_SOURCES, MERGED_CONFIG, SOURCE_OUTPUT_STATE, SOURCE_CONFIG_SNAPSHOTS, TVBOX_UA } from './config';
import { cacheableLive, decodeLiveSources, liveAddress, supportedLives } from './live-source';
import { getDataDir } from './site-store';
import { normalizePlaylist, type PlaylistFile } from './live-playlist';
import { normalizeConfig } from './parser';
import { withSourceGate } from './source-gate';
import { activationFailures, decodeOutputState } from './aggregate-state';
import { logger } from './logger';

interface CacheRecord {
  url: string;
  headers: Record<string, string>;
  requestError?: string;
  generation: string;
  attempt?: string;
  outcome: 'waiting' | 'success' | 'failed' | 'passthrough';
  file?: string;
  savedAt?: string;
  reason?: string;
  failures: number;
  providers?: Record<string, string>;
}
export interface LiveCacheState { version: 1; records: Record<string, CacheRecord> }
export interface LiveCacheView {
  level: 'ok' | 'warn' | 'error' | 'unknown';
  label: string;
  reason?: string;
  cached?: boolean;
  cacheTime?: string;
  failures?: number;
}
const MAX_BYTES = 20 * 1024 * 1024;
const locks = new WeakMap<Storage, Map<string, Promise<void>>>();
const running = new WeakMap<Storage, Map<string, string>>();
const empty = (): LiveCacheState => ({ version: 1, records: {} });
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const filePattern = /^[a-f0-9]{64}\.(m3u|txt)$/;
const cacheDir = (): string => path.join(getDataDir(), 'live');

function requestFor(entry: TVBoxLive): { headers: Record<string, string>; error?: string } {
  try {
    const headers = new Headers({ 'User-Agent': entry.ua || TVBOX_UA });
    for (const [name, value] of Object.entries(entry.header || {})) headers.set(name, value);
    return { headers: Object.fromEntries([...headers.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  } catch { return { headers: {}, error: '直播请求头配置无法用于下载' }; }
}
export function liveCacheKey(entry: TVBoxLive): string {
  return hash(JSON.stringify([liveAddress(entry), requestFor(entry)]));
}
export async function loadLiveCache(storage: Storage): Promise<{ state: LiveCacheState | null; raw: string | null }> {
  try {
    const raw = await storage.get(LIVE_CACHE_STATE);
    if (raw === null) return { state: empty(), raw };
    const state: LiveCacheState = JSON.parse(raw);
    if (state?.version !== 1 || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) throw new Error('Invalid live cache');
    for (const [key, r] of Object.entries(state.records)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !r || typeof r.url !== 'string' || typeof r.generation !== 'string'
        || !r.generation || !r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers) || Object.values(r.headers).some(v => typeof v !== 'string')
        || !['waiting', 'success', 'failed', 'passthrough'].includes(r.outcome)
        || !Number.isInteger(r.failures) || r.failures < 0 || (r.file !== undefined && (typeof r.file !== 'string' || !filePattern.test(r.file)))
        || (r.reason !== undefined && typeof r.reason !== 'string') || (r.attempt !== undefined && typeof r.attempt !== 'string')
        || (r.requestError !== undefined && typeof r.requestError !== 'string')
        || (r.providers !== undefined && (!r.providers || typeof r.providers !== 'object'
          || Object.values(r.providers).some(value => typeof value !== 'string')))
        || (r.savedAt !== undefined && (typeof r.savedAt !== 'string' || !Number.isFinite(Date.parse(r.savedAt))))) throw new Error('Invalid live cache record');
    }
    for (const [key, record] of Object.entries(state.records)) {
      if (record.attempt && running.get(storage)?.get(key) !== record.attempt) {
        // An interrupted attempt (including a failed final write) cannot start again on a client read.
        delete record.attempt; record.outcome = 'failed';
        record.reason = '缓存未完成，等待下次聚合重试'; record.failures++;
      }
    }
    return { state, raw };
  } catch { return { state: null, raw: 'unreadable' }; }
}
function hasFile(record?: CacheRecord): boolean {
  if (!record?.file || !filePattern.test(record.file)) return false;
  try {
    const file = path.join(cacheDir(), record.file); const stat = fs.statSync(file);
    fs.accessSync(file, fs.constants.R_OK);
    return stat.isFile() && stat.size > 0;
  } catch { return false; }
}
export function liveCacheView(entry: TVBoxLive, state: LiveCacheState | null): LiveCacheView {
  if (!cacheableLive(entry)) return { level: 'ok', label: 'OK' };
  if (!state) return { level: 'unknown', label: '状态暂不可用' };
  const r = state.records[liveCacheKey(entry)];
  if (r?.outcome === 'passthrough') return { level: 'ok', label: 'OK' };
  if (r?.attempt) return { level: 'unknown', label: '缓存中' };
  if (!r || r.outcome === 'waiting') return { level: 'unknown', label: '等待聚合' };
  const cached = hasFile(r);
  if (r.outcome === 'success' && cached) return { level: 'ok', label: 'OK' };
  return { level: cached ? 'warn' : 'error', label: cached ? '警告' : '错误',
    reason: r.reason || '本地缓存文件不可用', cached, cacheTime: cached ? r.savedAt : undefined, failures: r.failures };
}
export function projectLiveAddress(entry: TVBoxLive, state: LiveCacheState | null, baseUrl: string): TVBoxLive {
  if (cacheableLive(entry) && entry.type == null) entry = { ...entry, type: 0 };
  if (!baseUrl || !cacheableLive(entry) || !state) return entry;
  const key = liveCacheKey(entry); const r = state.records[key];
  if (r?.outcome === 'passthrough' || (r?.outcome === 'failed' && !r.attempt && !hasFile(r))) return entry;
  const format = r?.file?.endsWith('.m3u') ? 'm3u' : r?.file?.endsWith('.txt') ? 'txt'
    : /\.m3u8?(?:[?#]|$)/i.test(liveAddress(entry)) ? 'm3u' : 'txt';
  const field = entry.url ? 'url' : 'api';
  return { ...entry, [field]: `${baseUrl.replace(/\/$/, '')}/live/${key}.${format}` };
}

/** Gate held. Stored config contains original interface declarations, never cache paths. */
async function currentLives(storage: Storage, manual?: LiveSourceEntry[]): Promise<TVBoxLive[]> {
  const declared = manual || decodeLiveSources(await storage.get(LIVE_SOURCES));
  const manualLives = declared.map(entry => ({ ...entry, type: 0 }));
  let upstream: TVBoxLive[] = [];
  let admitted = false;
  try { admitted = !activationFailures.has(storage) && !decodeOutputState(await storage.get(SOURCE_OUTPUT_STATE))?.blocked; } catch { /* Invalid output never authorizes interface resources. */ }
  try {
    if (admitted && (await storage.get(LIVE_DISABLED)) === 'false') {
      const raw = await storage.get(MERGED_CONFIG);
      if (raw) {
        const lives = JSON.parse(raw).lives;
        if (Array.isArray(lives)) upstream = supportedLives(lives);
      }
    }
  } catch { /* Unreadable interface output must not lock independent manual declarations. */ }
  const urls = new Set(declared.map(entry => entry.url));
  return [...upstream.filter(entry => !urls.has(liveAddress(entry))), ...manualLives];
}
function register(state: LiveCacheState, entry: TVBoxLive): CacheRecord {
  const key = liveCacheKey(entry);
  const request = requestFor(entry);
  return state.records[key] ||= { url: liveAddress(entry), headers: request.headers, requestError: request.error,
    generation: randomUUID(), outcome: 'waiting', failures: 0 };
}
/** Caller holds gate; batch this with the manual declaration mutation. */
export async function manualLiveCacheValue(storage: Storage, entries: LiveSourceEntry[]): Promise<string | undefined> {
  const { state } = await loadLiveCache(storage);
  if (!state) return undefined;
  const before = new Set((await currentLives(storage)).filter(cacheableLive).map(liveCacheKey));
  const lives = (await currentLives(storage, entries)).filter(cacheableLive);
  const keys = new Set(lives.map(liveCacheKey));
  for (const key of Object.keys(state.records)) if (!before.has(key) || !keys.has(key)) delete state.records[key];
  for (const entry of lives) register(state, entry);
  return JSON.stringify(state);
}

async function download(record: CacheRecord, timeoutMs: number): Promise<PlaylistFile | null> {
  if (record.requestError) throw new Error(record.requestError);
  let address: URL;
  try { address = new URL(record.url); } catch { throw new Error('直播地址格式无效'); }
  // Managed live playlists may reside on the operator's LAN, regardless of DMZ.
  if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error('直播地址仅支持 HTTP/HTTPS');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(record.url, { headers: record.headers, signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('直播列表超过 20 MiB'); }
    reader = response.body?.getReader(); const chunks: Buffer[] = []; let size = 0;
    while (reader) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > MAX_BYTES) throw new Error('直播列表超过 20 MiB');
      chunks.push(Buffer.from(chunk.value));
    }
    const result = normalizePlaylist(Buffer.concat(chunks), response.headers.get('content-type') || '', response.url || record.url);
    if (result && result.data.length > MAX_BYTES) throw new Error('直播列表超过 20 MiB');
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('直播列表下载超时');
    throw error;
  } finally {
    clearTimeout(timer); try { await reader?.cancel(); } catch { /* Reader may already be closed. */ }
    reader?.releaseLock();
  }
}

type Guard = () => Promise<boolean>;
type Providers = Record<string, Record<string, string>>;
async function sourceGenerations(storage: Storage): Promise<Record<string, string>> {
  const raw = await storage.get(SOURCE_CONFIG_SNAPSHOTS);
  if (!raw) return {};
  const registry = JSON.parse(raw);
  if (!registry?.roots || !registry.nodes) return {};
  const values: Record<string, string> = {};
  for (const url of Object.keys(registry.roots)) {
    const generation = registry.nodes[url]?.generation;
    if (typeof generation === 'string') values[url] = generation;
  }
  return values;
}
/** Caller holds gate; preserve all actual providers, including deduplicated declarations. */
export async function liveCacheProviders(storage: Storage, sources: SourcedConfig[]): Promise<Providers> {
  const generations = await sourceGenerations(storage); const providers: Providers = {};
  for (const source of sources) {
    if (!generations[source.sourceUrl]) continue;
    const prepared = source.prepared ? source : normalizeConfig(source);
    for (const entry of supportedLives(prepared.config.lives || []).filter(cacheableLive)) {
      (providers[liveCacheKey(entry)] ||= {})[source.sourceUrl] = generations[source.sourceUrl];
    }
  }
  return providers;
}
async function attempt(storage: Storage, entry: TVBoxLive, timeoutMs: number, refresh: boolean, guard?: Guard, providers?: Providers): Promise<void> {
  const key = liveCacheKey(entry);
  if (!refresh) {
    const available = await withSourceGate(storage, async () => {
      const { state } = await loadLiveCache(storage); const record = state?.records[key];
      return record?.outcome !== 'passthrough' && hasFile(record);
    });
    if (available) return; // Never delay a cache hit behind an aggregation's remote refresh.
  }
  let active = locks.get(storage); if (!active) { active = new Map(); locks.set(storage, active); }
  if (active.has(key)) {
    await active.get(key);
    if (!refresh) return;
  }
  const work = (async () => {
    const ticket = await withSourceGate(storage, async () => {
      if (guard && !await guard()) return null;
      if (!guard && !(await currentLives(storage)).some(live => cacheableLive(live) && liveCacheKey(live) === key)) return null;
      // An actual aggregation may recover corrupt private metadata; ordinary reads never reset failure state.
      const loaded = await loadLiveCache(storage); const state = loaded.state || (refresh ? empty() : null);
      if (!state) return null;
      if (refresh && providers) {
        const previous = state.records[key];
        const generations = await sourceGenerations(storage);
        const manual = decodeLiveSources(await storage.get(LIVE_SOURCES)).some(item => liveCacheKey({ ...item, type: 0 }) === key);
        const retained = previous?.providers && Object.entries(previous.providers).some(([url, generation]) => generations[url] === generation);
        // A deleted/re-added last provider cannot qualify an earlier file; an unchanged co-provider may.
        if (previous && !manual && !retained) delete state.records[key];
      }
      const record = register(state, entry);
      if (refresh && providers) record.providers = providers[key] || {};
      if (record.outcome === 'passthrough' || (!refresh && (record.outcome === 'failed' || hasFile(record)))) return null;
      const id = randomUUID(); record.attempt = id;
      let current = running.get(storage); if (!current) { current = new Map(); running.set(storage, current); }
      current.set(key, id);
      // The persisted attempt marker prevents client retries after interruption/restart.
      await storage.put(LIVE_CACHE_STATE, JSON.stringify(state));
      return { id, generation: record.generation, record: { ...record } };
    });
    if (!ticket) return;
    let temporary: string | undefined; let file: string | undefined; let reason: string | undefined; let passthrough = false; let writing = false;
    try {
      const result = await download(ticket.record, timeoutMs);
      if (!result) passthrough = true;
      else {
        writing = true;
        fs.mkdirSync(cacheDir(), { recursive: true });
        file = `${hash(result.data)}.${result.format}`;
        temporary = path.join(cacheDir(), `${ticket.id}.tmp`);
        fs.writeFileSync(temporary, result.data);
      }
    } catch (error) {
      reason = writing ? '直播缓存文件写入失败' : error instanceof Error ? error.message : String(error);
      if (writing) logger.warn('live-cache', `文件写入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    try { await withSourceGate(storage, async () => {
      if (guard && !await guard()) return;
      if (!guard && !(await currentLives(storage)).some(live => cacheableLive(live) && liveCacheKey(live) === key)) return;
      const { state } = await loadLiveCache(storage); const record = state?.records[key];
      if (!state || !record || record.generation !== ticket.generation || record.attempt !== ticket.id) return;
      if (!reason && file && temporary) {
        try { fs.renameSync(temporary, path.join(cacheDir(), file)); }
        catch (error) {
          reason = '直播缓存文件发布失败';
          logger.warn('live-cache', `文件发布失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      delete record.attempt;
      if (passthrough) { record.outcome = 'passthrough'; delete record.reason; delete record.file; }
      else if (!reason && file) {
        record.file = file; record.savedAt = new Date().toISOString(); record.outcome = 'success'; record.failures = 0; delete record.reason;
      } else { record.outcome = 'failed'; record.reason = reason || '直播缓存写入失败'; record.failures++; }
      await storage.put(LIVE_CACHE_STATE, JSON.stringify(state));
      if (reason) logger.warn('live-cache', `${entry.name || '直播源'}: ${reason}`);
    }); } finally { if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Candidate moved or removed. */ } } }
  })();
  active.set(key, work);
  try { await work; } finally { if (active.get(key) === work) { active.delete(key); running.get(storage)?.delete(key); } }
}

/** Refresh once per identity with bounded concurrency; guard runs only under the source gate. */
export async function refreshLiveCache(storage: Storage, entries: TVBoxLive[], timeoutMs: number, guard: Guard, providers?: Providers): Promise<void> {
  const unique = [...new Map(entries.filter(cacheableLive).map(entry => [liveCacheKey(entry), entry])).values()];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const entry = unique[cursor++];
      try { await attempt(storage, entry, timeoutMs, true, guard, providers); }
      catch (error) { logger.warn('live-cache', `缓存状态写入失败: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }));
}

/** Authorize against current declarations/usable aggregate, not filesystem existence. */
export async function readLiveFile(storage: Storage, key: string, timeoutMs: number): Promise<{ data?: Buffer; file?: string; redirect?: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(key)) return null;
  const entry = await withSourceGate(storage, async () => (await currentLives(storage))
    .find(live => cacheableLive(live) && liveCacheKey(live) === key));
  if (!entry) return null;
  try { await attempt(storage, entry, timeoutMs, false); }
  catch (error) { logger.warn('live-cache', `列表请求无法更新缓存状态: ${error instanceof Error ? error.message : String(error)}`); }
  return withSourceGate(storage, async () => {
    if (!(await currentLives(storage)).some(live => cacheableLive(live) && liveCacheKey(live) === key)) return null;
    const { state } = await loadLiveCache(storage); const record = state?.records[key];
    if (record?.outcome !== 'passthrough' && hasFile(record)) {
      try { return { data: fs.readFileSync(path.join(cacheDir(), record!.file!)), file: record!.file }; }
      catch { /* Preserve origin fallback; file may be unreadable. */ }
    }
    return { redirect: liveAddress(entry) };
  });
}

export async function pruneLiveCache(storage: Storage): Promise<void> {
  await withSourceGate(storage, async () => {
    const { state } = await loadLiveCache(storage); if (!state) return;
    const keys = new Set((await currentLives(storage)).filter(cacheableLive).map(liveCacheKey));
    for (const key of Object.keys(state.records)) if (!keys.has(key)) delete state.records[key];
    await storage.put(LIVE_CACHE_STATE, JSON.stringify(state));
    const keep = new Set(Object.values(state.records).flatMap(record => record.file ? [record.file] : []));
    const pending = new Set(running.get(storage)?.values() || []);
    try {
      for (const file of fs.readdirSync(cacheDir())) {
        const obsolete = filePattern.test(file) && !keep.has(file);
        const abandoned = /^[a-f0-9-]{36}\.tmp$/.test(file) && !pending.has(file.slice(0, -4));
        if (obsolete || abandoned) {
          try { fs.unlinkSync(path.join(cacheDir(), file)); }
          catch { logger.warn('live-cache', '旧直播文件清理失败'); }
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('live-cache', '旧直播文件清理失败'); }
  });
}
