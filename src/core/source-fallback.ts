import { createHash, randomUUID } from 'crypto';
import type { Storage } from '../storage/interface';
import type { SourceEntry, TVBoxConfig } from './types';
import { MANUAL_SOURCES, SOURCE_CONFIG_SNAPSHOTS, SOURCE_PROCESSING_REPORT, SOURCE_OUTPUT_STATE, SOURCE_URLS, SOURCE_IMPORT_POLICY_STATE } from './config';
import { withSourceGate } from './source-gate';
import { activateOutputRun, pendingOutputState, type OutputRunTicket } from './aggregate-output';
export { withSourceGate } from './source-gate';
import { isMultiRepoConfig } from './fetcher';
import { prepareSourceLeaf } from './source-leaf';
import { readImportPolicy } from './source-import-state';
import { logger } from './logger';

type Kind = 'leaf' | 'index';
type FailureStage = 'acquisition' | 'local_read' | 'preparation';
interface Snapshot {
  version: 1 | 2;
  url: string;
  fingerprint: string;
  generation: string;
  kind: Kind;
  savedAt: string;
  config: TVBoxConfig;
}
interface Node {
  fingerprint: string;
  generation: string;
  name: string;
  children?: string[];
  classification?: Kind;
  snapshot?: Snapshot;
}
interface Registry {
  version: 1 | 2;
  revision: string;
  roots: Record<string, string>;
  nodes: Record<string, Node>;
}
interface Observation {
  url: string;
  name: string;
  generation: string;
  kind: Kind;
  mode: 'fresh' | 'restored' | 'skipped';
  reason?: string;
  stage?: FailureStage;
  snapshotTime?: string;
  local: boolean;
}
interface RoundReport {
  roundId: string;
  attemptedAt: string;
  savedAt?: string;
  outcome: 'saved' | 'failed' | 'no_configs';
  observations: Observation[];
  identities: Record<string, string>;
}
interface Reports { version: 2; latest: RoundReport; lastSuccessful?: RoundReport }

/** Optional API metadata; acquisition health remains a separate, truthful record. */
export interface SourceAggregationStatus {
  latest?: {
    roundId: string;
    attemptedAt: string;
    outcome: RoundReport['outcome'];
    kind: Kind;
    mode: Observation['mode'];
    reason?: string;
    stage?: FailureStage;
  };
  lastSuccessful?: {
    roundId: string;
    savedAt: string;
    kind: Kind;
    fallbackApplied: boolean;
    snapshotTime?: string;
  };
}

// Retain lifecycle metadata (never cached payloads) when the registry cannot be read.
const lifecycleState = new WeakMap<Storage, Registry>();

