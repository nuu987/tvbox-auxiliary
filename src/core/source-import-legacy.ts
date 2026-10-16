import { randomUUID } from 'crypto';
import type { ImportResult, ImportSkip, SourceEntry, TVBoxConfig } from './types';
import { INLINE_PREFIX } from './config';
import { extractMultiRepoEntries, inspectSourceOnce, isMultiRepoConfig, parseConfigJson } from './fetcher';
import { prepareSourceLeaf } from './source-leaf';
import { sourceCapacity, sourceLimit, sourceLimitMessage } from './source-capacity';

import { SourceImportError, importSourceEntry } from './source-import-input';
export interface InspectionContext {
  sources: SourceEntry[];
  knownLeaves: Set<string>;
  timeoutMs: number;
  maxDataSources?: number;
}
export interface SourceImportInput { source?: SourceEntry; text?: string; config?: TVBoxConfig }
export interface SourceImportPlan {
  entries: SourceEntry[];
  result: ImportResult;
  /** Temporary inline content, never a successful snapshot. */
  inline?: { key: string; text: string };
  usable: number;
}

function fetchFailure(result: Awaited<ReturnType<typeof inspectSourceOnce>>['fetchResult']): ImportSkip {
  return { url: result.url, name: result.name, reason: result.errorMessage || result.status,
    stage: result.status === 'decode_error' ? 'decode' : result.status === 'parse_error' ? 'parse' : 'acquisition' };
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Memory-only, one-level inspection; never publishes cache, health or output. */
export async function planSourceImport(input: SourceImportInput, context: InspectionContext): Promise<SourceImportPlan> {
  const result: ImportResult = { success: false, type: 'single', outcome: 'none', checked: 0,
    added: 0, duplicates: 0, sources: [], skipped: [] };
  const plan: SourceImportPlan = { entries: [], result, usable: 0 };
  const limit = sourceLimit(context);
  const available = sourceCapacity(context.sources.length, limit).remaining;
  if (available === 0 && !input.config) throw new SourceImportError(sourceLimitMessage(limit), 409);
  const source = input.source ? importSourceEntry(input.source) : undefined;
  let config = input.config;
  if (!config && source) {
    result.checked++;
    const acquired = await inspectSourceOnce(source, context.timeoutMs);
    if (!acquired.config) {
      const failure = fetchFailure(acquired.fetchResult);
      throw new SourceImportError(failure.reason, acquired.fetchResult.status === 'timeout' ? 504
        : failure.stage === 'acquisition' ? 502 : 400);
    }
    config = acquired.config;
  } else if (!config) {
    result.checked++;
    const parsed = parseConfigJson(input.text || '');
    if (!parsed.ok) throw new SourceImportError(`${parsed.errorCategory}: ${parsed.message}`, 400);
    config = parsed.config!;
  }
  const existing = new Map(context.sources.map(entry => [entry.url, entry]));
  if (!isMultiRepoConfig(config!)) {
    const entry = source || { name: 'Inline Config', url: `inline://${INLINE_PREFIX}${randomUUID()}` };
    try { prepareSourceLeaf(entry, config!); }
    catch (error) { throw new SourceImportError(message(error), 400); }
    plan.usable = 1;
    if (existing.has(entry.url)) result.duplicates++;
    else if (available === 0) result.skipped.push({ url: entry.url, name: entry.name, reason: sourceLimitMessage(limit), stage: 'capacity' });
    else {
      plan.entries.push(entry);
      if (!source) plan.inline = { key: entry.url.slice('inline://'.length), text: input.text! };
    }
  } else {
    result.type = 'multi';
    const entries = extractMultiRepoEntries(config!, source?.name || 'Imported');
    if (!entries.length) result.skipped.push({ reason: '多仓目录没有可导入的单仓地址', stage: 'directory' });
    const seen = new Set<string>();
    type Outcome = { entry?: SourceEntry; skip?: ImportSkip; duplicate?: boolean; usable?: boolean };
    const outcomes: Outcome[] = new Array(entries.length);
    const queued: Array<{ entry: SourceEntry; index: number }> = [];
    entries.forEach((raw, index) => {
      let entry: SourceEntry;
      try { entry = importSourceEntry(raw); }
      catch (error) { outcomes[index] = { skip: { name: raw.name, url: raw.url.split(';pk;')[0], reason: message(error), stage: 'input' } }; return; }
      if (entry.url === source?.url) {
        outcomes[index] = { skip: { name: entry.name, url: entry.url, reason: '跳过目录自引用', stage: 'directory' } }; return;
      }
      if (seen.has(entry.url)) { outcomes[index] = { duplicate: true }; return; }
      seen.add(entry.url);
      if (existing.has(entry.url) && context.knownLeaves.has(entry.url)) {
        outcomes[index] = { duplicate: true, usable: true }; return;
      }
      queued.push({ entry: existing.get(entry.url) || entry, index });
    });
    let cursor = 0;
    let accepted = 0;
    while (cursor < queued.length) {
      const slots = available === null ? 4 : available - accepted;
      if (slots <= 0) {
        for (const { entry, index } of queued.slice(cursor)) outcomes[index] = existing.has(entry.url)
          ? { duplicate: true } : { skip: { url: entry.url, name: entry.name, reason: sourceLimitMessage(limit), stage: 'capacity' } };
        break;
      }
      const batch = queued.slice(cursor, cursor + Math.min(4, slots));
      cursor += batch.length;
      await Promise.all(batch.map(async ({ entry, index }) => {
        result.checked++;
        const acquired = await inspectSourceOnce(entry, context.timeoutMs);
        if (!acquired.config) { outcomes[index] = { skip: fetchFailure(acquired.fetchResult) }; return; }
        if (isMultiRepoConfig(acquired.config)) {
          outcomes[index] = { skip: { url: entry.url, name: entry.name, reason: '不支持嵌套多仓，已跳过', stage: 'directory' } }; return;
        }
        try {
          prepareSourceLeaf(entry, acquired.config);
          outcomes[index] = existing.has(entry.url) ? { duplicate: true, usable: true } : { entry, usable: true };
        } catch (error) { outcomes[index] = { skip: { url: entry.url, name: entry.name, reason: message(error), stage: 'preparation' } }; }
      }));
      accepted += batch.filter(({ index }) => !!outcomes[index].entry).length;
    }
    for (const outcome of outcomes) {
      if (outcome.entry) plan.entries.push(outcome.entry);
      if (outcome.duplicate) result.duplicates++;
      if (outcome.skip) result.skipped.push(outcome.skip);
      if (outcome.usable) plan.usable++;
    }
  }
  result.added = plan.entries.length;
  result.sources = plan.entries.map(entry => entry.url);
  result.success = result.added > 0;
  result.capacity = sourceCapacity(context.sources.length + result.added, limit, result.skipped.filter(item => item.stage === 'capacity').length);
  result.outcome = result.added ? result.skipped.length ? 'partial' : 'added'
    : result.duplicates && !result.skipped.length ? 'duplicates_only' : 'none';
  return plan;
}
