// 频道级 URL 测速（方案 D+，仅 Node/Docker 跑）
// 独立模块：不阻塞主聚合，失败不影响聚合产出

import type { Storage } from '../storage/interface';
import type { TVBoxLiveGroup, ChannelSpeedMap, ChannelProbeStatus } from './types';
import {
  CHANNEL_SPEED_MAP,
  CHANNEL_PROBE_STATUS,
  CHANNEL_PROBE_ENABLED,
  CHANNEL_MERGED_TREE,
  CHANNEL_PROBE_CONCURRENCY,
  CHANNEL_PROBE_TIMEOUT_MS,
  CHANNEL_SPEED_TTL_MS,
  TVBOX_UA,
  LIVE_DISABLED,
} from './config';
import { extractAllUrls } from './live-merger';

// ─── 开关/状态 ─────────────────────────────────────────

export async function isProbeEnabled(storage: Storage): Promise<boolean> {
  const v = await storage.get(CHANNEL_PROBE_ENABLED);
  return v === 'true';
}

export async function setProbeEnabled(storage: Storage, enabled: boolean): Promise<void> {
  await storage.put(CHANNEL_PROBE_ENABLED, enabled ? 'true' : 'false');
}

export async function loadStatus(storage: Storage): Promise<ChannelProbeStatus> {
  const raw = await storage.get(CHANNEL_PROBE_STATUS);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fallthrough */
    }
  }
  return {
    state: 'idle',
    totalUrls: 0,
    probed: 0,
    success: 0,
    failed: 0,
    totalChannels: 0,
    coverage: 0,
  };
}

async function saveStatus(storage: Storage, status: ChannelProbeStatus): Promise<void> {
  await storage.put(CHANNEL_PROBE_STATUS, JSON.stringify(status));
}

// ─── 测速缓存 ──────────────────────────────────────────

export async function loadSpeedMap(storage: Storage): Promise<ChannelSpeedMap> {
  const raw = await storage.get(CHANNEL_SPEED_MAP);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSpeedMap(storage: Storage, map: ChannelSpeedMap): Promise<void> {
  await storage.put(CHANNEL_SPEED_MAP, JSON.stringify(map));
}

/** 清理 7 天前的测速缓存 */
export function pruneExpired(map: ChannelSpeedMap): ChannelSpeedMap {
  const now = Date.now();
  const out: ChannelSpeedMap = {};
  for (const [url, entry] of Object.entries(map)) {
    const ts = Date.parse(entry.probedAt);
    if (isFinite(ts) && now - ts < CHANNEL_SPEED_TTL_MS) {
      out[url] = entry;
    }
  }
  return out;
}

// ─── 单 URL 测试 ───────────────────────────────────────

interface ProbeResult {
  url: string;
  speedMs: number;
  kind: 'm3u8' | 'ts' | 'tcp' | 'fail';
}

async function probeSingle(url: string): Promise<ProbeResult> {
  const isM3U8 = /\.m3u8(\?|$)/i.test(url);
  const isTs = /\.(ts|flv|mp4)(\?|$)/i.test(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHANNEL_PROBE_TIMEOUT_MS);
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': TVBOX_UA },
    });
    const ttfb = Date.now() - start;

    if (!resp.ok) {
      clearTimeout(timer);
      return { url, speedMs: 0, kind: 'fail' };
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      return { url, speedMs: ttfb, kind: 'tcp' };
    }

    try {
      const { value } = await reader.read();
      clearTimeout(timer);
      if (!value) {
        return { url, speedMs: ttfb, kind: 'tcp' };
      }

      if (isM3U8) {
        const head = new TextDecoder().decode(value.slice(0, Math.min(1024, value.length)));
        if (head.includes('#EXTM3U')) {
          return { url, speedMs: ttfb, kind: 'm3u8' };
        }
        return { url, speedMs: 0, kind: 'fail' };
      }

      if (isTs) {
        // 检查 sync byte 0x47（4KB 内任何位置）
        const end = Math.min(4096, value.length);
        for (let i = 0; i < end; i += 188) {
          if (value[i] === 0x47) {
            return { url, speedMs: ttfb, kind: 'ts' };
          }
        }
        // 没找到 sync byte 也不一定失败（可能是 HTTP-FLV 等），用 tcp 标记
        return { url, speedMs: ttfb, kind: 'tcp' };
      }

      return { url, speedMs: ttfb, kind: 'tcp' };
    } finally {
      reader.cancel().catch(() => {});
    }
  } catch {
    clearTimeout(timer);
    return { url, speedMs: 0, kind: 'fail' };
  }
}

