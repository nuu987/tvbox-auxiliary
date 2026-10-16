import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Storage } from '../src/storage/interface';
import type { SourceEntry, TVBoxConfig, TVBoxSite, AppConfig } from '../src/core/types';
import { SourceFallbackRound, withSourceGate, saveSourceRoots, sourceAggregationStatuses } from '../src/core/source-fallback';
import { fetchConfigs, fetchSingleConfig, parseConfigJson } from '../src/core/fetcher';
import { decodeConfigResponse } from '../src/core/decoder';
import { mergeConfigs } from '../src/core/merger';
import { JsonFileStorage } from '../src/storage/json-file';
import { runSync } from '../src/syncer';
import { createApp } from '../src/routes';
import { createSourceMgmtRouter } from '../src/routes/source-management';
import { createDashboardRouter } from '../src/routes/dashboard';
import { createConfigOutputRouter } from '../src/routes/config-output';
import { createConfigEditorRouter } from '../src/routes/config-editor';
import { createExportConfigRouter } from '../src/routes/export-config';
import { createCloudCredRouter } from '../src/routes/cloud-credentials';
import { createRefreshRouter } from '../src/routes/refresh';
import { createJarProxyRouter } from '../src/routes/jar-proxy';
import { downloadResource, parseSpiderString, urlToKey } from '../src/core/jar-proxy';
import { getSiteResourceDir } from '../src/core/site-store';
import { createLiveSourcesRouter } from '../src/routes/live-sources';
import { createSettingsRouter } from '../src/routes/settings';
import { readAggregateOutputs, publishAggregatePatch } from '../src/core/aggregate-output';
import { beginSourceOutputRun, fingerprint, captureSourceBaseline } from '../src/core/source-fallback';
import { prepareImportOnlyRun, sourceMigrationReport } from '../src/core/source-import-policy';
import { patchMergedConfig } from '../src/core/blacklist';
import { logger, subscribeLogSink } from '../src/core/logger';
import type { LogEntry } from '../src/core/logger';
import { _resetForTest as resetLogBuffer, _getSubscriberCountForTest as logSubscriberCount,
  getHistory as logHistory } from '../src/core/log-buffer';
import { createLogViewerRouter } from '../src/routes/log-viewer';
import { sharedUi } from '../src/core/shared-ui';
import { liveCacheKey, projectLiveAddress, loadLiveCache, liveCacheView, refreshLiveCache } from '../src/core/live-cache';
import { createLiveCacheRouter } from '../src/routes/live-cache';
import { normalizePlaylist } from '../src/core/live-playlist';
import { loadLivePolicy } from '../src/core/live-policy';
import { cacheableLive } from '../src/core/live-source';
import { parseMaxDataSources, sourceLimit } from '../src/core/source-capacity';
import { createSyncRunner, sourceActivity, SourceActivity } from '../src/core/source-activity';
import { ImportCacheRound, IMPORT_CACHE_TTL_MS } from '../src/core/source-import-cache';
import { adminHtml } from '../src/core/admin';
import { dashboardHtml } from '../src/core/dashboard';
import { configEditorHtml } from '../src/core/config-editor';
import { encodeSiteSourceAttribution } from '../src/core/site-source-attribution';
import { Script, createContext } from 'node:vm';
import { createCipheriv } from 'node:crypto';
import { BLACKLIST, MANUAL_SOURCES, MERGED_CONFIG, LAST_UPDATE, SOURCE_CONFIG_SNAPSHOTS,
  SOURCE_PROCESSING_REPORT, SOURCE_HEALTH, MACCMS_SOURCES,
  MERGED_CONFIG_FULL, EXPORT_CONFIG, SOURCE_OUTPUT_STATE, SOURCE_IMPORT_POLICY_STATE, SOURCE_URLS,
  SITE_SOURCE_ATTRIBUTION, EDGE_PROXIES, LIVE_DISABLED, LIVE_SOURCES, SMART_JAR_URL_ENABLED,
  LIVE_CACHE_STATE, NAME_TRANSFORM, SOURCE_IMPORT_CACHE } from '../src/core/config';

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  failPut?: string;
  failGet?: string;
  failBatch?: (values: Record<string, string>) => boolean;
  async get(key: string) { if (key === this.failGet) throw new Error('read failed'); return this.data.get(key) ?? null; }
  async put(key: string, value: string) { if (key === this.failPut) throw new Error('write failed'); this.data.set(key, value); }
  async putMany(values: Record<string, string>) {
    if ((this.failPut && this.failPut in values) || this.failBatch?.(values)) throw new Error('write failed');
    for (const [key, value] of Object.entries(values)) this.data.set(key, value);
  }
  async delete(key: string) { this.data.delete(key); }
  async list(prefix: string) { return [...this.data.keys()].filter(key => key.startsWith(prefix)); }
}
const A: SourceEntry = { url: 'https://a.test/config.json', name: 'A' };
const B: SourceEntry = { url: 'https://b.test/config.json', name: 'B' };
const M: SourceEntry = { url: 'https://m.test/config.json', name: 'M' };
const N: SourceEntry = { url: 'https://n.test/config.json', name: 'N' };
const config: AppConfig = { adminToken: 'test-token', fetchTimeoutMs: 200, siteTimeoutMs: 30 };
const leaf = (key: string): TVBoxConfig => ({ sites: [{ key, name: key, type: 3, api: `csp_${key}`, ext: { marker: key } }] });
const index = (...entries: SourceEntry[]): TVBoxConfig => ({ urls: entries.map(s => ({ name: s.name, url: s.url })) } as TVBoxConfig);
const ok = { status: 'ok' };
const failed = { status: 'decode_error', errorMessage: 'decode failed' };
const idleRuntime = { isSyncing: () => false, getPatchLock: () => false, setPatchLock: () => {} };
const adminHeaders = { Authorization: 'Bearer test-token' };
let directory: string;
let restoreMocks: (() => void)[] = [];
const realTimeout = globalThis.setTimeout;
function clock(value: number) {
  const original = Date.now;
  let now = value;
  Date.now = () => now;
  restoreMocks.push(() => { Date.now = original; });
  return (next: number) => { now = next; };
}
async function importCache(storage: Storage) { return JSON.parse((await storage.get(SOURCE_IMPORT_CACHE)) || '{"version":1,"entries":{}}'); }

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'tvbox-fallback-case-'));
  process.env.DATA_DIR = directory;
  // Preserve production retries but eliminate real backoff waits in mocked regressions.
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    realTimeout(fn, ms && ms >= 800 && ms <= 6000 ? 0 : ms, ...args)) as typeof setTimeout;
  for (const method of ['log', 'warn', 'error'] as const) {
    const original = console[method]; console[method] = () => {};
    restoreMocks.push(() => { console[method] = original; });
  }
});
afterEach(() => {
  for (const restore of restoreMocks.reverse()) restore();
  restoreMocks = [];
  globalThis.setTimeout = realTimeout;
  rmSync(directory, { recursive: true, force: true });
});

async function roots(storage: Storage, sources: SourceEntry[]) {
  await withSourceGate(storage, () => saveSourceRoots(storage, sources));
}
async function registry(storage: Storage) { return JSON.parse((await storage.get(SOURCE_CONFIG_SNAPSHOTS))!); }
async function snapshot(storage: Storage, source = A) { return (await registry(storage)).nodes[source.url]?.snapshot; }
async function publish(round: SourceFallbackRound) { await round.commit(async () => {}); await round.finish('no_configs'); }
async function seed(storage: Storage, sources = [A, B]) {
  await roots(storage, sources);
  const round = await SourceFallbackRound.begin(storage);
  for (const s of sources) round.resolve(s, leaf(s.name + '1'), ok);
  await publish(round);
}
function mockFetch(handler: (url: string, options?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => handler(String(input), options)) as typeof fetch;
  restoreMocks.push(() => { globalThis.fetch = original; });
}
async function outputState(storage: Storage) { return JSON.parse((await storage.get(SOURCE_OUTPUT_STATE))!); }
async function rawOutputs(storage: Storage) {
  return Promise.all([MERGED_CONFIG, MERGED_CONFIG_FULL, EXPORT_CONFIG].map(key => storage.get(key)));
}
async function legacyOutputs(storage: Storage) {
  const data = JSON.stringify(leaf('deleted-legacy'));
  await storage.putMany({ [MERGED_CONFIG]: data, [MERGED_CONFIG_FULL]: data, [EXPORT_CONFIG]: data });
}
async function assertUnavailableViews(storage: Storage) {
  const main = createConfigOutputRouter({ storage, config });
  assert.equal((await main.request('/')).status, 503);
  assert.equal((await main.request('/live-config')).status, 503);
  const exported = createExportConfigRouter({ storage, config, runtime: idleRuntime });
  assert.equal((await exported.request('/admin/export-config', { headers: adminHeaders })).status, 503);
  const editor = createConfigEditorRouter({ storage, config });
  assert.deepEqual(await (await editor.request('/admin/config-data', { headers: adminHeaders })).json(), { sites: [], parses: [], lives: [] });
  const dashboard = createDashboardRouter({ storage, config, runtime: idleRuntime });
  const counts = await (await dashboard.request('/status-data')).json() as { sites: number; parses: number; lives: number };
  assert.deepEqual([counts.sites, counts.parses, counts.lives], [0, 0, 0]);
  const risk = createCloudCredRouter({ storage, config });
  assert.equal((await risk.request('/admin/credential-risk-report', { headers: adminHeaders })).status, 404);
  assert.equal(await readAggregateOutputs(storage), null);
}
const response = (body: TVBoxConfig) => new Response(JSON.stringify(body), { status: 200 });
async function sourceRequest(storage: Storage, input: unknown, path = '/admin/sources/import', requestConfig: AppConfig = config) {
  return createSourceMgmtRouter({ storage, config: requestConfig }).request(path, { method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
/** Real v1 envelopes, including qualified children that are not yet direct roots. */
async function legacyDirectory(storage: Storage, children = [A, B], parents = [M]) {
  await seed(storage, children);
  const r = await registry(storage);
  r.version = 1;
  r.roots = Object.fromEntries(parents.map(source => [source.url, fingerprint(source)]));
  for (const node of Object.values(r.nodes) as any[]) {
    node.children = []; delete node.classification; node.snapshot.version = 1;
  }
  for (const source of parents) {
    const generation = 'legacy-' + source.name;
    r.nodes[source.url] = { name: source.name, generation, fingerprint: fingerprint(source), children: children.map(child => child.url),
      snapshot: { version: 1, url: source.url, generation, fingerprint: fingerprint(source), kind: 'index',
        savedAt: '2020-01-01T00:00:00.000Z', config: index(...children) } };
  }
  await storage.putMany({ [MANUAL_SOURCES]: JSON.stringify(parents), [SOURCE_CONFIG_SNAPSHOTS]: JSON.stringify(r) });
  return r;
}
async function status(storage: Storage) {
  const router = createDashboardRouter({ storage, config, runtime: { isSyncing: () => false, getPatchLock: () => false, setPatchLock: () => {} } });
  return (await router.request('/source-status')).json() as Promise<any>;
}

function compatibleFixture(key = 'compatible') {
  const marker = '优\n酷\r内容\r\n末尾';
  const input: TVBoxConfig = { sites: [{ key, name: key, type: 3, api: 'csp_compatible', style: { type: 'rect', ratio: 1.68 },
    ext: { marker, url: 'https://example.test/a//b/*c*/', escaped: 'literal \\n and "quote"' } }] };
  const text = '// TVBox configuration\r\n{/* metadata */' + JSON.stringify(input).slice(1)
    .replace(JSON.stringify(marker), '"' + marker + '"') + ' // EOF comment';
  return { input, text, marker };
}

test('strict JSON preserves escaped client values and does not emit compatibility diagnostics', () => {
  const input: TVBoxConfig = { sites: [{ key: 'strict', name: '中文', type: 3, api: 'csp_strict', style: { type: 'rect' },
    ext: { newline: 'a\nb', literal: 'a\\nb', quote: '"quoted"', slash: '\\', markers: 'http://a.test//b/*c*/' } }] };
  const logs: string[] = [];
  restoreMocks.push(subscribeLogSink(entry => { if (entry.scope === 'parser') logs.push(entry.message); }));
  assert.deepEqual(parseConfigJson('\uFEFF\r\n' + JSON.stringify(input) + '\r\n'), { ok: true, config: input });
  assert.deepEqual(logs, []);
});

test('comment compatibility preserves URLs, quoted markers and separators with all line endings', () => {
  const input: TVBoxConfig = { sites: [{ key: 'comments', type: 3, api: 'csp_comments',
    ext: { url: 'http://example.test/a//b/*c*/', quote: '" // /* inside string */' } }] };
  for (const ending of ['\n', '\r', '\r\n']) {
    const text = '// lead' + ending + '{/* inline */' + JSON.stringify(input).slice(1) + '/* tail */ // eof';
    assert.deepEqual(parseConfigJson(text), { ok: true, config: input });
  }
});

test('raw LF CR and CRLF compatibility preserves exact values and logs only successful repair counts', () => {
  const { input, text, marker } = compatibleFixture();
  const logs: string[] = [];
  restoreMocks.push(subscribeLogSink(entry => { if (entry.scope === 'parser') logs.push(entry.message); }));
  const parsed = parseConfigJson(text);
  assert.deepEqual(parsed, { ok: true, config: input });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /config-compatibility-applied/);
  assert.match(logs[0], /lineComments=2/); assert.match(logs[0], /blockComments=1/);
  assert.match(logs[0], /lfEscapes=2/); assert.match(logs[0], /crEscapes=2/);
  assert.ok(!logs[0].includes(marker)); assert.doesNotMatch(logs[0], /example\.test|csp_compatible|ratio/);
  for (const newline of ['\n', '\r', '\r\n']) {
    assert.deepEqual(parseConfigJson('{"value":"before' + newline + 'after"}'), { ok: true, config: { value: 'before' + newline + 'after' } });
  }
});

test('parsing classifies empty comments, valid non-object roots and syntax failures distinctly', () => {
  for (const text of ['', ' \uFEFF ', '// only', '/* only */', '/* a */\r\n// b']) {
    assert.equal(parseConfigJson(text).errorCategory, 'empty');
  }
  for (const text of ['null', 'false', '0', 'true', '"text"', '[]']) {
    assert.equal(parseConfigJson(text).errorCategory, 'structure');
    assert.equal(parseConfigJson('/* comment */' + text).errorCategory, 'structure');
  }
  assert.deepEqual(parseConfigJson('{}'), { ok: true, config: {} });
});

test('compatibility refuses damaged structure, token joining and unsupported syntax with bounded previews', () => {
  const logs: string[] = [];
  restoreMocks.push(subscribeLogSink(entry => { if (entry.scope === 'parser') logs.push(entry.message); }));
  for (const text of ['{"value":1}/* unfinished', '{"value":"unfinished', '{"value":1',
    '{"value":1/*x*/2}', '{"value":tru/*x*/e}', '{"a":1 "b":2}', '{"value":1,}',
    "{'value':1}", '{value:1}', '{"value":"bad\\q"}', '{"value":"raw\ttab"}',
    '{"value":"a\\' + '\n' + 'b"}', '/* outer /* inner */ still outer */{}',
    '{"value":(() => 1)()}', 'invalid ' + 'x'.repeat(300)]) {
    const result = parseConfigJson(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.errorCategory, 'syntax', text);
    assert.equal(result.preview, text.slice(0, 200));
  }
  assert.deepEqual(logs, []);
});

test('direct proxy and wrapped-response acquisition share compatibility parsing without extra requests', async () => {
  const { input, text } = compatibleFixture();
  const calls: string[] = []; let proxy = false; let wrapped = false;
  mockFetch(url => {
    calls.push(url);
    if (proxy && url === A.url) return new Response('', { status: 404 });
    return new Response(wrapped ? 'image-prefixABCDEFGH**' + Buffer.from(text, 'utf8').toString('base64') : text);
  });
  let result = await fetchConfigs([A], 200);
  assert.deepEqual(result.configs[0].config, input); assert.equal(result.fetchResults[0].status, 'ok');
  assert.deepEqual(calls, [A.url]);
  calls.length = 0; proxy = true;
  result = await fetchConfigs([A], 200, { urls: ['https://proxy.test/fetch-proxy'], token: 'test-token' });
  assert.deepEqual(result.configs[0].config, input); assert.equal(result.fetchResults[0].status, 'ok');
  assert.deepEqual(calls, [A.url, 'https://proxy.test/fetch-proxy?url=' + encodeURIComponent(A.url)]);
  calls.length = 0; proxy = false; wrapped = true;
  result = await fetchConfigs([A], 200);
  assert.deepEqual(result.configs[0].config, input); assert.deepEqual(calls, [A.url]);
  const bytes = new TextEncoder().encode(text);
  const decoded = await decodeConfigResponse(bytes.buffer);
  assert.equal(decoded, text); assert.deepEqual(parseConfigJson(decoded!), { ok: true, config: input });
});

test('URL and pasted imports plus stored inline reads preserve compatible content and save standard snapshots', async () => {
  const storage = new MemoryStorage(); await roots(storage, [B]);
  const { input, text } = compatibleFixture();
  mockFetch(url => url === A.url ? new Response(text) : response(leaf('B1')));
  const router = createSourceMgmtRouter({ storage, config });
  for (const importInput of [A.url]) {
    const result = await router.request('/admin/sources/import', { method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: importInput }) });
    assert.equal(result.status, 200);
  }
  const local = { name: 'Existing inline', url: 'inline://inline_config_compatible' };
  await roots(storage, [A, local]); await storage.put('inline_config_compatible', text);
  assert.equal(await storage.get(local.url.replace('inline://', '')), text);
  await runSync(storage, config);
  assert.deepEqual((await snapshot(storage, A)).config, input);
  assert.deepEqual((await snapshot(storage, local)).config, input);
  const output = JSON.parse((await storage.get(MERGED_CONFIG))!).sites.find((s: any) => s.key === 'compatible');
  assert.deepEqual(output.ext, input.sites![0].ext);
  assert.deepEqual(output.style, input.sites![0].style);
  const remote = (await status(storage)).records.find((r: any) => r.url === A.url);
  assert.equal(remote.status, 'OK'); assert.equal(remote.fetchStatus, 'ok');
});

test('compatible fresh recovery wins, later malformed input restores exact values, and failed rounds publish no candidate', async () => {
  const storage = new MemoryStorage(); await seed(storage);
  let phase = 'failure'; let fixture = compatibleFixture('A-compatible');
  mockFetch(url => url === B.url ? response(leaf('B2')) : phase === 'failure' ? new Response('', { status: 404 })
    : phase === 'malformed' ? new Response('{"sites":[]/* unclosed') : new Response(fixture.text));
  await runSync(storage, config);
  assert.equal((await status(storage)).records.find((r: any) => r.url === A.url).consecutiveFailures, 1);
  phase = 'compatible'; await runSync(storage, config);
  const cached = await snapshot(storage);
  assert.deepEqual(cached.config, fixture.input);
  let record = (await status(storage)).records.find((r: any) => r.url === A.url);
  assert.equal(record.status, 'OK'); assert.equal(record.consecutiveFailures, 0);
  assert.equal(record.aggregation.latest.mode, 'fresh'); assert.equal(record.aggregation.lastSuccessful.fallbackApplied, false);
  const rawOutput = (await storage.get(MERGED_CONFIG))!;
  assert.ok(rawOutput.includes('优\\n酷\\r内容\\r\\n末尾'));
  phase = 'malformed'; await runSync(storage, config);
  assert.deepEqual(await snapshot(storage), cached);
  record = (await status(storage)).records.find((r: any) => r.url === A.url);
  assert.equal(record.fetchStatus, 'parse_error'); assert.equal(record.consecutiveFailures, 1);
  assert.equal(record.aggregation.lastSuccessful.fallbackApplied, true);
  assert.equal(record.aggregation.lastSuccessful.snapshotTime, cached.savedAt);
  const restored = JSON.parse((await storage.get(MERGED_CONFIG))!).sites.find((s: any) => s.key === 'A-compatible');
  assert.deepEqual(restored.ext, fixture.input.sites![0].ext);
  const savedRound = record.aggregation.lastSuccessful.roundId;
  phase = 'compatible'; fixture = compatibleFixture('A-not-published'); storage.failPut = LAST_UPDATE;
  await assert.rejects(runSync(storage, config), /write failed/);
  storage.failPut = undefined;
  assert.deepEqual(await snapshot(storage), cached);
  record = (await status(storage)).records.find((r: any) => r.url === A.url);
  assert.equal(record.aggregation.latest.outcome, 'failed');
  assert.equal(record.aggregation.lastSuccessful.roundId, savedRound);
});

test('fresh preference; all source-local unusable configurations restore once and isolate other sources', async () => {
  const storage = new MemoryStorage(); await seed(storage);
  const original = await snapshot(storage);
  for (const bad of [{}, { parses: [{ name: 'p', url: 'https://p.test' }] }, { sites: [] },
    { sites: [{ key: '', api: '' }] }, { sites: [null] }, { sites: [{ key: 'broken', type: 3, api: 3 }] }, { hosts: [9] }]) {
    const round = await SourceFallbackRound.begin(storage);
    const a = round.resolve(A, bad as TVBoxConfig, ok)!;
    const b = round.resolve(B, leaf('B2'), ok)!;
    assert.equal(a.config.sites![0].key, 'A1');
    assert.equal(b.config.sites![0].key, 'B2');
    a.config.sites![0].ext = { mutated: true };
    await publish(round);
    assert.deepEqual(await snapshot(storage), original);
  }
  const round = await SourceFallbackRound.begin(storage);
  assert.equal(round.resolve(A, leaf('A2'), ok)!.config.sites![0].key, 'A2');
  await publish(round);
  assert.equal((await sourceAggregationStatuses(storage)).get(A.url)!.aggregation.lastSuccessful!.fallbackApplied, false);
});

test('fresh TVBox field variants pass existing normalization and survive saved fallback without a strict schema', async () => {
  const storage = new MemoryStorage(); await seed(storage);
  const variant = { sites: [{ key: 'A-compatible', name: 'Compatible', type: 3, api: 'csp_compatible',
    style: { type: 'rect', ratio: 1.68 }, categories: ['电影', 123], click: { selector: '.play' },
    searchable: '1', clientOption: { enabled: true } }] } as unknown as TVBoxConfig;
  let fail = false;
  mockFetch(url => url === A.url ? fail ? new Response('', { status: 404 }) : response(variant) : response(leaf('B2')));
  await runSync(storage, config);
  const cached = await snapshot(storage);
  assert.deepEqual(cached.config, variant);
  const output = JSON.parse((await storage.get(MERGED_CONFIG))!).sites.find((s: any) => s.key === 'A-compatible');
  assert.deepEqual(output.style, variant.sites![0].style);
  assert.deepEqual(output.categories, variant.sites![0].categories);
  assert.deepEqual(output.click, variant.sites![0].click);
  assert.equal(output.searchable, '1');
  assert.deepEqual(output.clientOption, { enabled: true });
  assert.equal((await status(storage)).records.find((r: any) => r.url === A.url).aggregation.latest.mode, 'fresh');

  fail = true; await runSync(storage, config);
  assert.deepEqual(await snapshot(storage), cached);
  const restored = JSON.parse((await storage.get(MERGED_CONFIG))!).sites.find((s: any) => s.key === 'A-compatible');
  assert.deepEqual(restored, output);
  const record = (await status(storage)).records.find((r: any) => r.url === A.url);
  assert.equal(record.fetchStatus, 'http_404');
  assert.equal(record.aggregation.lastSuccessful.fallbackApplied, true);
  assert.equal(record.aggregation.lastSuccessful.snapshotTime, cached.savedAt);
});

test('existing inline preserves object style through normalization, merge and missing-content fallback', async () => {
  const storage = new MemoryStorage(); await roots(storage, [B]);
  const input: TVBoxConfig = { sites: [{ key: 'local-compatible', name: 'Local compatible', type: 3, api: 'csp_local',
    style: { type: 'rect', ratio: 1.597 } }] };
  const local = { name: 'Existing inline', url: 'inline://inline_config_style' };
  await roots(storage, [B, local]); await storage.put('inline_config_style', JSON.stringify(input));
  mockFetch(() => response(leaf('B1')));
  await runSync(storage, config);
  const cached = await snapshot(storage, local);
  assert.deepEqual(cached.config, input);
  await storage.delete(local.url.replace('inline://', ''));
  await runSync(storage, config);
  const restored = JSON.parse((await storage.get(MERGED_CONFIG))!).sites.find((s: any) => s.key === 'local-compatible');
  assert.deepEqual(restored.style, input.sites![0].style);
  assert.deepEqual(await snapshot(storage, local), cached);
});

test('new sources, corrupt versions/identities/payloads never fabricate fallback; good sources continue', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A, B]);
  let round = await SourceFallbackRound.begin(storage);
  assert.equal(round.resolve(A, {}, ok), null);
  assert.equal(round.resolve(A, null, failed), null);
  round.resolve(B, leaf('B1'), ok); await publish(round);
  assert.equal(await snapshot(storage), undefined);
  for (const corrupt of [
    (r: any) => { r.nodes[B.url].snapshot.version = 99; },
    (r: any) => { r.nodes[B.url].snapshot.url = A.url; },
    (r: any) => { r.nodes[B.url].snapshot.generation = 'wrong'; },
    (r: any) => { r.nodes[B.url].snapshot.config = { sites: [null] }; },
  ]) {
    await seed(storage, [B]); const r = await registry(storage); corrupt(r);
    await storage.put(SOURCE_CONFIG_SNAPSHOTS, JSON.stringify(r));
    round = await SourceFallbackRound.begin(storage);
    assert.equal(round.resolve(B, null, failed), null);
  }
});

test('global/output failure discards candidates and applied markers while preserving prior successful report', async () => {
  const storage = new MemoryStorage(); await seed(storage);
  const before = await snapshot(storage);
  let round = await SourceFallbackRound.begin(storage);
  round.resolve(A, null, failed); round.resolve(B, leaf('B2'), ok); await publish(round);
  const lastApplied = (await sourceAggregationStatuses(storage)).get(A.url)!.aggregation.lastSuccessful!;
  round = await SourceFallbackRound.begin(storage);
  round.resolve(A, leaf('A2'), ok); round.resolve(B, null, failed);
  await assert.rejects(round.commit(async () => { throw new Error('output failed'); }), /output failed/);
  await round.finish('failed');
  assert.deepEqual(await snapshot(storage), before);
  const statuses = await sourceAggregationStatuses(storage);
  assert.equal(statuses.get(A.url)!.aggregation.latest!.outcome, 'failed');
  assert.equal(statuses.get(A.url)!.aggregation.lastSuccessful!.roundId, lastApplied.roundId);
  assert.equal(statuses.get(B.url)!.aggregation.lastSuccessful!.fallbackApplied, false);
});

test('no TTL or restore-count limit; more than 50 real failing rounds keep true health and fresh attempts', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A, B]);
  let failure = false; let attempts = 0;
  mockFetch(url => {
    if (url === A.url) { attempts++; return failure ? new Response('', { status: 404 }) : response(leaf('A1')); }
    return response(leaf('B2'));
  });
  await runSync(storage, config);
  const before = await snapshot(storage);
  const r = await registry(storage); r.nodes[A.url].snapshot.savedAt = '2020-01-01T00:00:00.000Z';
  await storage.put(SOURCE_CONFIG_SNAPSHOTS, JSON.stringify(r));
  const healthBefore = JSON.parse((await storage.get(SOURCE_HEALTH))!).find((s: any) => s.url === A.url);
  failure = true;
  for (let n = 1; n <= 51; n++) {
    await runSync(storage, config);
    const health = JSON.parse((await storage.get(SOURCE_HEALTH))!).find((s: any) => s.url === A.url);
    assert.equal(health.consecutiveFailures, n);
    assert.equal(health.lastSuccessTime, healthBefore.lastSuccessTime);
    assert.equal(JSON.parse((await storage.get(MERGED_CONFIG))!).sites[0].key, 'A1');
  }
  assert.equal(attempts, 2 + 3 * 51); // First upgrade run classifies once before ordinary acquisition.
  assert.equal((await snapshot(storage)).savedAt, '2020-01-01T00:00:00.000Z');
  assert.deepEqual((await snapshot(storage)).config, before.config);
  const api = await status(storage); const a = api.records.find((s: any) => s.url === A.url);
  assert.equal(a.status, 'ERR'); assert.equal(a.aggregation.lastSuccessful.fallbackApplied, true);
  const publicPayload = JSON.stringify(api);
  for (const privateField of ['"fingerprint"', '"generation"', '"config"']) assert.ok(!publicPayload.includes(privateField));
  failure = false; await runSync(storage, config);
  const recovered = (await status(storage)).records.find((s: any) => s.url === A.url);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.aggregation.lastSuccessful.fallbackApplied, false);
});

test('slow valid fresh data participates alongside fast data and alone without using old snapshots', async () => {
  const storage = new MemoryStorage(); await seed(storage);
  const original = Date.now; let clock = original();
  Date.now = () => clock; restoreMocks.push(() => { Date.now = original; });
  mockFetch(url => { clock += url === A.url ? 8000 : 2000; return response(leaf(url === A.url ? 'A-new' : 'B-new')); });
  await runSync(storage, config);
  assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG))!).sites.map((s: any) => s.key), ['A-new', 'B-new']);
  assert.equal((await snapshot(storage)).config.sites[0].key, 'A-new');
  assert.equal((await status(storage)).records.find((s: any) => s.url === A.url).lastSpeedMs, 8000);
  mockFetch(url => { clock += 8000; return response(leaf(url === A.url ? 'A-new' : 'B-new')); });
  await runSync(storage, config);
  assert.equal(JSON.parse((await storage.get(MERGED_CONFIG))!).sites.length, 2);
  await roots(storage, [A]); await runSync(storage, config);
  assert.equal(JSON.parse((await storage.get(MERGED_CONFIG))!).sites[0].key, 'A-new');
});

test('first actual run imports a directory once; later aggregation fetches independent leaves and preserves fallback', async () => {
  const storage = new MemoryStorage(); await roots(storage, [M]);
  let phase = 0; const requests: string[] = [];
  mockFetch(url => {
    requests.push(url);
    if (url === M.url) return response(index(A, B));
    if (url === B.url && phase) return new Response('', { status: 404 });
    return response(leaf(url === A.url ? `A${phase + 1}` : 'B1'));
  });
  await runSync(storage, config);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A, B]);
  assert.equal(await snapshot(storage, M), undefined);
  const child = await snapshot(storage, B);
  for (phase = 1; phase <= 2; phase++) {
    requests.length = 0; await runSync(storage, config);
    assert.ok(!requests.includes(M.url)); assert.ok(requests.includes(A.url)); assert.ok(requests.includes(B.url));
    assert.deepEqual(await snapshot(storage, B), child);
    assert.equal((await snapshot(storage, A)).config.sites[0].key, `A${phase + 1}`);
    assert.equal((await status(storage)).records.find((entry: any) => entry.url === M.url), undefined);
  }
});

test('runtime aggregation refuses directories and never requests nested descendants or qualifies index snapshots', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A, M, N]);
  const requests: string[] = [];
  mockFetch(url => { requests.push(url); return response(url === M.url ? index(B, N) : url === N.url ? index(M) : leaf('A1')); });
  const round = await SourceFallbackRound.begin(storage);
  const result = await fetchConfigs([A, M, N], 200, undefined, round);
  assert.equal(result.configs.length, 1); assert.equal(requests.filter(url => url === A.url).length, 1);
  assert.ok(!requests.includes(B.url)); await publish(round);
  assert.equal(await snapshot(storage, M), undefined);
  assert.equal((await registry(storage)).version, 2);
  assert.ok(!JSON.stringify(await registry(storage)).includes('children'));
  const noResolver = await fetchConfigs([M], 200);
  assert.equal(noResolver.configs.length, 0);
});

test('imported single sources own independent snapshots and deletion revokes only the removed source', async () => {
  const storage = new MemoryStorage(); await roots(storage, [M]);
  mockFetch(url => response(url === M.url ? index(A, B) : leaf(url === A.url ? 'A1' : 'B1')));
  await runSync(storage, config);
  const before = await snapshot(storage, B);
  await roots(storage, [B]);
  assert.equal(await snapshot(storage), undefined); assert.deepEqual(await snapshot(storage, B), before);
  await roots(storage, []); assert.equal(await snapshot(storage, B), undefined);
});

test('delete/re-add and observed key-change/reversion revoke generations including in-flight candidates', async () => {
  const storage = new MemoryStorage(); await seed(storage, [A]);
  let round = await SourceFallbackRound.begin(storage); round.resolve(A, leaf('A2'), ok);
  await roots(storage, []); await roots(storage, [A]);
  let saved = false;
  await assert.rejects(round.commit(async () => { saved = true; }), /membership changed/);
  assert.equal(saved, false); assert.equal(await snapshot(storage), undefined);
  round = await SourceFallbackRound.begin(storage); assert.equal(round.resolve(A, null, failed), null);
  round.resolve(A, leaf('A3'), ok); await publish(round);
  round = await SourceFallbackRound.begin(storage); round.resolve(A, leaf('A4'), ok);
  await roots(storage, [{ ...A, configKey: 'K2' }]);
  await assert.rejects(round.commit(async () => {}), /membership changed/);
  await roots(storage, [A]);
  round = await SourceFallbackRound.begin(storage); assert.equal(round.resolve(A, null, failed), null);
  await roots(storage, [{ ...A, configKey: 'K2' }]);
  round = await SourceFallbackRound.begin(storage); round.resolve({ ...A, configKey: 'K2' }, leaf('K2-good'), ok); await publish(round);
  round = await SourceFallbackRound.begin(storage);
  assert.equal(round.resolve({ ...A, configKey: 'K2' }, null, failed)!.config.sites![0].key, 'K2-good');
});

test('real deletion/key change during awaited fetch rejects old final output and candidates', async () => {
  const storage = new MemoryStorage(); await seed(storage, [A]);
  let acquired!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(r => { acquired = r; });
  let holdNext = true;
  mockFetch(async () => { if (holdNext) { holdNext = false; acquired(); await new Promise<void>(r => { resume = r; }); } return response(leaf('A-new')); });
  const syncing = runSync(storage, config); await waiting;
  const router = createSourceMgmtRouter({ storage, config });
  const request = async (method: string, body: unknown) => router.request('/admin/sources', {
    method, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await request('DELETE', { url: A.url })).status, 200);
  assert.equal((await request('POST', A)).status, 200);
  resume(); await syncing;
  assert.equal(await snapshot(storage), undefined);
  assert.equal(await storage.get(MERGED_CONFIG), null);
  assert.match((await storage.get(LAST_UPDATE))!, /membership changed/);

  await seed(storage, [A]);
  const keyWaiting = new Promise<void>(r => { acquired = r; });
  await storage.delete(SOURCE_IMPORT_CACHE); // This case exercises an actual awaited download, not import reuse.
  holdNext = true;
  const keySyncing = runSync(storage, config); await keyWaiting;
  await roots(storage, [{ ...A, configKey: 'new-key' }]);
  resume(); await keySyncing;
  assert.equal(await snapshot(storage), undefined);
  assert.match((await storage.get(LAST_UPDATE))!, /membership changed/);
  await roots(storage, [A]);
  const afterReversion = await SourceFallbackRound.begin(storage);
  assert.equal(afterReversion.resolve(A, null, failed), null);
});

test('restart with persisted ERR retains snapshot time and real failure count; removal persists across restart', async () => {
  const file = path.join(directory, 'config.json'); let storage = new JsonFileStorage(file);
  await roots(storage, [A]); let fail = false;
  mockFetch(() => fail ? new Response('', { status: 404 }) : response(leaf('A1')));
  await runSync(storage, config); const before = await snapshot(storage); fail = true;
  await runSync(storage, config); await runSync(storage, config); await runSync(storage, config);
  storage = new JsonFileStorage(file); await runSync(storage, config);
  assert.deepEqual(await snapshot(storage), before);
  assert.equal((await status(storage)).records[0].consecutiveFailures, 4);
  await roots(storage, []); storage = new JsonFileStorage(file); await roots(storage, [A]);
  const round = await SourceFallbackRound.begin(storage); assert.equal(round.resolve(A, null, failed), null);
});