export function fingerprint(source: SourceEntry): string {
  return createHash('sha256').update(source.configKey || '').digest('hex');
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function emptyRegistry(): Registry { return { version: 2, revision: 'empty', roots: {}, nodes: {} }; }
function unavailableRegistry(storage: Storage): Registry {
  const registry = copy(lifecycleState.get(storage) || emptyRegistry());
  for (const node of Object.values(registry.nodes)) delete node.snapshot;
  return registry;
}
function rememberLifecycle(storage: Storage, registry: Registry): void {
  const metadata = copy(registry);
  for (const node of Object.values(metadata.nodes)) delete node.snapshot;
  lifecycleState.set(storage, metadata);
}
async function persistRegistry(storage: Storage, registry: Registry): Promise<void> {
  await storage.put(SOURCE_CONFIG_SNAPSHOTS, JSON.stringify(registry));
  rememberLifecycle(storage, registry);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function loadRegistry(storage: Storage): Promise<Registry> {
  try {
    const raw = await storage.get(SOURCE_CONFIG_SNAPSHOTS);
    if (!raw) return unavailableRegistry(storage);
    const data: unknown = JSON.parse(raw);
    if (!record(data) || ![1, 2].includes(Number(data.version)) || typeof data.revision !== 'string' || !data.revision || !record(data.roots) || !record(data.nodes)) {
      throw new Error('Unsupported or invalid source registry');
    }
    const registry = emptyRegistry();
    registry.version = data.version as 1 | 2;
    registry.revision = data.revision;
    for (const [url, key] of Object.entries(data.roots)) {
      if (typeof key !== 'string') throw new Error('Invalid root identity');
      registry.roots[url] = key;
    }
    for (const [url, value] of Object.entries(data.nodes)) {
      if (!record(value) || typeof value.fingerprint !== 'string' || typeof value.generation !== 'string' || !value.generation
        || typeof value.name !== 'string'
        || (data.version === 1 && (!Array.isArray(value.children) || value.children.some(c => typeof c !== 'string')))) continue;
      const node: Node = { fingerprint: value.fingerprint, generation: value.generation, name: value.name };
      if (data.version === 1) node.children = value.children as string[];
      if (value.classification === 'leaf' || value.classification === 'index') node.classification = value.classification;
      const s = value.snapshot;
      if (record(s) && s.version === data.version && s.url === url && s.fingerprint === node.fingerprint && s.generation === node.generation
        && (s.kind === 'leaf' || (data.version === 1 && s.kind === 'index')) && typeof s.savedAt === 'string' && Number.isFinite(Date.parse(s.savedAt)) && record(s.config)) {
        node.snapshot = s as unknown as Snapshot;
      }
      if (node.snapshot && isMultiRepoConfig(node.snapshot.config) === (node.snapshot.kind === 'index')) node.classification = node.snapshot.kind;
      registry.nodes[url] = node;
    }
    rememberLifecycle(storage, registry);
    return registry;
  } catch (error) {
    logger.warn('source-fallback', `Registry unavailable; fresh acquisition remains enabled: ${message(error)}`);
    return unavailableRegistry(storage);
  }
}

async function rootsFromStorage(storage: Storage): Promise<SourceEntry[]> {
  const raw = await storage.get(MANUAL_SOURCES);
  const sources: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(sources)) throw new Error('Invalid stored source list');
  return sources as SourceEntry[];
}

function prune(registry: Registry): void {
  const reached = new Set<string>();
  const visit = (url: string) => {
    if (reached.has(url)) return;
    reached.add(url);
    if (registry.version === 1) for (const child of registry.nodes[url]?.children || []) visit(child);
  };
  for (const url of Object.keys(registry.roots)) visit(url);
  for (const url of Object.keys(registry.nodes)) if (!reached.has(url)) delete registry.nodes[url];
}

function reconcile(registry: Registry, sources: SourceEntry[]): boolean {
  const before = JSON.stringify(registry);
  registry.roots = Object.fromEntries(sources.map(source => [source.url, fingerprint(source)]));
  for (const source of sources) {
    const key = fingerprint(source);
    const node = registry.nodes[source.url];
    if (!node || node.fingerprint !== key) {
      registry.nodes[source.url] = { fingerprint: key, generation: randomUUID(), name: source.name, ...(registry.version === 1 ? { children: [] } : {}) };
    } else node.name = source.name;
  }
  prune(registry);
  const changed = before !== JSON.stringify(registry);
  if (changed) registry.revision = randomUUID();
  return changed;
}

function revokedRoots(previous: Record<string, string>, sources: SourceEntry[]): boolean {
  const next = new Map(sources.map(source => [source.url, fingerprint(source)]));
  return Object.entries(previous).some(([url, key]) => next.get(url) !== key);
}

/** Caller holds the gate. Persist list, identities and pending output invalidation together. */
export async function saveSourceRoots(storage: Storage, sources: SourceEntry[], extra: Record<string, string> = {}, checkedLeaves: string[] = []): Promise<void> {
  const previous = await rootsFromStorage(storage);
  const registry = await loadRegistry(storage);
  const revoked = revokedRoots(Object.fromEntries(previous.map(source => [source.url, fingerprint(source)])), sources)
    || revokedRoots(registry.roots, sources);
  let changed = reconcile(registry, sources);
  for (const url of checkedLeaves) if (registry.nodes[url] && registry.nodes[url].classification !== 'leaf') {
    registry.nodes[url].classification = 'leaf'; changed = true; registry.revision = randomUUID();
  }
  const values: Record<string, string> = { ...extra, [MANUAL_SOURCES]: JSON.stringify(sources), [SOURCE_URLS]: JSON.stringify(sources) };
  if (changed || revoked) values[SOURCE_CONFIG_SNAPSHOTS] = JSON.stringify(registry);
  if (revoked) values[SOURCE_OUTPUT_STATE] = await pendingOutputState(storage);
  await storage.putMany(values);
  rememberLifecycle(storage, registry);
}

/** Actual aggregation entry: reconcile external list/key edits before auto-scraping or fetch. */
export async function beginSourceOutputRun(storage: Storage): Promise<OutputRunTicket> {
  return withSourceGate(storage, async () => {
    let sources: SourceEntry[];
    let registry: Registry;
    let revoked: boolean;
    let changed: boolean;
    try {
      // Before migration, do not overwrite a readable-on-retry legacy registry
      // with empty fallback metadata merely because this read failed.
      const policy = readImportPolicy(await storage.get(SOURCE_IMPORT_POLICY_STATE));
      if (!policy?.completedAt) {
        await storage.get(SOURCE_CONFIG_SNAPSHOTS);
        await storage.get(SOURCE_PROCESSING_REPORT);
      }
      sources = await rootsFromStorage(storage);
      registry = await loadRegistry(storage);
      revoked = revokedRoots(registry.roots, sources);
      changed = reconcile(registry, sources);
    }
    catch (error) {
      // Even a malformed/unreadable list cannot bypass pending/legacy activation.
      await activateOutputRun(storage, false, {});
      throw error;
    }
    const ticket = await activateOutputRun(storage, revoked, {
      [SOURCE_URLS]: JSON.stringify(sources),
      ...(changed ? { [SOURCE_CONFIG_SNAPSHOTS]: JSON.stringify(registry) } : {}),
    });
    rememberLifecycle(storage, registry);
    return ticket;
  });
}

export class SourceFallbackRound {
  readonly roundId = randomUUID();
  readonly attemptedAt = new Date().toISOString();
  private candidates = new Map<string, { config: TVBoxConfig; kind: Kind }>();
  private observations = new Map<string, Observation>();
  private staged: Registry;
  private savedAt?: string;
  private roots: Map<string, SourceEntry>;

  private constructor(private storage: Storage, private baseline: Registry, sources: SourceEntry[]) {
    this.staged = copy(baseline);
    this.roots = new Map(sources.map(source => [source.url, source]));
  }

  static async begin(storage: Storage): Promise<SourceFallbackRound> {
    return withSourceGate(storage, async () => {
      const sources = await rootsFromStorage(storage);
      const registry = await loadRegistry(storage);
      const revoked = revokedRoots(registry.roots, sources);
      if (reconcile(registry, sources)) {
        try {
          const values: Record<string, string> = { [SOURCE_CONFIG_SNAPSHOTS]: JSON.stringify(registry), [SOURCE_URLS]: JSON.stringify(sources) };
          if (revoked) values[SOURCE_OUTPUT_STATE] = await pendingOutputState(storage);
          await storage.putMany(values);
          rememberLifecycle(storage, registry);
        } catch (error) {
          if (revoked) throw error;
          logger.warn('source-fallback', `Identity persistence failed: ${message(error)}`);
        }
      }
      return new SourceFallbackRound(storage, registry, sources);
    });
  }

  // Use the current persisted identity for each independent source.
  source = (source: SourceEntry): SourceEntry => this.roots.get(source.url) || source;

  sourceEntries(): SourceEntry[] { return copy([...this.roots.values()]); }

  activeUrls(): Set<string> {
    return new Set([...Object.keys(this.baseline.nodes), ...Object.keys(this.staged.nodes)]);
  }

  private node(source: SourceEntry): Node {
    const key = fingerprint(source);
    let node = this.staged.nodes[source.url];
    if (!node || node.fingerprint !== key) {
      node = { fingerprint: key, generation: randomUUID(), name: source.name };
      this.staged.nodes[source.url] = node;
    }
    return node;
  }

  resolve = (source: SourceEntry, config: TVBoxConfig | null, result: { status: string; errorMessage?: string }, _depth = 0): { config: TVBoxConfig; prepared?: boolean } | null => {
    source = this.source(source);
    const node = this.node(source);
    const observation: Observation = {
      url: source.url, name: source.name, generation: node.generation,
      kind: node.snapshot?.kind || 'leaf', mode: 'skipped', local: source.url.startsWith('inline://'),
    };
    this.observations.set(source.url, observation);

    const prepare = (raw: TVBoxConfig): { config: TVBoxConfig; prepared?: boolean } => {
      if (isMultiRepoConfig(raw)) {
        observation.kind = 'index';
        throw new Error('多仓仅用于导入，不参与聚合或缓存复用');
      }
      observation.kind = 'leaf';
      return { config: prepareSourceLeaf(source, raw), prepared: true };
    };

    if (result.status === 'ok' && config) {
      try {
        const resolved = prepare(config);
        observation.mode = 'fresh';
        node.classification = 'leaf';
        this.candidates.set(source.url, { config: copy(config), kind: 'leaf' });
        return resolved;
      } catch (error) { observation.reason = message(error); observation.stage = 'preparation'; }
    } else {
      observation.reason = result.errorMessage || result.status;
      observation.stage = observation.local ? 'local_read' : 'acquisition';
    }

    const snapshot = node.snapshot;
    if (snapshot?.kind === 'leaf') {
      logger.infoFields('source-fallback', 'restore-attempt', { roundId: this.roundId, url: source.url, kind: snapshot.kind, stage: observation.stage, reason: observation.reason, snapshotTime: snapshot.savedAt });
      try {
        // Recheck semantic kind and prepare under today's rules, with no second attempt.
        if (isMultiRepoConfig(snapshot.config)) throw new Error('Snapshot kind mismatch');
        const resolved = prepare(snapshot.config);
        observation.mode = 'restored';
        observation.snapshotTime = snapshot.savedAt;
        return resolved;
      } catch (error) {
        logger.warnFields('source-fallback', 'snapshot-unusable', { url: source.url, message: message(error) });
        observation.reason += `; snapshot unusable: ${message(error)}`;
      }
    }
    logger.warnFields('source-fallback', 'source-skipped', { roundId: this.roundId, url: source.url, stage: observation.stage, reason: observation.reason });
    return null;
  };

  /** Save output only after checking lifecycle state again, then publish fresh candidates. */
  async commit(saveOutput: (savedAt: string) => Promise<void>): Promise<void> {
    await withSourceGate(this.storage, async () => {
      const current = await loadRegistry(this.storage);
      const sources = await rootsFromStorage(this.storage);
      const revoked = revokedRoots(current.roots, sources);
      const changed = reconcile(current, sources);
      if (changed) {
        const values: Record<string, string> = { [SOURCE_CONFIG_SNAPSHOTS]: JSON.stringify(current) };
        if (revoked) values[SOURCE_OUTPUT_STATE] = await pendingOutputState(this.storage);
        await this.storage.putMany(values);
        rememberLifecycle(this.storage, current);
      }
      if (current.revision !== this.baseline.revision) throw new Error('Source membership changed during aggregation; run again');
      const savedAt = new Date().toISOString();
      await saveOutput(savedAt);
      this.savedAt = savedAt;
      for (const [url, candidate] of this.candidates) {
        const node = this.staged.nodes[url];
        node.snapshot = { version: 2, url, fingerprint: node.fingerprint, generation: node.generation,
          kind: candidate.kind, savedAt, config: copy(candidate.config) };
      }
      this.staged = flattenRegistry(this.staged, [...this.roots.values()]);
      prune(this.staged);
      this.staged.revision = randomUUID();
      try { await persistRegistry(this.storage, this.staged); }
      catch (error) { logger.error('source-fallback', `Output saved but snapshot publication failed: ${message(error)}`); }
      for (const observation of this.observations.values()) if (observation.mode === 'restored') {
        logger.infoFields('source-fallback', 'restore-applied', { roundId: this.roundId, savedAt, url: observation.url, kind: observation.kind, snapshotTime: observation.snapshotTime });
      }
    });
  }

  async finish(outcome: 'failed' | 'no_configs'): Promise<void> {
    try {
      await withSourceGate(this.storage, async () => {
        const previous = await loadReports(this.storage);
        const latest: RoundReport = {
          roundId: this.roundId, attemptedAt: this.attemptedAt, savedAt: this.savedAt,
          outcome: this.savedAt ? 'saved' : outcome, observations: [...this.observations.values()],
          identities: Object.fromEntries([...this.roots.keys()].map(url => [url, this.staged.nodes[url].generation])),
        };
        const reports: Reports = { version: 2, latest,
          lastSuccessful: this.savedAt ? latest : previous?.lastSuccessful };
        // Do not let an older overlapping round replace newer diagnostics.
        if (!previous || previous.latest.attemptedAt <= latest.attemptedAt) {
          await this.storage.put(SOURCE_PROCESSING_REPORT, JSON.stringify(reports));
        }
      });
    } catch (error) { logger.warn('source-fallback', `Processing report unavailable: ${message(error)}`); }
  }
}

function decodeReport(value: unknown): RoundReport | null {
  if (!record(value) || typeof value.roundId !== 'string' || typeof value.attemptedAt !== 'string'
    || !['saved', 'failed', 'no_configs'].includes(String(value.outcome))
    || (value.outcome === 'saved' && (typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))))
    || !Array.isArray(value.observations) || !value.observations.every(o => record(o) && typeof o.url === 'string'
      && typeof o.name === 'string' && typeof o.generation === 'string' && typeof o.local === 'boolean'
      && ['leaf', 'index'].includes(String(o.kind)) && ['fresh', 'restored', 'skipped'].includes(String(o.mode))
      && (o.stage === undefined || ['acquisition', 'local_read', 'preparation'].includes(String(o.stage)))
      && (o.reason === undefined || typeof o.reason === 'string') && (o.snapshotTime === undefined || typeof o.snapshotTime === 'string'))) return null;
  let identities: Record<string, string>;
  if (record(value.identities) && Object.values(value.identities).every(g => typeof g === 'string')) {
    identities = value.identities as Record<string, string>;
  } else if (record(value.lineage) && Object.values(value.lineage).every(n => record(n) && typeof n.generation === 'string')) {
    identities = Object.fromEntries(Object.entries(value.lineage).map(([url, n]) => [url, (n as { generation: string }).generation]));
  } else return null;
  return { roundId: value.roundId, attemptedAt: value.attemptedAt, savedAt: value.savedAt as string | undefined,
    outcome: value.outcome as RoundReport['outcome'], observations: value.observations as Observation[], identities };
}
async function loadReports(storage: Storage): Promise<Reports | null> {
  try {
    const raw = await storage.get(SOURCE_PROCESSING_REPORT);
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (!record(data) || ![1, 2].includes(Number(data.version))) return null;
    const latest = decodeReport(data.latest);
    const lastSuccessful = data.lastSuccessful === undefined ? undefined : decodeReport(data.lastSuccessful);
    if (!latest || (data.lastSuccessful !== undefined && lastSuccessful?.outcome !== 'saved')) return null;
    return { version: 2, latest, ...(lastSuccessful ? { lastSuccessful } : {}) };
  } catch { return null; }
}

