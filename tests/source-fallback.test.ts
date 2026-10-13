import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Storage } from '../src/storage/interface';
import type { SourceEntry, TVBoxConfig, AppConfig } from '../src/core/types';
import { SourceFallbackRound, withSourceGate, saveSourceRoots, sourceAggregationStatuses } from '../src/core/source-fallback';
import { fetchConfigs, parseConfigJson } from '../src/core/fetcher';
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
import { readAggregateOutputs, publishAggregatePatch } from '../src/core/aggregate-output';
import { beginSourceOutputRun, fingerprint, captureSourceBaseline } from '../src/core/source-fallback';
import { prepareImportOnlyRun, sourceMigrationReport } from '../src/core/source-import-policy';
import { patchMergedConfig } from '../src/core/blacklist';
import { subscribeLogSink } from '../src/core/logger';
import { adminHtml } from '../src/core/admin';
import { dashboardHtml } from '../src/core/dashboard';
import { Script, createContext } from 'node:vm';
import { BLACKLIST, MANUAL_SOURCES, MERGED_CONFIG, LAST_UPDATE, SOURCE_CONFIG_SNAPSHOTS,
  SOURCE_PROCESSING_REPORT, SOURCE_HEALTH, MACCMS_SOURCES,
  MERGED_CONFIG_FULL, EXPORT_CONFIG, SOURCE_OUTPUT_STATE, SOURCE_IMPORT_POLICY_STATE, SOURCE_URLS } from '../src/core/config';

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

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'tvbox-fallback-case-'));
  process.env.DATA_DIR = directory;
  // Preserve production retries but eliminate real backoff waits in mocked regressions.
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    realTimeout(fn, ms && ms >= 4000 && ms <= 24000 ? 0 : ms, ...args)) as typeof setTimeout;
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
async function sourceRequest(storage: Storage, input: unknown, path = '/admin/sources/import') {
  return createSourceMgmtRouter({ storage, config }).request(path, { method: 'POST',
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
  for (const importInput of [A.url, text]) {
    const result = await router.request('/admin/sources/import', { method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: importInput }) });
    assert.equal(result.status, 200);
  }
  const local = JSON.parse((await storage.get(MANUAL_SOURCES))!).find((s: SourceEntry) => s.url.startsWith('inline://'));
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

test('inline import preserves object style through normalization, merge and missing-content fallback', async () => {
  const storage = new MemoryStorage(); await roots(storage, [B]);
  const input: TVBoxConfig = { sites: [{ key: 'local-compatible', name: 'Local compatible', type: 3, api: 'csp_local',
    style: { type: 'rect', ratio: 1.597 } }] };
  const router = createSourceMgmtRouter({ storage, config });
  const result = await router.request('/admin/sources/import', { method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: JSON.stringify(input) }) });
  assert.equal(result.status, 200);
  const local = JSON.parse((await storage.get(MANUAL_SOURCES))!).find((s: SourceEntry) => s.url.startsWith('inline://'));
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
  assert.equal(attempts, 2 + 4 * 51); // First upgrade run classifies once before ordinary acquisition.
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

test('retired setting routes return 404 while other settings, MacCMS validation and live probes remain available', async () => {
  const storage = new MemoryStorage(); await storage.put('speed_test_enabled', 'true');
  const app = createApp({ storage, config: { ...config, siteTimeoutMs: 5 }, runtime: idleRuntime,
    triggerRefresh: async () => ({ ran: false }), enableChannelProbe: true });
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
  assert.equal((await app.request('/admin/channel-probe/status', { headers: adminHeaders })).status, 200);
  const toggle = await app.request('/admin/channel-probe/toggle', { method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ enabled: false }) });
  assert.equal(toggle.status, 200);
  const probeState = await (await app.request('/admin/channel-probe/status', { headers: adminHeaders })).json();
  assert.ok(probeState && typeof probeState === 'object' && 'enabled' in probeState);
  assert.equal(probeState.enabled, false);
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
    'loadSyncSchedule', 'loadSmartJarUrl', 'loadLiveDisabled', 'loadEdgeProxies', 'loadSearchQuota', 'loadChannelProbe'];
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
  assert.equal((await request(JSON.stringify(leaf('local-import')))).status, 200);
  const local = JSON.parse((await storage.get(MANUAL_SOURCES))!).find((s: SourceEntry) => s.url.startsWith('inline://'));
  assert.equal(await snapshot(storage, local), undefined);
  mockFetch(() => response(leaf('remote'))); await runSync(storage, config);
  assert.equal((await snapshot(storage, local)).config.sites[0].key, 'local-import');
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
    const context = createContext({ input: record, healthMap: {},
      $: (id: string) => elements[id] ||= { innerHTML: '' },
      esc: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      auth: { authFetch: async () => ({ json: async () => [A] }) },
    });
    const selected = element === 'sourceList' ? script.slice(start, end) : script.slice(tableStart, tableEnd);
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