test('inline read/parse failures restore only after saved aggregation and do not fabricate fetch records', async () => {
  const storage = new MemoryStorage(); const local = { name: 'Inline', url: 'inline://inline_config_test' };
  await roots(storage, [local, B]); await storage.put('inline_config_test', JSON.stringify(leaf('local1')));
  assert.equal(await snapshot(storage, local), undefined);
  mockFetch(() => response(leaf('B1'))); await runSync(storage, config);
  const before = await snapshot(storage, local);
  for (const data of [null, 'not-json', '{}']) {
    if (data === null) await storage.delete('inline_config_test'); else await storage.put('inline_config_test', data);
    await runSync(storage, config);
    assert.deepEqual(await snapshot(storage, local), before);
    assert.ok(JSON.parse((await storage.get(MERGED_CONFIG))!).sites.some((s: any) => s.key === 'local1'));
    assert.ok(!JSON.parse((await storage.get(SOURCE_HEALTH))!).some((r: any) => r.url === local.url));
    const api = await status(storage); const record = api.records.find((r: any) => r.url === local.url);
    assert.equal(record.local, true); assert.equal(record.fetchStatus, undefined);
    assert.equal(record.aggregation.lastSuccessful.fallbackApplied, true);
  }
});

test('policy filtering cannot restore excluded content; snapshots stay raw before names, dedup and rewriting', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A, B]);
  let fail = false;
  mockFetch(url => url === A.url && fail ? new Response('', { status: 404 }) : response(leaf(url === A.url ? 'A1' : 'B1')));
  await runSync(storage, config); const before = await snapshot(storage);
  await storage.put(BLACKLIST, JSON.stringify({ sites: [], parses: [], lives: [], regexRules: [{ pattern: 'A1', enabled: true }], regexBlockOverrides: [] }));
  fail = true; await runSync(storage, config);
  assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG))!).sites.map((s: any) => s.key), ['B1']);
  assert.deepEqual(await snapshot(storage), before);
  const round = await SourceFallbackRound.begin(storage);
  const a = round.resolve(A, null, failed)!;
  const merged = mergeConfigs([{ sourceUrl: A.url, sourceName: A.name, ...a }, { sourceUrl: B.url, sourceName: B.name, config: leaf('A1') }]);
  merged.config.sites![0].name = 'changed';
  assert.deepEqual(await snapshot(storage), before);
});

test('cache-read failures cannot block valid fresh acquisition; snapshot-publication failure preserves prior data', async () => {
  const storage = new MemoryStorage(); await seed(storage, [A]); const before = await snapshot(storage);
  let round = await SourceFallbackRound.begin(storage); round.resolve(A, leaf('A2'), ok);
  const logs: string[] = []; const unsubscribe = subscribeLogSink(entry => logs.push(entry.message)); restoreMocks.push(unsubscribe);
  storage.failPut = SOURCE_CONFIG_SNAPSHOTS; let saved = false;
  await round.commit(async () => { saved = true; }); await round.finish('no_configs');
  assert.equal(saved, true); storage.failPut = undefined;
  assert.deepEqual(await snapshot(storage), before);
  assert.ok(logs.some(l => l.includes('snapshot publication failed')));
  await prepareImportOnlyRun(storage, config, await beginSourceOutputRun(storage));
  storage.failGet = SOURCE_CONFIG_SNAPSHOTS;
  mockFetch(() => response(leaf('fresh-despite-cache-error'))); await runSync(storage, config);
  assert.equal(JSON.parse((await storage.get(MERGED_CONFIG))!).sites[0].key, 'fresh-despite-cache-error');
});

test('failed file writes never expose failed put/delete in memory or as successful persisted snapshots', async () => {
  const file = path.join(directory, 'config.json'); const storage = new JsonFileStorage(file);
  await storage.put('old', 'good'); const prior = readFileSync(file, 'utf8');
  // Turn the target into a directory to deterministically make writeFileSync fail on Windows/Unix.
  rmSync(file); mkdirSync(file);
  await assert.rejects(storage.put('new', 'bad'));
  await assert.rejects(storage.delete('old'));
  assert.equal(await storage.get('new'), null); assert.equal(await storage.get('old'), 'good');
  assert.match(prior, /good/);
});

test('failed lifecycle persistence aborts deletion before changing roots', async () => {
  const storage = new MemoryStorage(); await seed(storage, [A]);
  storage.failPut = SOURCE_CONFIG_SNAPSHOTS;
  await assert.rejects(roots(storage, []), /write failed/);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
});

test('failed import checks leave full migration diagnostics after removal without fabricated acquisition health', async () => {
  const storage = new MemoryStorage(); await roots(storage, [M]);
  mockFetch(url => response(url === M.url ? index(A) : {}));
  await runSync(storage, config);
  assert.equal(await storage.get(MERGED_CONFIG), null);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), []);
  const report = await sourceMigrationReport(storage);
  assert.match(report!.skipped[0].reason, /no valid VOD sites/);
  assert.equal(report!.removed[0].url, M.url);
  assert.equal((await status(storage)).records.length, 0);
  await assertUnavailableViews(storage);
});

test('real request timeout and parse failures preserve retry health while using eligible snapshots', async () => {
  const storage = new MemoryStorage(); await seed(storage, [A, B]); const before = await snapshot(storage);
  let phase = 'parse';
  mockFetch((url, options) => {
    if (url === B.url) return response(leaf('B-new'));
    if (phase === 'parse') return new Response('invalid JSON');
    return new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    });
  });
  await runSync(storage, { ...config, fetchTimeoutMs: 5 });
  let a = (await status(storage)).records.find((r: any) => r.url === A.url);
  assert.equal(a.fetchStatus, 'parse_error'); assert.equal(a.consecutiveFailures, 1);
  phase = 'timeout'; await runSync(storage, { ...config, fetchTimeoutMs: 5 });
  a = (await status(storage)).records.find((r: any) => r.url === A.url);
  assert.equal(a.fetchStatus, 'timeout'); assert.equal(a.consecutiveFailures, 2);
  assert.equal(a.aggregation.lastSuccessful.fallbackApplied, true);
  assert.deepEqual(await snapshot(storage), before);
});

test('fresh and restored sites are not probed, filtered or tagged regardless of an obsolete saved toggle', async () => {
  const payload: TVBoxConfig = { sites: [
    { key: 'good', type: 1, api: 'https://good.test/api', name: 'Good' },
    { key: 'bad', type: 1, api: 'https://bad.test/api', name: 'Bad' },
    { key: 'xml', type: 0, api: 'https://xml.test/api', name: 'XML' },
    { key: 'http', type: 3, api: 'https://http.test/api', name: 'HTTP [source text]' },
    { key: 'local', type: 3, api: 'csp_local', name: 'Local [0.4s]' },
  ] };
  for (const legacyValue of [undefined, 'true', 'false']) {
    const storage = new MemoryStorage(); await roots(storage, [A]);
    if (legacyValue !== undefined) await storage.put('speed_test_enabled', legacyValue);
    // A persisted obsolete key must not even be read by the running pipeline.
    storage.failGet = 'speed_test_enabled';
    let failingSource = false;
    const calls: string[] = [];
    mockFetch(url => {
      calls.push(url);
      if (url === A.url) return failingSource ? new Response('', { status: 404 }) : response(payload);
      // A single successful probe among failures would formerly bypass the safety valve.
      return new Response('{}', { status: url.startsWith('https://good.test') ? 200 : 404 });
    });
    await runSync(storage, config); const before = await snapshot(storage);
    const assertSites = async () => {
      const output: TVBoxConfig = JSON.parse((await storage.get(MERGED_CONFIG))!);
      assert.deepEqual(output.sites!.map(({ key, name, api }) => ({ key, name, api })),
        payload.sites!.map(({ key, name, api }) => ({ key, name, api })));
      assert.ok(calls.length > 0); assert.ok(calls.every(url => url === A.url));
    };
    await assertSites();
    assert.deepEqual(before.config, payload);
    calls.length = 0; failingSource = true; await runSync(storage, config);
    await assertSites();
    assert.deepEqual(await snapshot(storage), before);
    const record = (await status(storage)).records.find((entry: { url: string }) => entry.url === A.url);
    assert.equal(record.fetchStatus, 'http_404'); assert.equal(record.consecutiveFailures, 1);
    assert.equal(record.aggregation.latest.mode, 'restored');
    assert.equal(record.aggregation.lastSuccessful.snapshotTime, before.savedAt);
    assert.equal(storage.data.get('speed_test_enabled'), legacyValue);
  }
});

test('retired setting routes return 404 while other settings, MacCMS validation and retired channel probes stay unavailable', async () => {
  const storage = new MemoryStorage(); await storage.put('speed_test_enabled', 'true');
  const app = createApp({ storage, config: { ...config, siteTimeoutMs: 5 }, runtime: idleRuntime,
    triggerRefresh: async () => ({ ran: false, outcome: 'busy', message: '正在聚合' }) });
  for (const method of ['GET', 'PUT']) {
    const res = await app.request('/admin/speed-test', { method, headers: adminHeaders,
      ...(method === 'PUT' ? { body: JSON.stringify({ enabled: false }) } : {}) });
    assert.equal(res.status, 404);
  }
  assert.equal(await storage.get('speed_test_enabled'), 'true');
  assert.equal((await app.request('/admin/name-transform')).status, 401);
  const settings = await app.request('/admin/name-transform', { method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ prefix: 'kept' }) });
  assert.equal(settings.status, 200);
  assert.deepEqual(await (await app.request('/admin/name-transform', { headers: adminHeaders })).json(), { prefix: 'kept' });
  for (const route of ['/admin/channel-probe/status', '/admin/channel-probe/toggle', '/admin/channel-probe/trigger']) {
    assert.equal((await app.request(route, { headers: adminHeaders })).status, 404);
  }
  const calls: string[] = []; let timedOut = false;
  mockFetch((url, options) => {
    calls.push(url);
    if (url.includes('timeout.test')) return new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => {
        timedOut = true; reject(new DOMException('Timed out', 'AbortError'));
      }, { once: true });
    });
    return new Response(JSON.stringify({ list: [] }));
  });
  const validate = (api: string, headers = adminHeaders) => app.request('/admin/maccms/validate', {
    method: 'POST', headers, body: JSON.stringify({ api }) });
  assert.equal((await validate('https://cms.test/api', { Authorization: 'Bearer wrong-token' })).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await validate('https://cms.test/api')).status, 200);
  assert.equal((await validate('https://timeout.test/api')).status, 200);
  assert.equal(timedOut, true); // The shared siteTimeoutMs still controls independent validation.
  assert.deepEqual(calls, ['https://cms.test/api?ac=list', 'https://timeout.test/api?ac=list']);
});

test('generated Admin initializes without the retired setting and still renders and invokes MacCMS tests', async () => {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    .find(text => text.includes('async function loadAll()'))!;
  new Script(script);
  assert.doesNotMatch(adminHtml, /speedTestCheck|speedTestStatus|loadSpeedTest|saveSpeedTest|\/admin\/speed-test|启用站点测速与不可达剔除/);
  const loaders = ['loadSourceHealth', 'loadSources', 'loadMacCMS', 'loadLives', 'loadNameTransform',
    'loadSyncSchedule', 'loadSmartJarUrl', 'loadLiveDisabled', 'loadEdgeProxies', 'loadSearchQuota'];
  const initialized: string[] = [];
  const initContext = createContext(Object.fromEntries(loaders.map(name => [name, () => { initialized.push(name); }])));
  await new Script(script.slice(script.indexOf('async function loadAll()'), script.indexOf('async function loadSources()'))
    + '\nloadAll()').runInContext(initContext);
  assert.deepEqual(initialized, loaders);
  const elements: Record<string, { innerHTML: string; textContent?: unknown }> = {};
  const calls: { url: string; options?: RequestInit }[] = [];
  const context = createContext({ $: (id: string) => elements[id] ||= { innerHTML: '' }, esc: String,
    toast() {}, auth: { authFetch: async (url: string, options?: RequestInit) => {
      calls.push({ url, options });
      return { json: async () => url === '/admin/maccms'
        ? [{ key: 'cms', name: 'CMS', api: 'https://cms.test/api' }] : { valid: true } };
    } } });
  const mac = script.slice(script.indexOf('async function loadMacCMS()'), script.indexOf('async function addMacCMS()'));
  const validate = script.slice(script.indexOf('async function validateMC(api)'), script.indexOf('async function batchImportMacCMS()'));
  await new Script(mac + validate + '\nloadMacCMS()').runInContext(context);
  assert.match(elements.mcList.innerHTML, /onclick="validateMC\('https:\/\/cms.test\/api'\)">测试/);
  await new Script("validateMC('https://cms.test/api')").runInContext(context);
  assert.deepEqual(calls.map(call => call.url), ['/admin/maccms', '/admin/maccms/validate']);
  assert.equal(calls[1].options!.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options!.body as string), { api: 'https://cms.test/api' });
});

test('shared whole-merge/global-policy and final-marker errors cannot publish new snapshots or applied claims', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A, B]); let changed = false;
  mockFetch(url => url === A.url && changed ? new Response('', { status: 404 }) : response(leaf(url === A.url ? 'A1' : changed ? 'B2' : 'B1')));
  await runSync(storage, config); const before = await snapshot(storage, B);
  changed = true; storage.failPut = LAST_UPDATE;
  await assert.rejects(runSync(storage, config), /write failed/);
  storage.failPut = undefined;
  assert.deepEqual(await snapshot(storage, B), before);
  const a = (await status(storage)).records.find((r: any) => r.url === A.url);
  assert.equal(a.aggregation.latest.outcome, 'failed');
  assert.equal(a.aggregation.latest.mode, 'restored');
  assert.equal(a.aggregation.lastSuccessful.fallbackApplied, false);
  await storage.put('name_transform', '{broken-json');
  await runSync(storage, config);
  assert.deepEqual(await snapshot(storage, B), before);
});

test('legacy whole output cannot qualify snapshots and an empty directory is removed with diagnostics', async () => {
  const storage = new MemoryStorage(); await roots(storage, [M, B]);
  await storage.put(MERGED_CONFIG, JSON.stringify(leaf('legacy-old')));
  await storage.put(SOURCE_CONFIG_SNAPSHOTS, '{invalid');
  await storage.put(SOURCE_HEALTH, JSON.stringify([{ url: M.url, name: M.name, latestStatus: 'ok', consecutiveFailures: 0 }]));
  mockFetch(url => response(url === M.url ? index() : leaf('B1')));
  await runSync(storage, config);
  assert.equal(await snapshot(storage, M), undefined);
  assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG))!).sites.map((site: any) => site.key), ['B1']);
  assert.equal((await sourceMigrationReport(storage))!.removed[0].url, M.url);
  assert.equal((await status(storage)).records.find((entry: any) => entry.url === M.url), undefined);
});

test('source import routes establish membership but eligibility waits for a saved aggregation', async () => {
  mockFetch(() => response(leaf('remote')));
  const storage = new MemoryStorage(); const router = createSourceMgmtRouter({ storage, config });
  const request = (input: string) => router.request('/admin/sources/import', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ input }),
  });
  assert.equal((await request(JSON.stringify(index(A, B)))).status, 200);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!).map((s: SourceEntry) => s.url), [A.url, B.url]);
  assert.equal(await snapshot(storage), undefined);
  assert.equal((await request(JSON.stringify(leaf('local-import')))).status, 400);
  assert.equal(await snapshot(storage), undefined);
  mockFetch(() => response(leaf('remote'))); await runSync(storage, config);
  assert.equal((await snapshot(storage)).config.sites[0].key, 'remote');
});

test('MacCMS-only aggregation still saves output and mixed rounds do not give MacCMS VOD fallback snapshots', async () => {
  const storage = new MemoryStorage(); await roots(storage, []);
  await storage.put(MACCMS_SOURCES, JSON.stringify([{ key: 'cms', name: 'CMS', api: 'https://cms.test/api' }]));
  let failingCMS = false; const calls: string[] = [];
  mockFetch(url => {
    calls.push(url);
    return url === B.url ? response(leaf('B1')) : new Response(JSON.stringify({ list: [] }), { status: failingCMS ? 404 : 200 });
  });
  await runSync(storage, config);
  const output: TVBoxConfig = JSON.parse((await storage.get(MERGED_CONFIG))!);
  assert.equal(output.sites![0].key, 'cms');
  assert.match(output.sites![0].name!, /^CMS \[\d+\.\ds\]$/);
  assert.deepEqual(calls, ['https://cms.test/api?ac=list']);
  assert.deepEqual((await registry(storage)).nodes, {});
  await roots(storage, [B]); failingCMS = true; await runSync(storage, config);
  assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG))!).sites.map((s: any) => s.key), ['B1']);
  assert.deepEqual(Object.keys((await registry(storage)).nodes), [B.url]);
});

test('sources and health details render truthful acquisition plus escaped round-specific fallback metadata', async () => {
  const badReason = '<failure & reason>';
  const record = { url: A.url, name: A.name, status: 'ERR', fetchStatus: 'http_404', label: 'HTTP 404', consecutiveFailures: 6,
    lastFailReason: badReason, aggregation: { latest: { mode: 'restored', reason: badReason, outcome: 'failed' },
      lastSuccessful: { roundId: 'previous-round', savedAt: '2026-10-01T00:00:00.000Z', kind: 'leaf',
        fallbackApplied: true, snapshotTime: '2026-09-01T00:00:00.000Z' } } };
  for (const [html, call, element] of [
    [adminHtml, 'healthMap = { "https://a.test/config.json": input }; await loadSources();', 'sourceList'],
    [dashboardHtml, 'renderHealthTable([input]);', 'healthTableBody'],
  ]) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    const script = scripts.find(text => text.includes(element === 'sourceList' ? 'async function loadSources()' : 'function renderHealthTable(records)'))!;
    for (const text of scripts) new Script(text);
    new Script(script); // Check actual generated inline JS, including template interpolation.
    const start = script.indexOf('async function loadSources()');
    const end = script.indexOf('// --- Add source ---', start);
    const tableStart = script.indexOf('function renderHealthTable(records)');
    const tableEnd = script.indexOf('// Plan 03.1 D-06:', tableStart);
    const elements: Record<string, { innerHTML: string; textContent?: unknown }> = {};
    const context = createContext({ input: record, healthMap: {}, document: { querySelectorAll: () => [] },
      $: (id: string) => elements[id] ||= { innerHTML: '' },
      esc: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      auth: { authFetch: async () => ({ ok: true, headers: new Headers({ 'X-Max-Data-Sources': '6' }), json: async () => [A] }) },
    });
    const selected = element === 'sourceList' ? capacityScript(script) + script.slice(start, end) : script.slice(tableStart, tableEnd);
    await new Script(selected + '\n(async () => { ' + call + ' })()').runInContext(context);
    const rendered = elements[element].innerHTML;
    if (element === 'sourceList') {
      assert.match(rendered, /2026-09-01/);
      assert.match(rendered, /class="source-status">状态：HTTP 404 · 连续失败 6/);
      assert.equal(rendered.split('&lt;failure &amp; reason&gt;').length - 1, 1);
      assert.match(rendered, /class="source-reason">原因：/);
      assert.match(rendered, /class="source-cache-time">已缓存的最后成功聚合时间：2026-09-01T00:00:00.000Z/);
      assert.equal((rendered.match(/class="source-url"/g) || []).length, 1);
      assert.doesNotMatch(rendered, /previous-round|2026-10-01|获取：|本轮不可用：|保留旧聚合结果|data-tooltip|已尝试回填/);
    } else {
      assert.match(rendered, /<div>&lt;failure &amp; reason&gt; · 已缓存<\/div>/);
      assert.doesNotMatch(rendered, /previous-round|已保存|已尝试回填|本轮失败|保留旧聚合结果|最近成功聚合已回填/);
    }
    assert.match(rendered, /HTTP 404/); assert.match(rendered, /6/);
    assert.match(rendered, /&lt;failure &amp; reason&gt;/); assert.ok(!rendered.includes(badReason));
  }
});

function capacityScript(script: string): string {
  return script.slice(script.indexOf('let sourceListRequest'), script.indexOf('async function loadSourceHealth'));
}

async function renderSourceRow(record?: object, source: SourceEntry = A) {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(text => text.includes('async function loadSources()'))!;
  const start = script.indexOf('async function loadSources()');
  const end = script.indexOf('// --- Add source ---', start);
  const elements: Record<string, { innerHTML: string; textContent?: unknown }> = {};
  const context = createContext({ healthMap: record ? { [source.url]: record } : {}, document: { querySelectorAll: () => [] },
    $: (id: string) => elements[id] ||= { innerHTML: '' },
    esc: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    auth: { authFetch: async () => ({ ok: true, headers: new Headers({ 'X-Max-Data-Sources': '6' }), json: async () => [source] }) },
  });
  await new Script(capacityScript(script) + script.slice(start, end) + '\nloadSources()').runInContext(context);
  return elements.sourceList.innerHTML;
}

function renderHomepageRow(record: object) {
  const script = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(text => text.includes('function renderHealthTable(records)'))!;
  const start = script.indexOf('function renderHealthTable(records)');
  const end = script.indexOf('// Plan 03.1 D-06:', start);
  const element = { innerHTML: '' };
  const context = createContext({ input: { ...A, ...record }, $: () => element, esc: String });
  new Script(script.slice(start, end) + '\nrenderHealthTable([input])').runInContext(context);
  return element.innerHTML;
}

test('both source views mark only current usable cache, independent of round outcome or historical usage', async () => {
  const historical = { roundId: 'past-round', savedAt: '2026-10-01T00:00:00.000Z', kind: 'leaf',
    fallbackApplied: true, snapshotTime: '2026-09-01T00:00:00.000Z' };
  for (const outcome of ['saved', 'failed', 'no_configs']) for (const mode of ['restored', 'skipped']) {
    const record = { status: 'ERR', label: 'HTTP 404', consecutiveFailures: 2,
      aggregation: { latest: { mode, outcome, reason: 'request failed' }, lastSuccessful: historical } };
    const admin = await renderSourceRow(record);
    const home = renderHomepageRow(record);
    for (const rendered of [admin, home]) {
      assert.ok(rendered.includes('request failed'));
      assert.doesNotMatch(rendered, /已保存|已尝试回填|本轮失败|保留旧聚合结果|最近成功聚合已回填/);
      if (mode === 'restored') assert.match(rendered, /request failed · 已缓存<\/div>/);
      else assert.doesNotMatch(rendered, /已缓存|source-cache-time|past-round/);
    }
    assert.doesNotMatch(home, /past-round|2026-09-01/);
  }
  const local = { local: true, status: 'ERR', label: 'LOCAL UNAVAILABLE', aggregation: {
    latest: { mode: 'restored', reason: 'local read failed', outcome: 'failed' } } };
  assert.match(await renderSourceRow(local, { name: 'Local', url: 'inline://missing' }), /local read failed · 已缓存/);
  assert.match(renderHomepageRow(local), /local read failed · 已缓存/);
  const healthy = { status: 'OK', label: 'OK', lastFailReason: 'old error',
    aggregation: { latest: { mode: 'fresh', outcome: 'failed' }, lastSuccessful: historical } };
  for (const rendered of [await renderSourceRow(healthy), renderHomepageRow(healthy)]) {
    assert.doesNotMatch(rendered, /old error|已缓存|source-cache-time|past-round/);
  }
  const noReport = { status: 'ERR', label: 'HTTP 404', lastFailReason: 'no cache available' };
  for (const rendered of [await renderSourceRow(noReport), renderHomepageRow(noReport)]) {
    assert.match(rendered, /no cache available/); assert.doesNotMatch(rendered, /已缓存|已保存/);
  }
});

test('real restored source remains marked cached after global failure; unusable old snapshots and fresh recovery clear the marker', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A, B]); let failing = false;
  mockFetch(url => url === A.url && failing ? new Response('', { status: 404 }) : response(leaf(url === A.url ? 'A' : 'B')));
  const record = async () => (await status(storage)).records.find((entry: any) => entry.url === A.url);
  await runSync(storage, config);
  failing = true; await runSync(storage, config);
  let current = await record();
  assert.equal(current.aggregation.latest.mode, 'restored');
  assert.equal(current.aggregation.latest.outcome, 'saved');
  assert.match(await renderSourceRow(current), / · 已缓存<\/div>/);
  assert.match(renderHomepageRow(current), / · 已缓存<\/div>/);
  storage.failBatch = values => MERGED_CONFIG in values; await runSync(storage, config);
  current = await record(); assert.equal(current.aggregation.latest.outcome, 'failed');
  assert.match(await renderSourceRow(current), / · 已缓存<\/div>/);
  assert.match(renderHomepageRow(current), / · 已缓存<\/div>/);
  const broken = await registry(storage); broken.nodes[A.url].snapshot.config = { sites: [] };
  await storage.put(SOURCE_CONFIG_SNAPSHOTS, JSON.stringify(broken));
  await runSync(storage, config); current = await record();
  assert.equal(current.aggregation.latest.mode, 'skipped');
  assert.equal(current.aggregation.lastSuccessful.fallbackApplied, true); // Historical use is not current usability.
  for (const rendered of [await renderSourceRow(current), renderHomepageRow(current)]) {
    assert.match(rendered, /snapshot unusable/); assert.doesNotMatch(rendered, /已缓存|source-cache-time|已保存|已回填/);
  }
  failing = false; storage.failBatch = undefined; await runSync(storage, config);
  current = await record(); assert.equal(current.status, 'OK'); assert.equal(current.aggregation.latest.mode, 'fresh');
  for (const rendered of [await renderSourceRow(current), renderHomepageRow(current)]) {
    assert.doesNotMatch(rendered, /已缓存|source-cache-time|HTTP 404|snapshot unusable/);
  }
});

test('source rows hide historical healthy errors and keep current unavailable reasons exactly once', async () => {
  const historical = 'historical HTTP error';
  const healthy = await renderSourceRow({ status: 'OK', label: 'OK', consecutiveFailures: 6, lastFailReason: historical });
  assert.match(healthy, /状态：OK/);
  assert.doesNotMatch(healthy, /连续失败|source-reason|historical HTTP error|source-cache-time/);
  assert.match(await renderSourceRow(), /状态：暂无数据/);

  const warn = await renderSourceRow({ status: 'WARN', label: 'TIMEOUT', consecutiveFailures: 2, lastFailReason: 'request timed out' });
  assert.match(warn, /状态：TIMEOUT · 连续失败 2/);
  assert.match(warn, /class="source-reason">原因：request timed out/);

  const reason = 'no valid sites';
  const prepared = await renderSourceRow({ status: 'OK', label: 'OK', lastFailReason: historical,
    aggregation: { latest: { reason, stage: 'preparation' }, lastSuccessful: { fallbackApplied: false } } });
  assert.match(prepared, /状态：配置不可用（获取 OK）/);
  assert.match(prepared, /source-health-dot error/);
  assert.equal(prepared.split(reason).length - 1, 1);
  assert.doesNotMatch(prepared, /连续失败|historical HTTP error|source-cache-time/);
});

test('source failure counts appear only while unhealthy and restart at one after persisted recovery', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); let failing = false;
  mockFetch(() => failing ? new Response('', { status: 404 }) : response(leaf('A1')));
  const record = async () => (await status(storage)).records.find((r: any) => r.url === A.url);
  await runSync(storage, config);
  let current = await record();
  assert.equal(current.status, 'OK'); assert.equal(current.consecutiveFailures, 0);
  assert.doesNotMatch(await renderSourceRow(current), /连续失败/);
  failing = true;
  for (const count of [1, 2]) {
    await runSync(storage, config); current = await record();
    assert.equal(current.status, 'ERR'); assert.equal(current.consecutiveFailures, count);
    assert.ok((await renderSourceRow(current)).includes(' · 连续失败 ' + count));
  }
  failing = false; await runSync(storage, config); current = await record();
  assert.equal(current.status, 'OK'); assert.equal(current.consecutiveFailures, 0);
  assert.equal(JSON.parse((await storage.get(SOURCE_HEALTH))!).find((r: any) => r.url === A.url).consecutiveFailures, 0);
  assert.doesNotMatch(await renderSourceRow(current), /连续失败/);
  failing = true; await runSync(storage, config); current = await record();
  assert.equal(current.consecutiveFailures, 1);
  assert.match(await renderSourceRow(current), / · 连续失败 1/);
});

test('inline rows show local state without invented remote counters or stale errors', async () => {
  const source = { url: 'inline://local', name: 'Local' };
  const healthy = await renderSourceRow({ local: true, status: 'OK', label: 'LOCAL OK', lastFailReason: 'old error' }, source);
  assert.match(healthy, /状态：本地配置正常/);
  assert.doesNotMatch(healthy, /连续失败|source-reason|old error/);
  const failed = await renderSourceRow({ local: true, status: 'ERR',
    aggregation: { latest: { reason: 'local configuration missing' } } }, source);
  assert.match(failed, /状态：本地配置不可用/);
  assert.match(failed, /原因：local configuration missing/);
  assert.doesNotMatch(failed, /连续失败/);
});

test('source rows preserve full long escaped information and do not contain hover diagnostics', async () => {
  const name = '接口<名称>'.repeat(200);
  const url = 'https://a.test/' + 'path'.repeat(400) + '?a=1&b=2';
  const reason = '<error & detail>'.repeat(300);
  const rendered = await renderSourceRow({ status: 'ERR', label: 'HTTP 404', lastFailReason: reason }, { name, url });
  assert.ok(rendered.includes(name.replace(/</g, '&lt;').replace(/>/g, '&gt;')));
  assert.ok(rendered.includes(url.replace(/&/g, '&amp;')));
  assert.ok(rendered.includes(reason.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
  assert.doesNotMatch(rendered, /data-tooltip|title=/);
  assert.doesNotMatch(adminHtml, /source-health-dot::after|attr\(data-tooltip\)/);
});


test('deleting the only source keeps output pending across restart, then blocks all views on the next empty run', async () => {
  const file = path.join(directory, 'deletion.json');
  let storage = new JsonFileStorage(file);
  await roots(storage, [A]); let requests = 0;
  mockFetch(() => { requests++; return response(leaf('A1')); });
  await runSync(storage, config); const previous = await rawOutputs(storage);
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([persisted[MERGED_CONFIG], persisted[MERGED_CONFIG_FULL], persisted[EXPORT_CONFIG]], previous);
  assert.equal(JSON.parse(persisted[SOURCE_OUTPUT_STATE]).published.savedAt, persisted[LAST_UPDATE]);
  const router = createSourceMgmtRouter({ storage, config });
  const deleted = await router.request('/admin/sources', { method: 'DELETE', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: A.url }) });
  assert.equal(deleted.status, 200); assert.equal(requests, 2);
  assert.equal((await outputState(storage)).pending, true);
  assert.equal((await outputState(storage)).blocked, false);
  assert.deepEqual(await rawOutputs(storage), previous);
  storage = new JsonFileStorage(file);
  assert.ok((await readAggregateOutputs(storage))?.merged?.includes('A1'));
  const skipped = createRefreshRouter({ storage, config, runtime: idleRuntime,
    triggerRefresh: async () => ({ ran: false, outcome: 'busy', message: '正在聚合' }) });
  assert.equal((await skipped.request('/refresh', { method: 'POST', headers: adminHeaders })).status, 200);
  assert.equal((await outputState(storage)).pending, true);
  await runSync(storage, config);
  assert.equal(requests, 2); assert.equal((await outputState(storage)).pending, false);
  assert.equal((await outputState(storage)).blocked, true);
  assert.equal(await snapshot(storage), undefined);
  await assertUnavailableViews(storage);
  assert.equal((await patchMergedConfig(storage)).patched, false);
  storage = new JsonFileStorage(file); await assertUnavailableViews(storage);
  await roots(storage, [A]);
  assert.equal((await outputState(storage)).blocked, true);
  await runSync(storage, config);
  assert.equal((await outputState(storage)).blocked, false);
  assert.ok((await readAggregateOutputs(storage))?.merged?.includes('A1'));
});

test('deleted A cannot survive when an unqualified remaining B fails or the new whole pipeline throws', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A, B]); let phase = 'initial';
  mockFetch(url => url === A.url && phase === 'initial' ? response(leaf('A1'))
    : phase === 'fresh-B' ? response(leaf('B-new')) : new Response('', { status: 404 }));
  await runSync(storage, config); assert.equal(await snapshot(storage, B), undefined);
  const previous = await rawOutputs(storage); await roots(storage, [B]);
  assert.ok((await readAggregateOutputs(storage))?.merged?.includes('A1'));
  phase = 'fail'; await runSync(storage, config); await assertUnavailableViews(storage);
  assert.deepEqual(await rawOutputs(storage), previous); // Retained raw keys are inaccessible.
  assert.equal((await status(storage)).records.find((r: any) => r.url === B.url).consecutiveFailures, 2);
  phase = 'fresh-B'; await storage.put('name_transform', '{broken');
  await runSync(storage, config); await assertUnavailableViews(storage);
  assert.deepEqual(await rawOutputs(storage), previous);
  assert.equal(await snapshot(storage, B), undefined);
  await storage.delete('name_transform'); await runSync(storage, config);
  const views = await readAggregateOutputs(storage);
  for (const raw of [views!.merged, views!.full, views!.exported]) {
    assert.ok(raw?.includes('B-new')); assert.ok(!raw?.includes('A1'));
  }
});

test('legacy migration blocks before auto-scraping and early exits, persists across restart and occurs only once', async () => {
  const file = path.join(directory, 'legacy.json'); let storage = new JsonFileStorage(file);
  await legacyOutputs(storage);
  assert.ok((await readAggregateOutputs(storage))?.merged?.includes('deleted-legacy'));
  let reached!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(r => { reached = r; });
  mockFetch(async () => { reached(); await new Promise<void>(r => { resume = r; }); return new Response('no sources'); });
  const syncing = runSync(storage, { ...config, scrapeSourceUrl: 'https://scrape.test/list', scrapeSourceReferer: 'https://scrape.test/' });
  await waiting; await assertUnavailableViews(storage);
  resume(); await syncing;
  storage = new JsonFileStorage(file); await assertUnavailableViews(storage);
  await roots(storage, [B]); mockFetch(() => response(leaf('B1')));
  await runSync(storage, config); const previous = await rawOutputs(storage);
  const published = (await outputState(storage)).published;
  await storage.put('name_transform', '{broken'); await runSync(storage, config);
  assert.equal((await outputState(storage)).blocked, false);
  assert.deepEqual((await outputState(storage)).published, published);
  assert.deepEqual(await rawOutputs(storage), previous);
  assert.ok((await readAggregateOutputs(storage))?.merged?.includes('B1'));
});

test('qualified remaining snapshots rebuild after deletion and legacy migration without advancing time or inventing health', async () => {
  for (const legacy of [false, true]) {
    const storage = new MemoryStorage(); await roots(storage, [A, B]); let failing = false;
    mockFetch(url => failing ? new Response('', { status: 404 }) : response(leaf(url === A.url ? 'A1' : 'B1')));
    await runSync(storage, config); const oldB = await snapshot(storage, B);
    if (legacy) await storage.delete(SOURCE_OUTPUT_STATE);
    await roots(storage, [B]); failing = true;
    await storage.put(SOURCE_HEALTH, JSON.stringify([{ url: B.url, name: B.name, fetchStatus: 'http_error', consecutiveFailures: 7,
      lastSuccessTime: '2020-01-01T00:00:00.000Z' }]));
    await runSync(storage, config);
    const views = await readAggregateOutputs(storage);
    for (const raw of [views!.merged, views!.full, views!.exported]) {
      assert.ok(raw?.includes('B1')); assert.ok(!raw?.includes('A1'));
    }
    assert.deepEqual(await snapshot(storage, B), oldB);
    const b = (await status(storage)).records.find((r: any) => r.url === B.url);
    assert.equal(b.status, 'ERR'); assert.equal(b.consecutiveFailures, 8);
    assert.equal(b.lastSuccessTime, '2020-01-01T00:00:00.000Z');
    assert.equal(b.aggregation.lastSuccessful.fallbackApplied, true);
    assert.equal(b.aggregation.lastSuccessful.snapshotTime, oldB.savedAt);
  }
});