/** Snapshot identity and payload are retained only for effective independent leaves. */
function flattenRegistry(registry: Registry, sources: SourceEntry[]): Registry {
  const flat = copy(registry);
  // Include promoted children before pruning legacy reachability.
  reconcile(flat, sources);
  flat.version = 2;
  for (const [url, node] of Object.entries(flat.nodes)) {
    delete node.children;
    if (!flat.roots[url]) { delete flat.nodes[url]; continue; }
    if (node.snapshot?.kind === 'leaf' && !isMultiRepoConfig(node.snapshot.config)) node.snapshot.version = 2;
    else delete node.snapshot;
  }
  return flat;
}
function flatReports(reports: Reports | null, registry: Registry): Reports | null {
  if (!reports) return null;
  const filter = (report: RoundReport): RoundReport => ({ ...report,
    identities: Object.fromEntries(Object.entries(report.identities).filter(([url, generation]) => registry.roots[url] && registry.nodes[url]?.generation === generation)),
    observations: report.observations.filter(o => registry.roots[o.url] && registry.nodes[o.url]?.generation === o.generation && o.kind === 'leaf'),
  });
  return { version: 2, latest: filter(reports.latest), ...(reports.lastSuccessful ? { lastSuccessful: filter(reports.lastSuccessful) } : {}) };
}