// ─── 并发池 ────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  let done = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        // 兜底：fn 理论上已内部 try/catch；此路径保险返回显式 fail 对象
        results[i] = { url: String(items[i]), speedMs: 0, kind: 'fail' } as R;
      }
      done++;
      if (onProgress && done % 50 === 0) onProgress(done, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (onProgress) onProgress(done, items.length);
  return results;
}

// ─── 主入口 ────────────────────────────────────────────

let running = false;

export async function runChannelProbe(storage: Storage): Promise<ChannelProbeStatus> {
  if (running) {
    console.log('[channel-probe] Already running, skipping');
    return loadStatus(storage);
  }

  if (!(await isProbeEnabled(storage))) {
    console.log('[channel-probe] Disabled by user, skipping');
    return loadStatus(storage);
  }

  // 直播功能禁用时跳过测速（无意义）
  if ((await storage.get(LIVE_DISABLED)) === 'true') {
    console.log('[channel-probe] Live disabled, skipping');
    return loadStatus(storage);
  }

  // 读取上次合并的频道树
  const treeRaw = await storage.get(CHANNEL_MERGED_TREE);
  if (!treeRaw) {
    console.log('[channel-probe] No merged tree available, skipping (run main sync first)');
    const status: ChannelProbeStatus = {
      state: 'error',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels: 0,
      coverage: 0,
      error: 'No merged channel tree (run main sync first)',
    };
    await saveStatus(storage, status);
    return status;
  }

  let groups: TVBoxLiveGroup[];
  try {
    groups = JSON.parse(treeRaw);
  } catch (err) {
    const status: ChannelProbeStatus = {
      state: 'error',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels: 0,
      coverage: 0,
      error: `Parse merged tree failed: ${err}`,
    };
    await saveStatus(storage, status);
    return status;
  }

  const urls = extractAllUrls(groups);
  const totalChannels = groups.reduce((n, g) => n + g.channels.length, 0);

  if (urls.length === 0) {
    const status: ChannelProbeStatus = {
      state: 'done',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels,
      coverage: 0,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    };
    await saveStatus(storage, status);
    return status;
  }

  running = true;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let success = 0;
  let failed = 0;

  const status: ChannelProbeStatus = {
    state: 'running',
    startedAt,
    totalUrls: urls.length,
    probed: 0,
    success: 0,
    failed: 0,
    totalChannels,
    coverage: 0,
  };
  await saveStatus(storage, status);

  console.log(`[channel-probe] Started: ${urls.length} URLs, ${totalChannels} channels, concurrency=${CHANNEL_PROBE_CONCURRENCY}`);

  try {
    // 先读旧缓存，复用未过期条目（减少重复测试）
    const oldMap = pruneExpired(await loadSpeedMap(storage));
    const fresh: ChannelSpeedMap = { ...oldMap };

    // 只测缓存里没有的 URL
    const toProbe = urls.filter((u) => !fresh[u]);
    console.log(`[channel-probe] ${toProbe.length} new URLs to probe (${urls.length - toProbe.length} cached)`);

    const results = await runWithConcurrency(
      toProbe,
      CHANNEL_PROBE_CONCURRENCY,
      (url) => probeSingle(url),
      (done, total) => {
        status.probed = done + (urls.length - toProbe.length); // 含缓存命中
        saveStatus(storage, status).catch(() => {});
        if (done % 200 === 0) {
          console.log(`[channel-probe] Progress: ${done}/${total}`);
        }
      },
    );

    const now = new Date().toISOString();
    for (const r of results) {
      fresh[r.url] = {
        speedMs: r.speedMs,
        probedAt: now,
        kind: r.kind,
      };
      if (r.kind === 'fail') failed++;
      else success++;
    }

    // 算上缓存命中的成功数（不重复测但视为 success）
    const cachedSuccess = urls.length - toProbe.length;
    success += cachedSuccess;

    await saveSpeedMap(storage, fresh);

    const durationMs = Date.now() - startMs;
    const coverage = urls.length > 0 ? Math.round((success / urls.length) * 100) : 0;

    const finalStatus: ChannelProbeStatus = {
      state: 'done',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      totalUrls: urls.length,
      probed: urls.length,
      success,
      failed,
      totalChannels,
      coverage,
    };
    await saveStatus(storage, finalStatus);

    console.log(
      `[channel-probe] Done in ${(durationMs / 1000).toFixed(1)}s: ` +
      `${success} success, ${failed} failed, coverage=${coverage}%`,
    );

    return finalStatus;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errStatus: ChannelProbeStatus = {
      state: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      totalUrls: urls.length,
      probed: status.probed,
      success,
      failed,
      totalChannels,
      coverage: 0,
      error: msg,
    };
    await saveStatus(storage, errStatus);
    console.error(`[channel-probe] Error: ${msg}`);
    return errStatus;
  } finally {
    running = false;
  }
}

export function isRunning(): boolean {
  return running;
}