test('add rename and no-op delete do not revoke output; deleting while blocked never reopens it', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('A1')));
  await runSync(storage, config); const state = await storage.get(SOURCE_OUTPUT_STATE);
  await roots(storage, [{ ...A, name: 'Renamed' }, B]);
  assert.equal(await storage.get(SOURCE_OUTPUT_STATE), state);
  const router = createSourceMgmtRouter({ storage, config });
  const result = await router.request('/admin/sources', { method: 'DELETE', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: N.url }) });
  assert.equal(result.status, 200); assert.equal(await storage.get(SOURCE_OUTPUT_STATE), state);
  await roots(storage, []); await runSync(storage, config);
  await roots(storage, [A]); await roots(storage, []);
  assert.equal((await outputState(storage)).pending, true);
  assert.equal((await outputState(storage)).blocked, true);
  await assertUnavailableViews(storage);
});

test('externally saved removals and key changes activate in the current run before acquisition', async () => {
  for (const next of [[B], [{ ...A, configKey: 'changed' }, B]]) {
    const storage = new MemoryStorage(); await roots(storage, [A, B]); let changed = false;
    mockFetch(async url => {
      if (changed) {
        assert.equal((await outputState(storage)).blocked, true);
        assert.equal(await readAggregateOutputs(storage), null);
        return new Response('', { status: 404 });
      }
      return response(leaf(url === A.url ? 'A1' : 'B1'));
    });
    await runSync(storage, config); const b = await snapshot(storage, B);
    await storage.put(MANUAL_SOURCES, JSON.stringify(next)); changed = true;
    await runSync(storage, config);
    assert.equal((await readAggregateOutputs(storage))!.merged!.includes('A1'), false);
    assert.deepEqual(await snapshot(storage, B), b);
    if (next.some(s => s.url === A.url)) assert.equal(await snapshot(storage), undefined);
  }
});

test('root batches fail without partial list registry state or remembered identity, even with unavailable snapshot reads', async () => {
  for (const failedKey of [MANUAL_SOURCES, SOURCE_CONFIG_SNAPSHOTS, SOURCE_OUTPUT_STATE]) {
    const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('A1')));
    await runSync(storage, config); const before = new Map(storage.data);
    storage.failPut = failedKey;
    await assert.rejects(roots(storage, []), /write failed/);
    assert.deepEqual(storage.data, before);
    storage.failPut = undefined; storage.failGet = SOURCE_CONFIG_SNAPSHOTS;
    const round = await SourceFallbackRound.begin(storage);
    assert.equal(round.resolve(A, null, failed), null); // Read failure never invents payloads.
    storage.failGet = undefined;
    assert.deepEqual(await snapshot(storage), JSON.parse(before.get(SOURCE_CONFIG_SNAPSHOTS)!).nodes[A.url].snapshot);
  }
  const storage = new MemoryStorage(); await roots(storage, [A]); await legacyOutputs(storage);
  storage.failGet = SOURCE_CONFIG_SNAPSHOTS;
  await roots(storage, []); storage.failGet = undefined;
  assert.equal((await outputState(storage)).pending, true);
  assert.ok((await readAggregateOutputs(storage))?.full);
  await runSync(storage, config); await assertUnavailableViews(storage);
});

test('JsonFileStorage commits batches in one persisted image and failed batches expose none of their values', async () => {
  const file = path.join(directory, 'batch.json'); const storage = new JsonFileStorage(file);
  await storage.putMany({ old: 'good', one: 'first', two: 'second' });
  const reloaded = new JsonFileStorage(file);
  assert.equal(await reloaded.get('one'), 'first'); assert.equal(await reloaded.get('two'), 'second');
  rmSync(file); mkdirSync(file);
  await assert.rejects(storage.putMany({ old: 'bad', one: 'new-first', two: 'new-second', extra: 'bad' }));
  assert.equal(await storage.get('old'), 'good'); assert.equal(await storage.get('one'), 'first');
  assert.equal(await storage.get('two'), 'second'); assert.equal(await storage.get('extra'), null);
});

test('all final output keys publish together and injected batch failures preserve prior views and snapshot claims', async () => {
  for (const failedKey of [MERGED_CONFIG, MERGED_CONFIG_FULL, EXPORT_CONFIG, LAST_UPDATE, SOURCE_OUTPUT_STATE, SITE_SOURCE_ATTRIBUTION]) {
    const storage = new MemoryStorage(); await roots(storage, [A]); let key = 'A1';
    mockFetch(() => response(leaf(key))); await runSync(storage, config);
    const oldOutputs = await rawOutputs(storage); const oldSnapshot = await snapshot(storage);
    const oldAttribution = await storage.get(SITE_SOURCE_ATTRIBUTION);
    const oldPublished = (await outputState(storage)).published;
    storage.failBatch = values => MERGED_CONFIG in values && failedKey in values;
    key = 'A2'; await runSync(storage, config);
    assert.deepEqual(await rawOutputs(storage), oldOutputs);
    assert.equal(await storage.get(SITE_SOURCE_ATTRIBUTION), oldAttribution);
    assert.deepEqual(await snapshot(storage), oldSnapshot);
    assert.deepEqual((await outputState(storage)).published, oldPublished);
    assert.equal((await outputState(storage)).blocked, false);
    assert.ok((await readAggregateOutputs(storage))!.full!.includes('A1'));
    storage.failBatch = undefined; await runSync(storage, config);
    const views = await readAggregateOutputs(storage);
    for (const raw of [views!.merged, views!.full, views!.exported]) assert.ok(raw!.includes('A2'));
    assert.equal((await outputState(storage)).published.savedAt, await storage.get(LAST_UPDATE));
  }
  const storage = new MemoryStorage(); await roots(storage, [A]); await legacyOutputs(storage);
  mockFetch(() => response(leaf('A2'))); storage.failBatch = values => MERGED_CONFIG in values;
  await runSync(storage, config); await assertUnavailableViews(storage);
  assert.equal(await snapshot(storage), undefined);
});

test('timed-out aggregation retains ownership until actual completion and blocks import and another run', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  mockFetch(() => response(leaf('baseline'))); await runSync(storage, config);
  let acquired!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(r => { acquired = r; }); let requests = 0;
  mockFetch(async () => {
    if (++requests === 1) { acquired(); await new Promise<void>(r => { resume = r; }); return response(leaf('late-old')); }
    storage.failPut = SOURCE_CONFIG_SNAPSHOTS;
    return response(leaf('newest'));
  });
  const runs: ReturnType<typeof runSync>[] = [];
  const activity = sourceActivity(storage);
  const guard = createSyncRunner(activity, () => { const running = runSync(storage, config); runs.push(running); return running; }, 5);
  const first = guard(); await waiting;
  assert.equal((await guard()).ran, false); // Skipped requests do not start a new ticket.
  const firstRun = (await outputState(storage)).activeRun;
  assert.equal((await first).ran, true);
  assert.equal((await outputState(storage)).activeRun, firstRun);
  assert.equal((await guard()).ran, false);
  assert.equal((await sourceRequest(storage, B, '/admin/sources')).status, 409);
  assert.equal(requests, 1);
  resume(); await runs[0]; await Promise.resolve();
  assert.equal(activity.kind, undefined);
  assert.equal((await guard()).ran, true);
  assert.ok((await readAggregateOutputs(storage))!.full!.includes('newest'));
});

test('a newer started but failed round still prevents an older candidate from publishing any view', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('baseline')));
  await runSync(storage, config); const before = await rawOutputs(storage);
  let acquired!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(r => { acquired = r; }); let requests = 0;
  mockFetch(async () => {
    if (++requests === 1) { acquired(); await new Promise<void>(r => { resume = r; }); }
    return response(leaf('candidate'));
  });
  const older = runSync(storage, config); await waiting;
  await storage.put('name_transform', '{broken'); await runSync(storage, config);
  const failureTime = await storage.get(LAST_UPDATE); await storage.delete('name_transform');
  resume(); await older;
  assert.deepEqual(await rawOutputs(storage), before); assert.equal(await storage.get(LAST_UPDATE), failureTime);
});

test('a former shared child is an independent root after migration and remains until explicitly deleted', async () => {
  const storage = new MemoryStorage(); await roots(storage, [M, N]); let failing = false;
  mockFetch(url => failing ? new Response('', { status: 404 }) : response(url === M.url || url === N.url ? index(A) : leaf('shared')));
  await runSync(storage, config); const child = await snapshot(storage);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
  failing = true; await runSync(storage, config);
  assert.deepEqual(await snapshot(storage), child);
  assert.ok((await readAggregateOutputs(storage))!.merged!.includes('shared'));
  await roots(storage, []); await runSync(storage, config);
  assert.equal(await snapshot(storage), undefined); await assertUnavailableViews(storage);
});

test('instant patches keep pending and legacy state, reject changed inputs and cannot unblock deleted output', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('A1')));
  await runSync(storage, config);
  assert.equal((await patchMergedConfig(storage)).patched, true);
  await roots(storage, []); const pending = await storage.get(SOURCE_OUTPUT_STATE);
  assert.equal((await patchMergedConfig(storage)).patched, true);
  assert.equal(await storage.get(SOURCE_OUTPUT_STATE), pending);
  const captured = (await readAggregateOutputs(storage))!;
  await beginSourceOutputRun(storage);
  assert.equal(await publishAggregatePatch(storage, captured.token, 'stale', 'stale'), false);
  await assertUnavailableViews(storage); assert.equal((await patchMergedConfig(storage)).patched, false);
  await roots(storage, [B]); mockFetch(() => response(leaf('rebuild'))); await runSync(storage, config);
  const normal = (await readAggregateOutputs(storage))!;
  await beginSourceOutputRun(storage); // A readable but newly started round invalidates a captured patch token.
  const prior = await rawOutputs(storage);
  assert.equal(await publishAggregatePatch(storage, normal.token, 'stale', 'stale'), false);
  assert.deepEqual(await rawOutputs(storage), prior);
  const legacy = new MemoryStorage(); await legacyOutputs(legacy);
  assert.equal((await patchMergedConfig(legacy)).patched, true);
  assert.equal(await legacy.get(SOURCE_OUTPUT_STATE), null);
  const firstPatch = (await readAggregateOutputs(legacy))!;
  assert.equal(await publishAggregatePatch(legacy, firstPatch.token, 'new patch', 'new export'), true);
  assert.equal(await publishAggregatePatch(legacy, firstPatch.token, 'old patch', 'old export'), false);
});

test('actual instant patch transformation rejects concurrent deletion without overwriting outputs', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('A1')));
  await runSync(storage, config); const previous = await rawOutputs(storage);
  const originalGet = storage.get.bind(storage); let acquired!: () => void; let resume!: () => void; let held = false;
  const waiting = new Promise<void>(r => { acquired = r; });
  storage.get = async key => {
    if (key === BLACKLIST && !held) { held = true; acquired(); await new Promise<void>(r => { resume = r; }); }
    return originalGet(key);
  };
  const patch = patchMergedConfig(storage); await waiting; await roots(storage, []);
  resume(); assert.equal((await patch).patched, false);
  assert.deepEqual(await rawOutputs(storage), previous); assert.equal((await outputState(storage)).pending, true);
});

test('malformed output state fails closed and valid reconstruction recovers without losing qualified snapshots', async () => {
  for (const corrupt of ['{broken', '{"version":99}', JSON.stringify({ version: 1, epoch: 'x', pending: false, blocked: false }),
    JSON.stringify({ version: 1, epoch: 'new', pending: false, blocked: false, published: { runId: 'r', epoch: 'old', savedAt: new Date().toISOString() } })]) {
    const storage = new MemoryStorage(); await roots(storage, [A]); let failing = false;
    mockFetch(() => failing ? new Response('', { status: 404 }) : response(leaf('A1')));
    await runSync(storage, config); const old = await snapshot(storage);
    await storage.put(SOURCE_OUTPUT_STATE, corrupt); await assertUnavailableViews(storage);
    failing = true; await runSync(storage, config);
    assert.ok((await readAggregateOutputs(storage))!.merged!.includes('A1'));
    assert.deepEqual(await snapshot(storage), old);
  }
});

test('failed activation aborts before network and fails closed until retry; corrupt source lists cannot bypass migration', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await legacyOutputs(storage); let requests = 0;
  mockFetch(() => { requests++; return response(leaf('A1')); });
  storage.failPut = SOURCE_OUTPUT_STATE;
  await runSync(storage, config); assert.equal(requests, 0);
  assert.equal(await storage.get(SOURCE_OUTPUT_STATE), null); await assertUnavailableViews(storage);
  storage.failPut = undefined; await runSync(storage, config); assert.equal(requests, 2);
  assert.ok((await readAggregateOutputs(storage))!.merged!.includes('A1'));
  const badList = new MemoryStorage(); await legacyOutputs(badList); await badList.put(MANUAL_SOURCES, '{broken');
  await runSync(badList, config);
  assert.equal((await outputState(badList)).blocked, true);
  await badList.put(MANUAL_SOURCES, '[]'); await assertUnavailableViews(badList);
});


test('deletion during an already started valid run preserves pending output and rejects every staged old view', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('A1')));
  await runSync(storage, config); const before = await rawOutputs(storage);
  let acquired!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(r => { acquired = r; });
  mockFetch(async () => { acquired(); await new Promise<void>(r => { resume = r; }); return response(leaf('A-new')); });
  const oldRun = runSync(storage, config); await waiting; await roots(storage, []);
  assert.ok((await readAggregateOutputs(storage))!.merged!.includes('A1'));
  resume(); await oldRun;
  assert.deepEqual(await rawOutputs(storage), before);
  assert.equal((await outputState(storage)).pending, true);
  assert.equal((await outputState(storage)).blocked, false);
  await runSync(storage, config); await assertUnavailableViews(storage);
});

test('external removal observed after auto-scraping starts records pending invalidation before source-round reconciliation', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('A1')));
  await runSync(storage, config); const before = await rawOutputs(storage);
  mockFetch(async () => {
    await storage.put(MANUAL_SOURCES, '[]');
    return new Response('no sources');
  });
  await runSync(storage, { ...config, scrapeSourceUrl: 'https://scrape.test/list', scrapeSourceReferer: 'https://scrape.test/' });
  assert.deepEqual(await rawOutputs(storage), before);
  assert.equal((await outputState(storage)).pending, true);
  assert.ok((await readAggregateOutputs(storage))!.full!.includes('A1'));
  await runSync(storage, config); await assertUnavailableViews(storage);
});


test('tracked unchanged-source all-failure rounds retain every valid view when source snapshots cannot be read', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); let failing = false;
  mockFetch(() => failing ? new Response('', { status: 404 }) : response(leaf('A1')));
  await runSync(storage, config); const before = await rawOutputs(storage);
  const published = (await outputState(storage)).published;
  failing = true; storage.failGet = SOURCE_CONFIG_SNAPSHOTS;
  await runSync(storage, config);
  assert.deepEqual(await rawOutputs(storage), before);
  assert.deepEqual((await outputState(storage)).published, published);
  assert.equal((await outputState(storage)).blocked, false);
  assert.ok((await readAggregateOutputs(storage))!.merged!.includes('A1'));
  storage.failGet = undefined;
  assert.equal((await status(storage)).records[0].consecutiveFailures, 1);
});


test('deletion with unreadable registry after restart persists revoked eligibility before same-URL re-add', async () => {
  const original = new MemoryStorage(); await roots(original, [A]); mockFetch(() => response(leaf('A1')));
  await runSync(original, config);
  const restarted = new MemoryStorage(); restarted.data = new Map(original.data);
  restarted.failGet = SOURCE_CONFIG_SNAPSHOTS;
  await roots(restarted, []); restarted.failGet = undefined;
  assert.equal(await snapshot(restarted), undefined);
  assert.equal((await outputState(restarted)).pending, true);
  await roots(restarted, [A]);
  mockFetch(() => new Response('', { status: 404 })); await runSync(restarted, config);
  assert.equal(await snapshot(restarted), undefined);
  await assertUnavailableViews(restarted);
});

test('advanced URL/paste Import shares acquisition, child suffix keys and deterministic sibling results', async () => {
  for (const mode of ['url', 'paste']) {
    const storage = new MemoryStorage(); const requests: string[] = [];
    const directory = { storeHouse: [{ sourceName: 'Child A', sourceUrl: A.url + ';pk;child-key' },
      { sourceName: 'Nested', sourceUrl: N.url }, { sourceName: 'Bad', sourceUrl: B.url }] } as TVBoxConfig;
    mockFetch(url => {
      requests.push(url);
      return url === M.url ? response(directory) : url === A.url ? response(leaf('good'))
        : url === N.url ? response(index({ name: 'Never', url: 'https://never.test/config.json' })) : new Response('', { status: 404 });
    });
    const res = await sourceRequest(storage, { input: mode === 'url' ? M.url + ';pk;parent-key' : JSON.stringify(directory) });
    assert.equal(res.status, 200); const result = await res.json() as any;
    assert.deepEqual([result.success, result.outcome, result.added, result.duplicates, result.skipped.length], [true, 'partial', 1, 0, 2]);
    assert.deepEqual(result.skipped.map((skip: any) => skip.url), [N.url, B.url]);
    assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [{ name: 'Child A', url: A.url, configKey: 'child-key' }]);
    assert.equal(requests.filter(url => url === A.url).length, 1);
    assert.equal(requests.filter(url => url === N.url).length, 1);
    assert.ok(!requests.some(url => url.includes('never.test')));
    assert.equal(await snapshot(storage), undefined); assert.equal(await storage.get(MERGED_CONFIG), null);
    assert.ok(!JSON.stringify(await registry(storage)).includes('children'));
  }
});

test('Add/Import keep normal retries and never save unverified inputs or update health', async () => {
  const cases: Array<[() => Response | Promise<Response>, number]> = [
    [() => new Response('', { status: 403 }), 502],
    [() => new Response('{broken'), 400], [() => response({}), 400],
    [() => { throw new Error('offline'); }, 502],
  ];
  for (const path of ['/admin/sources', '/admin/sources/import']) for (const [handler, code] of cases) {
    const storage = new MemoryStorage(); let requests = 0;
    mockFetch(() => { requests++; return handler(); });
    const res = await sourceRequest(storage, path.endsWith('/import') ? { input: A.url } : A, path);
    assert.equal(res.status, path.endsWith('/import') ? 200 : code);
    assert.equal(requests, code === 400 ? handler === cases[2][0] ? 1 : 6 : 3);
    const detail = await res.json() as any;
    assert.ok(path.endsWith('/import') ? detail.skipped.length : detail.error);
    assert.equal(await storage.get(MANUAL_SOURCES), null); assert.equal(await storage.get(SOURCE_HEALTH), null);
    assert.equal(await storage.get(SOURCE_CONFIG_SNAPSHOTS), null);
  }
  const storage = new MemoryStorage();
  mockFetch((_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort',
    () => reject(new DOMException('timed out', 'AbortError')), { once: true })));
  const res = await sourceRequest(storage, A, '/admin/sources');
  assert.equal(res.status, 504); assert.equal(await storage.get(MANUAL_SOURCES), null);
});

test('all-skipped empty and duplicate-only results are truthful; known duplicates bypass child downloads', async () => {
  const storage = new MemoryStorage(); await seed(storage, [A]); const before = await snapshot(storage);
  let requests = 0; mockFetch(() => { requests++; return response(index(A, A)); });
  const duplicate = await sourceRequest(storage, { input: M.url });
  const d = await duplicate.json() as any;
  assert.deepEqual([d.success, d.outcome, d.added, d.duplicates, requests], [false, 'duplicates_only', 0, 2, 1]);
  assert.deepEqual(await snapshot(storage), before);
  const addDuplicate = await sourceRequest(storage, { ...A, name: 'replace' }, '/admin/sources');
  assert.equal(addDuplicate.status, 200); assert.equal(requests, 1);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
  mockFetch(url => response(url === M.url ? index(N, M) : index(B)));
  const none = await sourceRequest(storage, { input: M.url }); const result = await none.json() as any;
  assert.deepEqual([result.outcome, result.added, result.skipped.length], ['none', 0, 2]);
  const empty = await sourceRequest(storage, { input: JSON.stringify(index()) });
  assert.match((await empty.json() as any).skipped[0].reason, /没有可导入/);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
});

test('existing URLs are skipped unchanged; parsing failures isolate normal siblings', async () => {
  const storage = new MemoryStorage(); await roots(storage, [N]); const requests: string[] = [];
  const unusable: SourceEntry = { name: 'Unusable', url: 'https://empty.test/config.json' };
  mockFetch(url => {
    requests.push(url); return url === M.url ? response(index(A, N, B, unusable, { name: 'Invalid', url: 'no-url;pk;private' }))
      : url === A.url ? new Response(compatibleFixture().text) : url === N.url ? response(index(M))
      : url === B.url ? new Response('{broken') : response({});
  });
  const res = await sourceRequest(storage, { input: M.url }); const result = await res.json() as any;
  assert.equal(result.added, 1); assert.equal(result.skipped.length, 3); assert.equal(result.duplicates, 1);
  assert.deepEqual(result.skipped.map((skip: any) => skip.stage), ['parse', 'parse', 'input']);
  assert.equal(requests.filter(url => url === N.url).length, 0);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!).map((entry: SourceEntry) => entry.url), [N.url, A.url]);
});

test('interactive inspection leaves all aggregate views, success times, snapshots and health unchanged', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('A1'))); await runSync(storage, config);
  const outputs = await rawOutputs(storage); const time = await storage.get(LAST_UPDATE);
  const health = await storage.get(SOURCE_HEALTH); const before = await snapshot(storage);
  mockFetch(url => response(url === M.url ? index(A, B) : leaf('B-inspected')));
  const res = await sourceRequest(storage, { input: M.url });
  assert.equal((await res.json() as any).added, 1);
  assert.deepEqual(await rawOutputs(storage), outputs); assert.equal(await storage.get(LAST_UPDATE), time);
  assert.equal(await storage.get(SOURCE_HEALTH), health); assert.deepEqual(await snapshot(storage), before);
  assert.equal(await snapshot(storage, B), undefined);
  mockFetch(() => response(leaf('fresh-next-round'))); await runSync(storage, config);
  assert.equal((await snapshot(storage, B)).config.sites[0].key, 'B-inspected');
});

test('import uses at most four acquisitions at once, preserves declaration order and retries normally', async () => {
  const storage = new MemoryStorage();
  const entries = Array.from({ length: 11 }, (_, n) => ({ name: String(n), url: `https://source${n}.test/config.json` }));
  let active = 0; let maxActive = 0; let requests = 0;
  mockFetch(async url => {
    requests++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => realTimeout(resolve, 5)); active--;
    return url === entries[5].url ? new Response('', { status: 404 }) : response(leaf(url));
  });
  const res = await sourceRequest(storage, { input: JSON.stringify(index(...entries)) }, '/admin/sources/import', { ...config, maxDataSources: 0 }); const result = await res.json() as any;
  assert.equal(requests, 13); assert.equal(maxActive, 4);
  assert.deepEqual(result.sources, entries.filter((_, n) => n !== 5).map(entry => entry.url));
});

test('concurrent delete/re-add/key edits reject stale interactive import rather than reviving its list', async () => {
  for (const edit of ['delete', 'readd', 'key']) {
    const storage = new MemoryStorage(); await seed(storage, [A]);
    let acquired!: () => void; let resume!: () => void;
    const waiting = new Promise<void>(resolve => { acquired = resolve; });
    mockFetch(async () => { acquired(); await new Promise<void>(resolve => { resume = resolve; }); return response(leaf('B')); });
    const importing = sourceRequest(storage, B, '/admin/sources'); await waiting;
    if (edit === 'key') await roots(storage, [{ ...A, configKey: 'new-key' }]);
    else { await roots(storage, []); if (edit === 'readd') await roots(storage, [A]); }
    const list = await storage.get(MANUAL_SOURCES); resume();
    assert.equal((await importing).status, 409); assert.equal(await storage.get(MANUAL_SOURCES), list);
    assert.equal(await snapshot(storage, B), undefined);
  }
});

test('directory and remote import batches expose no partial staging or qualification after write failure', async () => {
  for (const mode of ['directory', 'remote']) {
    const storage = new MemoryStorage(); await seed(storage, [A]); const before = new Map(storage.data);
    storage.failPut = SOURCE_CONFIG_SNAPSHOTS; mockFetch(() => response(leaf('new')));
    const res = await sourceRequest(storage, { input: mode === 'directory' ? JSON.stringify(index(B)) : B.url });
    assert.equal(res.status, 500); assert.deepEqual(storage.data, before);
    assert.equal([...storage.data.keys()].some(key => key.startsWith('inline_')), false);
  }
});

test('v1 directory migration preserves original qualified child payload/time across actual leaf failures and disk restart', async () => {
  const file = path.join(directory, 'legacy-v1.json'); let storage = new JsonFileStorage(file);
  const old = await legacyDirectory(storage); const requests: string[] = [];
  const counts = new Map<string, number>();
  mockFetch(url => {
    requests.push(url); const n = (counts.get(url) || 0) + 1; counts.set(url, n);
    return url === M.url ? response(index(A, B)) : n === 1 ? response(leaf('inspection-only')) : new Response('', { status: 404 });
  });
  await legacyOutputs(storage);
  await runSync(storage, config);
  assert.equal(requests.filter(url => url === M.url).length, 1);
  assert.equal(requests.filter(url => url === A.url).length, 4);
  for (const source of [A, B]) {
    const restored = await snapshot(storage, source); const original = old.nodes[source.url].snapshot;
    assert.deepEqual(restored.config, original.config); assert.equal(restored.savedAt, original.savedAt);
    assert.equal(restored.version, 2); assert.equal(restored.generation, original.generation);
  }
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A, B]);
  assert.deepEqual(JSON.parse((await storage.get(SOURCE_URLS))!), [A, B]);
  for (const key of [SOURCE_CONFIG_SNAPSHOTS, SOURCE_PROCESSING_REPORT, SOURCE_IMPORT_POLICY_STATE]) {
    const raw = (await storage.get(key))!; assert.doesNotMatch(raw, /"children"|"lineage"/);
  }
  assert.ok((await readAggregateOutputs(storage))!.merged!.includes('A1'));
  storage = new JsonFileStorage(file); counts.clear(); requests.length = 0;
  mockFetch(url => { requests.push(url); return new Response('', { status: 404 }); });
  await runSync(storage, config); assert.ok(!requests.includes(M.url));
  assert.equal((await snapshot(storage)).savedAt, old.nodes[A.url].snapshot.savedAt);
});

test('confirmed failed old directories are deleted once; unknown failed old singles remain unresolved and recover normally', async () => {
  const storage = new MemoryStorage(); await legacyDirectory(storage, [A]);
  await roots(storage, [M, B]); const requests: string[] = [];
  mockFetch(url => { requests.push(url); return new Response('', { status: 404 }); });
  await legacyOutputs(storage); await runSync(storage, config);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [B]);
  assert.equal(requests.filter(url => url === M.url).length, 1);
  assert.equal(requests.filter(url => url === B.url).length, 4);
  const state = JSON.parse((await storage.get(SOURCE_IMPORT_POLICY_STATE))!);
  assert.equal(state.completedAt, undefined); assert.deepEqual(state.remaining.map((i: any) => i.url), [B.url]);
  assert.equal((await sourceMigrationReport(storage))!.removed[0].url, M.url);
  await assertUnavailableViews(storage);
  requests.length = 0; mockFetch(url => { requests.push(url); return response(leaf('B-recovered')); });
  await runSync(storage, config); assert.ok(!requests.includes(M.url));
  assert.ok(JSON.parse((await storage.get(SOURCE_IMPORT_POLICY_STATE))!).completedAt);
  assert.equal((await snapshot(storage, B)).config.sites[0].key, 'B-recovered');
});

test('legacy empty all-nested and all-failed directories remove their parents without requesting grandchildren', async () => {
  for (const mode of ['empty', 'nested', 'failed']) {
    const storage = new MemoryStorage(); await legacyDirectory(storage, [A]); await legacyOutputs(storage);
    const requests: string[] = [];
    mockFetch(url => {
      requests.push(url);
      if (url === M.url) return response(mode === 'empty' ? index() : index(N));
      return mode === 'nested' ? response(index(B)) : new Response('{broken');
    });
    await runSync(storage, config);
    assert.ok(!requests.includes(B.url)); assert.equal(requests.filter(url => url === N.url).length, mode === 'empty' ? 0 : 1);
    assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), []);
    assert.equal((await sourceMigrationReport(storage))!.removed.length, 1);
    await assertUnavailableViews(storage);
  }
});

test('duplicate-only legacy replacement removes the parent without overwriting a qualified direct leaf', async () => {
  const storage = new MemoryStorage(); const old = await legacyDirectory(storage, [A]); await roots(storage, [M, A]);
  const requests: string[] = []; mockFetch(url => { requests.push(url); return response(index(A)); });
  const ticket = await beginSourceOutputRun(storage); const rebased = await prepareImportOnlyRun(storage, config, ticket);
  assert.deepEqual(requests, [M.url]); assert.equal(rebased.runId, ticket.runId); assert.notEqual(rebased.epoch, ticket.epoch);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
  assert.deepEqual((await snapshot(storage)).config, old.nodes[A.url].snapshot.config);
  assert.equal((await snapshot(storage)).savedAt, old.nodes[A.url].snapshot.savedAt);
  const report = await sourceMigrationReport(storage); assert.equal(report!.added, 0); assert.equal(report!.duplicates, 1);
});

test('first actual activation blocks previously tracked old-policy output before migration network; restart alone is inert', async () => {
  const file = path.join(directory, 'tracked-legacy.json'); let storage = new JsonFileStorage(file);
  await legacyDirectory(storage, [A]); await legacyOutputs(storage);
  await storage.put(SOURCE_OUTPUT_STATE, JSON.stringify({ version: 1, epoch: 'old', pending: false, blocked: false,
    published: { epoch: 'old', runId: 'old-run', savedAt: '2020-01-01T00:00:00.000Z' } }));
  storage = new JsonFileStorage(file);
  assert.ok(await readAggregateOutputs(storage)); assert.equal(await storage.get(SOURCE_IMPORT_POLICY_STATE), null);
  let acquired!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(resolve => { acquired = resolve; });
  mockFetch(async url => {
    if (url === M.url) { acquired(); await new Promise<void>(resolve => { resume = resolve; }); return response(index(A)); }
    return response(leaf('A'));
  });
  const syncing = runSync(storage, config); await waiting;
  await assertUnavailableViews(storage); const restart = new JsonFileStorage(file); await assertUnavailableViews(restart);
  assert.deepEqual(JSON.parse((await restart.get(MANUAL_SOURCES))!), [M]);
  resume(); await syncing; assert.ok(await readAggregateOutputs(storage));
});

test('migration batch failure commits no roots health caches report or completion and retries only on a real run', async () => {
  const storage = new MemoryStorage(); await legacyDirectory(storage, [A]);
  await storage.put(SOURCE_HEALTH, JSON.stringify([{ url: A.url, consecutiveFailures: 8 }, { url: M.url, consecutiveFailures: 3 }]));
  mockFetch(url => response(url === M.url ? index(A) : leaf('A-inspected')));
  const ticket = await beginSourceOutputRun(storage); const before = new Map(storage.data);
  storage.failBatch = values => SOURCE_IMPORT_POLICY_STATE in values;
  await assert.rejects(prepareImportOnlyRun(storage, config, ticket), /write failed/);
  assert.deepEqual(storage.data, before); await assertUnavailableViews(storage);
  storage.failBatch = undefined;
  await prepareImportOnlyRun(storage, config, await beginSourceOutputRun(storage));
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
  assert.deepEqual(JSON.parse((await storage.get(SOURCE_HEALTH))!), [{ url: A.url, consecutiveFailures: 8 }]);
  assert.equal(await storage.get(MERGED_CONFIG), null); // Inspection is still not publication.
});

test('committed migration stays completed through a failed aggregate publication and never rechecks the removed parent', async () => {
  const storage = new MemoryStorage(); await legacyDirectory(storage, [A]); const requests: string[] = [];
  mockFetch(url => { requests.push(url); return response(url === M.url ? index(A) : leaf('A-new')); });
  storage.failBatch = values => MERGED_CONFIG in values;
  await runSync(storage, config);
  assert.ok(JSON.parse((await storage.get(SOURCE_IMPORT_POLICY_STATE))!).completedAt);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]); await assertUnavailableViews(storage);
  requests.length = 0; storage.failBatch = undefined; await runSync(storage, config);
  assert.deepEqual(requests, [A.url]); assert.ok(await readAggregateOutputs(storage));
});

test('stale migration cannot overwrite concurrent roots or supersede the newest run during epoch rebasing', async () => {
  for (const race of ['delete', 'readd', 'key', 'newer']) {
    const storage = new MemoryStorage(); await legacyDirectory(storage, [A]);
    let acquired!: () => void; let resume!: () => void;
    const waiting = new Promise<void>(resolve => { acquired = resolve; });
    let hold = true;
    mockFetch(async url => {
      if (url === M.url && hold) { hold = false; acquired(); await new Promise<void>(resolve => { resume = resolve; }); }
      return response(url === M.url ? index(A) : leaf('A'));
    });
    const old = await beginSourceOutputRun(storage); const migrating = prepareImportOnlyRun(storage, config, old); await waiting;
    if (race === 'newer') await beginSourceOutputRun(storage);
    else if (race === 'key') await roots(storage, [{ ...M, configKey: 'changed' }]);
    else { await roots(storage, []); if (race === 'readd') await roots(storage, [M]); }
    const before = new Map(storage.data); resume(); await assert.rejects(migrating, /changed|superseded|revoked/);
    assert.deepEqual(storage.data, before); assert.equal(await storage.get(SOURCE_IMPORT_POLICY_STATE), null);
  }
});

test('migration report route is authenticated flat and does not expose private identity or configuration fields', async () => {
  const storage = new MemoryStorage(); await legacyDirectory(storage, [A]); mockFetch(() => new Response('', { status: 404 }));
  await runSync(storage, config); const router = createSourceMgmtRouter({ storage, config });
  assert.equal((await router.request('/admin/sources/migration-result')).status, 401);
  const res = await router.request('/admin/sources/migration-result', { headers: adminHeaders });
  assert.equal(res.status, 200); const text = await res.text();
  assert.ok(text.includes(M.url)); assert.ok(text.includes('404'));
  assert.doesNotMatch(text, /"config"|"fingerprint"|"generation"|"children"|"remaining"/);
});

test('generated Admin actions wait once, render full inert text, retain partial input and restore controls', async () => {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    .find(text => text.includes('async function addSource()'))!;
  new Script(script); // Check the actual whole generated script, including template escaping.
  assert.doesNotMatch(adminHtml, /migrationResult|loadMigrationResult|\/admin\/sources\/migration-result/);
  const selected = capacityScript(script) + '\nsourceLimitValue = 6;\n' + script.slice(script.indexOf('// --- Final operation results ---'), script.indexOf('// --- Remove source ---'))
    + script.slice(script.indexOf('// --- Import Config ---'), script.indexOf('// --- Name Transform ---'));
  const reason = '<img src=x onerror=alert(1)> & ' + 'very-long-reason'.repeat(600);
  const partial = { type: 'multi', success: true, outcome: 'partial', added: 1, duplicates: 2,
    skipped: [{ name: '<nested>', url: N.url, reason }] };
  for (const action of ['addSource', 'importConfig']) {
    const elements: Record<string, any> = {};
    for (const id of ['addBtn', 'addResult', 'addUrl', 'addName', 'addConfigKey', 'importBtn', 'importResult', 'importInput', 'sourceCapacityHint']) {
      elements[id] = { value: id === 'addUrl' ? M.url : 'original input', textContent: '', innerHTML: '', disabled: false, focus() {} };
    }
    let resolve!: (value: unknown) => void; let calls = 0;
    let request: Promise<unknown> = new Promise(r => { resolve = r; });
    const context = createContext({ $: (id: string) => elements[id], loadSources() {}, loadSourceHealth() {}, document: { querySelectorAll: () => [] },
      auth: { authFetch: () => { calls++; return request; } } });
    new Script(selected).runInContext(context);
    const running = new Script(`${action}()`).runInContext(context);
    const button = elements[action === 'addSource' ? 'addBtn' : 'importBtn'];
    const result = elements[action === 'addSource' ? 'addResult' : 'importResult'];
    assert.equal(button.disabled, true); assert.match(button.textContent, /检查中/);
    await new Script(`${action}()`).runInContext(context); assert.equal(calls, 1);
    resolve({ ok: true, json: async () => partial }); await running;
    assert.equal(button.disabled, false); assert.ok(result.textContent.includes(reason));
    assert.match(result.textContent, /新增 1，重复 2，跳过 1/); assert.equal(result.innerHTML, '');
    assert.ok(result.textContent.includes('\n<nested>')); // Exact inert text, without stripping/truncation.
    assert.equal(elements.addUrl.value, M.url); assert.equal(elements.importInput.value, 'original input');
    request = Promise.resolve({ ok: true, json: async () => ({ ...partial, outcome: 'duplicates_only', added: 0, skipped: [] }) });
    await new Script(`${action}()`).runInContext(context); assert.match(result.textContent, /新增 0，重复 2，跳过 0/);
    request = Promise.resolve({ ok: true, json: async () => ({ ...partial, outcome: 'added', skipped: [] }) });
    await new Script(`${action}()`).runInContext(context);
    assert.equal(elements[action === 'addSource' ? 'addUrl' : 'importInput'].value, '');
    elements[action === 'addSource' ? 'addUrl' : 'importInput'].value = 'retry input';
    request = Promise.resolve({ ok: false, json: async () => ({ error: reason }) });
    await new Script(`${action}()`).runInContext(context);
    assert.equal(result.textContent, '导入出错：' + reason); assert.equal(button.disabled, false);
    assert.equal(elements[action === 'addSource' ? 'addUrl' : 'importInput'].value, 'retry input');
  }
});

