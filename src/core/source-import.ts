import type { ImportResult, ImportSkip, SourceEntry, TVBoxConfig } from './types';
import { fetchSingleConfig, isMultiRepoConfig, parseConfigJson, type FetchProxyConfig, type SingleFetchResult } from './fetcher';
import { prepareSourceLeaf } from './source-leaf';
import { sourceCapacity, sourceLimit, sourceLimitMessage } from './source-capacity';
import { externalSourceEntry, SourceImportError } from './source-import-input';
import type { AcceptedImport } from './source-import-cache';
export { SourceImportError, importSourceEntry, externalSourceEntry } from './source-import-input';

interface ImportContext { sources: SourceEntry[]; timeoutMs: number; maxDataSources?: number; proxyConfig?: FetchProxyConfig }
export interface SourceImportPlan { entries: SourceEntry[]; accepted: AcceptedImport[]; result: ImportResult }
export interface SourceImportInput { source?: SourceEntry; text?: string }
type Acquired = SingleFetchResult & { acquiredAt: number };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function kind(config: TVBoxConfig | null): 'multi' | 'single' | 'invalid' {
  if (!config) return 'invalid';
  return isMultiRepoConfig(config) ? 'multi' : Array.isArray(config.sites) ? 'single' : 'invalid';
}
async function mapFour<T, R>(values: T[], work: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor++; results[index] = await work(values[index]); }
  }));
  const failed = workers.find((worker): worker is PromiseRejectedResult => worker.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

/** Memory-only plan; each acquisition promise serves classification and staging. */
export async function planSourceImport(input: SourceImportInput, context: ImportContext): Promise<SourceImportPlan> {
  const result: ImportResult = { success: false, type: 'single', outcome: 'none', checked: 0,
    added: 0, duplicates: 0, sources: [], skipped: [], inputKind: input.source ? 'single' : undefined };
  const plan: SourceImportPlan = { entries: [], accepted: [], result };
  const existing = new Set(context.sources.map(s => s.url));
  const limit = sourceLimit(context);
  const remaining = sourceCapacity(context.sources.length, limit).remaining;
  if (remaining === 0) throw new SourceImportError(sourceLimitMessage(limit), 409);
  const preferred = new Map<string, SourceEntry>();
  const acquisitions = new Map<string, Promise<Acquired>>();
  const select = (source: SourceEntry) => {
    const first = preferred.get(source.url);
    if (first) return first;
    preferred.set(source.url, source); return source;
  };
  const acquire = (source: SourceEntry): Promise<Acquired> => {
    source = select(source);
    let pending = acquisitions.get(source.url);
    if (!pending) {
      result.checked++;
      pending = fetchSingleConfig(source, context.timeoutMs, context.proxyConfig).then(value => ({ ...value, acquiredAt: Date.now() }));
      acquisitions.set(source.url, pending);
    }
    return pending;
  };
  const failure = (entry: SourceEntry, acquired: Acquired): ImportSkip => ({ url: entry.url, name: entry.name,
    reason: acquired.fetchResult.errorMessage || acquired.fetchResult.status,
    stage: acquired.fetchResult.status === 'decode_error' ? 'decode' : acquired.fetchResult.status === 'parse_error' ? 'parse' : 'acquisition' });
  const capacity = (candidates: SourceEntry[]) => {
    const count = new Set(candidates.filter(s => !existing.has(s.url)).map(s => s.url)).size;
    if (remaining !== null && count > remaining) throw new SourceImportError(`${sourceLimitMessage(limit)}`, 409,
      sourceCapacity(context.sources.length, limit, count - remaining));
  };
  const accepted = new Set<string>();
  const checkLeaf = (entry: SourceEntry, acquired: Acquired): ImportSkip | undefined => {
    if (!acquired.config) return failure(entry, acquired);
    const type = kind(acquired.config);
    if (type === 'multi') return { url: entry.url, name: entry.name, reason: '嵌套多仓已忽略，不支持', stage: 'directory' };
    if (type === 'invalid') return { url: entry.url, name: entry.name, reason: '无法识别接口类型，需要单仓配置', stage: 'parse' };
    try { prepareSourceLeaf(entry, copy(acquired.config)); }
    catch (error) { return { url: entry.url, name: entry.name, reason: message(error), stage: 'preparation' }; }
    accepted.add(entry.url);
    plan.entries.push(entry);
    plan.accepted.push({ entry, config: copy(acquired.config), acquiredAt: acquired.acquiredAt });
  };
  const finish = () => {
    result.added = plan.entries.length;
    result.sources = plan.entries.map(s => s.url);
    result.success = result.added > 0;
    result.outcome = result.added ? result.skipped.length ? 'partial' : 'added'
      : result.duplicates && !result.skipped.length ? 'duplicates_only' : 'none';
    result.capacity = sourceCapacity(context.sources.length + result.added, limit);
    return plan;
  };
  if (input.source) {
    // External validation precedes normalization at the route boundary.
    const source = select(input.source);
    if (existing.has(source.url)) { result.duplicates++; return finish(); }
    capacity([source]);
    const acquired = await acquire(source);
    if (kind(acquired.config) === 'multi') throw new SourceImportError('此地址为多仓接口，请使用高级添加', 400);
    const error = checkLeaf(source, acquired);
    if (error) throw new SourceImportError(error.reason, acquired.fetchResult.status === 'timeout' ? 504
      : error.stage === 'acquisition' ? 502 : 400);
    return finish();
  }

  const text = (input.text || '').trim();
  if (!text) throw new SourceImportError('请输入接口地址或多仓JSON', 400);
  const rootInputs: Array<SourceEntry | ImportSkip> = [];
  const directories: Array<{ config: TVBoxConfig; name: string }> = [];
  if (/^[{\[]|^\/\//.test(text) || text.startsWith('/*')) {
    const parsed = parseConfigJson(text); result.checked++;
    if (!parsed.ok || !parsed.config || kind(parsed.config) !== 'multi') throw new SourceImportError('仅支持一份完整多仓JSON，或每行一条单仓/多仓地址；不可混合粘贴', 400);
    result.type = 'multi'; result.inputKind = 'multi_json';
    directories.push({ config: parsed.config, name: 'Imported' });
  } else {
    // Never extract URLs from malformed JSON, or split suffix keys/punctuation.
    if (/[\r\n]\s*[{\[]/.test(text)) throw new SourceImportError('JSON内容与接口地址不可混合粘贴', 400);
    for (const [i, line] of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).entries()) {
      try { rootInputs.push(select(externalSourceEntry({ url: line }))); }
      catch (error) { rootInputs.push({ name: `第${i + 1}条`, url: line.split(';pk;')[0], reason: message(error), stage: 'input' }); }
    }
    const unique = [...new Map(rootInputs.filter((s): s is SourceEntry => !('stage' in s)).map(s => [s.url, s])).values()];
    const values = await mapFour(unique, acquire);
    const byUrl = new Map(unique.map((s, i) => [s.url, values[i]]));
    const types = new Set(values.map(a => kind(a.config)).filter(t => t !== 'invalid'));
    if (types.size > 1) throw new SourceImportError('单仓地址与多仓地址不可混合导入，本批未添加任何接口', 400);
    result.type = types.has('multi') ? 'multi' : 'single';
    result.inputKind = result.type === 'multi' ? 'multi_urls' : 'single_urls';
    if (types.has('single')) capacity(unique);
    const seenRoots = new Set<string>();
    for (const root of rootInputs) {
      if ('stage' in root) { result.skipped.push(root); continue; }
      if (seenRoots.has(root.url)) { result.duplicates++; continue; }
      seenRoots.add(root.url);
      const acquired = byUrl.get(root.url)!;
      if (!acquired.config) { result.skipped.push(failure(root, acquired)); continue; }
      if (kind(acquired.config) === 'invalid') {
        result.skipped.push({ url: root.url, name: root.name, reason: '无法识别接口类型', stage: 'parse' }); continue;
      }
      if (result.type === 'multi') directories.push({ config: acquired.config, name: root.name });
      else if (existing.has(root.url)) result.duplicates++;
      else { const error = checkLeaf(root, acquired); if (error) result.skipped.push(error); }
    }
  }
  if (directories.length) {
    const children: Array<SourceEntry | ImportSkip> = [];
    for (const directory of directories) {
      const raw = directory.config as Record<string, unknown>;
      const storeHouse = Array.isArray(raw.storeHouse);
      const items = (storeHouse ? raw.storeHouse : raw.urls) as unknown[];
      if (!items.length) children.push({ name: directory.name, reason: '多仓目录没有可导入的单仓地址', stage: 'directory' });
      items.forEach((item, i) => {
        const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
        const url = storeHouse ? value.sourceUrl : value.url;
        const name = storeHouse ? value.sourceName : value.name;
        try { children.push(select(externalSourceEntry({ url, name, configKey: value.configKey }))); }
        catch (error) { children.push({ name: typeof name === 'string' ? name : `${directory.name} 第${i + 1}条`,
          url: typeof url === 'string' ? url.split(';pk;')[0] : undefined, reason: message(error), stage: 'input' }); }
      });
    }
    const candidates = [...new Map(children.filter((s): s is SourceEntry => !('stage' in s)).map(s => [s.url, s])).values()];
    capacity(candidates);
    const fresh = candidates.filter(s => !existing.has(s.url));
    const values = await mapFour(fresh, acquire);
    const byUrl = new Map(fresh.map((s, i) => [s.url, values[i]]));
    const seen = new Set<string>();
    for (const child of children) {
      if ('stage' in child) { result.skipped.push(child); continue; }
      if (seen.has(child.url) || existing.has(child.url) || accepted.has(child.url)) { result.duplicates++; continue; }
      seen.add(child.url);
      const error = checkLeaf(child, byUrl.get(child.url)!);
      if (error) result.skipped.push(error);
    }
  }
  return finish();
}
