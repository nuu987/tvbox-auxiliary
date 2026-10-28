import { createHash } from 'crypto';
import type { Storage } from '../storage/interface';
import type { TVBoxConfig, TVBoxLive } from './types';
import { loadLiveCache, projectLiveAddress, type LiveCacheState } from './live-cache';
import { supportedLives, liveAddress, decodeLiveSources } from './live-source';
export { decodeLiveSources } from './live-source';
import { LIVE_DISABLED, LIVE_SOURCES } from './config';

export interface LivePolicy {
  disabled: boolean;
  manualLives: TVBoxLive[];
  cacheState: LiveCacheState | null;
  /** Private snapshot identity for stale patch detection. */
  token: string;
}

/** Caller holds the source gate for a coherent setting/list snapshot. No network I/O. */
export async function loadLivePolicy(storage: Storage): Promise<LivePolicy> {
  const setting = await storage.get(LIVE_DISABLED);
  const disabled = setting !== 'false';
  const manual = await storage.get(LIVE_SOURCES);
  const manualLives = decodeLiveSources(manual).map(entry => ({ ...entry, type: 0 }));
  const cache = await loadLiveCache(storage);
  const token = createHash('sha256').update(JSON.stringify([setting, manual, cache.raw])).digest('hex');
  return { disabled, manualLives, cacheState: cache.state, token };
}

function interfaceLives(config: TVBoxConfig, policy: LivePolicy): TVBoxLive[] {
  const manualUrls = new Set(policy.manualLives.map(entry => entry.url));
  return policy.disabled ? [] : supportedLives(config.lives || []).filter(entry => !manualUrls.has(liveAddress(entry)));
}

/** Stored aggregate payloads contain upstream results only; manual declarations stay independent. */
export function applyStoredLivePolicy(config: TVBoxConfig, policy: LivePolicy): TVBoxConfig {
  return { ...config, lives: policy.disabled ? [] : supportedLives(config.lives || []) };
}

/** Compose the latest manual list exactly once, without changing the stored base. */
export function projectLiveJson(
  raw: string,
  policy: LivePolicy,
  transformBase?: (base: string) => string,
  baseUrl = '',
  transformConfig?: (config: TVBoxConfig) => TVBoxConfig,
): string {
  const config: unknown = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid config object');
  // Public lives are the only field projected here; leave all other TVBox fields intact.
  const lives = policy.disabled || !('lives' in config) || config.lives == null ? [] : config.lives;
  if (!Array.isArray(lives)) throw new Error('Invalid config lives');
  // Filter collisions before host replacement; compose literal manual URLs afterwards.
  const entries = [...interfaceLives({ ...config, lives }, policy), ...supportedLives(policy.manualLives)];
  const base = { ...(config as TVBoxConfig), lives: [] };
  const resolved = transformBase ? JSON.parse(transformBase(JSON.stringify(base))) as TVBoxConfig : base;
  const projected: TVBoxConfig = {
    ...resolved,
    lives: entries.map(entry => projectLiveAddress(entry, policy.cacheState, baseUrl)),
  };
  return JSON.stringify(transformConfig ? transformConfig(projected) : projected);
}