test('v1 report-only directory proof can remove unavailable legacy parents without reconstructing a payload', async () => {
  const storage = new MemoryStorage(); await legacyDirectory(storage, [A]);
  const r = await registry(storage); delete r.nodes[M.url].snapshot;
  await storage.put(SOURCE_CONFIG_SNAPSHOTS, JSON.stringify(r));
  const report = { roundId: 'old', attemptedAt: '2020-01-01T00:00:00.000Z', outcome: 'failed', roots: [M.url],
    lineage: { [M.url]: { generation: r.nodes[M.url].generation, children: [A.url] },
      [A.url]: { generation: r.nodes[A.url].generation, children: [] } },
    observations: [{ ...M, generation: r.nodes[M.url].generation, kind: 'index', mode: 'skipped', local: false }] };
  await storage.put(SOURCE_PROCESSING_REPORT, JSON.stringify({ version: 1, latest: report }));
  let requests = 0; mockFetch(() => { requests++; return new Response('', { status: 404 }); });
  await runSync(storage, config);
  assert.equal(requests, 1); assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), []);
  assert.equal((await sourceMigrationReport(storage))!.removed[0].url, M.url);
  assert.equal(await snapshot(storage), undefined); await assertUnavailableViews(storage);
});

test('unreadable migration metadata aborts unsafe conversion before acquisition and retries with intact eligibility', async () => {
  for (const key of [SOURCE_CONFIG_SNAPSHOTS, SOURCE_PROCESSING_REPORT, SOURCE_IMPORT_POLICY_STATE]) {
    const storage = new MemoryStorage(); const old = await legacyDirectory(storage, [A]); await legacyOutputs(storage);
    let requests = 0; mockFetch(url => { requests++; return response(url === M.url ? index(A) : leaf('A')); });
    storage.failGet = key; await runSync(storage, config);
    assert.equal(requests, 0); assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [M]);
    storage.failGet = undefined;
    assert.equal((await registry(storage)).nodes[A.url].snapshot.savedAt, old.nodes[A.url].snapshot.savedAt);
    await assertUnavailableViews(storage); await runSync(storage, config);
    assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
  }
});

test('corrupt policy completion cannot skip legacy migration or expose malformed report payloads', async () => {
  for (const corrupt of ['{broken', JSON.stringify({ version: 1, policy: 'import-only-v1',
    startedAt: '2020-01-01T00:00:00.000Z', completedAt: '2020-01-01T00:00:00.000Z', remaining: [],
    report: { savedAt: '2020-01-01T00:00:00.000Z', added: 0, duplicates: 0,
      skipped: [{ url: { configKey: 'private' }, reason: 'bad', stage: 'parse' }], removed: [] } })]) {
    const storage = new MemoryStorage(); await legacyDirectory(storage, [A]);
    await storage.put(SOURCE_IMPORT_POLICY_STATE, corrupt);
    assert.equal(await sourceMigrationReport(storage), null);
    let requests = 0; mockFetch(() => { requests++; return new Response('', { status: 404 }); });
    await runSync(storage, config);
    assert.equal(requests, 1); assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), []);
    assert.equal((await sourceMigrationReport(storage))!.removed[0].url, M.url);
  }
});

async function editorSites(storage: Storage, editorConfig = config) {
  const res = await createConfigEditorRouter({ storage, config: editorConfig })
    .request('/admin/config-data', { headers: adminHeaders });
  assert.equal(res.status, 200);
  const data: { sites: (TVBoxSite & { sourceNames: string[]; fingerprint: string; blocked: boolean })[] } = JSON.parse(await res.text());
  return data.sites;
}

test('merge attributes all duplicate contributors without changing first content, suffix collisions or input configs', () => {
  const site = (key: string, api: string, name: string): TVBoxSite => ({ key, api, name, type: 3 });
  const sources = [
    { sourceUrl: A.url, sourceName: 'Same name', config: { sites: [
      site('shared', 'csp_common', 'Winner'), site('shared', 'csp_common', 'Discarded same-source'),
      site('conflict', 'csp_a', 'First'), site('other-key', 'csp_common', 'Other key'),
    ] } },
    { sourceUrl: B.url, sourceName: 'B', config: { sites: [
      site('shared', 'csp_common', 'Discarded other-source'), site('conflict', 'csp_b', 'Second'),
    ] } },
    { sourceUrl: N.url, sourceName: 'Same name', config: { sites: [
      site('shared', 'csp_common', 'Discarded same-name'), site('conflict_2', 'csp_b', 'Original suffix'),
    ] } },
  ];
  const before = JSON.stringify(sources); const merged = mergeConfigs(sources);
  assert.deepEqual(merged.config.sites!.map(s => [s.key, s.api, s.name]), [
    ['shared', 'csp_common', 'Winner'], ['conflict', 'csp_a', 'First'], ['other-key', 'csp_common', 'Other key'],
    ['conflict_2', 'csp_b', 'Second(2)'], ['conflict_2', 'csp_b', 'Original suffix'],
  ]);
  assert.deepEqual(merged.siteSourceNames, [['Same name', 'B', 'Same name'], ['Same name'], ['Same name'], ['B'], ['Same name']]);
  assert.equal(JSON.stringify(sources), before);
  assert.doesNotMatch(JSON.stringify(merged.config), /siteSourceNames|sourceIdentity|sourceNames/);
  const normalized = mergeConfigs([
    { sourceUrl: 'https://same.test/folder/config', sourceName: 'Relative', config: { sites: [{ key: 'api', type: 1, api: '../api' }] } },
    { sourceUrl: 'https://same.test/config', sourceName: 'Absolute', config: { sites: [{ key: 'api', type: 1, api: 'https://same.test/api' }] } },
  ]);
  assert.equal(normalized.config.sites!.length, 1);
  assert.deepEqual(normalized.siteSourceNames, [['Relative', 'Absolute']]);
});

test('full aggregation publishes fresh restored and inline origins without polluting config, snapshots or health', async () => {
  const storage = new MemoryStorage(); const local = { url: 'inline://inline_config_origins', name: 'Local interface' };
  await roots(storage, [A, B, local]); await storage.put('inline_config_origins', JSON.stringify(leaf('shared')));
  let failingA = false;
  mockFetch(url => url === A.url && failingA ? new Response('', { status: 404 }) : response(leaf('shared')));
  await runSync(storage, config); const original = await snapshot(storage); const localOriginal = await snapshot(storage, local);
  let sites = await editorSites(storage);
  assert.deepEqual(sites.map(s => s.sourceNames), [['A', 'B', 'Local interface']]);
  const fingerprint = sites[0].fingerprint;
  for (const raw of await rawOutputs(storage)) assert.doesNotMatch(raw!, /sourceNames|sourceIdentity|siteSourceNames/);
  const savedMetadata = JSON.parse((await storage.get(SITE_SOURCE_ATTRIBUTION))!);
  assert.equal(savedMetadata.runId, (await outputState(storage)).published.runId);
  assert.doesNotMatch(JSON.stringify(savedMetadata), /https:|inline:|configKey|generation/);
  failingA = true; await storage.delete('inline_config_origins'); await runSync(storage, config);
  sites = await editorSites(storage);
  assert.deepEqual(sites[0].sourceNames, ['A', 'B', 'Local interface']);
  assert.equal(sites[0].name, 'shared'); assert.equal(sites[0].fingerprint, fingerprint);
  assert.deepEqual(await snapshot(storage), original); assert.deepEqual(await snapshot(storage, local), localOriginal);
  const a = (await status(storage)).records.find((r: { url: string }) => r.url === A.url);
  assert.equal(a.fetchStatus, 'http_404'); assert.equal(a.consecutiveFailures, 1);
  assert.equal(a.aggregation.lastSuccessful.snapshotTime, original.savedAt);
  // An active newer run must not hide the attribution belonging to still-readable prior output.
  await beginSourceOutputRun(storage);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, ['A', 'B', 'Local interface']);
  const app = createApp({ storage, config, runtime: idleRuntime,
    triggerRefresh: async () => ({ ran: false, outcome: 'busy', message: '正在聚合' }) });
  assert.equal((await app.request('/admin/config-data')).status, 401);
});

test('independent MacCMS rows retain their entry origins, validation filtering, proxy path and latency names', async () => {
  for (const edge of [false, true]) {
    const storage = new MemoryStorage(); await roots(storage, [A]);
    await storage.put(MACCMS_SOURCES, JSON.stringify([
      { key: 'one', name: 'CMS One', api: 'https://cms-one.test/api' },
      { key: 'two', name: 'CMS Two', api: 'https://cms-two.test/api' },
    ]));
    if (edge) await storage.put(EDGE_PROXIES, JSON.stringify({ vercel: 'https://edge.test' }));
    let failingTwo = false; const calls: string[] = [];
    mockFetch(url => {
      calls.push(url);
      if (url === A.url) return response(leaf('vod'));
      return new Response(JSON.stringify({ list: [] }), { status: failingTwo && url.includes('cms-two') ? 404 : 200 });
    });
    await runSync(storage, config); let sites = await editorSites(storage);
    assert.deepEqual(sites.map(s => s.sourceNames), [['A'], ['CMS One'], ['CMS Two']]);
    assert.match(sites[1].name!, edge ? /^CMS One$/ : /^CMS One \[\d+\.\ds\]$/);
    assert.ok(sites[1].api.includes('/api/one'));
    assert.deepEqual(Object.keys((await registry(storage)).nodes), [A.url]);
    assert.equal(calls.filter(url => url.includes('cms-one.test')).length, edge ? 0 : 1);
    failingTwo = true; await runSync(storage, config); sites = await editorSites(storage);
    assert.deepEqual(sites.map(s => s.sourceNames), edge ? [['A'], ['CMS One'], ['CMS Two']] : [['A'], ['CMS One']]);
  }
});

test('missing damaged or mismatched attribution never invents sources or disables ordinary output', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  mockFetch(() => response(leaf('known'))); await runSync(storage, config);
  const raw = (await storage.get(SITE_SOURCE_ATTRIBUTION))!;
  const envelope: { version: number; runId: string; fullHash: string; rows: unknown[] } = JSON.parse(raw);
  for (const corrupt of [null, '{broken', JSON.stringify([]),
    JSON.stringify({ ...envelope, version: 2 }), JSON.stringify({ ...envelope, runId: 'old-publication' }),
    JSON.stringify({ ...envelope, fullHash: 'wrong' }), JSON.stringify({ ...envelope, rows: [] }),
    JSON.stringify({ ...envelope, rows: [[123]] }), JSON.stringify({ ...envelope, rows: [['']] })]) {
    if (corrupt === null) await storage.delete(SITE_SOURCE_ATTRIBUTION);
    else await storage.put(SITE_SOURCE_ATTRIBUTION, corrupt);
    assert.deepEqual((await editorSites(storage))[0].sourceNames, []);
    assert.ok((await readAggregateOutputs(storage))!.merged!.includes('known'));
  }
  await storage.put(SITE_SOURCE_ATTRIBUTION, raw);
  storage.failGet = SITE_SOURCE_ATTRIBUTION;
  assert.deepEqual((await editorSites(storage))[0].sourceNames, []); storage.failGet = undefined;
  assert.deepEqual((await editorSites(storage))[0].sourceNames, ['A']);
  const full = (await storage.get(MERGED_CONFIG_FULL))!;
  await storage.put(MERGED_CONFIG_FULL, full + ' ');
  assert.deepEqual((await editorSites(storage))[0].sourceNames, []);
  await storage.delete(MERGED_CONFIG_FULL);
  const merged = (await storage.get(MERGED_CONFIG))!;
  await storage.put(SITE_SOURCE_ATTRIBUTION, encodeSiteSourceAttribution(envelope.runId, merged, [['Fallback view']]));
  assert.deepEqual((await editorSites(storage))[0].sourceNames, ['Fallback view']);
  // Untracked legacy data and user-supplied fields cannot fabricate authoritative provenance.
  const legacy = new MemoryStorage(); const forged = JSON.stringify({ sites: [{ ...leaf('forged').sites![0], sourceNames: ['Untrusted'] }] });
  await legacy.put(MERGED_CONFIG_FULL, forged); await legacy.put(MERGED_CONFIG, forged);
  await legacy.put(SITE_SOURCE_ATTRIBUTION, encodeSiteSourceAttribution('untracked', forged, [['Untrusted']]));
  assert.deepEqual((await editorSites(legacy))[0].sourceNames, []);
  // Identical FULL bytes can represent different successful source-name publications.
  await roots(storage, [{ ...A, name: 'Renamed interface' }]); await runSync(storage, config);
  assert.equal(await storage.get(MERGED_CONFIG_FULL), full);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, ['Renamed interface']);
  const newMetadata = (await storage.get(SITE_SOURCE_ATTRIBUTION))!;
  await storage.put(SITE_SOURCE_ATTRIBUTION, raw);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, []);
  await storage.put(SITE_SOURCE_ATTRIBUTION, newMetadata);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, ['Renamed interface']);
});

test('editor attributes the raw published view before host substitution and preserves current sources through patches and deletion', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A, B]);
  mockFetch(url => response(leaf(url === A.url ? 'A1' : 'B1'))); await runSync(storage, config);
  const captured = (await readAggregateOutputs(storage))!;
  await storage.put(SITE_SOURCE_ATTRIBUTION, (await storage.get(SITE_SOURCE_ATTRIBUTION))! + ' ');
  assert.equal(await publishAggregatePatch(storage, captured.token, captured.merged!, captured.exported!), false);
  const oldMetadata = await storage.get(SITE_SOURCE_ATTRIBUTION);
  const fp = (await editorSites(storage))[0].fingerprint;
  await storage.put(BLACKLIST, JSON.stringify({ sites: [fp], parses: [], lives: [], regexRules: [], regexBlockOverrides: [] }));
  assert.equal((await patchMergedConfig(storage)).patched, true);
  assert.equal(await storage.get(SITE_SOURCE_ATTRIBUTION), oldMetadata);
  assert.equal((await editorSites(storage))[0].blocked, true);
  assert.deepEqual((await editorSites(storage)).map(s => s.sourceNames), [['A'], ['B']]);
  await roots(storage, [B]); assert.deepEqual((await editorSites(storage)).map(s => s.sourceNames), [['A'], ['B']]);
  mockFetch(() => new Response('', { status: 404 })); await runSync(storage, config);
  assert.deepEqual((await editorSites(storage)).map(s => s.sourceNames), [['B']]);
  await roots(storage, []); await runSync(storage, config); assert.deepEqual(await editorSites(storage), []);
  const host = new MemoryStorage(); await roots(host, [A]);
  await host.put(MACCMS_SOURCES, JSON.stringify([{ key: 'host', name: 'Host source', api: 'https://host.test/api' }]));
  mockFetch(url => url === A.url ? response(leaf('vod')) : new Response(JSON.stringify({ list: [] })));
  await runSync(host, config);
  const one = await editorSites(host, { ...config, localBaseUrl: 'https://first.test' });
  const two = await editorSites(host, { ...config, localBaseUrl: 'https://second.test' });
  assert.deepEqual(one.map(s => s.sourceNames), [['A'], ['Host source']]);
  assert.deepEqual(two.map(s => s.sourceNames), one.map(s => s.sourceNames));
  assert.ok(one[1].api.includes('first.test')); assert.ok(two[1].api.includes('second.test'));
});

test('actual editor row scripts keep origins as escaped independent text in every blocking state', () => {
  const scripts = [...configEditorHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  for (const script of scripts) new Script(script);
  const script = scripts.find(text => text.includes('function siteRow(s)'))!;
  const selected = script.slice(script.indexOf('function siteTitle(s, badge)'), script.indexOf('function renderParses()'));
  const source = '<source & "quoted"> 🎬 ' + 'long-interface-name'.repeat(200);
  const esc = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  for (const flags of [{}, { blocked: true }, { blocked: true, regexBlocked: true }, { isOverridden: true }]) {
    const input = { ...leaf('site').sites![0], fingerprint: 'fp', sourceNames: [source, 'Other interface'], ...flags };
    const before = JSON.stringify(input);
    const context = createContext({ input, esc, escAttr: esc, typeSpan: () => '', SITE_TYPE_TIPS: {} });
    const rendered: string = new Script(selected + '\nsiteRow(input)').runInContext(context);
    assert.match(rendered, /class="item-source-name"/);
    assert.ok(rendered.includes(esc(source) + '、Other interface'));
    assert.ok(!rendered.includes(source)); assert.doesNotMatch(rendered, /source-url/);
    assert.match(rendered, /data-search="site site csp_site"/);
    assert.ok(!rendered.slice(rendered.indexOf('data-search='), rendered.indexOf('data-search=') + 45).includes('source'));
    assert.equal(JSON.stringify(input), before);
    const missing = createContext({ input: { ...input, sourceNames: [] }, esc, escAttr: esc, typeSpan: () => '', SITE_TYPE_TIPS: {} });
    assert.doesNotMatch(new Script(selected + '\nsiteRow(input)').runInContext(missing), /item-source-name/);
  }
});

// Run actual generated Admin functions, including switchTab and the shared transport.
class LogDomElement {
  children: LogDomElement[] = [];
  className = '';
  scrollTop = 0;
  clientHeight = 40;
  checked = true;
  private text = '';
  private active = false;
  dataset: { tab?: string } = {};
  constructor(public id = '') {}
  classList = {
    contains: (name: string) => name === 'active' && this.active,
    toggle: (_name: string, active: boolean) => { this.active = active; },
  };
  get scrollHeight() { return this.children.length * 20; }
  get firstChild() { return this.children[0]; }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('\n') : this.text; }
  set textContent(value: string) { this.text = value; this.children = []; }
  appendChild(child: LogDomElement) { this.children.push(child); }
  removeChild(child: LogDomElement) { this.children.splice(this.children.indexOf(child), 1); }
}
type LogConnection = {
  aborted: boolean;
  abort(): void;
  data(data: string): void;
  open(): void;
  error(error?: Error): void;
};
function logUi(transport?: { fetch: typeof fetch }) {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    .find(text => text.includes('function switchTab(tab)'))!;
  new Script(script);
  const elements = Object.fromEntries(['panelLogs', 'panelSettings', 'panelSources', 'logConnStatus', 'logViewer', 'logAutoScroll']
    .map(id => [id, new LogDomElement(id)]));
  const panels = ['panelLogs', 'panelSettings', 'panelSources'].map(id => elements[id]);
  const connections: LogConnection[] = [];
  const timers = new Map<number, () => void>();
  const allTimers = new Map<number, () => void>();
  let timerId = 0;
  const context = createContext({ loadLives() {},
    $: (id: string) => elements[id],
    auth: { getToken: () => 'test-token' },
    document: { getElementById: (id: string) => elements[id],
      querySelectorAll: (selector: string) => selector === '.tab-panel' ? panels : [],
      createElement: () => new LogDomElement() },
    setTimeout: (fn: () => void, ms: number) => {
      assert.equal(ms, 3000);
      timers.set(++timerId, fn); allTimers.set(timerId, fn); return timerId;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    streamSse: (_url: string, token: string, data: LogConnection['data'], open: LogConnection['open'], error: LogConnection['error']) => {
      assert.equal(token, 'test-token');
      const connection: LogConnection = { aborted: false, abort() { this.aborted = true; }, data, open, error };
      connections.push(connection); return connection;
    },
    ...(transport ? { fetch: transport.fetch, AbortController, TextDecoder } : {}),
  });
  const selected = script.slice(script.indexOf('function switchTab(tab)'), script.indexOf('// --- Source health ---'))
    + script.slice(script.indexOf('let logSseHandle = null;'), script.indexOf('applyTheme(getTheme());', script.indexOf('let logSseHandle = null;')));
  new Script((transport ? sharedUi : '') + selected).runInContext(context);
  return { elements, connections, timers, allTimers,
    tab: (tab: string) => new Script(`switchTab(${JSON.stringify(tab)})`).runInContext(context),
    retry() { const [id, fn] = [...timers][0]; timers.delete(id); fn(); },
    active: () => connections.filter(connection => !connection.aborted).length,
  };
}
const logEntry = (message: string): LogEntry => ({ ts: '2026-10-13 17:24:52', level: 'info', scope: 'fixture', message });

test('Admin tab cycles replace replayed history but preserve authentic identical entries', () => {
  const ui = logUi();
  const repeated = JSON.stringify(logEntry('同一秒真实产生的相同日志'));
  for (let cycle = 0; cycle < 5; cycle++) {
    ui.tab('logs');
    const stream = ui.connections.at(-1)!;
    ui.tab('logs'); assert.equal(ui.connections.length, cycle + 1);
    stream.open(); assert.equal(ui.elements.logViewer.children.length, 0);
    stream.data(repeated); stream.data(repeated); stream.data('malformed JSON');
    assert.equal(ui.elements.logViewer.children.length, 2);
    assert.equal(ui.elements.logViewer.children[0].textContent, ui.elements.logViewer.children[1].textContent);
    ui.tab('settings');
    assert.equal(ui.active(), 0); assert.equal(ui.timers.size, 0);
    assert.equal(ui.elements.logViewer.children.length, 2);
  }
});

test('Admin keeps logs on failure, has one retry, and cancels retries on leaving without a handle', () => {
  const ui = logUi(); ui.tab('logs');
  const first = ui.connections[0]; first.open(); first.data(JSON.stringify(logEntry('existing')));
  first.error(new Error('disconnect'));
  first.error(new Error('late second error'));
  assert.equal(ui.timers.size, 1); assert.equal(ui.active(), 0);
  ui.retry(); const second = ui.connections[1];
  assert.equal(ui.elements.logViewer.children.length, 1);
  second.error(new Error('HTTP 401'));
  assert.equal(ui.elements.logViewer.children.length, 1);
  const staleTimer = [...ui.timers.values()][0];
  ui.tab('settings'); assert.equal(ui.timers.size, 0);
  assert.equal(ui.elements.logConnStatus.textContent, '未连接');
  ui.tab('logs'); ui.connections[2].open();
  assert.equal(ui.elements.logViewer.children.length, 0);
  staleTimer(); assert.equal(ui.connections.length, 3); assert.equal(ui.active(), 1);
  ui.tab('settings');
});

test('Admin ignores old open/data/error callbacks while a newer connection is active', () => {
  const ui = logUi(); ui.tab('logs'); const old = ui.connections[0];
  old.open(); old.data(JSON.stringify(logEntry('old')));
  ui.tab('settings'); ui.tab('logs'); const current = ui.connections[1];
  current.open(); current.data(JSON.stringify(logEntry('current')));
  old.open(); old.data(JSON.stringify(logEntry('stale'))); old.error(new Error('late error'));
  assert.equal(ui.elements.logViewer.children.length, 1);
  assert.match(ui.elements.logViewer.textContent, /current$/);
  assert.equal(ui.elements.logConnStatus.textContent, '已连接');
  assert.equal(ui.timers.size, 0); assert.equal(ui.active(), 1);
  ui.tab('settings');
});

test('Admin keeps its 500-line cap and active-stream auto-scroll behavior', () => {
  const ui = logUi(); ui.tab('logs'); const stream = ui.connections[0]; stream.open();
  for (let i = 0; i < 510; i++) stream.data(JSON.stringify(logEntry('line-' + i)));
  assert.equal(ui.elements.logViewer.children.length, 500);
  assert.match(ui.elements.logViewer.firstChild.textContent, /line-10$/);
  assert.equal(ui.elements.logViewer.scrollTop, ui.elements.logViewer.scrollHeight);
  ui.elements.logViewer.scrollTop = 0;
  stream.data(JSON.stringify(logEntry('scrolled-away')));
  assert.equal(ui.elements.logViewer.scrollTop, 0);
  ui.elements.logViewer.scrollTop = ui.elements.logViewer.scrollHeight;
  ui.elements.logAutoScroll.checked = false;
  stream.open();
  stream.data(JSON.stringify(logEntry('auto-scroll-off')));
  assert.equal(ui.elements.logViewer.scrollTop, 0);
  assert.equal(ui.elements.logViewer.scrollHeight, 20);
  ui.elements.logAutoScroll.checked = true;
  stream.data(JSON.stringify(logEntry('auto-scroll-on')));
  assert.equal(ui.elements.logViewer.scrollTop, 40);
  ui.tab('settings');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function transportFixture(fetcher: typeof fetch) {
  const messages: string[] = []; const errors: Error[] = []; let opens = 0;
  const context = createContext({ fetch: fetcher, AbortController, TextDecoder,
    onMessage: (data: string) => messages.push(data), onOpen: () => { opens++; }, onError: (error: Error) => errors.push(error) });
  new Script(sharedUi + '\nvar handle = streamSse("/admin/logs", "test-token", onMessage, onOpen, onError);').runInContext(context);
  return { messages, errors, opens: () => opens,
    abort: () => new Script('handle.abort()').runInContext(context) };
}

test('shared SSE decodes split Chinese UTF-8 and frame boundaries, ignores heartbeats, and reports EOF once', async () => {
  const encoder = new TextEncoder();
  const body = encoder.encode(': ping\n\nid: unused\ndata: 中文第一行\ndata: 第二行\n\ndata: last\n\n');
  const responseBody = new ReadableStream<Uint8Array>({ start(controller) {
    // One-byte chunks split every multibyte character and every delimiter.
    for (const byte of body) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } });
  const fixture = transportFixture((async (_input: unknown, options?: RequestInit) => {
    assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer test-token');
    return new Response(responseBody);
  }) as typeof fetch);
  await tick();
  assert.equal(fixture.opens(), 1);
  assert.deepEqual(fixture.messages, ['中文第一行\n第二行', 'last']);
  assert.equal(fixture.errors.length, 1); assert.match(fixture.errors[0].message, /stream ended/);
  assert.equal(responseBody.locked, false);
});

test('shared SSE ignores responses delivered after abort and leaves failed connections unopened', async () => {
  const request = deferred<Response>();
  let cancelled = false;
  const fixture = transportFixture((async () => request.promise) as typeof fetch);
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  fixture.abort(); request.resolve(new Response(body)); await tick();
  assert.equal(fixture.opens(), 0); assert.deepEqual(fixture.messages, []); assert.deepEqual(fixture.errors, []);
  assert.equal(cancelled, true);
  const failed = transportFixture((async () => new Response('', { status: 401 })) as typeof fetch);
  await tick(); assert.equal(failed.opens(), 0); assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0].message, /HTTP 401/);
  const missing = transportFixture((async () => new Response(null)) as typeof fetch);
  await tick(); assert.equal(missing.opens(), 0); assert.equal(missing.errors.length, 1);
});

test('shared SSE cancels its reader and suppresses normally ended or failed reads after abort', async () => {
  for (const failure of [false, true]) {
    const read = deferred<{ done: boolean; value?: Uint8Array }>();
    let cancels = 0; let releases = 0;
    const fixture = transportFixture((async () => ({ ok: true, body: { getReader: () => ({
      read: () => read.promise, cancel: async () => { cancels++; }, releaseLock: () => { releases++; },
    }) } })) as unknown as typeof fetch);
    await tick(); assert.equal(fixture.opens(), 1);
    fixture.abort();
    if (failure) read.reject(new Error('unrelated reader failure'));
    else read.resolve({ done: false, value: new TextEncoder().encode('data: stale\n\n') });
    await tick();
    assert.ok(cancels >= 1); assert.equal(releases, 1);
    assert.deepEqual(fixture.messages, []); assert.deepEqual(fixture.errors, []);
  }
});

function resetLogsForCase() { resetLogBuffer(); restoreMocks.push(resetLogBuffer); }
function observeLogHeartbeats() {
  const originalSet = globalThis.setInterval; const originalClear = globalThis.clearInterval;
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    assert.equal(ms, 25_000); const timer = originalSet(() => {}, 60_000); timers.set(timer, fn); return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { timers.delete(timer); originalClear(timer); }) as typeof clearInterval;
  restoreMocks.push(() => {
    for (const timer of timers.keys()) originalClear(timer);
    globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear;
  });
  return timers;
}
function logStreamFrames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let buffer = ''; const decoder = new TextDecoder();
  return async () => {
    while (!buffer.includes('\n\n')) {
      const next = await reader.read();
      if (next.done) throw new Error('unexpected EOF');
      buffer += decoder.decode(next.value, { stream: true });
    }
    const index = buffer.indexOf('\n\n'); const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
    return frame.startsWith(':') ? frame : JSON.parse(frame.slice('data: '.length)) as LogEntry;
  };
}

test('log route subscribes before history replay, serializes live events, and keeps genuine repeats', async () => {
  resetLogsForCase(); const heartbeats = observeLogHeartbeats();
  for (let i = 0; i < 4; i++) logger.info('fixture', 'history-' + i);
  const history = logHistory();
  const route = createLogViewerRouter({ storage: new MemoryStorage(), config });
  const res = await route.request('/admin/logs', { headers: adminHeaders });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(logSubscriberCount(), 1); assert.equal(heartbeats.size, 1);
  // Reader has not consumed history; these events arrive while replay is blocked.
  logger.info('fixture', 'during-replay'); logger.info('fixture', 'during-replay');
  const reader = res.body!.getReader(); const frame = logStreamFrames(reader);
  try {
    for (const entry of history) assert.deepEqual(await frame(), entry);
    const first = await frame() as LogEntry; const second = await frame() as LogEntry;
    assert.equal(first.message, 'during-replay'); assert.equal(second.message, 'during-replay');
    const waiting = frame(); await tick(); logger.info('fixture', 'after-replay');
    assert.equal((await waiting as LogEntry).message, 'after-replay');
    [...heartbeats.values()][0](); assert.equal(await frame(), ': ping');
  } finally { await reader.cancel(); }
  await tick(); assert.equal(logSubscriberCount(), 0); assert.equal(heartbeats.size, 0);
});

test('log route cleans up cancellation during replay, including queued live data and request abort', async () => {
  const heartbeats = observeLogHeartbeats();
  for (const mode of ['reader', 'request', 'already-aborted']) {
    resetLogsForCase();
    for (let i = 0; i < 10; i++) logger.info('fixture', 'history-' + i);
    const controller = new AbortController();
    if (mode === 'already-aborted') controller.abort();
    const res = await createLogViewerRouter({ storage: new MemoryStorage(), config })
      .request('/admin/logs', { headers: adminHeaders, signal: controller.signal });
    if (mode !== 'already-aborted') {
      assert.equal(logSubscriberCount(), 1); logger.info('fixture', 'queued');
    }
    if (mode === 'reader') await res.body!.cancel(); else controller.abort();
    await tick(); assert.equal(logSubscriberCount(), 0); assert.equal(heartbeats.size, 0);
    if (mode !== 'reader') await res.body!.cancel();
  }
});

test('log route cleans up idle cancellation and rejects unauthorized streams without subscriptions', async () => {
  resetLogsForCase(); const heartbeats = observeLogHeartbeats();
  const route = createLogViewerRouter({ storage: new MemoryStorage(), config });
  assert.equal((await route.request('/admin/logs')).status, 401);
  assert.equal(logSubscriberCount(), 0); assert.equal(heartbeats.size, 0);
  const res = await route.request('/admin/logs', { headers: adminHeaders });
  const reader = res.body!.getReader(); const frame = logStreamFrames(reader);
  const count = logHistory().length; for (let i = 0; i < count; i++) await frame();
  await tick(); await reader.cancel(); await tick();
  assert.equal(logSubscriberCount(), 0); assert.equal(heartbeats.size, 0);
});

test('real Admin and shared transport rebuild the log window on EOF reconnect without extra streams', async () => {
  let requests = 0; let active = 0; let maximumActive = 0;
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const ui = logUi({ fetch: (async () => {
    requests++; active++; maximumActive = Math.max(maximumActive, active);
    let finished = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); },
      cancel() { if (!finished) { finished = true; active--; } } });
    return new Response(body);
  }) as typeof fetch });
  const encoded = new TextEncoder().encode('data: ' + JSON.stringify(logEntry('startup')) + '\n\n');
  ui.tab('logs'); await tick(); controllers[0].enqueue(encoded); await tick();
  assert.equal(ui.elements.logViewer.children.length, 1);
  controllers[0].close(); await tick();
  // Closing a mock source normally does not invoke its cancel hook.
  active = 0;
  assert.equal(ui.timers.size, 1); ui.retry(); await tick();
  controllers[1].enqueue(encoded); await tick();
  assert.equal(ui.elements.logViewer.children.length, 1); assert.equal(requests, 2); assert.equal(maximumActive, 1);
  ui.tab('settings'); await tick(); assert.equal(active, 0); assert.equal(ui.timers.size, 0);
});

const manualOne = { name: '我的直播 <&> 🎬', url: 'https://manual.test/list.m3u?marker=__TVBOX_BASE_URL__&q=%22' };
const manualTwo = { name: '', url: 'http://192.168.1.9/live.txt' };
const automaticLive = { name: 'upstream live', type: 0, url: 'https://upstream.test/live.m3u' };
const directLives = (...entries: { name: string; url: string }[]) => entries.map(entry => ({ ...entry, type: 0 }));
async function seedLegacyLives(storage: Storage) {
  const raw = JSON.stringify({ ...leaf('legacy-vod'), lives: [automaticLive] });
  await storage.putMany({ [MERGED_CONFIG]: raw, [MERGED_CONFIG_FULL]: raw, [EXPORT_CONFIG]: raw, [LAST_UPDATE]: 'old-success' });
}
async function liveMutation(storage: Storage, entry: { name?: string; url: string }, method = 'POST') {
  return createLiveSourcesRouter({ storage, config }).request('/admin/lives', { method,
    headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
}
async function manualLiveViews(storage: Storage, appConfig = config) {
  const main = createConfigOutputRouter({ storage, config: appConfig });
  const exported = createExportConfigRouter({ storage, config: appConfig, runtime: idleRuntime });
  const routes = [await main.request('/'), await main.request('/live-config'),
    await exported.request('/admin/export-config', { headers: adminHeaders })];
  for (const route of routes) assert.equal(route.status, 200);
  const results = await Promise.all(routes.map(route => route.json() as Promise<TVBoxConfig>));
  return { results, routes };
}
async function assertManualViews(storage: Storage, expected: ReturnType<typeof directLives>, appConfig = config) {
  const views = await manualLiveViews(storage, appConfig);
  for (const [index, result] of views.results.entries()) {
    const policy = await loadLivePolicy(storage);
    assert.deepEqual(result.lives, index < 2 ? expected.map(entry => projectLiveAddress(entry, policy.cacheState, appConfig.localBaseUrl || '')) : expected);
    assert.equal(views.routes[index].headers.get('cache-control'), 'no-store');
  }
}
async function setLiveDisabled(storage: Storage, disabled: boolean) {
  return createSettingsRouter({ storage, config, runtime: idleRuntime }).request('/admin/live-disabled', {
    method: 'PUT', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled }),
  });
}