/** Caller holds the gate. Raw comparison token is private and catches key/re-add/cache races. */
export async function captureSourceBaseline(storage: Storage) {
  const sourcesRaw = await storage.get(MANUAL_SOURCES);
  const registryRaw = await storage.get(SOURCE_CONFIG_SNAPSHOTS);
  const reportsRaw = await storage.get(SOURCE_PROCESSING_REPORT);
  const sources = await rootsFromStorage(storage);
  const registry = await loadRegistry(storage);
  reconcile(registry, sources);
  const reports = await loadReports(storage);
  const knownLeaves = new Set<string>();
  const knownDirectories = new Set<string>();
  for (const source of sources) {
    const node = registry.nodes[source.url];
    let kind = node.classification;
    if (!kind) for (const report of [reports?.latest, reports?.lastSuccessful]) {
      const observation = report?.observations.find(o => o.url === source.url && o.generation === node.generation
        && report.identities[source.url] === node.generation);
      if (observation?.kind === 'index') kind = 'index';
    }
    if (kind === 'leaf') knownLeaves.add(source.url);
    if (kind === 'index') knownDirectories.add(source.url);
  }
  return { sources, registry, reports, knownLeaves, knownDirectories,
    token: JSON.stringify([sourcesRaw, registryRaw]), reportsRaw };
}
export type SourceBaseline = Awaited<ReturnType<typeof captureSourceBaseline>>;

