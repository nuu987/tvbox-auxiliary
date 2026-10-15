import type { Storage } from '../storage/interface';
import type { AppConfig, FlatMigrationReport, ImportSkip, SourceEntry, TVBoxConfig } from './types';
import { SOURCE_HEALTH, SOURCE_IMPORT_POLICY_STATE, SOURCE_OUTPUT_STATE, SOURCE_IMPORT_POLICY } from './config';
import { captureSourceBaseline, fingerprint, migrationSourceValues, rememberSourceMigration, withSourceGate } from './source-fallback';
import { migrationOutputState, type OutputRunTicket } from './aggregate-output';
import { inspectSourceOnce, isMultiRepoConfig, parseConfigJson } from './fetcher';
import { planSourceImport } from './source-import';
import { readImportPolicy, type ImportPolicyState, type PendingIdentity } from './source-import-state';
import { selectDataSources, sourceLimit } from './source-capacity';

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Safe flat public projection; never return policy identities/configuration/key material. */
export async function sourceMigrationReport(storage: Storage): Promise<FlatMigrationReport | null> {
  const report = readImportPolicy(await storage.get(SOURCE_IMPORT_POLICY_STATE))?.report;
  if (!report) return null;
  return { savedAt: report.savedAt, added: report.added, duplicates: report.duplicates,
    skipped: report.skipped.map(s => ({ url: s.url, name: s.name, reason: s.reason, stage: s.stage })),
    removed: report.removed.map(s => ({ url: s.url, name: s.name, reason: s.reason })) };
}

/** Called only after actual run activation and before scraping/network/normal leaf round. */
export async function prepareImportOnlyRun(storage: Storage, config: AppConfig, ticket: OutputRunTicket): Promise<OutputRunTicket> {
  const capture = await withSourceGate(storage, async () => {
    await migrationOutputState(storage, ticket, false);
    const policyRaw = await storage.get(SOURCE_IMPORT_POLICY_STATE);
    const policy = readImportPolicy(policyRaw);
    if (policy?.completedAt) return null;
    return { baseline: await captureSourceBaseline(storage), policy, policyRaw };
  });
  if (!capture) return ticket;
  const { baseline, policy, policyRaw } = capture;
  const limit = sourceLimit(config);
  const eligible = new Set(selectDataSources(baseline.sources, limit).map(source => source.url));
  const initial = baseline.sources.filter(source => !baseline.knownLeaves.has(source.url));
  const pending = policy ? policy.remaining.filter(identity => {
    const node = baseline.registry.nodes[identity.url];
    return baseline.registry.roots[identity.url] === identity.fingerprint && node?.generation === identity.generation;
  }).map(identity => baseline.sources.find(source => source.url === identity.url)!) : initial;
  // Type proofs committed by Add/Import need no migration or second inspection.
  const work = pending.filter(source => !baseline.knownLeaves.has(source.url));
  const effective = new Map(baseline.sources.map(source => [source.url, source]));
  const checkedLeaves = new Set(baseline.knownLeaves);
  const remaining: PendingIdentity[] = [];
  const report: FlatMigrationReport = {
    savedAt: new Date().toISOString(), added: policy?.report.added || 0, duplicates: policy?.report.duplicates || 0,
    skipped: [], removed: [...(policy?.report.removed || [])],
  };
  // Preserve completed diagnostics, replace only unresolved attempts on a later run.
  const pendingUrls = new Set(work.map(source => source.url));
  report.skipped.push(...(policy?.report.skipped || []).filter(skip => !skip.url || !pendingUrls.has(skip.url)));
  for (const source of work) {
    if (!eligible.has(source.url)) {
      remaining.push({ url: source.url, fingerprint: fingerprint(source), generation: baseline.registry.nodes[source.url].generation });
      continue;
    }
    let current: TVBoxConfig | null = null;
    let failure: ImportSkip | undefined;
    if (source.url.startsWith('inline://')) {
      const raw = await storage.get(source.url.slice('inline://'.length));
      const parsed = parseConfigJson(raw || '');
      if (parsed.ok) current = parsed.config!;
      else failure = { url: source.url, name: source.name, reason: `${parsed.errorCategory}: ${parsed.message}`, stage: 'parse' };
    } else {
      const acquired = await inspectSourceOnce(source, config.fetchTimeoutMs);
      current = acquired.config;
      if (!current) failure = { url: source.url, name: source.name, reason: acquired.fetchResult.errorMessage || acquired.fetchResult.status,
        stage: acquired.fetchResult.status === 'decode_error' ? 'decode' : acquired.fetchResult.status === 'parse_error' ? 'parse' : 'acquisition' };
    }
    const directory = baseline.knownDirectories.has(source.url) || (!!current && isMultiRepoConfig(current));
    if (!directory) {
      if (current) checkedLeaves.add(source.url); // Classification is not success qualification.
      else {
        const node = baseline.registry.nodes[source.url];
        remaining.push({ url: source.url, fingerprint: fingerprint(source), generation: node.generation });
        if (failure) report.skipped.push(failure);
      }
      continue;
    }
    let reason = failure?.reason || '已转换为独立单仓';
    effective.delete(source.url); // A confirmed old parent releases its slot before children are admitted.
    if (current && isMultiRepoConfig(current)) {
      const plan = await planSourceImport(source.url.startsWith('inline://') ? { config: current } : { source, config: current },
        { sources: [...effective.values()], knownLeaves: checkedLeaves, timeoutMs: config.fetchTimeoutMs, maxDataSources: limit });
      for (const entry of plan.entries) { effective.set(entry.url, entry); checkedLeaves.add(entry.url); }
      report.added += plan.result.added; report.duplicates += plan.result.duplicates;
      report.skipped.push(...plan.result.skipped);
      if (!plan.usable) reason = plan.result.capacity?.rejected ? '容量已满，子接口未检查，已移除旧多仓' : '没有可用的直接单仓，已移除旧多仓';
    } else if (current) reason = '旧多仓当前内容不是目录，已移除';
    else if (failure) report.skipped.push(failure);
    effective.delete(source.url);
    report.removed.push({ url: source.url, name: source.name, reason });
  }
  const sources: SourceEntry[] = [...effective.values()];
  const state: ImportPolicyState = { version: 1, policy: SOURCE_IMPORT_POLICY, startedAt: policy?.startedAt || report.savedAt,
    remaining, report, ...(!remaining.length ? { completedAt: report.savedAt } : {}) };
  return withSourceGate(storage, async () => {
    const current = await captureSourceBaseline(storage);
    if (current.token !== baseline.token || current.reportsRaw !== baseline.reportsRaw
      || await storage.get(SOURCE_IMPORT_POLICY_STATE) !== policyRaw) throw new Error('Sources changed during migration; run again');
    const output = await migrationOutputState(storage, ticket, JSON.stringify(sources) !== JSON.stringify(baseline.sources));
    const prepared = migrationSourceValues(baseline, sources, checkedLeaves);
    const healthRaw = await storage.get(SOURCE_HEALTH);
    const health: unknown = healthRaw ? JSON.parse(healthRaw) : [];
    if (!Array.isArray(health)) throw new Error('Invalid source health records');
    await storage.putMany({ ...prepared.values,
      [SOURCE_HEALTH]: JSON.stringify(health.filter(record => object(record) && effective.has(String(record.url)))),
      [SOURCE_IMPORT_POLICY_STATE]: JSON.stringify(state), [SOURCE_OUTPUT_STATE]: output.value });
    rememberSourceMigration(storage, prepared.registry);
    return output.ticket;
  });
}