test('disabled manual lives update every response immediately without aggregation, fetch or success-time mutation', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage);
  const originals = await rawOutputs(storage); const stamp = await storage.get(LAST_UPDATE);
  mockFetch(() => { throw new Error('Manual policy must not fetch a URL'); });
  await assertManualViews(storage, []); // Missing setting defaults to disabled; empty is intentional.
  assert.equal((await liveMutation(storage, manualOne)).status, 200);
  assert.equal((await liveMutation(storage, manualTwo)).status, 200);
  await assertManualViews(storage, directLives(manualOne, manualTwo), { ...config, localBaseUrl: 'http://192.168.1.5:8787' });
  const stats = await (await createDashboardRouter({ storage, config, runtime: idleRuntime }).request('/status-data')).json() as { lives: number };
  assert.equal(stats.lives, 2);
  const editor = await (await createConfigEditorRouter({ storage, config }).request('/admin/config-data', { headers: adminHeaders })).json() as any;
  assert.equal(editor.liveDisabled, true); assert.equal(editor.lives[0].url, automaticLive.url);
  assert.equal((await liveMutation(storage, manualOne, 'DELETE')).status, 200);
  await assertManualViews(storage, directLives(manualTwo));
  assert.equal((await liveMutation(storage, manualTwo, 'DELETE')).status, 200);
  await assertManualViews(storage, []);
  assert.deepEqual(await rawOutputs(storage), originals);
  assert.equal(await storage.get(LAST_UPDATE), stamp);
  assert.equal(await storage.get(SOURCE_OUTPUT_STATE), null);
  assert.equal(await storage.get(SOURCE_CONFIG_SNAPSHOTS), null);
});

test('disabled aggregation and VOD cache reuse publish direct manual lives while FULL and source snapshots retain upstream data', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  await liveMutation(storage, manualOne);
  await storage.put(BLACKLIST, JSON.stringify({ sites: [], parses: [], lives: [manualOne.url, automaticLive.url], regexRules: [] }));
  let fail = false; const calls: string[] = [];
  const upstream = { ...leaf('vod'), lives: [automaticLive] };
  mockFetch(url => { calls.push(url); assert.equal(url, A.url); return fail ? new Response('', { status: 503 }) : response(upstream); });
  await runSync(storage, config);
  const raw = await rawOutputs(storage);
  assert.deepEqual(JSON.parse(raw[0]!).lives, []); // Stored base excludes independent manual declarations.
  assert.deepEqual(JSON.parse(raw[1]!).lives, [automaticLive]);
  assert.deepEqual(JSON.parse(raw[2]!).lives, []);
  assert.deepEqual((await snapshot(storage)).config.lives, [automaticLive]);
  const saved = (await snapshot(storage)).savedAt;
  fail = true; await runSync(storage, config);
  await assertManualViews(storage, directLives(manualOne));
  assert.equal((await snapshot(storage)).savedAt, saved);
  assert.ok(calls.every(url => url === A.url));
  assert.equal(await storage.get('channel_merged_tree'), null);
  assert.equal((await status(storage)).records[0].aggregation.latest.mode, 'restored');
  assert.equal((await patchMergedConfig(storage)).patched, true);
  await assertManualViews(storage, directLives(manualOne));
  assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG_FULL))!).lives, [automaticLive]);
});

test('manual declarations never establish or revive unavailable VOD output and remain saved across failed writes', async () => {
  const storage = new MemoryStorage(); await liveMutation(storage, manualOne);
  const absent = createConfigOutputRouter({ storage, config });
  assert.equal((await absent.request('/')).status, 503);
  assert.equal((await absent.request('/live-config')).status, 503);
  const absentExport = createExportConfigRouter({ storage, config, runtime: idleRuntime });
  assert.equal((await absentExport.request('/admin/export-config', { headers: adminHeaders })).status, 503);
  assert.equal((await readAggregateOutputs(storage))?.merged, null);
  await seedLegacyLives(storage); await assertManualViews(storage, directLives(manualOne));
  storage.failPut = LIVE_SOURCES;
  const prior = await storage.get(LIVE_SOURCES); const stamp = await storage.get(LAST_UPDATE);
  const router = createLiveSourcesRouter({ storage, config }); router.onError(() => new Response('write failed', { status: 500 }));
  const failedAdd = await router.request('/admin/lives', { method: 'POST', headers: adminHeaders, body: JSON.stringify(manualTwo) });
  assert.equal(failedAdd.status, 500); assert.equal(await storage.get(LIVE_SOURCES), prior);
  const failedDelete = await router.request('/admin/lives', { method: 'DELETE', headers: adminHeaders, body: JSON.stringify(manualOne) });
  assert.equal(failedDelete.status, 500); assert.equal(await storage.get(LIVE_SOURCES), prior);
  await assertManualViews(storage, directLives(manualOne)); assert.equal(await storage.get(LAST_UPDATE), stamp);
  storage.failPut = undefined;
  await roots(storage, [A]); await beginSourceOutputRun(storage); await assertUnavailableViews(storage);
  assert.equal((await liveMutation(storage, manualTwo)).status, 200); await assertUnavailableViews(storage);
});

test('manual live CRUD stays authenticated and serializes concurrent additions and deletions without lost entries', async () => {
  const storage = new MemoryStorage(); const router = createLiveSourcesRouter({ storage, config });
  assert.equal((await router.request('/admin/lives')).status, 401);
  assert.equal((await router.request('/admin/lives', { method: 'POST', body: JSON.stringify(manualOne) })).status, 401);
  assert.equal(await storage.get(LIVE_SOURCES), null);
  for (const input of [null, { url: 123 }, { url: 'not a URL' }, { url: manualOne.url, name: 123 }]) {
    assert.equal((await router.request('/admin/lives', { method: 'POST', headers: adminHeaders, body: JSON.stringify(input) })).status, 400);
  }
  const added = await Promise.all([liveMutation(storage, manualOne), liveMutation(storage, manualTwo)]);
  assert.deepEqual(added.map(result => result.status), [200, 200]);
  assert.deepEqual(JSON.parse((await storage.get(LIVE_SOURCES))!), [manualOne, manualTwo]);
  const duplicates = await Promise.all([liveMutation(storage, manualOne), liveMutation(storage, manualOne)]);
  assert.deepEqual(duplicates.map(result => result.status), [409, 409]);
  await Promise.all([liveMutation(storage, manualOne, 'DELETE'), liveMutation(storage, manualTwo, 'DELETE')]);
  assert.deepEqual(JSON.parse((await storage.get(LIVE_SOURCES))!), []);
});

test('setting changes apply immediately, enabled sources retain address objects, and legacy probe data remains inert', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, manualTwo);
  assert.equal((await setLiveDisabled(storage, false)).status, 200);
  const enabled = await manualLiveViews(storage);
  assert.deepEqual(enabled.results[0].lives, [automaticLive, ...directLives(manualTwo)]);
  assert.equal(enabled.routes[0].headers.get('cache-control'), 'no-store');
  assert.equal(enabled.routes[1].headers.get('cache-control'), 'no-store');
  const prior = await rawOutputs(storage);
  await liveMutation(storage, manualOne); assert.deepEqual(await rawOutputs(storage), prior);
  await assertManualViews(storage, [automaticLive, ...directLives(manualTwo, manualOne)]);
  await roots(storage, [A]); const calls: string[] = [];
  mockFetch(url => {
    calls.push(url);
    if (url === A.url) return response({ ...leaf('vod'), lives: [automaticLive] });
    return new Response('#EXTM3U\n#EXTINF:-1 group-title="测试",CCTV1\nhttps://channel.test/' + calls.length + '.m3u8\n');
  });
  await runSync(storage, config);
  assert.deepEqual(new Set(calls), new Set([A.url]));
  const native = JSON.parse((await storage.get(MERGED_CONFIG))!).lives;
  assert.deepEqual(native, [automaticLive]); assert.equal(await storage.get('channel_merged_tree'), null);
  assert.equal((await setLiveDisabled(storage, true)).status, 200);
  await assertManualViews(storage, directLives(manualTwo, manualOne));
  await storage.put('channel_probe_enabled', 'true'); calls.length = 0;
  assert.deepEqual(calls, []);
  await storage.delete(LIVE_DISABLED); assert.deepEqual(calls, []);
});

test('manual-mode live-config retains smart host protection and preserves declared URL literals', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, manualOne);
  await storage.put(SMART_JAR_URL_ENABLED, 'true');
  const oldDmz = process.env.DMZ; process.env.DMZ = '1';
  restoreMocks.push(() => { if (oldDmz === undefined) delete process.env.DMZ; else process.env.DMZ = oldDmz; });
  const router = createConfigOutputRouter({ storage, config: { ...config, localBaseUrl: 'http://192.168.1.5:8787' } });
  const awaitPolicy = await loadLivePolicy(storage);
  for (const route of ['/', '/live-config']) {
    assert.equal((await router.request('https://public.test' + route, { headers: { Host: 'public.test' } })).status, 403);
    const res = await router.request('http://192.168.1.6:8787' + route, { headers: { Host: '192.168.1.6:8787' } });
    assert.equal(res.status, 200); assert.deepEqual((await res.json() as TVBoxConfig).lives, directLives(manualOne).map(entry => projectLiveAddress(entry, awaitPolicy.cacheState, 'http://192.168.1.6:8787')));
  }
});

test('damaged or unreadable manual declarations fail closed without upstream leakage and recover after repair', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage);
  for (const raw of ['{', '{}', '[null]', '[{"url":123}]', '[{"url":"not a URL"}]']) {
    await storage.put(LIVE_SOURCES, raw);
    const router = createConfigOutputRouter({ storage, config });
    assert.equal((await router.request('/')).status, 503); assert.equal((await router.request('/live-config')).status, 503);
    assert.equal((await patchMergedConfig(storage)).patched, false);
  }
  await storage.put(LIVE_SOURCES, JSON.stringify([manualOne]));
  storage.failGet = LIVE_SOURCES;
  assert.equal(await readAggregateOutputs(storage), null);
  storage.failGet = undefined; await assertManualViews(storage, directLives(manualOne));
  await storage.put(LIVE_SOURCES, 'broken unused list'); await storage.put(LIVE_DISABLED, 'false');
  assert.equal(await readAggregateOutputs(storage), null); // Manual declarations now participate in both output modes.
  await storage.put(LIVE_DISABLED, 'true'); await storage.put(LIVE_SOURCES, JSON.stringify([manualOne]));
  await storage.put(MERGED_CONFIG, '{'); await storage.put(EXPORT_CONFIG, '{');
  const routes = createConfigOutputRouter({ storage, config });
  assert.equal((await routes.request('/')).status, 500);
  assert.equal((await routes.request('/live-config')).status, 500);
  const exp = createExportConfigRouter({ storage, config, runtime: idleRuntime });
  assert.equal((await exp.request('/admin/export-config', { headers: adminHeaders })).status, 500);
  const nullLives = JSON.stringify({ ...leaf('legacy-null'), lives: null });
  await storage.putMany({ [MERGED_CONFIG]: nullLives, [EXPORT_CONFIG]: nullLives });
  await assertManualViews(storage, directLives(manualOne));
  await storage.put(LIVE_DISABLED, 'false'); await assertManualViews(storage, directLives(manualOne));
});

test('manual edits reject captured patches and an in-flight real patch cannot restore a deleted address', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, manualOne);
  const captured = (await readAggregateOutputs(storage))!; const before = await rawOutputs(storage);
  await liveMutation(storage, manualTwo);
  assert.equal(await publishAggregatePatch(storage, captured.token, captured.merged!, captured.exported!), false);
  assert.deepEqual(await rawOutputs(storage), before);
  const originalGet = storage.get.bind(storage); const held = deferred<void>(); const resume = deferred<void>(); let once = false;
  storage.get = async key => {
    if (key === BLACKLIST && !once) { once = true; held.resolve(); await resume.promise; }
    return originalGet(key);
  };
  const patch = patchMergedConfig(storage); await held.promise;
  await liveMutation(storage, manualOne, 'DELETE'); resume.resolve();
  assert.equal((await patch).patched, false); await assertManualViews(storage, directLives(manualTwo));
  assert.deepEqual(await rawOutputs(storage), before);
});

test('aggregation publication uses the newest manual list and rejects an incompatible live mode switch', async () => {
  for (const changeMode of [false, true]) {
    const storage = new MemoryStorage(); await roots(storage, [A]); await liveMutation(storage, manualOne);
    mockFetch(() => response({ ...leaf('vod'), lives: [automaticLive] })); await runSync(storage, config);
    const snapshotBefore = await snapshot(storage); const rawBefore = await rawOutputs(storage);
    const held = deferred<void>(); const resume = deferred<void>(); const originalGet = storage.get.bind(storage); let once = false;
    storage.get = async key => {
      // Pipeline is past its policy capture but has not entered final publication.
      if (key === NAME_TRANSFORM && !once) { once = true; held.resolve(); await resume.promise; }
      return originalGet(key);
    };
    const sync = runSync(storage, config); await held.promise;
    await liveMutation(storage, manualOne, 'DELETE'); await liveMutation(storage, manualTwo);
    if (changeMode) await withSourceGate(storage, () => storage.put(LIVE_DISABLED, 'false'));
    resume.resolve(); await sync;
    if (changeMode) {
      assert.deepEqual(await rawOutputs(storage), rawBefore);
      assert.deepEqual(await snapshot(storage), snapshotBefore);
      assert.match((await storage.get(LAST_UPDATE))!, /Live policy changed during aggregation/);
    } else {
      assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG))!).lives, []);
      assert.deepEqual(JSON.parse((await storage.get(EXPORT_CONFIG))!).lives, []);
      await assertManualViews(storage, directLives(manualTwo));
    }
  }
});

test('Admin setting toggles save silently, prevent repeated writes and restore rejected changes', async () => {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    .find(text => text.includes('async function saveSetting('))!;
  new Script(script);
  const actions = script.slice(script.indexOf('async function saveSetting('), script.indexOf('async function loadSearchQuotaReport()'));
  for (const [action, control, route, field] of [
    ['saveSmartJarUrl', 'smartJarUrlCheck', '/admin/smart-jar-url', 'enabled'],
    ['saveLiveDisabled', 'liveDisabledCheck', '/admin/live-disabled', 'disabled'],
  ]) for (const value of [false, true]) for (const outcome of ['ok', 'http-error', 'network-error']) {
    const elements: Record<string, { checked: boolean; disabled: boolean }> = {
      smartJarUrlCheck: { checked: false, disabled: false },
      liveDisabledCheck: { checked: false, disabled: false },
      channelProbeCheck: { checked: false, disabled: false },
      channelProbeTriggerBtn: { checked: false, disabled: false },
    };
    elements[control].checked = value;
    const result = deferred<{ ok: boolean }>(); const calls: string[] = [];
    const context = createContext({
      $: (id: string) => { assert.ok(elements[id], id); return elements[id]; },
      document: { querySelector: () => ({ classList: { remove() {} } }) },
      toast() { assert.fail('Setting save must be silent'); },
      setTimeout() { assert.fail('Setting save must not schedule feedback'); },
      auth: { authFetch: (url: string, options: { method: string; body: string }) => {
        calls.push(url); assert.equal(url, route); assert.equal(options.method, 'PUT');
        assert.deepEqual(JSON.parse(options.body), { [field]: value }); return result.promise;
      } },
    });
    new Script(actions).runInContext(context);
    const pending = new Script(action + '()').runInContext(context);
    assert.equal(elements[control].disabled, true);
    await new Script(action + '()').runInContext(context);
    assert.equal(calls.length, 1);
    if (outcome === 'network-error') result.reject(new Error('offline'));
    else result.resolve({ ok: outcome === 'ok' });
    await pending;
    assert.equal(elements[control].disabled, false);
    assert.equal(elements[control].checked, outcome === 'ok' ? value : !value);
  }
});

test('Admin form settings keep their payloads and release save buttons without feedback on any outcome', async () => {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    .find(text => text.includes('async function saveSetting('))!;
  const actions = script.slice(script.indexOf('async function saveSetting('), script.indexOf('async function loadSearchQuotaReport()'));
  for (const [action, button, route, payload] of [
    ['saveNameTransform', 'ntSaveBtn', '/admin/name-transform', { prefix: 'before', suffix: 'after' }],
    ['saveSyncSchedule', 'syncSaveBtn', '/admin/cron-interval', { schedule: { period: 'weekly', hour: 5, minute: 30, dayOfWeek: 2 } }],
    ['saveEdgeProxies', 'edgeProxiesSaveBtn', '/admin/edge-proxies', { fetchProxy: 'https://proxy.test', vercel: '' }],
    ['saveSearchQuota', 'searchQuotaSaveBtn', '/admin/search-quota', { maxSearchable: 12, pinnedKeys: ['site-a'] }],
  ] as const) for (const outcome of ['ok', 'http-error', 'network-error']) {
    const elements: Record<string, { value?: string; disabled?: boolean; textContent?: string }> = {
      ntPrefix: { value: 'before' }, ntSuffix: { value: 'after' }, syncPeriod: { value: 'weekly' },
      syncTime: { value: '05:30' }, syncDayOfWeek: { value: '2' },
      edgeFetchProxyUrl: { value: ' https://proxy.test ' }, edgeVercelUrl: { value: '' },
      maxSearchableInput: { value: '12' }, [button]: { disabled: false, textContent: '保存' },
    };
    const result = deferred<{ ok: boolean }>(); let calls = 0;
    const context = createContext({
      $: (id: string) => { assert.ok(elements[id], id); return elements[id]; },
      toast() { assert.fail('Setting save must be silent'); },
      setTimeout() { assert.fail('Setting save must not schedule feedback'); },
      auth: { authFetch: (url: string, options: { method: string; body: string }) => {
        calls++; assert.equal(url, route); assert.equal(options.method, 'PUT');
        assert.deepEqual(JSON.parse(options.body), payload); return result.promise;
      } },
    });
    new Script(actions + '\nsqPinnedKeys = new Set(["site-a"]);').runInContext(context);
    const pending = new Script(action + '()').runInContext(context);
    await new Script(action + '()').runInContext(context);
    assert.equal(calls, 1); assert.equal(elements[button].disabled, true);
    assert.equal(elements[button].textContent, '保存');
    if (outcome === 'network-error') result.reject(new Error('offline'));
    else result.resolve({ ok: outcome === 'ok' });
    await pending;
    assert.equal(elements[button].disabled, false);
    assert.equal(elements[button].textContent, '保存');
  }
});

test('generated Admin permits manual live editing while disabled, and editor retains its live control lock', async () => {
  const admin = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    .find(script => script.includes('function switchTab(tab)'))!;
  new Script(admin);
  const elements: Record<string, { checked?: boolean; disabled?: boolean; value?: string; textContent?: string; className?: string; innerHTML?: string }> = {
    liveDisabledCheck: { checked: true }, channelProbeCheck: {}, channelProbeTriggerBtn: {},
    liveUrl: { value: manualOne.url }, liveName: { value: manualOne.name }, liveAddBtn: { disabled: false }, liveList: {},
  };
  const states: string[] = []; const calls: string[] = []; const result = deferred<{ ok: boolean; json: () => Promise<object> }>();
  const selected = admin.slice(admin.indexOf('function updateLiveTabState(disabled)'), admin.indexOf('async function saveLiveDisabled()'))
    + admin.slice(admin.indexOf('async function addLive()'), admin.indexOf('// --- Import Config ---'));
  const context = createContext({ $: (id: string) => elements[id], toast() {}, loadLives() {},
    document: { querySelector: () => ({ classList: { remove: (name: string) => states.push(name) } }) },
    auth: { authFetch: async (url: string) => { calls.push(url); return result.promise; } } });
  new Script(selected + '\nupdateLiveTabState(true)').runInContext(context);
  assert.deepEqual(states, ['disabled']);
  const pending = new Script('addLive()').runInContext(context); await new Script('addLive()').runInContext(context);
  assert.deepEqual(calls, ['/admin/lives']); assert.equal(elements.liveAddBtn.disabled, true);
  result.resolve({ ok: true, json: async () => ({ success: true }) }); await pending;
  assert.equal(elements.liveAddBtn.disabled, false); assert.equal(elements.liveUrl.value, '');
  const tabUi = logUi(); tabUi.elements.liveDisabledCheck = { checked: true } as unknown as LogDomElement;
  tabUi.tab('live'); // Original switchTab guard would keep logs active instead.
  assert.equal(tabUi.elements.logConnStatus.textContent, '未连接');
  assert.ok(!admin.slice(admin.indexOf('function switchTab(tab)'), admin.indexOf('// --- Source health ---')).includes('liveDisabledCheck'));
  const editor = [...configEditorHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    .find(script => script.includes('function liveRow(l, liveDisabled)'))!;
  new Script(editor);
  const row = editor.slice(editor.indexOf('function liveRow(l, liveDisabled)'), editor.indexOf('function doSearch()'));
  const locked = createContext({ l: automaticLive, esc: String, typeSpan: () => '', LIVE_TYPE_TIPS: {} });
  const rendered = new Script(row + '\nliveRow(l,true)').runInContext(locked) as string;
  assert.doesNotMatch(rendered, /item-check|<button/);
  let requests = 0;
  const ctx = createContext({ DATA: { liveDisabled: true }, fetch: () => { requests++; }, automaticLive });
  const actions = editor.slice(editor.indexOf('async function block(type, id)'), editor.indexOf('function updateItemDom('));
  await new Script(actions + '\nPromise.all([block("lives",automaticLive.url),unblock("lives",automaticLive.url)])').runInContext(ctx);
  assert.equal(requests, 0);
});

test('manual-only live addresses remain objects in both modes and update after aggregation without a download or stale declaration', async () => {
  for (const disabled of [false, true]) {
    const storage = new MemoryStorage(); await roots(storage, [A]);
    await storage.put(LIVE_DISABLED, String(disabled)); await liveMutation(storage, manualOne);
    await storage.put('channel_merged_tree', JSON.stringify([{ group: 'old-manual', channels: [{ name: 'old', urls: [manualOne.url] }] }]));
    await storage.put('channel_probe_enabled', 'true');
    const calls: string[] = [];
    mockFetch(url => { calls.push(url); assert.equal(url, A.url, 'manual playlist must be client-loaded'); return response(leaf('vod')); });
    await runSync(storage, config);
    assert.ok(await storage.get('channel_merged_tree')); // Legacy data is inert, no probing or migration.
    await assertManualViews(storage, directLives(manualOne));
    assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG))!).lives, []);
    assert.deepEqual(JSON.parse((await storage.get(EXPORT_CONFIG))!).lives, []);
    const stamp = await storage.get(LAST_UPDATE); const raw = await rawOutputs(storage);
    await liveMutation(storage, manualTwo);
    await assertManualViews(storage, directLives(manualOne, manualTwo));
    await liveMutation(storage, manualOne, 'DELETE');
    await assertManualViews(storage, directLives(manualTwo));
    assert.deepEqual(await rawOutputs(storage), raw); assert.equal(await storage.get(LAST_UPDATE), stamp);
    assert.equal((await patchMergedConfig(storage)).patched, true);
    await assertManualViews(storage, directLives(manualTwo));
    await runSync(storage, config); await assertManualViews(storage, directLives(manualTwo));
    await liveMutation(storage, manualTwo, 'DELETE'); await assertManualViews(storage, []);
    assert.ok(calls.every(url => url === A.url));
  }
});

test('enabled upstream address objects coexist with current manual objects without a configured cache host', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
  await liveMutation(storage, manualOne); let fail = false; const calls: string[] = [];
  mockFetch(url => {
    calls.push(url);
    if (url === A.url) return response({ ...leaf('vod'), lives: [automaticLive] });
    assert.equal(url, automaticLive.url);
    return fail ? new Response('', { status: 503 }) : new Response('#EXTM3U\n#EXTINF:-1 group-title="自动频道",CCTV1\nhttps://channel.test/auto.m3u8\n');
  });
  await runSync(storage, config);
  const views = await manualLiveViews(storage);
  for (const result of views.results.slice(0, 2)) {
    assert.deepEqual(result.lives!.at(-1), directLives(manualOne)[0]);
    assert.deepEqual(result.lives![0], automaticLive);
  }
  assert.deepEqual(views.results[2].lives, [automaticLive, ...directLives(manualOne)]);
  assert.ok(!JSON.stringify(await rawOutputs(storage)).includes(manualOne.url));
  fail = true; await runSync(storage, config);
  const degraded = await manualLiveViews(storage);
  assert.deepEqual(degraded.results[0].lives, [automaticLive, ...directLives(manualOne)]);
  assert.deepEqual(degraded.results[1].lives, [automaticLive, ...directLives(manualOne)]);
  assert.ok(calls.every(url => url === A.url || url === automaticLive.url));
});

test('a manual address shared with an upstream declaration is not downloaded twice or duplicated in output', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
  await liveMutation(storage, manualOne); const calls: string[] = [];
  const legacy = JSON.stringify({ ...leaf('legacy-shared'), lives: [{ ...automaticLive, url: manualOne.url }] });
  await storage.putMany({ [MERGED_CONFIG]: legacy, [MERGED_CONFIG_FULL]: legacy, [EXPORT_CONFIG]: legacy });
  await assertManualViews(storage, directLives(manualOne), { ...config, localBaseUrl: 'http://192.168.1.5:8787' });
  mockFetch(url => {
    calls.push(url);
    if (url === A.url) return response({ ...leaf('vod'), lives: [{ ...automaticLive, url: manualOne.url }] });
    return new Response('#EXTM3U\n#EXTINF:-1 group-title="频道",CCTV1\nhttps://channel.test/live.m3u8\n');
  });
  await runSync(storage, config); await assertManualViews(storage, directLives(manualOne));
  assert.ok(calls.every(url => url === A.url));
  await liveMutation(storage, manualOne, 'DELETE'); await runSync(storage, config);
  assert.ok(calls.every(url => url === A.url)); // No local proxy configured: ordinary addresses pass through.
  const views = await manualLiveViews(storage);
  assert.equal(views.results[0].lives![0].url, manualOne.url);
});

test('enabled manual edits reject old patch tokens and stale real patches without restoring deleted objects', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await storage.put(LIVE_DISABLED, 'false');
  await liveMutation(storage, manualOne);
  const captured = (await readAggregateOutputs(storage))!;
  const held = deferred<void>(); const resume = deferred<void>(); const originalGet = storage.get.bind(storage); let once = false;
  storage.get = async key => {
    if (key === BLACKLIST && !once) { once = true; held.resolve(); await resume.promise; }
    return originalGet(key);
  };
  const patch = patchMergedConfig(storage); await held.promise;
  await liveMutation(storage, manualOne, 'DELETE'); await liveMutation(storage, manualTwo);
  resume.resolve(); assert.equal((await patch).patched, false);
  assert.equal(await publishAggregatePatch(storage, captured.token, captured.merged!, captured.exported!), false);
  await assertManualViews(storage, [automaticLive, ...directLives(manualTwo)]);
});


const cacheConfig = { ...config, localBaseUrl: 'http://192.168.1.5:8787' };
const cachedManual = { name: '手动列表', url: 'https://manual-cache.test/list.m3u' };
const playlistText = (name = 'CCTV1') => '#EXTM3U\n#EXTINF:-1 group-title="央视",' + name + '\nhttps://channel.test/live.m3u8\n';
const listRequest = (storage: Storage, entry = { ...cachedManual, type: 0 }, suffix = 'm3u') =>
  createLiveCacheRouter({ storage, config: cacheConfig }).request('/live/' + liveCacheKey(entry) + '.' + suffix);
async function liveStatusViews(storage: Storage) {
  const result = await createLiveSourcesRouter({ storage, config: cacheConfig }).request('/admin/lives', { headers: adminHeaders });
  assert.equal(result.status, 200);
  return result.json() as Promise<Array<{ name: string; url: string; cacheStatus: ReturnType<typeof liveCacheView> }>>;
}

for (const dmz of [undefined, '0', '1']) {
  test('live playlists cache local and public addresses regardless of DMZ=' + String(dmz), async () => {
    const originalDmz = process.env.DMZ;
    if (dmz === undefined) delete process.env.DMZ; else process.env.DMZ = dmz;
    restoreMocks.push(() => { if (originalDmz === undefined) delete process.env.DMZ; else process.env.DMZ = originalDmz; });
    const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
    const addresses = [
      'http://192.168.31.120:8088/watch.txt', 'https://10.0.0.2/list.m3u', 'http://172.16.0.2/list.m3u',
      'http://localhost/list.m3u', 'http://127.0.0.1/list.m3u', 'http://[::1]/list.m3u',
      'http://169.254.1.2/list.m3u', 'http://[fe80::1]/list.m3u', 'http://[fd00::1]/list.m3u',
      'http://playlist.local/list.m3u', 'http://playlist.internal/list.m3u', 'https://public-live.test/list.m3u',
    ];
    const entries = addresses.map((url, i) => ({ name: '列表' + i, url, type: 0 }));
    const calls: string[] = [];
    mockFetch(url => {
      calls.push(url);
      return url === A.url ? response({ ...leaf('vod'), lives: entries.slice(0, 6) }) : new Response(playlistText());
    });
    for (const entry of entries.slice(6)) await liveMutation(storage, entry);
    assert.deepEqual(calls, []);
    await runSync(storage, cacheConfig);
    assert.deepEqual(new Set(calls), new Set([A.url, ...addresses]));
    for (const url of addresses) assert.equal(calls.filter(call => call === url).length, 1);
    const afterPrefetch = calls.length;
    const views = await manualLiveViews(storage, cacheConfig);
    assert.equal(views.results[0].lives!.length, entries.length);
    assert.ok(views.results[0].lives!.every(entry => entry.url!.startsWith(cacheConfig.localBaseUrl + '/live/')));
    assert.deepEqual(views.results[2].lives, entries);
    for (const entry of entries) {
      const cached = await listRequest(storage, entry);
      assert.equal(cached.status, 200); assert.equal(await cached.text(), playlistText());
    }
    assert.equal(calls.length, afterPrefetch); // All reads use the published files.
    assert.ok((await liveStatusViews(storage)).every(entry => entry.cacheStatus.level === 'ok'));

    const added = { name: '新增局域网列表', url: 'http://192.168.31.121/first.m3u', type: 0 };
    await liveMutation(storage, added); assert.equal(calls.length, afterPrefetch);
    assert.equal((await listRequest(storage, added)).status, 200); // First access can also fill a LAN cache.
    assert.equal((await listRequest(storage, added)).status, 200);
    assert.equal(calls.filter(url => url === added.url).length, 1);
  });
}

test('malformed live HTTP addresses fail before download without preventing valid LAN peers from caching', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
  const invalid = { name: '无效地址', url: 'http://[', type: 0 };
  const valid = { name: '局域网', url: 'http://192.168.31.120/list.m3u', type: 0 };
  const calls: string[] = [];
  mockFetch(url => { calls.push(url); return url === A.url ? response({ ...leaf('vod'), lives: [invalid, valid] }) : new Response(playlistText()); });
  await runSync(storage, cacheConfig);
  assert.deepEqual(new Set(calls), new Set([A.url, valid.url]));
  const state = (await loadLiveCache(storage)).state!;
  assert.equal(liveCacheView(invalid, state).level, 'error');
  assert.equal(liveCacheView(invalid, state).reason, '直播地址格式无效');
  assert.equal(liveCacheView(valid, state).level, 'ok');
  assert.equal((await listRequest(storage, valid)).status, 200);
});

test('live playlist cache prefetches both origins, keeps JSON compact, serves bytes and preserves original export', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
  const calls: string[] = [];
  mockFetch(url => { calls.push(url); return url === A.url ? response({ ...leaf('vod'), lives: [automaticLive] }) : new Response(playlistText()); });
  await liveMutation(storage, cachedManual); assert.deepEqual(calls, []);
  await runSync(storage, cacheConfig);
  assert.deepEqual(new Set(calls), new Set([A.url, automaticLive.url, cachedManual.url]));
  const views = await manualLiveViews(storage, cacheConfig);
  assert.equal(views.results[0].lives!.length, 2);
  assert.ok(views.results[0].lives!.every(entry => entry.url!.startsWith(cacheConfig.localBaseUrl + '/live/') && !entry.channels));
  assert.deepEqual(views.results[2].lives, [automaticLive, ...directLives(cachedManual)]);
  assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG))!).lives, [automaticLive]);
  const before = calls.length; const res = await listRequest(storage);
  assert.equal(res.status, 200); assert.equal(await res.text(), playlistText()); assert.equal(calls.length, before);
  assert.equal(res.headers.get('cache-control'), 'no-cache'); assert.ok(res.headers.get('etag'));
  const unchanged = await createLiveCacheRouter({ storage, config: cacheConfig }).request('/live/' + liveCacheKey({ ...cachedManual, type: 0 }) + '.m3u',
    { headers: { 'If-None-Match': res.headers.get('etag')! } });
  assert.equal(unchanged.status, 304); assert.equal(calls.length, before);
  assert.deepEqual((await liveStatusViews(storage))[0].cacheStatus, { level: 'ok', label: 'OK' });
});

test('live refresh failure preserves old file/time, stays warning across failures and recovers only on the next aggregation', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await liveMutation(storage, cachedManual);
  let fail = false; let downloads = 0;
  mockFetch(url => { if (url === A.url) return response(leaf('vod')); downloads++;
    return fail ? new Response('unavailable', { status: 503 }) : new Response(playlistText('频道' + downloads)); });
  await runSync(storage, cacheConfig);
  const state = (await loadLiveCache(storage)).state!; const old = state.records[liveCacheKey({ ...cachedManual, type: 0 })];
  const time = old.savedAt; const body = await (await listRequest(storage)).text();
  fail = true;
  for (let i = 0; i < 4; i++) await runSync(storage, cacheConfig);
  assert.equal(downloads, 5);
  for (let i = 0; i < 3; i++) assert.equal(await (await listRequest(storage)).text(), body);
  assert.equal(downloads, 5);
  const status = (await liveStatusViews(storage))[0].cacheStatus;
  assert.equal(status.level, 'warn'); assert.equal(status.cached, true); assert.equal(status.cacheTime, time);
  assert.equal(status.failures, 4); assert.match(status.reason!, /503/);
  const restarted = new MemoryStorage(); restarted.data = new Map(storage.data);
  assert.equal(await (await listRequest(restarted)).text(), body); assert.equal(downloads, 5);
  fail = false; await runSync(restarted, cacheConfig); assert.equal(downloads, 6);
  assert.deepEqual((await liveStatusViews(restarted))[0].cacheStatus, { level: 'ok', label: 'OK' });
  assert.notEqual(await (await listRequest(restarted)).text(), body);
});

test('no-cache aggregation failure outputs origin and freezes old-local requests across restart until next aggregation', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await liveMutation(storage, cachedManual);
  let fail = true; let calls = 0;
  mockFetch(url => { if (url === A.url) return response(leaf('vod')); calls++;
    return fail ? new Response('no', { status: 404 }) : new Response(playlistText()); });
  await runSync(storage, cacheConfig); assert.equal(calls, 1);
  await assertManualViews(storage, directLives(cachedManual), cacheConfig);
  const status = (await liveStatusViews(storage))[0].cacheStatus;
  assert.equal(status.level, 'error'); assert.equal(status.cached, false);
  for (const store of [storage, Object.assign(new MemoryStorage(), { data: new Map(storage.data) })]) {
    for (let i = 0; i < 2; i++) {
      const res = await listRequest(store); assert.equal(res.status, 302); assert.equal(res.headers.get('location'), cachedManual.url);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(calls, 1); fail = false; await runSync(storage, cacheConfig); assert.equal(calls, 2);
  assert.equal((await listRequest(storage)).status, 200);
});

test('manual first access shares one download, save is network-free and deletion/re-add revokes old bytes and late results', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage);
  const hold = deferred<Response>(); const started = deferred<void>(); let requests = 0;
  mockFetch(() => { requests++; started.resolve(); return hold.promise; });
  await liveMutation(storage, cachedManual); assert.equal(requests, 0);
  assert.equal((await liveStatusViews(storage))[0].cacheStatus.label, '等待聚合');
  const pending = Promise.all([listRequest(storage), listRequest(storage), listRequest(storage)]);
  await started.promise; assert.equal(requests, 1);
  await liveMutation(storage, cachedManual, 'DELETE'); await liveMutation(storage, cachedManual);
  hold.resolve(new Response(playlistText('不应写回')));
  const responses = await pending;
  assert.ok(responses.every(res => res.status === 302));
  assert.equal((await liveStatusViews(storage))[0].cacheStatus.label, '等待聚合');
  assert.equal((await loadLiveCache(storage)).state!.records[liveCacheKey({ ...cachedManual, type: 0 })].file, undefined);
  mockFetch(() => { requests++; return new Response(playlistText('新内容')); });
  const filled = await Promise.all([listRequest(storage), listRequest(storage)]);
  assert.equal(requests, 2); assert.ok(filled.every(res => res.status === 200));
  await liveMutation(storage, cachedManual, 'DELETE');
  assert.equal((await listRequest(storage)).status, 404); assert.equal(requests, 2);
});