async function renderSourceRow(record?: object, source: SourceEntry = A) {
  const script = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(text => text.includes('async function loadSources()'))!;
  const start = script.indexOf('async function loadSources()');
  const end = script.indexOf('// --- Add source ---', start);
  const elements: Record<string, { innerHTML: string; textContent?: unknown }> = {};
  const context = createContext({ healthMap: record ? { [source.url]: record } : {},
    $: (id: string) => elements[id] ||= { innerHTML: '' },
    esc: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    auth: { authFetch: async () => ({ json: async () => [source] }) },
  });
  await new Script(script.slice(start, end) + '\nloadSources()').runInContext(context);
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
  const skipped = createRefreshRouter({ storage, config, runtime: idleRuntime, triggerRefresh: async () => ({ ran: false }) });
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
  for (const failedKey of [MERGED_CONFIG, MERGED_CONFIG_FULL, EXPORT_CONFIG, LAST_UPDATE, SOURCE_OUTPUT_STATE]) {
    const storage = new MemoryStorage(); await roots(storage, [A]); let key = 'A1';
    mockFetch(() => response(leaf(key))); await runSync(storage, config);
    const oldOutputs = await rawOutputs(storage); const oldSnapshot = await snapshot(storage);
    const oldPublished = (await outputState(storage)).published;
    storage.failBatch = values => MERGED_CONFIG in values && failedKey in values;
    key = 'A2'; await runSync(storage, config);
    assert.deepEqual(await rawOutputs(storage), oldOutputs);
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

test('timed-out late aggregation cannot overwrite newer outputs even when the newer snapshot publication failed', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]);
  mockFetch(() => response(leaf('baseline'))); await runSync(storage, config);
  let acquired!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(r => { acquired = r; }); let requests = 0;
  mockFetch(async () => {
    if (++requests === 1) { acquired(); await new Promise<void>(r => { resume = r; }); return response(leaf('late-old')); }
    storage.failPut = SOURCE_CONFIG_SNAPSHOTS;
    return response(leaf('newest'));
  });
  // Execute the real timeout wrapper without starting a server or waiting five minutes.
  const source = readFileSync(path.join(process.cwd(), 'src/node-entry.ts'), 'utf8');
  const wrapper = source.slice(source.indexOf('const runWithGuard = async'), source.indexOf('// 动态 cron 管理'))
    .replace('opts?: { source?: \'cron\' | \'manual\' }', 'opts')
    .replace(': Promise<{ ran: boolean }>', '').replace('catch (err: unknown)', 'catch (err)');
  const timers: (() => void)[] = []; const runs: Promise<void>[] = [];
  const context = createContext({ storage, config, SYNC_TIMEOUT_MS: 300_000,
    logger: { info: () => {}, warn: () => {}, error: () => {} }, getDirtyMarker: async () => null, clearDirtyMarker: async () => {},
    setTimeout: (fn: () => void) => { timers.push(fn); return 0; },
    runSync: (s: Storage, c: AppConfig) => { const run = runSync(s, c); runs.push(run); return run; } });
  const guard = new Script('let refreshRunning = false; ' + wrapper + '\nrunWithGuard;').runInContext(context) as () => Promise<{ ran: boolean }>;
  const first = guard(); await waiting;
  assert.equal((await guard()).ran, false); // Skipped requests do not start a new ticket.
  const firstRun = (await outputState(storage)).activeRun;
  timers[0](); assert.equal((await first).ran, true);
  assert.equal((await outputState(storage)).activeRun, firstRun);
  assert.equal((await guard()).ran, true);
  const newestOutputs = await rawOutputs(storage); const newestTime = await storage.get(LAST_UPDATE);
  assert.ok(newestOutputs.every(raw => raw!.includes('newest')));
  assert.equal((await snapshot(storage)).config.sites[0].key, 'baseline');
  storage.failPut = undefined; resume(); await runs[0];
  assert.deepEqual(await rawOutputs(storage), newestOutputs);
  assert.equal(await storage.get(LAST_UPDATE), newestTime);
  assert.equal((await readAggregateOutputs(storage))!.full!.includes('late-old'), false);
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

test('ordinary Add and URL/paste Import share one-layer inspection, child keys and deterministic sibling results', async () => {
  for (const mode of ['add', 'url', 'paste']) {
    const storage = new MemoryStorage(); const requests: string[] = [];
    const directory = { storeHouse: [{ sourceName: 'Child A', sourceUrl: A.url + ';pk;child-key' },
      { sourceName: 'Nested', sourceUrl: N.url }, { sourceName: 'Bad', sourceUrl: B.url }] } as TVBoxConfig;
    mockFetch(url => {
      requests.push(url);
      return url === M.url ? response(directory) : url === A.url ? response(leaf('good'))
        : url === N.url ? response(index({ name: 'Never', url: 'https://never.test/config.json' })) : new Response('', { status: 404 });
    });
    const res = await sourceRequest(storage, mode === 'add' ? { ...M, configKey: 'parent-key' }
      : { input: mode === 'url' ? M.url + ';pk;parent-key' : JSON.stringify(directory) },
      mode === 'add' ? '/admin/sources' : '/admin/sources/import');
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

test('Add/Import reject initial failures once and never save unverified inputs or update health', async () => {
  const cases: Array<[() => Response | Promise<Response>, number]> = [
    [() => new Response('', { status: 403 }), 502],
    [() => new Response('{broken'), 400], [() => response({}), 400],
    [() => { throw new Error('offline'); }, 502],
  ];
  for (const path of ['/admin/sources', '/admin/sources/import']) for (const [handler, code] of cases) {
    const storage = new MemoryStorage(); let requests = 0;
    mockFetch(() => { requests++; return handler(); });
    const res = await sourceRequest(storage, path.endsWith('/import') ? { input: A.url } : A, path);
    assert.equal(res.status, code); assert.equal(requests, 1);
    assert.ok((await res.json() as any).error);
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
  const addDuplicate = await sourceRequest(storage, { ...A, name: 'replace', configKey: 'changed' }, '/admin/sources');
  assert.equal(addDuplicate.status, 409); assert.equal(requests, 1);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
  mockFetch(url => response(url === M.url ? index(N, M) : index(B)));
  const none = await sourceRequest(storage, { input: M.url }); const result = await none.json() as any;
  assert.deepEqual([result.outcome, result.added, result.skipped.length], ['none', 0, 2]);
  const empty = await sourceRequest(storage, { input: JSON.stringify(index()) });
  assert.match((await empty.json() as any).skipped[0].reason, /没有可导入/);
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!), [A]);
});

test('unclassified duplicate directories are inspected and rejected; parsing failures isolate normal siblings', async () => {
  const storage = new MemoryStorage(); await roots(storage, [N]); const requests: string[] = [];
  const unusable: SourceEntry = { name: 'Unusable', url: 'https://empty.test/config.json' };
  mockFetch(url => {
    requests.push(url); return url === M.url ? response(index(A, N, B, unusable, { name: 'Invalid', url: 'no-url;pk;private' }))
      : url === A.url ? new Response(compatibleFixture().text) : url === N.url ? response(index(M))
      : url === B.url ? new Response('{broken') : response({});
  });
  const res = await sourceRequest(storage, { input: M.url }); const result = await res.json() as any;
  assert.equal(result.added, 1); assert.equal(result.skipped.length, 4);
  assert.deepEqual(result.skipped.map((skip: any) => skip.stage), ['directory', 'parse', 'preparation', 'input']);
  assert.equal(requests.filter(url => url === N.url).length, 1);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(JSON.parse((await storage.get(MANUAL_SOURCES))!).map((entry: SourceEntry) => entry.url), [N.url, A.url]);
});

test('interactive inspection leaves all aggregate views, success times, snapshots and health unchanged', async () => {
  const storage = new MemoryStorage(); await roots(storage, [A]); mockFetch(() => response(leaf('A1'))); await runSync(storage, config);
  const outputs = await rawOutputs(storage); const time = await storage.get(LAST_UPDATE);
  const health = await storage.get(SOURCE_HEALTH); const before = await snapshot(storage);
  mockFetch(url => response(url === M.url ? index(A, B) : leaf('B-inspected')));
  const res = await sourceRequest(storage, M, '/admin/sources');
  assert.equal((await res.json() as any).added, 1);
  assert.deepEqual(await rawOutputs(storage), outputs); assert.equal(await storage.get(LAST_UPDATE), time);
  assert.equal(await storage.get(SOURCE_HEALTH), health); assert.deepEqual(await snapshot(storage), before);
  assert.equal(await snapshot(storage, B), undefined);
  mockFetch(() => response(leaf('fresh-next-round'))); await runSync(storage, config);
  assert.equal((await snapshot(storage, B)).config.sites[0].key, 'fresh-next-round');
});

test('inspection uses at most four requests at once, preserves declaration order and does not retry', async () => {
  const storage = new MemoryStorage();
  const entries = Array.from({ length: 11 }, (_, n) => ({ name: String(n), url: `https://source${n}.test/config.json` }));
  let active = 0; let maxActive = 0; let requests = 0;
  mockFetch(async url => {
    requests++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => realTimeout(resolve, 5)); active--;
    return url === entries[5].url ? new Response('', { status: 404 }) : response(leaf(url));
  });
  const res = await sourceRequest(storage, { input: JSON.stringify(index(...entries)) }); const result = await res.json() as any;
  assert.equal(requests, 11); assert.equal(maxActive, 4);
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

test('inline and remote import batches expose no partial source content or success qualification after write failure', async () => {
  for (const mode of ['inline', 'remote']) {
    const storage = new MemoryStorage(); await seed(storage, [A]); const before = new Map(storage.data);
    storage.failPut = SOURCE_CONFIG_SNAPSHOTS; mockFetch(() => response(leaf('new')));
    const res = await sourceRequest(storage, { input: mode === 'inline' ? compatibleFixture().text : B.url });
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
  assert.equal(requests.filter(url => url === A.url).length, 5);
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
  assert.equal(requests.filter(url => url === B.url).length, 5);
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
  const selected = script.slice(script.indexOf('// --- Final operation results ---'), script.indexOf('// --- Remove source ---'))
    + script.slice(script.indexOf('// --- Import Config ---'), script.indexOf('// --- Name Transform ---'));
  const reason = '<img src=x onerror=alert(1)> & ' + 'very-long-reason'.repeat(600);
  const partial = { type: 'multi', success: true, outcome: 'partial', added: 1, duplicates: 2,
    skipped: [{ name: '<nested>', url: N.url, reason }] };
  for (const action of ['addSource', 'importConfig']) {
    const elements: Record<string, any> = {};
    for (const id of ['addBtn', 'addResult', 'addUrl', 'addName', 'addConfigKey', 'importBtn', 'importResult', 'importInput']) {
      elements[id] = { value: id === 'addUrl' ? M.url : 'original input', textContent: '', innerHTML: '', disabled: false, focus() {} };
    }
    let resolve!: (value: unknown) => void; let calls = 0;
    let request: Promise<unknown> = new Promise(r => { resolve = r; });
    const context = createContext({ $: (id: string) => elements[id], loadSources() {},
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
    assert.equal(result.textContent, reason); assert.equal(button.disabled, false);
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