/** Caller holds the gate; migration composes these values with its policy/owned-output batch. */
export function migrationSourceValues(baseline: SourceBaseline, sources: SourceEntry[], checkedLeaves: Set<string>) {
  const registry = flattenRegistry(baseline.registry, sources);
  registry.revision = randomUUID();
  for (const url of checkedLeaves) if (registry.nodes[url]) registry.nodes[url].classification = 'leaf';
  const reports = flatReports(baseline.reports, registry);
  const values: Record<string, string> = { [MANUAL_SOURCES]: JSON.stringify(sources), [SOURCE_URLS]: JSON.stringify(sources),
    [SOURCE_CONFIG_SNAPSHOTS]: JSON.stringify(registry), [SOURCE_PROCESSING_REPORT]: JSON.stringify(reports) };
  return { registry, values };
}
export function rememberSourceMigration(storage: Storage, registry: SourceBaseline['registry']): void { rememberLifecycle(storage, registry); }

/** Project only effective generation-matched independent source reports. */
export async function sourceAggregationStatuses(storage: Storage): Promise<Map<string, { name: string; local: boolean; aggregation: SourceAggregationStatus }>> {
  const registry = await loadRegistry(storage);
  reconcile(registry, await rootsFromStorage(storage));
  const reports = await loadReports(storage);
  const statuses = new Map<string, { name: string; local: boolean; aggregation: SourceAggregationStatus }>();
  if (!reports) return statuses;
  for (const report of [reports.latest, reports.lastSuccessful]) {
    if (!report) continue;
    for (const o of report.observations) {
      if (!registry.roots[o.url] || registry.nodes[o.url]?.generation !== o.generation || report.identities[o.url] !== o.generation) continue;
      const status = statuses.get(o.url) || { name: o.name, local: o.local, aggregation: {} };
      if (report === reports.latest) status.aggregation.latest = {
        roundId: report.roundId, attemptedAt: report.attemptedAt, outcome: report.outcome, kind: o.kind, mode: o.mode, reason: o.reason, stage: o.stage,
      };
      if (report === reports.lastSuccessful && report.savedAt) status.aggregation.lastSuccessful = {
        roundId: report.roundId, savedAt: report.savedAt, kind: o.kind,
        fallbackApplied: o.mode === 'restored', snapshotTime: o.snapshotTime,
      };
      statuses.set(o.url, status);
    }
  }
  return statuses;
}