test('on-demand first failure freezes retries and switches new config to original URL without aggregation', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, cachedManual);
  let requests = 0; mockFetch(() => { requests++; return new Response('blocked', { status: 403 }); });
  assert.equal((await listRequest(storage)).status, 302);
  assert.equal((await listRequest(storage)).status, 302); assert.equal(requests, 1);
  await assertManualViews(storage, directLives(cachedManual), cacheConfig);
});

test('live normalization preserves names/order/directives and resolves relative links against final upstream URL', async () => {
  const source = '#EXTM3U\r\n#EXTINF:-1 tvg-logo="../logo.png" group-title="原组",名称 HD type\r\n./channel.m3u8?x=1#frag$线路A\r\n#UNKNOWN:keep\r\n';
  const result = normalizePlaylist(Buffer.from(source), 'text/plain', 'https://final.test/lists/live.m3u')!;
  assert.equal(result.data.toString(), '#EXTM3U\r\n#EXTINF:-1 tvg-logo="https://final.test/logo.png" group-title="原组",名称 HD type\r\nhttps://final.test/lists/channel.m3u8?x=1#frag$线路A\r\n#UNKNOWN:keep\r\n');
  const txt = '原组,#genre#\n频道,../one.ts$一号#https://absolute.test/two.ts#fragment$二号\n';
  assert.equal(normalizePlaylist(Buffer.from(txt), '', 'https://final.test/lists/live.txt')!.data.toString(),
    '原组,#genre#\n频道,https://final.test/one.ts$一号#https://absolute.test/two.ts#fragment$二号\n');
  assert.equal(normalizePlaylist(Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:10\nchunk.ts'), '', 'https://final.test/live.m3u8'), null);
  assert.throws(() => normalizePlaylist(Buffer.from('<html>wrong</html>'), '', 'https://final.test/live'), /不是直播列表/);
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, cachedManual);
  mockFetch(() => { const response = new Response(source); Object.defineProperty(response, 'url', { value: 'https://final.test/lists/live.m3u' }); return response; });
  const response = await listRequest(storage); assert.equal(response.status, 200); assert.equal(await response.text(), result.data.toString());
});

test('special types pass through unchanged, inline channels are excluded, disabled mode caches only manual lists', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
  const special = { name: '插件', type: 3, api: 'csp_Live', ext: { note: '__TVBOX_BASE_URL__' } };
  const inline = { group: '内嵌', channels: [{ name: '频道', urls: ['https://channel.test/inline'] }] };
  const calls: string[] = [];
  mockFetch(url => { calls.push(url); return url === A.url ? response({ ...leaf('vod'), lives: [automaticLive, special, inline] }) : new Response(playlistText()); });
  await liveMutation(storage, cachedManual); await runSync(storage, cacheConfig);
  const views = await manualLiveViews(storage, cacheConfig);
  assert.deepEqual(views.results[0].lives![1], special); assert.deepEqual(views.results[2].lives, [automaticLive, special, ...directLives(cachedManual)]);
  assert.ok(views.results.every(value => !value.lives!.some(entry => entry.channels)));
  assert.ok(calls.every(url => [A.url, automaticLive.url, cachedManual.url].includes(url)));
  await liveMutation(storage, { name: '特殊协议', url: 'rtsp://stream.test/live' });
  assert.deepEqual((await liveStatusViews(storage))[1].cacheStatus, { level: 'ok', label: 'OK' });
  assert.equal(cacheableLive(special), false);
  await setLiveDisabled(storage, true); calls.length = 0; await runSync(storage, cacheConfig);
  assert.deepEqual(new Set(calls), new Set([A.url, cachedManual.url]));
  assert.equal((await manualLiveViews(storage, cacheConfig)).results[0].lives!.length, 2);
});

test('list download preserves declared headers and distinguishes same URL with different header identities', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
  const live = { ...automaticLive, ua: 'declared-agent', header: { Referer: 'https://referer.test/', 'X-Key': 'private-key' } };
  let headers: Headers | undefined;
  mockFetch((url, options) => { if (url === A.url) return response({ ...leaf('vod'), lives: [live] });
    headers = new Headers(options?.headers); return new Response(playlistText()); });
  await runSync(storage, cacheConfig);
  assert.equal(headers!.get('user-agent'), 'declared-agent'); assert.equal(headers!.get('referer'), 'https://referer.test/');
  assert.equal(headers!.get('x-key'), 'private-key');
  assert.notEqual(liveCacheKey(live), liveCacheKey(automaticLive));
  const res = await listRequest(storage, live); assert.equal(res.status, 200);
  assert.equal((await listRequest(storage, automaticLive)).status, 404);
});

test('shared manual/upstream URL downloads once and a remaining provider retains cache after manual deletion', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false'); await liveMutation(storage, cachedManual);
  let calls = 0;
  mockFetch(url => { if (url === A.url) return response({ ...leaf('vod'), lives: [{ ...automaticLive, url: cachedManual.url }] }); calls++; return new Response(playlistText()); });
  await runSync(storage, cacheConfig); assert.equal(calls, 1);
  assert.equal((await manualLiveViews(storage, cacheConfig)).results[0].lives!.length, 1);
  await liveMutation(storage, cachedManual, 'DELETE');
  assert.equal((await listRequest(storage)).status, 200); assert.equal(calls, 1);
  await roots(storage, []); await runSync(storage, cacheConfig);
  assert.equal((await listRequest(storage)).status, 404); assert.equal(calls, 1);
});

test('a stale cache refresh cannot publish bytes after a newer aggregate starts', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await liveMutation(storage, cachedManual);
  const hold = deferred<Response>(); const started = deferred<void>(); let old = true;
  mockFetch(url => { if (url === A.url) return response(leaf('vod')); if (old) { started.resolve(); return hold.promise; } return new Response(playlistText('最新')); });
  const pending = runSync(storage, cacheConfig); await started.promise; old = false;
  const newer = runSync(storage, cacheConfig); await tick();
  hold.resolve(new Response(playlistText('过期'))); await Promise.all([pending, newer]);
  assert.equal(await (await listRequest(storage)).text(), playlistText('最新'));
});

test('failed cache metadata commit keeps old successful bytes and prevents repeated downloads after restart', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, cachedManual);
  let calls = 0; let breakWrite = false;
  mockFetch(() => { calls++; if (breakWrite) storage.failPut = LIVE_CACHE_STATE; return new Response(playlistText('版本' + calls)); });
  assert.equal((await listRequest(storage)).status, 200);
  const initial = (await loadLiveCache(storage)).state!.records[liveCacheKey({ ...cachedManual, type: 0 })];
  breakWrite = true; await refreshLiveCache(storage, [{ ...cachedManual, type: 0 }], 200, async () => true);
  storage.failPut = undefined;
  const restarted = new MemoryStorage(); restarted.data = new Map(storage.data);
  assert.equal(await (await listRequest(restarted)).text(), playlistText('版本1')); assert.equal(calls, 2);
  const view = (await liveStatusViews(restarted))[0].cacheStatus;
  assert.equal(view.level, 'warn'); assert.equal(view.cacheTime, initial.savedAt);
});

test('invalid cache metadata leaves VOD and declarations readable without upstream retry or private data exposure', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, cachedManual);
  await storage.put(LIVE_CACHE_STATE, '{'); let calls = 0; mockFetch(() => { calls++; throw new Error('must not fetch'); });
  await assertManualViews(storage, directLives(cachedManual), cacheConfig);
  const entries = await liveStatusViews(storage); assert.equal(entries.length, 1); assert.equal(entries[0].cacheStatus.level, 'unknown');
  assert.equal((await listRequest(storage)).status, 302); assert.equal(calls, 0);
  assert.equal(JSON.stringify(entries).includes('generation'), false);
  assert.equal((await createLiveSourcesRouter({ storage, config }).request('/admin/lives')).status, 401);
});

test('empty HTML timeout and oversized responses isolate list failure without destroying VOD output', async () => {
  for (const kind of ['empty', 'html', 'timeout', 'oversize']) {
    const storage = new MemoryStorage(); await roots(storage, [A]); await liveMutation(storage, cachedManual);
    let calls = 0;
    mockFetch((url, options) => {
      if (url === A.url) return response(leaf('vod')); calls++;
      if (kind === 'timeout') return new Promise<Response>((_, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError'))));
      if (kind === 'oversize') return new Response(playlistText(), { headers: { 'Content-Length': String(21 * 1024 * 1024) } });
      return new Response(kind === 'empty' ? '' : '<html>登录</html>');
    });
    await runSync(storage, cacheConfig); assert.equal(calls, 1);
    await assertManualViews(storage, directLives(cachedManual), cacheConfig);
    assert.equal((await liveStatusViews(storage))[0].cacheStatus.level, 'error');
    assert.equal((await listRequest(storage)).status, 302); assert.equal(calls, 1);
  }
});

test('generated live rows wrap full escaped diagnostics, omit LIVE tags and follow agreed state wording', () => {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes('function liveSourceRow'))!;
  new Script(script);
  const code = script.slice(script.indexOf('function liveSourceRow'), script.indexOf('async function loadLives'));
  const escape = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const input = { name: '<名字>', url: 'https://example.test/"quoted"', cacheStatus: { level: 'warn', label: '警告', reason: '<错误>' + '很长'.repeat(100), failures: 4, cached: true, cacheTime: '原时间' } };
  const context = createContext({ esc: escape, escAttr: escape, input });
  const render = () => new Script(code + '\nliveSourceRow(input)').runInContext(context) as string;
  const warning = render(); assert.match(warning, /source-health-dot warn/); assert.match(warning, /&lt;错误&gt;/);
  assert.match(warning, /已缓存/); assert.match(warning, /最后缓存时间：原时间/); assert.match(warning, /连续失败 4/);
  assert.doesNotMatch(warning, /source-tag|title=/); assert.match(warning, /data-url=/);
  Object.assign(input.cacheStatus, { level: 'ok', label: '健康' });
  const healthy = render(); assert.doesNotMatch(healthy, /source-reason|source-cache-time|连续失败|不参与缓存/);
  Object.assign(input.cacheStatus, { level: 'unknown', label: '等待聚合', reason: '', failures: 0 });
  assert.match(render(), /状态：等待聚合/);
});


test('live refresh concurrency is bounded, invalid headers isolate one source and large lists stay outside config JSON', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
  const lists = Array.from({ length: 9 }, (_, i) => ({ name: '列表' + i, type: 0, url: 'https://lists.test/' + i + '.m3u' }));
  const invalid = { ...automaticLive, header: { 'Invalid Header': 'secret-should-not-leak' } };
  let active = 0; let maximum = 0; let calls = 0;
  const large = '#EXTM3U\n' + Array.from({ length: 1000 }, (_, i) => '#EXTINF:-1,频道' + i + '\nhttps://channel.test/' + i + '.m3u8\n').join('');
  mockFetch(async url => {
    if (url === A.url) return response({ ...leaf('vod'), lives: [...lists, invalid] });
    assert.notEqual(url, invalid.url); calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => realTimeout(resolve, 5)); active--; return new Response(large);
  });
  await runSync(storage, cacheConfig); assert.equal(calls, 9); assert.ok(maximum <= 4 && maximum > 1);
  const views = await manualLiveViews(storage, cacheConfig);
  assert.equal(views.results[0].lives!.length, 10); assert.ok(JSON.stringify(views.results[0]).length < 10000);
  const bad = views.results[0].lives!.at(-1)!; assert.equal(bad.url, invalid.url);
  const view = liveCacheView(invalid, (await loadLiveCache(storage)).state);
  assert.equal(view.level, 'error'); assert.ok(!view.reason!.includes('secret'));
});

test('file publication failure leaves a successful previous cache readable and preserves its timestamp', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, cachedManual);
  let calls = 0; mockFetch(() => { calls++; return new Response(playlistText('文件' + calls)); });
  assert.equal((await listRequest(storage)).status, 200);
  const old = (await loadLiveCache(storage)).state!.records[liveCacheKey({ ...cachedManual, type: 0 })];
  const { createHash } = await import('node:crypto');
  const nextHash = createHash('sha256').update(playlistText('文件2')).digest('hex');
  mkdirSync(path.join(directory, 'live', nextHash + '.m3u')); // A directory cannot be replaced by the candidate file.
  await refreshLiveCache(storage, [{ ...cachedManual, type: 0 }], 200, async () => true);
  assert.equal(await (await listRequest(storage)).text(), playlistText('文件1')); assert.equal(calls, 2);
  const view = (await liveStatusViews(storage))[0].cacheStatus;
  assert.equal(view.level, 'warn'); assert.equal(view.cacheTime, old.savedAt);
  assert.ok(!view.reason!.includes(directory));
});

test('GET live list never downloads and late list responses cannot restore removed rows or erase loaded entries', async () => {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes('function liveSourceRow'))!;
  const code = script.slice(script.indexOf('let liveListRequest'), script.indexOf('async function addLive'));
  const old = deferred<{ ok: boolean; json: () => Promise<object[]> }>();
  const elements = { liveList: { innerHTML: '', querySelector: () => elements.liveList.innerHTML.includes('source-item') }, liveCount: { textContent: '' }, badgeLive: { textContent: '' } };
  let calls = 0;
  const context = createContext({ $: (id: keyof typeof elements) => elements[id], esc: String, escAttr: String,
    auth: { authFetch: async () => { calls++; return calls === 1 ? old.promise : { ok: true, json: async () => [] }; } } });
  new Script(code).runInContext(context);
  const first = new Script('loadLives()').runInContext(context);
  await new Script('loadLives()').runInContext(context);
  old.resolve({ ok: true, json: async () => [{ ...cachedManual, cacheStatus: { level: 'ok', label: '健康' } }] }); await first;
  assert.match(elements.liveList.innerHTML, /暂无直播源/); assert.equal(elements.liveCount.textContent, 0);
  elements.liveList.innerHTML = '<div class="source-item">已有列表</div>';
  new Script('auth.authFetch = async () => { throw new Error("offline") }').runInContext(context);
  await new Script('loadLives()').runInContext(context); assert.ok(elements.liveList.innerHTML.includes('已有列表'));
  const storage = new MemoryStorage(); await liveMutation(storage, cachedManual); let requests = 0;
  mockFetch(() => { requests++; throw new Error('Status GET must not download'); });
  assert.equal((await liveStatusViews(storage))[0].cacheStatus.label, '等待聚合'); assert.equal(requests, 0);
});

test('cached HLS-special sources remain raw healthy objects and do not repeat media downloads', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await liveMutation(storage, cachedManual); let requests = 0; let special = false;
  mockFetch(url => { if (url === A.url) return response(leaf('vod')); requests++; return new Response(special ? '#EXTM3U\n#EXT-X-TARGETDURATION:10\nvideo.ts\n' : playlistText()); });
  await runSync(storage, cacheConfig); special = true; await runSync(storage, cacheConfig); await runSync(storage, cacheConfig);
  assert.equal((await loadLiveCache(storage)).state!.records[liveCacheKey({ ...cachedManual, type: 0 })].file, undefined);
  assert.equal(requests, 2); await assertManualViews(storage, directLives(cachedManual), cacheConfig);
  assert.deepEqual((await liveStatusViews(storage))[0].cacheStatus, { level: 'ok', label: 'OK' });
});


test('deleted/re-added VOD provider cannot reuse its former live file but an unchanged co-provider may', async () => {
  for (const shared of [false, true]) {
    const storage = new MemoryStorage(); await roots(storage, shared ? [A, B] : [A]); await storage.put(LIVE_DISABLED, 'false');
    let fail = false;
    mockFetch(url => url === A.url || url === B.url ? response({ ...leaf(url === A.url ? 'a' : 'b'), lives: [automaticLive] })
      : fail ? new Response('gone', { status: 404 }) : new Response(playlistText()));
    await runSync(storage, cacheConfig);
    await roots(storage, shared ? [B] : []); await roots(storage, shared ? [A, B] : [A]);
    fail = true; await runSync(storage, cacheConfig);
    const views = await manualLiveViews(storage, cacheConfig);
    if (shared) assert.ok(views.results[0].lives![0].url!.startsWith(cacheConfig.localBaseUrl + '/live/'));
    else assert.equal(views.results[0].lives![0].url, automaticLive.url);
  }
});


test('live file router is mounted without Admin auth and extensionless TXT plus stream-body timeout follow cache rules', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage);
  const entry = { name: '无后缀', url: 'https://plain.test/playlist' }; await liveMutation(storage, entry);
  let calls = 0; mockFetch(() => { calls++; return new Response('分组,#genre#\n频道,./video.ts\n'); });
  const app = createApp({ storage, config: cacheConfig, runtime: idleRuntime,
    triggerRefresh: async () => ({ ran: false, outcome: 'busy', message: '正在聚合' }) });
  const uri = '/live/' + liveCacheKey({ ...entry, type: 0 }) + '.txt';
  const res = await app.request(uri); assert.equal(res.status, 200);
  assert.equal(await res.text(), '分组,#genre#\n频道,https://plain.test/video.ts\n'); assert.equal(calls, 1);
  assert.equal((await app.request('/live/' + liveCacheKey({ ...entry, type: 0 }) + '.unknown')).status, 404);
  assert.equal((await app.request('/admin/lives')).status, 401);
  const failing = { name: '慢响应体', url: 'https://body.test/live.m3u' }; await liveMutation(storage, failing);
  mockFetch((_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('#EXTM3U\n'));
    options!.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
  } })));
  const timed = await app.request('/live/' + liveCacheKey({ ...failing, type: 0 }) + '.m3u');
  assert.equal(timed.status, 302); assert.equal(timed.headers.get('location'), failing.url);
  assert.match((await liveStatusViews(storage))[1].cacheStatus.reason!, /超时/);
});


test('flat live URLs project exact paths, redirect format changes and reject old paths without fetching', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, cachedManual);
  const entry = { ...cachedManual, type: 0 }; const key = liveCacheKey(entry);
  const app = createApp({ storage, config: cacheConfig, runtime: idleRuntime,
    triggerRefresh: async () => ({ ran: false, outcome: 'busy', message: '正在聚合' }) });
  let body = '分组,#genre#\n频道,https://channel.test/live.ts\n'; let calls = 0;
  mockFetch(() => { calls++; return new Response(body); });
  const first = await app.request('/live/' + key + '.m3u');
  assert.equal(first.status, 302); assert.equal(first.headers.get('location'), './' + key + '.txt');
  assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
  const txt = await app.request(new URL(first.headers.get('location')!, 'http://app.test/live/' + key + '.m3u').pathname);
  assert.equal(txt.status, 200); assert.equal(await txt.text(), body); assert.equal(calls, 1);
  assert.equal(txt.headers.get('content-type'), 'text/plain; charset=utf-8');
  const unchanged = await app.request('/live/' + key + '.txt', { headers: { 'If-None-Match': txt.headers.get('etag')! } });
  assert.equal(unchanged.status, 304); assert.equal(calls, 1);
  const views = await manualLiveViews(storage, cacheConfig);
  for (const view of views.results.slice(0, 2)) assert.equal(view.lives!.at(-1)!.url, cacheConfig.localBaseUrl + '/live/' + key + '.txt');
  for (const uri of ['/live/' + key + '/list.txt', '/live/' + key + '/list.m3u', '/live/' + key + '.json', '/live/invalid.txt']) {
    assert.equal((await app.request(uri)).status, 404);
  }
  assert.equal(calls, 1);
  body = playlistText('变为 M3U'); await refreshLiveCache(storage, [entry], cacheConfig.fetchTimeoutMs, async () => true);
  const changed = await app.request('/live/' + key + '.txt');
  assert.equal(changed.status, 302); assert.equal(changed.headers.get('location'), './' + key + '.m3u');
  const m3u = await app.request('/live/' + key + '.m3u');
  assert.equal(m3u.status, 200); assert.equal(await m3u.text(), body); assert.equal(calls, 2);
  await liveMutation(storage, cachedManual, 'DELETE');
  assert.equal((await app.request('/live/' + key + '.m3u')).status, 404); assert.equal(calls, 2);
});

test('existing playlist cache serves immediately while a remote aggregation refresh is still pending', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, cachedManual);
  mockFetch(() => new Response(playlistText('已有缓存'))); assert.equal((await listRequest(storage)).status, 200);
  const hold = deferred<Response>(); const started = deferred<void>(); let calls = 0;
  mockFetch(() => { calls++; started.resolve(); return hold.promise; });
  const refreshing = refreshLiveCache(storage, [{ ...cachedManual, type: 0 }], 500, async () => true);
  await started.promise;
  const result = await Promise.race([listRequest(storage), new Promise<never>((_, reject) => realTimeout(() => reject(new Error('Cache hit waited for origin')), 100))]);
  assert.equal(result.status, 200); assert.equal(await result.text(), playlistText('已有缓存')); assert.equal(calls, 1);
  hold.resolve(new Response(playlistText('更新缓存'))); await refreshing;
  assert.equal(await (await listRequest(storage)).text(), playlistText('更新缓存')); assert.equal(calls, 1);
});


test('ordinary live objects missing type project as type zero without mutating raw source data', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); await storage.put(LIVE_DISABLED, 'false');
  const original = { name: '未指定类型', url: automaticLive.url };
  mockFetch(url => url === A.url ? response({ ...leaf('vod'), lives: [original] }) : new Response(playlistText()));
  await runSync(storage, cacheConfig); const views = await manualLiveViews(storage, cacheConfig);
  assert.equal(views.results[0].lives![0].type, 0); assert.equal(views.results[2].lives![0].type, 0);
  assert.deepEqual(JSON.parse((await storage.get(MERGED_CONFIG_FULL))!).lives, [original]);
});


test('damaged interface output does not block independent manual management or an existing manual file', async () => {
  const storage = new MemoryStorage(); await seedLegacyLives(storage); await liveMutation(storage, cachedManual);
  mockFetch(() => new Response(playlistText())); assert.equal((await listRequest(storage)).status, 200);
  await storage.put(LIVE_DISABLED, 'false'); await storage.put(MERGED_CONFIG, '{');
  assert.equal((await liveMutation(storage, manualOne)).status, 200);
  assert.equal((await liveStatusViews(storage)).length, 2);
  assert.equal((await listRequest(storage)).status, 200);
  assert.equal((await createConfigOutputRouter({ storage, config: cacheConfig }).request('/')).status, 500);
});


const capacityEntries = (count: number) => Array.from({ length: count }, (_, i) => ({ name: '容量' + i, url: 'https://capacity' + i + '.test/config.json' }));

test('source capacity defaults to six, supports explicit zero and rejects malformed complete values', () => {
  for (const input of [undefined, '', ' ', '-1', '1.5', '6abc', 'Infinity', '9007199254740992']) assert.equal(parseMaxDataSources(input), 6);
  assert.equal(parseMaxDataSources('0'), 0); assert.equal(parseMaxDataSources(' 12 '), 12);
  assert.equal(sourceLimit({}), 6); assert.equal(sourceLimit({ maxDataSources: 0 }), 0);
  assert.equal(sourceLimit({ maxDataSources: NaN }), 6);
});

test('capacity API preserves list arrays, refuses full requests before fetch and recovers after deletion', async () => {
  const storage = new MemoryStorage(); const entries = capacityEntries(7); await seed(storage, entries.slice(0, 5));
  const router = createSourceMgmtRouter({ storage, config }); let calls = 0;
  mockFetch(() => { calls++; return response(leaf('same-content')); });
  const first = await sourceRequest(storage, entries[5], '/admin/sources'); assert.equal(first.status, 200);
  assert.equal((await first.json() as any).capacity.current, 6); assert.equal(calls, 1);
  const list = await router.request('/admin/sources', { headers: adminHeaders });
  assert.equal(list.headers.get('X-Max-Data-Sources'), '6'); assert.equal((await list.json() as unknown[]).length, 6);
  for (const [path, body] of [['/admin/sources', entries[6]], ['/admin/sources/import', { input: M.url }]]) {
    const full = await sourceRequest(storage, body, path as string); assert.equal(full.status, 409);
    assert.equal((await full.json() as any).code, 'source_limit_exceeded');
  }
  assert.equal(calls, 1);
  await router.request('/admin/sources', { method: 'DELETE', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(entries[0]) });
  assert.equal((await sourceRequest(storage, entries[6], '/admin/sources')).status, 200); assert.equal(calls, 2);
  const unlimited = await sourceRequest(storage, entries[0], '/admin/sources', { ...config, maxDataSources: 0 });
  assert.equal(unlimited.status, 200); assert.equal((await unlimited.json() as any).capacity.remaining, null);
});

test('capacity import rejects the complete candidate upper bound before any child download', async () => {
  const storage = new MemoryStorage(); const old = capacityEntries(4); await seed(storage, old);
  const bad = { name: 'bad', url: 'https://bad-capacity.test/config.json' };
  const calls: string[] = [];
  mockFetch(url => { calls.push(url); return url === bad.url ? new Response('', { status: 404 }) : response(leaf('same-content')); });
  const result = await sourceRequest(storage, { input: JSON.stringify(index(old[0], bad, A, B, N)) });
  assert.equal(result.status, 409); const error = await result.json() as any;
  assert.match(error.error, /上限/); assert.equal(error.capacity.current, 4); assert.equal(error.capacity.limit, 6);
  assert.equal(calls.length, 0);
  assert.equal((JSON.parse((await storage.get(MANUAL_SOURCES))!) as SourceEntry[]).length, 4);
  assert.equal(await snapshot(storage, A), undefined); assert.equal(await snapshot(storage, N), undefined);
});

test('concurrent last-slot additions cannot overlap and failed source batches save nothing', async () => {
  const storage = new MemoryStorage(); await seed(storage, capacityEntries(5));
  const release = deferred<void>(); const started = deferred<void>(); let calls = 0;
  mockFetch(async url => { ++calls; started.resolve(); await release.promise; return response(leaf(new URL(url).hostname.split('.')[0])); });
  const pending = [sourceRequest(storage, A, '/admin/sources'), sourceRequest(storage, B, '/admin/sources')];
  await started.promise; release.resolve(); const results = await Promise.all(pending);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(JSON.parse((await storage.get(MANUAL_SOURCES))!).length, 6);
  const fresh = new MemoryStorage(); await roots(fresh, []); const before = new Map(fresh.data);
  fresh.failBatch = values => MANUAL_SOURCES in values;
  const failure = await sourceRequest(fresh, A, '/admin/sources');
  assert.equal(failure.status, 500); assert.deepEqual(fresh.data, before);
});

test('limited aggregation keeps all declarations/history, restricts every new view and preserves authorized old output on failure', async () => {
  const storage = new MemoryStorage(); const entries = capacityEntries(8); await seed(storage, entries);
  const calls: string[] = [];
  mockFetch(url => { calls.push(url); return response(leaf(new URL(url).hostname.split('.')[0])); });
  await runSync(storage, { ...config, maxDataSources: 0 });
  const oldOutputs = await rawOutputs(storage); const oldHealth = JSON.parse((await storage.get(SOURCE_HEALTH))!);
  const oldSnapshot = await snapshot(storage, entries[7]); calls.length = 0;
  storage.failBatch = values => MERGED_CONFIG in values;
  await runSync(storage, config);
  assert.deepEqual(calls, entries.slice(0, 6).map(entry => entry.url));
  assert.deepEqual(await rawOutputs(storage), oldOutputs); assert.ok(await readAggregateOutputs(storage));
  assert.equal(JSON.parse((await storage.get(MANUAL_SOURCES))!).length, 8);
  assert.deepEqual(await snapshot(storage, entries[7]), oldSnapshot);
  const health = JSON.parse((await storage.get(SOURCE_HEALTH))!);
  assert.deepEqual(health.find((entry: any) => entry.url === entries[7].url), oldHealth.find((entry: any) => entry.url === entries[7].url));
  storage.failBatch = undefined; calls.length = 0; await runSync(storage, config);
  for (const raw of await rawOutputs(storage)) assert.equal(JSON.parse(raw!).sites.length, 6);
  assert.equal(calls.length, 6);
  calls.length = 0; await runSync(storage, { ...config, maxDataSources: 0 });
  assert.equal(calls.length, 8); assert.equal(JSON.parse((await storage.get(MERGED_CONFIG))!).sites.length, 8);
});

test('capacity migration releases the parent slot and defers out-of-range unclassified roots without downloads', async () => {
  const storage = new MemoryStorage(); const old = capacityEntries(5); await seed(storage, old);
  await roots(storage, [...old, M, N]); const calls: string[] = [];
  mockFetch(url => { calls.push(url); return response(url === M.url ? index(A, B) : leaf(new URL(url).hostname.split('.')[0])); });
  const ticket = await beginSourceOutputRun(storage);
  await prepareImportOnlyRun(storage, config, ticket);
  assert.ok(!calls.includes(N.url)); assert.ok(!calls.includes(B.url));
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!).map((entry: SourceEntry) => entry.url), [...old.map(entry => entry.url), N.url]);
  // Seven old declarations minus the parent still fills six slots; its children are uninspected.
  const policy = JSON.parse((await storage.get(SOURCE_IMPORT_POLICY_STATE))!);
  assert.ok(policy.remaining.some((entry: SourceEntry) => entry.url === N.url)); assert.equal(policy.completedAt, undefined);
  assert.ok(policy.report.skipped.some((entry: any) => entry.stage === 'capacity'));
  calls.length = 0; await runSync(storage, config);
  assert.ok(calls.includes(N.url));

  const room = new MemoryStorage(); await seed(room, old); await roots(room, [...old, M]); calls.length = 0;
  await runSync(room, config);
  assert.ok(calls.includes(A.url)); assert.ok(!calls.includes(B.url));
  assert.deepEqual(JSON.parse((await room.get(MANUAL_SOURCES))!).map((entry: SourceEntry) => entry.url), [...old.map(entry => entry.url), A.url]);
});

test('automatic source scraping fills only remaining capacity and skips all page requests once full', async () => {
  const storage = new MemoryStorage(); await seed(storage, capacityEntries(5)); let pages = 0;
  mockFetch(url => {
    if (url === 'https://scrape-capacity.test/') {
      pages++; return new Response(pages === 1 ? '<div class="col-form-label">A</div><input value="' + A.url + '"><div class="col-form-label">B</div><input value="' + B.url + '">' : '');
    }
    return response(leaf(new URL(url).hostname.split('.')[0]));
  });
  const cfg = { ...config, scrapeSourceUrl: 'https://scrape-capacity.test/', scrapeSourceReferer: 'https://scrape-capacity.test/' };
  await runSync(storage, cfg); const saved = JSON.parse((await storage.get(MANUAL_SOURCES))!);
  assert.equal(saved.length, 6); assert.equal(saved[5].url, A.url); const before = pages;
  await runSync(storage, cfg); assert.equal(pages, before);
});


function sourceCapacityFixture(handler: (url: string, options?: RequestInit) => Promise<Response>) {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes('async function loadSources()'))!;
  const elements: Record<string, { value: string; textContent: unknown; innerHTML: string; disabled: boolean; hidden: boolean; focus(): void }> = {};
  const toasts: string[] = [];
  const context = createContext({ healthMap: {}, document: { querySelectorAll: () => [] }, loadSourceHealth() {},
    $: (id: string) => elements[id] ||= { value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, focus() {} },
    esc: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    toast: (text: string) => toasts.push(text), auth: { authFetch: handler },
  });
  new Script(capacityScript(script) + script.slice(script.indexOf('async function loadSources()'), script.indexOf('// --- MacCMS ---'))
    + script.slice(script.indexOf('// --- Import Config ---'), script.indexOf('// Settings saves are silent'))).runInContext(context);
  return { elements, toasts, context, run: (code: string) => new Script(code).runInContext(context) };
}

test('capacity page preserves full state across stale GETs, errors and neutralizes only out-of-range rows', async () => {
  const entries = capacityEntries(8); const old = deferred<Response>(); let first = true;
  const fixture = sourceCapacityFixture(async () => {
    if (first) { first = false; return old.promise; }
    return new Response(JSON.stringify(entries), { headers: { 'X-Max-Data-Sources': '6' } });
  });
  fixture.context.healthMap = Object.fromEntries(entries.map(entry => [entry.url, { status: 'ERR', label: 'HTTP 404', lastFailReason: 'OLD REASON', consecutiveFailures: 7 }]));
  const before = JSON.stringify(fixture.context.healthMap);
  fixture.run('updateSourceCapacityControls()'); assert.equal(fixture.elements.addBtn.disabled, true);
  const slow = fixture.run('loadSources()'); await fixture.run('loadSources()');
  assert.equal(fixture.elements.sourceCount.textContent, '8/6'); assert.equal(fixture.elements.importBtn.disabled, true);
  old.resolve(new Response('[]', { headers: { 'X-Max-Data-Sources': '0' } })); await slow;
  assert.equal(fixture.elements.sourceCount.textContent, '8/6');
  const rows = fixture.elements.sourceList.innerHTML.split('<div class="source-item">').slice(1);
  assert.equal(rows.length, 8);
  for (const row of rows.slice(6)) { assert.match(row, /source-health-dot unknown/); assert.match(row, /状态：暂无数据/); assert.doesNotMatch(row, /OLD REASON|连续失败|已缓存|source-cache-time/); }
  assert.match(rows[0], /OLD REASON/); assert.equal(JSON.stringify(fixture.context.healthMap), before);
  assert.equal(fixture.toasts.length, 0);
  fixture.context.auth = { authFetch: async () => new Response('', { status: 500 }) };
  await fixture.run('loadSources()'); assert.equal(fixture.elements.sourceList.innerHTML.split('<div class="source-item">').length, 9);
  assert.equal(fixture.elements.addBtn.disabled, true);
  fixture.context.auth = { authFetch: async () => new Response(JSON.stringify(entries), { headers: { 'X-Max-Data-Sources': '0' } }) };
  await fixture.run('loadSources()'); assert.equal(fixture.elements.sourceCount.textContent, 8);
  assert.equal(fixture.elements.addBtn.disabled, false); assert.equal(fixture.elements.sourceCapacityHint.hidden, true);
});

test('actual over-capacity import retains input and reports whole-batch rejection; deletion restores controls', async () => {
  const storage = new MemoryStorage(); await seed(storage, capacityEntries(4));
  const router = createSourceMgmtRouter({ storage, config }); let failGet = false;
  const fixture = sourceCapacityFixture(async (url, options) => {
    if (!options && failGet) return new Response('', { status: 500 });
    return router.request(url, { ...options, headers: { ...adminHeaders, 'Content-Type': 'application/json' } });
  });
  await fixture.run('loadSources()'); assert.equal(fixture.elements.sourceCount.textContent, '4/6');
  fixture.elements.importInput = { value: JSON.stringify(index(A, B, N)), textContent: '', innerHTML: '', disabled: false, hidden: false, focus() {} };
  const input = fixture.elements.importInput.value; mockFetch(() => response(leaf('same'))); failGet = true;
  await fixture.run('importConfig()');
  assert.equal(fixture.elements.sourceCount.textContent, '4/6'); assert.equal(fixture.elements.addBtn.disabled, false); assert.equal(fixture.elements.importBtn.disabled, false);
  assert.equal(fixture.elements.importInput.value, input); assert.match(String(fixture.elements.importResult.textContent), /^导入出错：.*上限/);
  assert.equal(fixture.toasts.length, 1); assert.match(fixture.toasts[0], /上限（6）/);
  failGet = false; await fixture.run('removeSource(' + JSON.stringify(capacityEntries(4)[0].url) + ')');
  assert.equal(fixture.elements.sourceCount.textContent, '3/6'); assert.equal(fixture.elements.importBtn.disabled, false);
});


test('all selected sources failing cannot borrow an out-of-range snapshot or revoke the otherwise valid old result', async () => {
  const storage = new MemoryStorage(); const entries = capacityEntries(8); await seed(storage, entries);
  mockFetch(url => response(leaf(new URL(url).hostname.split('.')[0])));
  await runSync(storage, { ...config, maxDataSources: 0 }); const old = await rawOutputs(storage);
  const r = await registry(storage); for (const entry of entries.slice(0, 6)) delete r.nodes[entry.url].snapshot;
  await storage.put(SOURCE_CONFIG_SNAPSHOTS, JSON.stringify(r));
  const calls: string[] = []; mockFetch(url => { calls.push(url); return new Response('', { status: 404 }); });
  await runSync(storage, config);
  assert.deepEqual(new Set(calls), new Set(entries.slice(0, 6).map(entry => entry.url)));
  assert.deepEqual(await rawOutputs(storage), old); assert.ok(await readAggregateOutputs(storage));
  assert.ok(await snapshot(storage, entries[7]));
});

test('ordinary Add stages raw configuration, waits neutrally, and first real aggregation consumes it without downloading again', async () => {
  const storage = new MemoryStorage(); let requests = 0;
  const { input, text } = compatibleFixture();
  mockFetch(() => { requests++; return new Response(text); });
  const res = await sourceRequest(storage, A, '/admin/sources');
  assert.equal(res.status, 200); assert.equal(requests, 1);
  const cached = (await importCache(storage)).entries[A.url];
  assert.deepEqual(cached.config, input); assert.equal(cached.expiresAt - cached.cachedAt, IMPORT_CACHE_TTL_MS);
  assert.equal(await snapshot(storage), undefined); assert.equal(await storage.get(SOURCE_HEALTH), null);
  assert.equal(await storage.get(MERGED_CONFIG), null);
  let record = (await status(storage)).records[0];
  assert.equal(record.waiting, true); assert.equal(record.label, '等待聚合');
  assert.equal((await status(storage)).summary.ok, 0);
  assert.doesNotMatch(JSON.stringify(record), /generation|fingerprint|recordId|configKey/);
  assert.match(await renderSourceRow(record), /source-health-dot unknown/);
  assert.doesNotMatch(await renderSourceRow(record), /连续失败|source-cache-time/);
  await runSync(storage, config);
  assert.equal(requests, 1); assert.deepEqual((await snapshot(storage)).config, input);
  assert.deepEqual((await importCache(storage)).entries, {});
  record = (await status(storage)).records[0];
  assert.equal(record.status, 'OK'); assert.equal(record.acquisition, 'import-cache');
  assert.equal(record.lastSuccessTime, new Date(cached.acquiredAt).toISOString()); assert.equal(record.lastSpeedMs, undefined);
  await runSync(storage, config); assert.equal(requests, 2);
});

test('ordinary Add rejects directories without children and external independent keys before downloading', async () => {
  const storage = new MemoryStorage(); const calls: string[] = [];
  mockFetch(url => { calls.push(url); return response(index(A)); });
  const directory = await sourceRequest(storage, M, '/admin/sources');
  assert.equal(directory.status, 400); assert.match((await directory.json() as any).error, /高级添加/);
  for (const source of [{ ...A, configKey: 'secret' }, { ...A, url: A.url + ';pk;suffix', configKey: 'secret' }]) {
    const res = await sourceRequest(storage, source, '/admin/sources');
    assert.equal(res.status, 400); assert.equal((await res.json() as any).error, '不支持独立解密的接口');
  }
  assert.deepEqual(calls, [M.url]); assert.equal(await storage.get(MANUAL_SOURCES), null);
  const unsupported = await sourceRequest(storage, { input: A.url, configKey: 'secret' });
  assert.equal(unsupported.status, 400); assert.equal((await unsupported.json() as any).error, '不支持独立解密的接口');
  assert.deepEqual(calls, [M.url]);
  assert.equal(await storage.get(SOURCE_IMPORT_CACHE), null);
});

test('suffix keys survive normalization and restart while rejected child keys and relative directory URLs never download', async () => {
  const file = path.join(directory, 'suffix-import.json'); const storage = new JsonFileStorage(file);
  const calls: string[] = [];
  mockFetch(url => { calls.push(url); return response(leaf('suffix')); });
  const multi = { urls: [{ name: 'Good', url: A.url + ';pk;suffix-secret' },
    { name: 'Unsupported', url: B.url, configKey: 'standalone-secret' },
    { name: 'Relative', url: './child.json' }, { name: 'Bad item' }] } as TVBoxConfig;
  const res = await sourceRequest(storage, { input: JSON.stringify(multi) }); const data = await res.json() as any;
  assert.equal(res.status, 200); assert.equal(data.added, 1); assert.equal(data.skipped.length, 3);
  assert.equal(data.skipped[0].reason, '不支持独立解密的接口'); assert.match(data.skipped[1].reason, /完整HTTP/);
  assert.deepEqual(calls, [A.url]);
  assert.doesNotMatch((await storage.get(SOURCE_IMPORT_CACHE))!, /suffix-secret|standalone-secret|configKey/);
  const restarted = new JsonFileStorage(file); await runSync(restarted, config);
  assert.deepEqual(calls, [A.url]); assert.equal((await snapshot(restarted)).config.sites[0].key, 'suffix');
  assert.equal(JSON.parse((await restarted.get(MANUAL_SOURCES))!)[0].configKey, 'suffix-secret');
});

test('advanced URL lines reuse responses, keep original order and accept partial eligible sources', async () => {
  const storage = new MemoryStorage(); const calls: string[] = [];
  mockFetch(async url => { calls.push(url); if (url === A.url) await new Promise(r => realTimeout(r, 8));
    return response(url === N.url ? { sites: [] } : leaf(url === A.url ? 'A' : 'B')); });
  const res = await sourceRequest(storage, { input: `\r\n${A.url}\r\n${B.url}\r\n${A.url}\r\n${N.url}\r\n` });
  const data = await res.json() as any;
  assert.deepEqual(data.sources, [A.url, B.url]); assert.equal(data.duplicates, 1); assert.equal(data.outcome, 'partial');
  assert.equal(data.inputKind, 'single_urls'); assert.equal(data.checked, 3); assert.equal(calls.length, 3);
  assert.equal(data.skipped[0].stage, 'preparation'); assert.equal(Object.keys((await importCache(storage)).entries).length, 2);
});

test('advanced inputs reject mixed roots, raw single JSON and mixed JSON/URLs without publishing any temporary data', async () => {
  for (const bad of [A.url + '\n' + M.url, JSON.stringify(leaf('raw')), JSON.stringify(index(A)) + '\n' + A.url,
    A.url + '\n' + JSON.stringify(index(B)), '{broken\n' + A.url]) {
    const storage = new MemoryStorage(); mockFetch(url => response(url === M.url ? index(B) : leaf('valid')));
    assert.equal((await sourceRequest(storage, { input: bad })).status, 400);
    assert.equal(await storage.get(MANUAL_SOURCES), null); assert.equal(await storage.get(SOURCE_IMPORT_CACHE), null);
  }
  const storage = new MemoryStorage(); mockFetch(url => response(url === M.url ? index(B) : { sites: [] }));
  assert.equal((await sourceRequest(storage, { input: M.url + '\n' + A.url })).status, 400);
  assert.equal(await storage.get(SOURCE_CONFIG_SNAPSHOTS), null); // Empty sites still proves a single root type.
});

test('an invalid root is skipped without inventing mixed types and nested directories never request grandchildren', async () => {
  const storage = new MemoryStorage(); const calls: string[] = [];
  mockFetch(url => { calls.push(url); return response(url === M.url ? index(A, N) : url === B.url ? {}
    : url === N.url ? index({ name: 'Never', url: 'https://never.test/grandchild' }) : leaf('A')); });
  const res = await sourceRequest(storage, { input: M.url + '\n' + B.url }); const data = await res.json() as any;
  assert.equal(res.status, 200); assert.deepEqual(data.sources, [A.url]); assert.equal(data.skipped.length, 2);
  assert.equal(data.skipped[1].reason, '嵌套多仓已忽略，不支持');
  assert.ok(!calls.some(url => url.includes('never.test'))); assert.equal(calls.length, 4);
});

test('root and direct-child roles share one acquisition but only independent roots expand', async () => {
  const storage = new MemoryStorage(); const calls: string[] = [];
  mockFetch(url => { calls.push(url); return response(url === M.url ? index(N, A) : url === N.url ? index(B) : leaf(url)); });
  const data = await (await sourceRequest(storage, { input: M.url + '\n' + N.url })).json() as any;
  assert.deepEqual(data.sources, [A.url, B.url]); assert.equal(data.skipped[0].url, N.url);
  assert.equal(calls.filter(url => url === N.url).length, 1); assert.equal(calls.length, 4);
});

test('candidate capacity includes failed single URLs and never relies on successes to fit', async () => {
  const storage = new MemoryStorage(); await seed(storage, capacityEntries(4)); const before = new Map(storage.data);
  let requests = 0; mockFetch(url => { requests++; return url === N.url ? new Response('', { status: 404 }) : response(leaf('valid')); });
  const res = await sourceRequest(storage, { input: [A.url, B.url, N.url].join('\n') });
  assert.equal(res.status, 409); assert.equal(requests, 5); assert.deepEqual(storage.data, before);
});

test('batch save shares a TTL origin and duplicates never renew or replace stored metadata', async () => {
  const storage = new MemoryStorage(); const base = Date.now(); const advance = clock(base);
  mockFetch(async url => { if (url === B.url) await new Promise(r => realTimeout(r, 8));
    advance(url === A.url ? base + 1_000 : base + 180_000); return response(leaf(url)); });
  const res = await sourceRequest(storage, { input: A.url + '\n' + B.url }); assert.equal(res.status, 200);
  const cache = await importCache(storage); const a = cache.entries[A.url], b = cache.entries[B.url];
  assert.equal(a.cachedAt, b.cachedAt); assert.equal(a.expiresAt, b.expiresAt); assert.equal(a.cachedAt, base + 180_000);
  assert.equal(a.expiresAt, base + 480_000); assert.notEqual(a.acquiredAt, b.acquiredAt);
  const before = new Map(storage.data); advance(base + 200_000);
  mockFetch(() => response(leaf('replacement')));
  const duplicate = await sourceRequest(storage, { ...A, name: 'Changed', url: A.url + ';pk;new' }, '/admin/sources');
  assert.equal((await duplicate.json() as any).outcome, 'duplicates_only'); assert.deepEqual(storage.data, before);
  await sourceRequest(storage, { input: JSON.stringify(index({ ...A, name: 'Changed' })) });
  assert.deepEqual(storage.data, before);
});

test('round-start TTL uses exact expiry and frozen copies remain eligible after five minutes', async () => {
  for (const offset of [299_999, 300_000]) {
    const storage = new MemoryStorage(); const base = Date.now(); const advance = clock(base);
    mockFetch(() => response(leaf('cached'))); await sourceRequest(storage, A, '/admin/sources');
    const cached = (await importCache(storage)).entries[A.url];
    advance(cached.cachedAt + offset);
    const frozen = await withSourceGate(storage, async () => ImportCacheRound.begin(storage, (await captureSourceBaseline(storage)).registry, Date.now()));
    const identity = (await registry(storage)).nodes[A.url];
    advance(cached.cachedAt + 400_000);
    assert.equal(!!frozen.acquire(A, identity), offset < IMPORT_CACHE_TTL_MS);
    assert.equal(cached.expiresAt, cached.cachedAt + IMPORT_CACHE_TTL_MS);
    advance(cached.cachedAt + offset); let requests = 0;
    mockFetch(() => { requests++; return response(leaf('fresh')); });
    await runSync(storage, config);
    assert.equal(requests, offset < IMPORT_CACHE_TTL_MS ? 0 : 1);
    assert.equal((await snapshot(storage)).config.sites[0].key, offset < IMPORT_CACHE_TTL_MS ? 'cached' : 'fresh');
  }
});

test('expired and corrupt import records miss normally; waiting state outlives cache TTL', async () => {
  for (const damage of ['expired', 'json', 'version', 'payload', 'read']) {
    const storage = new MemoryStorage(); const base = Date.now(); const advance = clock(base);
    mockFetch(() => response(leaf('cached'))); await sourceRequest(storage, A, '/admin/sources');
    const cache = await importCache(storage);
    if (damage === 'expired') advance(cache.entries[A.url].expiresAt);
    else if (damage === 'json') await storage.put(SOURCE_IMPORT_CACHE, '{broken');
    else if (damage === 'read') storage.failGet = SOURCE_IMPORT_CACHE;
    else { if (damage === 'version') cache.version = 99; else cache.entries[A.url].config = { sites: 'bad' }; await storage.put(SOURCE_IMPORT_CACHE, JSON.stringify(cache)); }
    assert.equal((await status(storage)).records[0].waiting, true);
    let requests = 0; mockFetch(() => { requests++; return response(leaf('fresh')); });
    await runSync(storage, config); assert.equal(requests, 1); assert.equal((await snapshot(storage)).config.sites[0].key, 'fresh');
    storage.failGet = undefined;
  }
});

test('unsuccessful output retains staged payload, then real publication consumes it', async () => {
  const storage = new MemoryStorage(); let requests = 0;
  mockFetch(() => { requests++; return response(leaf('staged')); }); await sourceRequest(storage, A, '/admin/sources');
  const before = await storage.get(SOURCE_IMPORT_CACHE);
  storage.failPut = LAST_UPDATE; await assert.rejects(runSync(storage, config), /write failed/);
  storage.failPut = undefined;
  assert.equal(await storage.get(SOURCE_IMPORT_CACHE), before); assert.equal(await snapshot(storage), undefined);
  await runSync(storage, config); assert.equal(requests, 1); assert.deepEqual((await importCache(storage)).entries, {});
  assert.equal((await snapshot(storage)).config.sites[0].key, 'staged');
});

test('successful publication only consumes staged inputs actually accepted into the merge', async () => {
  const storage = new MemoryStorage(); mockFetch(url => response(leaf(url === A.url ? 'A' : 'B')));
  await sourceRequest(storage, { input: A.url + '\n' + B.url }); const cache = await importCache(storage);
  // Structurally readable but now unpreparable payload: a hit fails locally, never refetches.
  cache.entries[B.url].config = { sites: [{ key: '', api: '' }] }; await storage.put(SOURCE_IMPORT_CACHE, JSON.stringify(cache));
  let requests = 0; mockFetch(() => { requests++; return response(leaf('unexpected')); });
  await runSync(storage, config); assert.equal(requests, 0);
  const remaining = (await importCache(storage)).entries;
  assert.equal(remaining[A.url], undefined); assert.equal(remaining[B.url].recordId, cache.entries[B.url].recordId);
  assert.equal(await snapshot(storage, B), undefined); assert.ok(await snapshot(storage));
});

test('deletion and key changes revoke staging and re-add never inherits old health or payload', async () => {
  const storage = new MemoryStorage(); mockFetch(() => response(leaf('first')));
  await sourceRequest(storage, A, '/admin/sources'); const old = (await importCache(storage)).entries[A.url];
  await runSync(storage, config); await roots(storage, []);
  await storage.put(SOURCE_IMPORT_CACHE, JSON.stringify({ version: 1, entries: { [A.url]: old } }));
  mockFetch(() => response(leaf('new'))); await sourceRequest(storage, A, '/admin/sources');
  assert.equal((await status(storage)).records[0].waiting, true);
  const current = (await importCache(storage)).entries[A.url]; assert.notEqual(current.generation, old.generation);
  await roots(storage, [{ ...A, configKey: 'different' }]); assert.deepEqual((await importCache(storage)).entries, {});
  let requests = 0; mockFetch(() => { requests++; return response(leaf('fresh-key')); });
  await runSync(storage, config); assert.equal(requests, 1); assert.equal((await snapshot(storage)).config.sites[0].key, 'fresh-key');
});

test('import holds shared runtime ownership through download and save; manual and cron sync do not start', async () => {
  const storage = new MemoryStorage(); const started = deferred<void>(), release = deferred<void>(); let requests = 0;
  mockFetch(async () => { requests++; started.resolve(); await release.promise; return response(leaf('new')); });
  const pending = sourceRequest(storage, A, '/admin/sources'); await started.promise;
  let runs = 0; const runner = createSyncRunner(sourceActivity(storage), async () => {
    runs++; return { outcome: 'saved', message: '聚合完成' };
  });
  assert.equal((await runner({ source: 'manual' })).ran, false); assert.equal((await runner({ source: 'cron' })).ran, false);
  assert.equal((await sourceRequest(storage, B, '/admin/sources')).status, 409);
  assert.equal(requests, 1); assert.equal(runs, 0);
  release.resolve(); assert.equal((await pending).status, 200); assert.equal((await runner()).ran, true);
  assert.equal(sourceActivity(storage).kind, undefined);
  const activity = new SourceActivity(); const failing = createSyncRunner(activity, async () => { throw new Error('failed'); });
  await failing(); assert.equal(activity.kind, undefined);
});

test('a real round freezes import eligibility before an earlier source takes it past expiry', async () => {
  const storage = new MemoryStorage(); await seed(storage, [A]); const base = Date.now(); const advance = clock(base);
  mockFetch(() => response(leaf('B-staged'))); await sourceRequest(storage, B, '/admin/sources');
  advance(base + 240_000); const calls: string[] = [];
  mockFetch(url => { calls.push(url); advance(base + 360_000); return response(leaf('A-fresh')); });
  await runSync(storage, config); assert.deepEqual(calls, [A.url]);
  assert.equal((await snapshot(storage, B)).config.sites[0].key, 'B-staged');
});

test('import and aggregation share direct UA fallback and configured proxy acquisition', async () => {
  for (const mode of ['ua', 'proxy']) {
    const storage = new MemoryStorage(); const calls: Array<{ url: string; options?: RequestInit }> = [];
    if (mode === 'proxy') await storage.put(EDGE_PROXIES, JSON.stringify({ fetchProxy: 'https://proxy.test' }));
    mockFetch((url, options) => {
      calls.push({ url, options });
      if (mode === 'ua') return calls.length % 2 === 1 ? new Response('{bad') : new Response(compatibleFixture().text);
      return url === A.url ? new Response('', { status: 403 }) : response(leaf('proxied'));
    });
    assert.equal((await sourceRequest(storage, A, '/admin/sources')).status, 200);
    assert.equal(calls.length, 2);
    const importCalls = calls.splice(0);
    await storage.delete(SOURCE_IMPORT_CACHE); await runSync(storage, config);
    assert.deepEqual(calls.map(c => c.url), importCalls.map(c => c.url));
    assert.deepEqual(calls.map(c => c.options?.headers), importCalls.map(c => c.options?.headers));
    if (mode === 'proxy') assert.match(JSON.stringify(importCalls[1].options), /test-token/);
  }
});

test('multiple directory roots share a global four-acquisition budget with stable children and full retries', async () => {
  const storage = new MemoryStorage();
  const children = capacityEntries(10); const calls = new Map<string, number>(); let active = 0, maximum = 0;
  mockFetch(async url => {
    active++; maximum = Math.max(maximum, active); calls.set(url, (calls.get(url) || 0) + 1);
    await new Promise(r => realTimeout(r, url === M.url ? 8 : 2)); active--;
    if (url === M.url) return response(index(...children.slice(0, 6)));
    if (url === N.url) return response(index(...children.slice(4)));
    if (url === children[3].url && calls.get(url) === 1) return new Response('', { status: 503 });
    return response(leaf(url));
  });
  const res = await sourceRequest(storage, { input: M.url + '\n' + N.url }, '/admin/sources/import', { ...config, maxDataSources: 0 });
  const data = await res.json() as any;
  assert.deepEqual(data.sources, children.map(c => c.url)); assert.equal(data.duplicates, 2);
  assert.equal(maximum, 4); assert.equal(calls.get(children[3].url), 2);
  assert.equal(data.checked, 12); assert.equal(calls.get(children[4].url), 1);
});

test('post-publication cache cleanup failure preserves successful output and record IDs protect replacements', async () => {
  const storage = new MemoryStorage(); mockFetch(() => response(leaf('staged')));
  await sourceRequest(storage, A, '/admin/sources');
  const initial = await storage.get(SOURCE_IMPORT_CACHE);
  storage.failBatch = values => SOURCE_IMPORT_CACHE in values && !(MANUAL_SOURCES in values);
  // MemoryStorage.put has its own failure hook, used by cleanup.
  storage.failPut = SOURCE_IMPORT_CACHE;
  await runSync(storage, config); storage.failPut = undefined; storage.failBatch = undefined;
  assert.ok((await readAggregateOutputs(storage))!.merged!.includes('staged'));
  assert.equal(await storage.get(SOURCE_IMPORT_CACHE), initial);
  const baseline = await withSourceGate(storage, () => captureSourceBaseline(storage));
  const frozen = await ImportCacheRound.begin(storage, baseline.registry, Date.now());
  assert.ok(frozen.acquire(A, baseline.registry.nodes[A.url])); frozen.accepted(A);
  const changed = await importCache(storage); changed.entries[A.url].recordId = 'replacement';
  await storage.put(SOURCE_IMPORT_CACHE, JSON.stringify(changed)); await frozen.consume();
  assert.equal((await importCache(storage)).entries[A.url].recordId, 'replacement');
});

test('capacity-excluded import entries remain staged and a no-snapshot failed round never qualifies them', async () => {
  const storage = new MemoryStorage(); mockFetch(url => response(leaf(url)));
  await sourceRequest(storage, { input: A.url + '\n' + B.url }); const cache = await importCache(storage);
  await runSync(storage, { ...config, maxDataSources: 1 });
  assert.equal((await importCache(storage)).entries[B.url].recordId, cache.entries[B.url].recordId);
  assert.equal(await snapshot(storage, B), undefined);
  const unused = new MemoryStorage(); mockFetch(() => response(leaf('unpublished')));
  await sourceRequest(unused, A, '/admin/sources');
  const damaged = await importCache(unused); damaged.entries[A.url].config.sites = [{ key: '', api: '' }];
  await unused.put(SOURCE_IMPORT_CACHE, JSON.stringify(damaged));
  let requests = 0; mockFetch(() => { requests++; return response(leaf('unexpected')); }); await runSync(unused, config);
  assert.equal(requests, 0); assert.equal(await snapshot(unused), undefined);
  assert.equal(await unused.get(MERGED_CONFIG), null); assert.ok((await importCache(unused)).entries[A.url]);
});

test('actual generated actions lock deletion during import and reload current status once before rendering saved rows', async () => {
  for (const failStatus of [false, true]) {
    const storage = new MemoryStorage(); await seed(storage, [A]);
    const router = createSourceMgmtRouter({ storage, config }); const started = deferred<void>(), release = deferred<void>();
    mockFetch(async () => { started.resolve(); await release.promise; return response(leaf('B')); });
    let deletes = 0, posts = 0, statuses = 0;
    const fixture = sourceCapacityFixture(async (url, options) => {
      if (options?.method === 'DELETE') deletes++;
      if (options?.method === 'POST') posts++;
      return router.request(url, { ...options, headers: { ...adminHeaders, 'Content-Type': 'application/json' } });
    });
    const deleteButton = { disabled: false };
    fixture.context.document = { querySelectorAll: () => [deleteButton] };
    fixture.context.fetch = async () => { statuses++; if (failStatus) throw new Error('status offline');
      return createDashboardRouter({ storage, config, runtime: idleRuntime }).request('/source-status'); };
    const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('async function loadSourceHealth'))!;
    fixture.run(script.slice(script.indexOf('async function loadSourceHealth'), script.indexOf('// --- Load data ---')));
    await fixture.run('loadSources()'); fixture.elements.addUrl = { value: B.url } as any; fixture.elements.addName = { value: '' } as any;
    fixture.elements.addResult = { textContent: '', innerHTML: '' } as any;
    fixture.context.healthMap = { [B.url]: { status: 'OK', label: 'STALE HEALTH' } };
    const importing = fixture.run('addSource()'); await started.promise;
    assert.equal(deleteButton.disabled, true); assert.equal(fixture.elements.importBtn.disabled, true);
    await fixture.run('removeSource(' + JSON.stringify(A.url) + ')'); await fixture.run('addSource()');
    assert.equal(deletes, 0); assert.equal(posts, 1);
    release.resolve(); await importing;
    assert.equal(statuses, 1); assert.equal(deleteButton.disabled, false); assert.equal(fixture.elements.addBtn.disabled, false);
    assert.match(String(fixture.elements.addResult.textContent), /新增 1/);
    assert.doesNotMatch(fixture.elements.sourceList.innerHTML, /STALE HEALTH/);
    if (!failStatus) assert.match(fixture.elements.sourceList.innerHTML, /状态：等待聚合/);
    else assert.match(fixture.elements.sourceList.innerHTML, /状态：暂无数据/);
    assert.equal(JSON.parse((await storage.get(MANUAL_SOURCES))!).length, 2);
  }
});

test('hash line comments preserve URL fragments, quoted hashes and original multiline string values', () => {
  const logs: string[] = []; restoreMocks.push(subscribeLogSink(entry => { if (entry.scope === 'parser') logs.push(entry.message); }));
  const text = '# configuration\r\n{\n  ## json sources\n  "sites":[{"key":"hash","type":3,"api":"csp_hash",\n'
    + '  "ext":{"url":"https://example.test/a#fragment","value":"literal # and ##", "lines":"first\n# text inside string\nlast"}}]\r\n  # end\r\n}';
  const parsed = parseConfigJson(text);
  assert.equal(parsed.ok, true);
  const ext = parsed.config!.sites![0].ext; assert.ok(ext && typeof ext === 'object');
  assert.equal(ext.url, 'https://example.test/a#fragment');
  assert.equal(ext.lines, 'first\n# text inside string\nlast');
  assert.equal(logs.length, 1); assert.match(logs[0], /hashComments=3/); assert.doesNotMatch(logs[0], /fragment|csp_hash/);
  assert.equal(parseConfigJson('# only').errorCategory, 'empty');
  assert.equal(parseConfigJson('{"value":1 # not a standalone comment\n}').errorCategory, 'syntax');
  assert.equal(parseConfigJson('{"value":tru# broken\ne}').errorCategory, 'syntax');
});

test('HTML suffix compatibility requires a complete object and preserves markup-looking string data', () => {
  const expected = { value: 'quoted }<div> inside', nested: [{ brackets: '[]{}', html: '<script>never()</script>' }] };
  const suffixes = ['\n<div style="text-align:center"><div></div></div>', '<!-- injected -->\n<div>tail</div>',
    '\r\n<!DOCTYPE html><html>tail</html>', '\n<script>globalThis.shouldNeverRun=1</script>'];
  const logs: string[] = []; restoreMocks.push(subscribeLogSink(e => { if (e.scope === 'parser') logs.push(e.message); }));
  for (const suffix of suffixes) assert.deepEqual(parseConfigJson(JSON.stringify(expected) + suffix), { ok: true, config: expected });
  assert.equal(logs.length, suffixes.length); assert.ok(logs.every(log => /htmlTrailers=1/.test(log)));
  for (const bad of ['<html>{"value":1}</html>', '{"value":1<div></div>', '{"value":1}<diversion',
    '{"value":1} trailing words<div></div>', '{"value":1}{"value":2}<div></div>', '{"value":1};evil()', '{"value":[1,]}<div></div>']) {
    assert.equal(parseConfigJson(bad).ok, false, bad);
  }
});

function cbcEnvelope(text: string): string {
  const key = '347', iv = '1792027989718';
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key.padEnd(16, '0')), Buffer.from(iv.padEnd(16, '0')));
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex');
  return Buffer.from('$#' + key + '#$').toString('hex') + encrypted + Buffer.from(iv).toString('hex');
}

test('CBC self-decoding ignores only outer transport whitespace and preserves the real first block and plaintext comments', async () => {
  const config = leaf('first-block');
  const text = '// UTF-8 配置说明与较长的首块内容\n' + JSON.stringify(config);
  for (const whitespace of ['', '\n', '\r\n', ' \t\r\n']) {
    const bytes = new TextEncoder().encode(whitespace + cbcEnvelope(text) + whitespace);
    const decoded = await decodeConfigResponse(bytes.buffer);
    assert.equal(decoded, text); assert.deepEqual(parseConfigJson(decoded!), { ok: true, config });
  }
});

test('new syntax and CBC responses pass actual direct, proxy, Add and inline aggregation without resource probes', async () => {
  const original = leaf('compatible-round1');
  const plain = '# source metadata\n' + JSON.stringify(original) + '\n<div class="injected"></div>';
  for (const payload of [plain, cbcEnvelope(plain) + '\n']) {
    const storage = new MemoryStorage(); const calls: string[] = [];
    mockFetch(url => { calls.push(url); return new Response(payload); });
    const added = await sourceRequest(storage, A, '/admin/sources'); assert.equal(added.status, 200);
    assert.equal(calls.length, 1); await runSync(storage, config); assert.equal(calls.length, 1);
    assert.deepEqual((await snapshot(storage)).config, original);
    const inline = { name: 'Existing', url: 'inline://inline_config_round1' };
    await roots(storage, [inline]); await storage.put('inline_config_round1', plain); await runSync(storage, config);
    assert.deepEqual((await snapshot(storage, inline)).config, original);
    calls.length = 0;
    mockFetch(url => { calls.push(url); return url === B.url ? new Response('', { status: 403 }) : new Response(payload); });
    const fetched = await fetchConfigs([B], 200, { urls: ['https://proxy.test/fetch-proxy'] });
    assert.equal(calls.length, 2); assert.deepEqual(fetched.configs[0].config, original);
  }
});

test('actual result renderer removes the single check label and prefixes inert failure details once', () => {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function renderSourceImportResult'))!;
  const renderer = script.slice(script.indexOf('function renderSourceImportResult'), script.indexOf('// --- Add source ---'));
  const el = { textContent: '', className: '', innerHTML: '' };
  const context = createContext({ el }); new Script(renderer).runInContext(context);
  new Script("renderSourceImportResult(el,{type:'single',outcome:'added',added:1,duplicates:0,skipped:[]})").runInContext(context);
  assert.equal(String(el.textContent), '新增 1，重复 0，跳过 0'); assert.doesNotMatch(el.textContent, /单仓检查/);
  new Script("renderSourceImportResult(el,{error:'syntax: <b>bad</b> & reason'})").runInContext(context);
  assert.equal(String(el.textContent), '导入出错：syntax: <b>bad</b> & reason'); assert.equal(el.innerHTML, '');
  new Script("renderSourceImportResult(el,{type:'single',outcome:'none',added:0,duplicates:0,skipped:[{reason:'offline'}]})").runInContext(context);
  assert.match(el.textContent, /^导入出错：/); assert.match(el.textContent, /offline/);
  assert.equal(el.textContent.split('导入出错：').length, 2);
});

test('Add and ordinary aggregation share three total rounds and exact 1s/2s waits', async () => {
  const storage = new MemoryStorage(); await seed(storage, [B]);
  const delays: number[] = [], bases: number[] = [];
  const previousTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms && ms >= 800 && ms <= 6000) delays.push(ms);
    return previousTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  restoreMocks.push(() => { globalThis.setTimeout = previousTimeout; });
  restoreMocks.push(subscribeLogSink(entry => {
    if (entry.scope === 'fetcher' && entry.message.includes('source-retry-attempt')) {
      bases.push(Number(entry.message.match(/backoffMs=(\d+)/)![1]));
    }
  }));
  let requests = 0; mockFetch(() => { requests++; return new Response('', { status: 503 }); });
  assert.equal((await sourceRequest(storage, A, '/admin/sources')).status, 502);
  assert.equal(requests, 3); assert.deepEqual(bases, [1000, 2000]);
  await runSync(storage, config);
  assert.equal(requests, 6); assert.deepEqual(bases, [1000, 2000, 1000, 2000]);
  assert.deepEqual(delays, bases);
  assert.equal((await snapshot(storage, B)).config.sites[0].key, 'B1');
});

test('editor keeps all source names across cached imports, fresh downloads and qualified fallback', async () => {
  const storage = new MemoryStorage(); const first = { ...A, name: '王二小放牛娃' }, second = { ...B, name: '另一个接口' };
  let requests = 0;
  mockFetch(() => { requests++; return response(leaf('shared-origin')); });
  assert.equal((await sourceRequest(storage, first, '/admin/sources')).status, 200);
  assert.equal((await sourceRequest(storage, second, '/admin/sources')).status, 200);
  assert.deepEqual((await editorSites(storage)).map(s => s.sourceNames), []);
  await runSync(storage, config); assert.equal(requests, 2);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, [first.name, second.name]);
  await runSync(storage, config); assert.equal(requests, 4);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, [first.name, second.name]);
  mockFetch(() => new Response('', { status: 503 })); await runSync(storage, config);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, [first.name, second.name]);
  for (const raw of await rawOutputs(storage)) assert.doesNotMatch(raw!, /sourceNames|siteSourceNames|王二小放牛娃|另一个接口/);
});

test('unnamed source contributions use the source URL instead of losing attribution or changing site names', async () => {
  const storage = new MemoryStorage(); mockFetch(() => response(leaf('unnamed-origin')));
  assert.equal((await sourceRequest(storage, { url: A.url }, '/admin/sources')).status, 200);
  await runSync(storage, config);
  assert.equal(JSON.parse((await storage.get(MANUAL_SOURCES))!)[0].name, A.url);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, [A.url]);
  assert.equal((await editorSites(storage))[0].name, 'unnamed-origin');
  for (const raw of await rawOutputs(storage)) {
    assert.doesNotMatch(raw!, /sourceNames/); assert.ok(!raw!.includes(A.url));
  }
  const merged = mergeConfigs([{ sourceUrl: A.url, sourceName: '', config: leaf('same') },
    { sourceUrl: B.url, sourceName: 'Named', config: leaf('same') }]);
  assert.deepEqual(merged.siteSourceNames, [[A.url, 'Named']]);
});

test('existing unnamed sources display URL names and regain editor origins on the next successful publication', async () => {
  const storage = new MemoryStorage(); const unnamed = { ...A, name: '' };
  await seed(storage, [unnamed]); const original = await snapshot(storage); const before = await storage.get(MANUAL_SOURCES);
  const res = await createSourceMgmtRouter({ storage, config }).request('/admin/sources', { headers: adminHeaders });
  assert.deepEqual(await res.json(), [{ ...A, name: A.url }]);
  assert.equal(await storage.get(MANUAL_SOURCES), before); // Display does not revoke or rewrite an old source.
  mockFetch(() => response(leaf('current'))); await runSync(storage, config);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, [A.url]);
  assert.equal((await snapshot(storage)).generation, original.generation);
  assert.equal((await status(storage)).records[0].name, A.url);
  assert.equal(await storage.get(MANUAL_SOURCES), before);
  mockFetch(() => new Response('', { status: 503 })); await runSync(storage, config);
  assert.deepEqual((await editorSites(storage))[0].sourceNames, [A.url]);
});

test('URL-line and nameless directory children persist URL names without inheriting a parent name or suffix key', async () => {
  for (const input of [A.url + ';pk;private-key', JSON.stringify({ urls: [{ url: A.url + ';pk;private-key' }] })]) {
    const storage = new MemoryStorage(); mockFetch(() => response(leaf('child')));
    const res = await sourceRequest(storage, { input }); assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [{ url: A.url, name: A.url, configKey: 'private-key' }]);
    await runSync(storage, config);
    assert.deepEqual((await editorSites(storage))[0].sourceNames, [A.url]);
    assert.doesNotMatch((await storage.get(SITE_SOURCE_ATTRIBUTION))!, /private-key/);
  }
});

const sharedJarUrl = 'https://resources.test/shared.jar?version=1';
const declaredJarMd5 = '0123456789abcdef0123456789abcdef';

function captureDownloadTimers(): number[] {
  const timers: number[] = [];
  const previousTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== undefined) timers.push(ms);
    return previousTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  restoreMocks.push(() => { globalThis.setTimeout = previousTimeout; });
  return timers;
}

for (const kind of ['configuration', 'resource']) {
  test(`shared retry stops immediately when ${kind} succeeds in any of its three rounds`, async () => {
    const timers = captureDownloadTimers();
    for (const succeedsAt of [1, 2, 3]) {
      let calls = 0; timers.length = 0;
      mockFetch(url => {
        assert.equal(url, A.url); calls++;
        return calls === succeedsAt ? response(leaf('recovered')) : new Response('', { status: 503 });
      });
      if (kind === 'configuration') {
        assert.deepEqual((await fetchSingleConfig(A, 200)).config, leaf('recovered'));
      } else {
        const data = await downloadResource(A.url, 200); assert.ok(data);
        assert.deepEqual(JSON.parse(data.toString()), leaf('recovered'));
      }
      assert.equal(calls, succeedsAt);
      assert.deepEqual(timers.filter(ms => ms === 1000 || ms === 2000), [1000, 2000].slice(0, succeedsAt - 1));
    }
  });

  test(`shared retry does not start another ${kind} round after an actual request timeout`, async () => {
    let calls = 0; const timers = captureDownloadTimers();
    mockFetch((_url, options) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort',
        () => reject(new DOMException('Timed out', 'AbortError')), { once: true }));
    });
    if (kind === 'configuration') assert.equal((await fetchSingleConfig(A, 5)).fetchResult.status, 'timeout');
    else assert.equal(await downloadResource(A.url, 5), null);
    assert.equal(calls, 1); assert.deepEqual(timers, [5]);
  });

  test(`shared total budget prevents further ${kind} rounds and configuration fallbacks`, async () => {
    const base = Date.now(); const advance = clock(base);
    const timers = captureDownloadTimers(); let calls = 0;
    const messages: string[] = [];
    restoreMocks.push(subscribeLogSink(entry => { messages.push(entry.message); }));
    mockFetch(url => {
      calls++; assert.equal(url, A.url); advance(base + 30_001);
      return new Response('', { status: 503 });
    });
    if (kind === 'configuration') {
      const result = await fetchSingleConfig(A, 40_000, { urls: ['https://edge.test/proxy'] });
      assert.equal(result.fetchResult.status, 'http_503');
      assert.ok(messages.some(message => message.includes('source-download-deadline') && message.includes('attempts=1')));
    } else {
      assert.equal(await downloadResource(A.url, 40_000), null);
      assert.ok(messages.some(message => message.includes('aggregate deadline after 1 attempts')));
    }
    assert.equal(calls, 1); assert.deepEqual(timers, [30_000, 1000]);
  });
}

test('configuration proxy fallback retains compatibility while using only the remaining shared request budget', async () => {
  const base = Date.now(); const advance = clock(base);
  const timers = captureDownloadTimers(); const calls: string[] = [];
  mockFetch(url => {
    calls.push(url);
    if (url === A.url) { advance(base + 20_000); return new Response('', { status: 503 }); }
    assert.equal(url, 'https://edge.test/proxy?url=' + encodeURIComponent(A.url));
    return response(leaf('proxy-recovered'));
  });
  const result = await fetchSingleConfig(A, 40_000, { urls: ['https://edge.test/proxy', 'https://unused.test/proxy'] });
  assert.equal(result.fetchResult.status, 'ok'); assert.deepEqual(result.config, leaf('proxy-recovered'));
  assert.equal(calls.length, 2); assert.deepEqual(timers, [30_000, 10_000]);
});

test('a browser fallback timeout stops outer retries while preserving the primary parse failure', async () => {
  const timers = captureDownloadTimers(); let calls = 0;
  mockFetch((_url, options) => {
    calls++;
    if (calls === 1) return new Response('{broken');
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort',
      () => reject(new DOMException('Timed out', 'AbortError')), { once: true }));
  });
  const result = await fetchSingleConfig(A, 5);
  assert.equal(result.fetchResult.status, 'parse_error');
  assert.equal(calls, 2); assert.deepEqual(timers, [5, 5]);
});

test('proxy timeouts cannot hide behind an HTTP failure, but later same-round proxy recovery still succeeds', async () => {
  const timers = captureDownloadTimers();
  for (const recovers of [false, true]) {
    const calls: string[] = []; timers.length = 0;
    mockFetch((url, options) => {
      calls.push(url);
      if (url === A.url) return new Response('', { status: 503 });
      if (url.startsWith('https://slow-edge.test/')) return new Promise<Response>((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true }));
      assert.ok(url.startsWith('https://last-edge.test/'));
      return recovers ? response(leaf('late-proxy')) : new Response('', { status: 503 });
    });
    const result = await fetchSingleConfig(A, 5, { urls: ['https://slow-edge.test/proxy', 'https://last-edge.test/proxy'] });
    assert.equal(result.fetchResult.status, recovers ? 'ok' : 'http_503');
    if (recovers) assert.deepEqual(result.config, leaf('late-proxy'));
    assert.equal(calls.length, 3); assert.deepEqual(timers, [5, 5, 5]);
  }
});

for (const failure of ['HTTP 401', 'connection reset']) {
  test(`static resource failures log all three attempts and only two actual retry waits: ${failure}`, async () => {
    let calls = 0;
    const messages: string[] = []; const waits: number[] = [];
    restoreMocks.push(subscribeLogSink(entry => { if (entry.scope === 'jar-proxy') messages.push(entry.message); }));
    const previousTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 1000 || ms === 2000 || ms === 5000) waits.push(ms);
      return previousTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    restoreMocks.push(() => { globalThis.setTimeout = previousTimeout; });
    mockFetch(url => {
      calls++; assert.equal(url, sharedJarUrl);
      if (failure === 'HTTP 401') return new Response('', { status: 401 });
      throw new Error(failure);
    });
    assert.equal(await downloadResource(sharedJarUrl, 200), null);
    assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
    const address = sharedJarUrl.substring(0, 60) + '...';
    assert.deepEqual(messages, [
      `Download attempt 1/3 failed (${failure}), retrying in 1000ms: ${address}`,
      `Download attempt 2/3 failed (${failure}), retrying in 2000ms: ${address}`,
      `Download attempt 3/3 failed (${failure}): ${address}`,
    ]);
  });
}

test('import stages original JAR references without downloading files, then aggregation prefetches from the staged config', async () => {
  const storage = new MemoryStorage();
  const upstream = { ...leaf('imported-jar'), spider: sharedJarUrl + ';md5;' + declaredJarMd5 };
  const calls: string[] = [];
  mockFetch(url => {
    calls.push(url); if (url === A.url) return response(upstream);
    assert.equal(url, sharedJarUrl); return new Response('imported JAR bytes');
  });
  assert.equal((await sourceRequest(storage, A, '/admin/sources')).status, 200);
  assert.deepEqual(calls, [A.url]);
  assert.deepEqual(await storage.list('jar:'), []);
  assert.equal(existsSync(path.join(getSiteResourceDir(0, 'jar'), declaredJarMd5 + '.jar')), false);
  assert.equal((await importCache(storage)).entries[A.url].config.spider, upstream.spider);
  await runSync(storage, config);
  assert.deepEqual(calls, [A.url, sharedJarUrl]);
  assert.equal((await status(storage)).records[0].acquisition, 'import-cache');
  assert.equal((await snapshot(storage)).config.spider, upstream.spider);
  assert.equal((await importCache(storage)).entries[A.url], undefined);
  const res = await createJarProxyRouter({ storage, config }).request('/jar/' + declaredJarMd5);
  assert.equal(res.status, 200); assert.equal(await res.text(), 'imported JAR bytes');
  assert.deepEqual(calls, [A.url, sharedJarUrl]);
});

for (const [label, prefix, md5] of [
  ['URL hash', '', ''],
  ['declared MD5', '', declaredJarMd5],
  ['img+ URL hash', 'img+', ''],
  ['img+ declared MD5', 'img+', declaredJarMd5],
]) {
  test(`global-only spider is prefetched and survives cache swaps without proxy re-download: ${label}`, async () => {
    const storage = new MemoryStorage(); await roots(storage, [A]);
    const suffix = md5 ? ';md5;' + md5 : '';
    const declaration = prefix + sharedJarUrl + suffix;
    const upstream = { ...leaf('shared-jar-user'), spider: declaration };
    const calls: string[] = [];
    mockFetch(url => {
      calls.push(url);
      if (url === A.url) return response(upstream);
      assert.equal(url, sharedJarUrl); return new Response('prefetched global JAR bytes');
    });
    await runSync(storage, config);
    assert.deepEqual(calls, [A.url, A.url, sharedJarUrl]); // Legacy inspection precedes first actual acquisition.
    const key = md5 || await urlToKey(sharedJarUrl);
    const merged = JSON.parse((await storage.get(MERGED_CONFIG))!) as TVBoxConfig;
    assert.equal(merged.spider, prefix + '__TVBOX_BASE_URL__/jar/' + key + suffix);
    assert.equal(merged.sites![0].jar, undefined);
    assert.equal(await storage.get('jar:' + key), sharedJarUrl);
    const mapping = JSON.parse((await storage.get('jar-source:' + key))!);
    assert.equal(mapping.index, 0);
    const cachedFile = path.join(getSiteResourceDir(mapping.index, 'jar'), key + '.jar');
    assert.equal(readFileSync(cachedFile, 'utf8'), 'prefetched global JAR bytes');
    for (const storedKey of [MERGED_CONFIG_FULL, EXPORT_CONFIG]) {
      assert.equal(JSON.parse((await storage.get(storedKey))!).spider, declaration);
    }
    assert.equal((await snapshot(storage)).config.spider, declaration);
    assert.deepEqual((await editorSites(storage))[0].sourceNames, [A.name]);
    const proxy = createJarProxyRouter({ storage, config });
    const first = await proxy.request('/jar/' + key);
    assert.equal(first.status, 200); assert.equal(await first.text(), 'prefetched global JAR bytes');
    assert.equal(calls.length, 3);
    calls.length = 0;
    await runSync(storage, config);
    assert.deepEqual(calls, [A.url]); // Effective cache is copied, rather than lost in the swap.
    assert.equal(readFileSync(cachedFile, 'utf8'), 'prefetched global JAR bytes');
    assert.equal(await (await proxy.request('/jar/' + key)).text(), 'prefetched global JAR bytes');
    assert.deepEqual(calls, [A.url]);
  });
}

test('shared and distinct JARs use original URLs once, global priority and matching proxy cache keys', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  const alternate = 'https://resources.test/alternate.jar';
  const plain = 'https://resources.test/plain.jar';
  const alternateMd5 = 'fedcba9876543210fedcba9876543210';
  const shared = sharedJarUrl + ';md5;' + declaredJarMd5;
  const alternateDeclaration = 'img+' + alternate + ';md5;' + alternateMd5;
  const upstream: TVBoxConfig = { spider: shared, sites: [
    { ...leaf('alternate-first').sites![0], jar: alternateDeclaration },
    leaf('implicit-shared').sites![0],
    { ...leaf('explicit-shared').sites![0], jar: shared },
    { ...leaf('duplicate-alternate').sites![0], jar: alternateDeclaration },
    { ...leaf('plain-last').sites![0], jar: plain },
  ] };
  const calls: string[] = [];
  mockFetch(url => {
    calls.push(url); if (url === A.url) return response(upstream);
    assert.ok([sharedJarUrl, alternate, plain].includes(url)); return new Response('bytes for ' + url);
  });
  await runSync(storage, config);
  assert.deepEqual(calls, [A.url, A.url, sharedJarUrl, alternate, plain]);
  const merged = JSON.parse((await storage.get(MERGED_CONFIG))!) as TVBoxConfig;
  const proxy = createJarProxyRouter({ storage, config });
  const plainKey = await urlToKey(plain);
  for (const [url, key, index] of [[sharedJarUrl, declaredJarMd5, 0], [alternate, alternateMd5, 0], [plain, plainKey, 4]] as const) {
    assert.equal(JSON.parse((await storage.get('jar-source:' + key))!).index, index);
    assert.equal(readFileSync(path.join(getSiteResourceDir(index, 'jar'), key + '.jar'), 'utf8'), 'bytes for ' + url);
    const res = await proxy.request('/jar/' + key); assert.equal(res.status, 200);
    assert.equal(await res.text(), 'bytes for ' + url);
  }
  assert.equal(parseSpiderString(merged.sites![2].jar!).url, '__TVBOX_BASE_URL__/jar/' + declaredJarMd5);
  assert.equal(parseSpiderString(merged.sites![3].jar!).url, '__TVBOX_BASE_URL__/jar/' + alternateMd5);
  assert.equal((await storage.list('jar:')).length, 3);
  assert.deepEqual(calls, [A.url, A.url, sharedJarUrl, alternate, plain]);
});

test('site-only JAR with declared MD5 is downloaded into the same nonzero owner directory as its proxy', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  const upstream: TVBoxConfig = { sites: [leaf('without-jar').sites![0],
    { ...leaf('own-jar').sites![0], jar: sharedJarUrl + ';md5;' + declaredJarMd5 }] };
  const calls: string[] = [];
  mockFetch(url => {
    calls.push(url); if (url === A.url) return response(upstream);
    assert.equal(url, sharedJarUrl); return new Response('site-only bytes');
  });
  await runSync(storage, config);
  assert.deepEqual(calls, [A.url, A.url, sharedJarUrl]);
  const merged = JSON.parse((await storage.get(MERGED_CONFIG))!) as TVBoxConfig;
  assert.equal(merged.spider, undefined);
  assert.equal(JSON.parse((await storage.get('jar-source:' + declaredJarMd5))!).index, 1);
  assert.equal(readFileSync(path.join(getSiteResourceDir(1, 'jar'), declaredJarMd5 + '.jar'), 'utf8'), 'site-only bytes');
  const res = await createJarProxyRouter({ storage, config }).request('/jar/' + declaredJarMd5);
  assert.equal(res.status, 200); assert.equal(await res.text(), 'site-only bytes');
  assert.deepEqual(calls, [A.url, A.url, sharedJarUrl]);
});

test('an existing JAR directory mapping preserves a valid legacy cache when its site index differs', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  const upstream: TVBoxConfig = { sites: [leaf('first').sites![0],
    { ...leaf('legacy-owner').sites![0], jar: sharedJarUrl + ';md5;' + declaredJarMd5 }] };
  const previousDir = getSiteResourceDir(0, 'jar'); mkdirSync(previousDir, { recursive: true });
  writeFileSync(path.join(previousDir, declaredJarMd5 + '.jar'), 'valid legacy bytes');
  await storage.put('jar-source:' + declaredJarMd5, JSON.stringify({ index: 0, name: 'old.jar', hash: declaredJarMd5.slice(0, 8) }));
  const calls: string[] = [];
  mockFetch(url => { calls.push(url); assert.equal(url, A.url); return response(upstream); });
  await runSync(storage, config);
  assert.deepEqual(calls, [A.url, A.url]);
  assert.equal(JSON.parse((await storage.get('jar-source:' + declaredJarMd5))!).index, 0);
  assert.equal(readFileSync(path.join(previousDir, declaredJarMd5 + '.jar'), 'utf8'), 'valid legacy bytes');
  const res = await createJarProxyRouter({ storage, config }).request('/jar/' + declaredJarMd5);
  assert.equal(res.status, 200); assert.equal(await res.text(), 'valid legacy bytes');
  assert.deepEqual(calls, [A.url, A.url]);
  const mapping = await storage.get('jar-source:' + declaredJarMd5);
  assert.equal((await patchMergedConfig(storage)).patched, true);
  assert.equal(await storage.get('jar-source:' + declaredJarMd5), mapping);
  const afterPatch = await createJarProxyRouter({ storage, config }).request('/jar/' + declaredJarMd5);
  assert.equal(afterPatch.status, 200); assert.equal(await afterPatch.text(), 'valid legacy bytes');
  assert.deepEqual(calls, [A.url, A.url]);
});

test('failed refresh does not reuse an expired JAR, preserves peers and supports later on-demand caching', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  const peer = 'https://resources.test/peer.jar';
  const upstream: TVBoxConfig = { ...leaf('expired-jar'), spider: sharedJarUrl,
    sites: [leaf('expired-jar').sites![0], { ...leaf('peer').sites![0], jar: peer }] };
  let failing = false; const calls: string[] = [];
  mockFetch(url => {
    calls.push(url); if (url === A.url) return response(upstream);
    if (url === sharedJarUrl) return failing ? new Response('', { status: 503 }) : new Response('current JAR');
    assert.equal(url, peer); return new Response('peer bytes');
  });
  await runSync(storage, config);
  const key = await urlToKey(sharedJarUrl);
  const cachedFile = path.join(getSiteResourceDir(0, 'jar'), key + '.jar');
  const expired = new Date(Date.now() - 172_800_000);
  utimesSync(cachedFile, expired, expired);
  failing = true; calls.length = 0;
  await runSync(storage, config);
  assert.equal(calls.filter(url => url === sharedJarUrl).length, 3);
  assert.equal(calls.filter(url => url === peer).length, 0);
  assert.equal(existsSync(cachedFile), false);
  const merged = JSON.parse((await storage.get(MERGED_CONFIG))!) as TVBoxConfig;
  assert.equal(merged.sites!.length, 2); assert.ok(await storage.get(LAST_UPDATE));
  assert.equal((await status(storage)).records[0].status, 'OK');
  assert.equal((await status(storage)).records[0].consecutiveFailures, 0);
  const proxy = createJarProxyRouter({ storage, config });
  const peerKey = await urlToKey(peer);
  assert.equal(await (await proxy.request('/jar/' + peerKey)).text(), 'peer bytes');
  assert.equal((await proxy.request('/jar/' + key)).status, 502);
  assert.equal(existsSync(cachedFile), false);
  failing = false;
  assert.equal(await (await proxy.request('/jar/' + key)).text(), 'current JAR');
  assert.equal(readFileSync(cachedFile, 'utf8'), 'current JAR');
  const count = calls.length;
  assert.equal(await (await proxy.request('/jar/' + key)).text(), 'current JAR');
  assert.equal(calls.length, count);
});

test('global JAR insertion keeps JS, PY, JSON, TXT and parse cache directories aligned with proxy mappings', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  const js = 'https://resources.test/site.js'; const py = 'https://resources.test/site.py';
  const json = 'https://resources.test/shared.json'; const txt = 'https://resources.test/rules.txt';
  const parseJs = 'https://resources.test/parse.js';
  const upstream: TVBoxConfig = { spider: sharedJarUrl, sites: [
    { ...leaf('js').sites![0], api: js, ext: { rules: json } },
    { ...leaf('py').sites![0], api: py, ext: txt },
    { ...leaf('shared-json').sites![0], ext: { rules: json } },
  ], parses: [{ name: 'parser', type: 1, url: parseJs }] };
  const calls: string[] = [];
  mockFetch(url => {
    calls.push(url); if (url === A.url) return response(upstream);
    assert.ok([sharedJarUrl, js, py, json, txt, parseJs].includes(url)); return new Response('content ' + url);
  });
  await runSync(storage, config);
  assert.equal(calls.filter(url => url !== A.url)[0], sharedJarUrl);
  const proxy = createJarProxyRouter({ storage, config });
  for (const [url, type, index] of [[js, 'js', 0], [py, 'py', 1], [json, 'json', 2], [txt, 'txt', 1], [parseJs, 'js', 0]] as const) {
    assert.equal(calls.filter(value => value === url).length, 1);
    const key = await urlToKey(url);
    assert.equal(JSON.parse((await storage.get('static-source:' + key))!).index, index);
    assert.equal(readFileSync(path.join(getSiteResourceDir(index, type), key + '.' + type), 'utf8'), 'content ' + url);
    const count = calls.length; const res = await proxy.request('/' + type + '/' + key + '.' + type);
    assert.equal(res.status, 200); assert.equal(await res.text(), 'content ' + url); assert.equal(calls.length, count);
  }
  const merged = JSON.parse((await storage.get(MERGED_CONFIG))!) as TVBoxConfig;
  assert.match(merged.sites![0].api, /^__TVBOX_BASE_URL__\/js\//);
  assert.match(merged.parses![0].url, /^__TVBOX_BASE_URL__\/js\//);
});

function refreshApi(storage: Storage, timeoutMs?: number) {
  const activity = sourceActivity(storage);
  const runtime = { ...idleRuntime, isSyncing: () => activity.kind === 'sync' };
  const runner = createSyncRunner(activity, () => runSync(storage, config), timeoutMs);
  return createRefreshRouter({ storage, config, runtime, triggerRefresh: runner });
}
const postRefresh = (router: ReturnType<typeof createRefreshRouter>) =>
  router.request('/refresh', { method: 'POST', headers: adminHeaders });

test('refresh reports actual publication, fallback success, empty inputs and failed output instead of ran alone', async () => {
  const empty = new MemoryStorage();
  let res = await postRefresh(refreshApi(empty));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ran: true, outcome: 'no_sources', message: '没有可聚合的接口，请先添加接口',
    success: false, syncRunning: false });
  const invalid = new MemoryStorage(); await roots(invalid, [A]);
  mockFetch(() => new Response('', { status: 503 }));
  res = await postRefresh(refreshApi(invalid));
  assert.equal(res.status, 200); assert.equal((await res.json() as { outcome: string }).outcome, 'no_configs');
  assert.equal(await invalid.get(MERGED_CONFIG), null);

  const storage = new MemoryStorage(); await roots(storage, [A]);
  mockFetch(() => response(leaf('published')));
  const api = refreshApi(storage);
  res = await postRefresh(api); assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ran: true, outcome: 'saved', message: '聚合完成', success: true, syncRunning: false });
  const first = await snapshot(storage);
  mockFetch(() => new Response('', { status: 503 }));
  res = await postRefresh(api);
  assert.equal((await res.json() as { success: boolean }).success, true);
  assert.equal((await status(storage)).records[0].aggregation.latest.mode, 'restored');
  assert.equal((await snapshot(storage)).savedAt, first.savedAt);
  storage.failBatch = values => MERGED_CONFIG in values;
  mockFetch(() => response(leaf('not-published')));
  res = await postRefresh(api); assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ran: true, outcome: 'failed', message: 'write failed', success: false, syncRunning: false });
  assert.ok((await readAggregateOutputs(storage))!.merged!.includes('published'));
  assert.equal((await snapshot(storage)).savedAt, first.savedAt);
});

test('refresh preserves busy/auth/patch protections and returns work exceptions as failed outcomes', async () => {
  const storage = new MemoryStorage(); const activity = sourceActivity(storage); let calls = 0;
  const runtime = { ...idleRuntime, isSyncing: () => activity.kind === 'sync' };
  const runner = createSyncRunner(activity, async () => { calls++; throw new Error('真实失败 <details>'); });
  const api = createRefreshRouter({ storage, config, runtime, triggerRefresh: runner });
  assert.equal((await api.request('/refresh', { method: 'POST' })).status, 401); assert.equal(calls, 0);
  const release = activity.acquire('import'); assert.ok(release);
  let res = await postRefresh(api); assert.equal(res.status, 200);
  const busy = await res.json() as { success: boolean; outcome: string; message: string };
  assert.equal(busy.success, false); assert.equal(busy.outcome, 'busy'); assert.match(busy.message, /接口正在导入/);
  assert.equal(calls, 0); release();
  const locked = createRefreshRouter({ storage, config, runtime: { ...runtime, getPatchLock: () => true }, triggerRefresh: runner });
  assert.equal((await postRefresh(locked)).status, 409); assert.equal(calls, 0);
  res = await postRefresh(api); assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ran: true, outcome: 'failed', message: '真实失败 <details>', success: false, syncRunning: false });
  assert.equal(calls, 1); assert.equal(activity.kind, undefined);
});

test('refresh timeout is not completion and retains actual task ownership until late work settles', async () => {
  const storage = new MemoryStorage(); const activity = sourceActivity(storage);
  const held = deferred<Awaited<ReturnType<typeof runSync>>>();
  const runtime = { ...idleRuntime, isSyncing: () => activity.kind === 'sync' };
  const runner = createSyncRunner(activity, () => held.promise, 5);
  const api = createRefreshRouter({ storage, config, runtime, triggerRefresh: runner });
  const res = await postRefresh(api); assert.equal(res.status, 504);
  const data = await res.json() as { success: boolean; outcome: string; syncRunning: boolean; message: string };
  assert.equal(data.success, false); assert.equal(data.outcome, 'timeout'); assert.equal(data.syncRunning, true);
  assert.match(data.message, /可能仍在执行/); assert.equal(activity.kind, 'sync');
  assert.equal((await (await postRefresh(api)).json() as { outcome: string }).outcome, 'busy');
  assert.equal((await sourceRequest(storage, A, '/admin/sources')).status, 409);
  held.resolve({ outcome: 'saved', message: '聚合完成' }); await held.promise; await tick();
  assert.equal(activity.kind, undefined);
});

interface DashboardElement {
  textContent: string; className: string; disabled: boolean; innerHTML: string;
  style: Record<string, string>; classList: { contains: (value: string) => boolean; add: (value: string) => void };
}
function dashboardActionFixture(handler: (url: string, options?: RequestInit) => Response | Promise<Response>) {
  const script = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(text => text.includes('async function triggerRefresh'))!;
  const elements: Record<string, DashboardElement> = {};
  for (const id of ['refreshBtn', 'exportBtn', 'statSites', 'statLives', 'statParses', 'statSources', 'updateTime',
    'warningBanner', 'healthOk', 'healthWarn', 'healthError', 'healthTableBody', 'healthToggle', 'healthBody',
    'searchQuotaSection', 'sqActiveCount', 'sqExcludedCount', 'sqTableBody']) {
    elements[id] = { textContent: '', className: '', disabled: false, innerHTML: '', style: {},
      classList: { contains: () => false, add() {} } };
  }
  const notices: Array<{ message: string; type: string }> = []; const requests: string[] = [];
  const request = async (url: string, options?: RequestInit) => { requests.push(url); return handler(url, options); };
  const context = createContext({ $: (id: string) => elements[id], fetch: request,
    initAuth: () => ({ authFetch: request }), toast: (message: string, type = 'success') => notices.push({ message, type }),
    applyTheme() {}, getTheme: () => 'dark', console: { warn() {} },
    setTimeout() { assert.fail('Refresh actions must not add a delayed result or reset timer'); },
    esc: (value: unknown) => String(value ?? ''), location: { origin: 'http://local.test' } });
  new Script(script.replace(sharedUi, '')).runInContext(context);
  return { elements, notices, requests, run: (code: string) => new Script(code).runInContext(context) };
}
function dashboardSummary(url: string, running = false) {
  if (url === '/status-data') return Response.json({ syncRunning: running, lastUpdate: '2026-10-16T01:00:00.000Z', sites: 7, warnings: [] });
  if (url === '/source-status') return Response.json({ records: [], summary: { ok: 0, warn: 0, err: 0 } });
  assert.equal(url, '/search-quota/summary'); return Response.json({ enabled: false });
}

test('real dashboard action notifies start before response, prevents duplicate posts and reports completion only afterwards', async () => {
  const held = deferred<Response>();
  const ui = dashboardActionFixture(url => url === '/refresh' ? held.promise : dashboardSummary(url));
  const pending = ui.run('triggerRefresh()');
  assert.deepEqual(ui.notices, [{ message: '开始聚合', type: 'success' }]);
  assert.equal(ui.elements.refreshBtn.disabled, true); assert.equal(ui.elements.exportBtn.disabled, true);
  await ui.run('triggerRefresh()'); assert.equal(ui.requests.filter(url => url === '/refresh').length, 1);
  await ui.run('loadStatus()'); // A false status response cannot unlock an in-flight action.
  assert.equal(ui.elements.refreshBtn.disabled, true); assert.equal(ui.notices.length, 1);
  held.resolve(Response.json({ success: true, outcome: 'saved', message: '聚合完成', syncRunning: false }));
  await pending;
  assert.deepEqual(ui.notices.map(notice => notice.message), ['开始聚合', '聚合完成']);
  assert.equal(ui.elements.refreshBtn.disabled, false); assert.equal(ui.elements.exportBtn.disabled, false);
  assert.equal(ui.elements.refreshBtn.textContent, '立即聚合'); assert.equal(ui.elements.statSites.textContent, 7);
  assert.ok(ui.requests.includes('/source-status')); assert.ok(ui.requests.includes('/search-quota/summary'));
});

for (const outcome of ['no_sources', 'no_configs', 'failed', 'busy', 'timeout', 'unauthorized', 'network']) {
  test(`dashboard renders the real ${outcome} outcome without a false completion notification`, async () => {
    let running = outcome === 'timeout';
    const message = outcome === 'timeout' ? '等待聚合结果超时，任务可能仍在执行' : '具体原因 <' + outcome + '>';
    const ui = dashboardActionFixture(url => {
      if (url !== '/refresh') return dashboardSummary(url, running);
      if (outcome === 'network') throw new Error('disconnected');
      const status = outcome === 'unauthorized' ? 401 : outcome === 'failed' ? 500 : outcome === 'timeout' ? 504 : 200;
      return Response.json({ success: false, outcome, message, syncRunning: running }, { status });
    });
    await ui.run('triggerRefresh()');
    assert.equal(ui.notices.length, 2); assert.equal(ui.notices[0].message, '开始聚合');
    assert.equal(ui.notices[1].message, outcome === 'unauthorized' ? '登录已失效，请重新登录'
      : outcome === 'network' ? '网络错误，无法确认聚合结果，请稍后查看状态' : message);
    assert.ok(!ui.notices.some(notice => notice.message === '聚合完成'));
    assert.equal(ui.elements.refreshBtn.disabled, running); assert.equal(ui.elements.exportBtn.disabled, running);
    if (running) {
      await ui.run('triggerRefresh()'); assert.equal(ui.requests.filter(url => url === '/refresh').length, 1);
      running = false; await ui.run('loadStatus()');
      assert.equal(ui.elements.refreshBtn.disabled, false); assert.equal(ui.elements.exportBtn.disabled, false);
      assert.equal(ui.notices.length, 2); // Status polling never fabricates an operation result.
    }
  });
}

test('dashboard status refresh failures do not turn confirmed aggregation success into a failed operation', async () => {
  const ui = dashboardActionFixture(url => {
    if (url === '/refresh') return Response.json({ success: true, outcome: 'saved', syncRunning: false });
    throw new Error('status unavailable');
  });
  await ui.run('triggerRefresh()');
  assert.deepEqual(ui.notices.map(notice => notice.message), ['开始聚合', '聚合完成']);
  assert.equal(ui.elements.refreshBtn.disabled, false); assert.equal(ui.elements.exportBtn.disabled, false);
  assert.equal(ui.elements.updateTime.textContent, '获取状态失败');
});

test('a slow post-completion summary does not hold controls or unlock a newer aggregation when it finally returns', async () => {
  const slowSummary = deferred<Response>(); const secondPost = deferred<Response>();
  let posts = 0; let firstSummary = true;
  const ui = dashboardActionFixture(url => {
    if (url === '/refresh') {
      posts++;
      return posts === 1 ? Response.json({ success: true, outcome: 'saved', syncRunning: false }) : secondPost.promise;
    }
    if (url === '/status-data' && firstSummary) { firstSummary = false; return slowSummary.promise; }
    return dashboardSummary(url);
  });
  const first = ui.run('triggerRefresh()'); await tick();
  assert.deepEqual(ui.notices.map(notice => notice.message), ['开始聚合', '聚合完成']);
  assert.equal(ui.elements.refreshBtn.disabled, false);
  const second = ui.run('triggerRefresh()'); assert.equal(ui.elements.refreshBtn.disabled, true);
  slowSummary.resolve(dashboardSummary('/status-data')); await first;
  assert.equal(ui.elements.refreshBtn.disabled, true); assert.equal(posts, 2);
  assert.equal(ui.notices.filter(notice => notice.message === '聚合完成').length, 1);
  secondPost.resolve(Response.json({ success: true, outcome: 'saved', syncRunning: false })); await second;
  assert.equal(ui.elements.refreshBtn.disabled, false);
  assert.deepEqual(ui.notices.map(notice => notice.message), ['开始聚合', '聚合完成', '开始聚合', '聚合完成']);
});

test('dashboard ignores stale statistics, source health and quota replies from before aggregation', async () => {
  const old = new Map(['/status-data', '/source-status', '/search-quota/summary'].map(url => [url, deferred<Response>()]));
  const pendingOld = new Set(old.keys());
  const ui = dashboardActionFixture(url => {
    if (url === '/refresh') return Response.json({ success: true, outcome: 'saved', syncRunning: false });
    if (pendingOld.delete(url)) return old.get(url)!.promise;
    return dashboardSummary(url);
  });
  const status = ui.run('loadStatus()'); const health = ui.run('loadSourceHealth()'); const quota = ui.run('loadSearchQuotaSummary()');
  await ui.run('triggerRefresh()');
  old.get('/status-data')!.resolve(Response.json({ syncRunning: true, sites: 999, warnings: [] }));
  old.get('/source-status')!.resolve(Response.json({ records: [], summary: { ok: 999, warn: 999, err: 0 } }));
  old.get('/search-quota/summary')!.resolve(Response.json({ enabled: true, searchable: 999 }));
  await Promise.all([status, health, quota]);
  assert.equal(ui.elements.statSites.textContent, 7); assert.equal(ui.elements.healthOk.textContent, 0);
  assert.equal(ui.elements.searchQuotaSection.style.display, 'none');
  assert.equal(ui.elements.refreshBtn.disabled, false); assert.equal(ui.notices.length, 2);
});

test('dashboard status polling cannot reenable an export while its download request remains pending', async () => {
  const held = deferred<Response>();
  const ui = dashboardActionFixture(url => url === '/admin/export-config' ? held.promise : dashboardSummary(url));
  const pending = ui.run('triggerExport()');
  assert.equal(ui.elements.exportBtn.disabled, true); await ui.run('loadStatus()');
  assert.equal(ui.elements.exportBtn.disabled, true);
  held.resolve(new Response('', { status: 503 })); await pending;
  assert.equal(ui.elements.exportBtn.disabled, false);
});
test('shared login focuses only when authentication requires input and preserves Enter login', async () => {
  for (const scenario of ['empty', 'valid', 'invalid', 'network'] as const) {
    let focused = 0;
    let loaded = 0;
    const requests: string[] = [];
    const saved = new Map(scenario === 'empty' ? [] : [['admin_token', 'saved-token']]);
    let keydown: ((event: { key: string }) => void) | undefined;
    const elements = {
      input: { value: '', focus: () => { focused++; }, addEventListener: (_: string, handler: typeof keydown) => { keydown = handler; } },
      overlay: { style: { display: '' } },
      content: { style: { display: 'none' } },
      error: { style: { display: 'none' } },
    };
    const context = createContext({
      document: { getElementById: (id: keyof typeof elements) => elements[id] },
      sessionStorage: { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value) },
      fetch: async (_: string, options: { headers: { Authorization: string } }) => {
        requests.push(options.headers.Authorization);
        if (options.headers.Authorization === 'Bearer replacement-token') return { ok: true };
        if (scenario === 'network') throw new Error('offline');
        return { ok: scenario === 'valid' };
      },
      onSuccess: () => { loaded++; },
    });
    new Script(sharedUi + '\ninitAuth("input", "error", "overlay", "content", "/verify", onSuccess);').runInContext(context);
    assert.equal(focused, scenario === 'empty' ? 1 : 0, scenario);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(focused, scenario === 'valid' ? 0 : 1, scenario);
    assert.equal(loaded, scenario === 'valid' ? 1 : 0, scenario);
    assert.equal(elements.overlay.style.display, scenario === 'valid' ? 'none' : '', scenario);
    assert.equal(elements.content.style.display, scenario === 'valid' ? 'block' : 'none', scenario);
    if (scenario !== 'valid') {
      elements.input.value = ' replacement-token ';
      keydown!({ key: 'Enter' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests.at(-1), 'Bearer replacement-token', scenario);
      assert.equal(elements.overlay.style.display, 'none', scenario);
      assert.equal(saved.get('admin_token'), 'replacement-token', scenario);
      assert.equal(loaded, 1, scenario);
    }
  }
});
