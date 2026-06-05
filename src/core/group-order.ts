import type { Storage } from '../storage/interface';
import type { TVBoxSite } from './types';
import { KV_GROUP_ORDER } from './config';

export interface GroupOrderRule {
  name: string;
  keywords: string[];
}

export interface GroupOrderConfig {
  rules: GroupOrderRule[];
  unmatchedPosition: 'before' | 'after';
  enabled: boolean;
}

export const DEFAULT_GROUP_ORDER_CONFIG: GroupOrderConfig = {
  rules: [],
  unmatchedPosition: 'after',
  enabled: false,
};

export async function loadGroupOrder(storage: Storage): Promise<GroupOrderConfig> {
  const raw = await storage.get(KV_GROUP_ORDER);
  if (!raw) return { ...DEFAULT_GROUP_ORDER_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<GroupOrderConfig>;
    return {
      rules: parsed.rules || [],
      unmatchedPosition: parsed.unmatchedPosition || 'after',
      enabled: parsed.enabled !== false,
    };
  } catch {
    return { ...DEFAULT_GROUP_ORDER_CONFIG };
  }
}

export async function saveGroupOrder(storage: Storage, cfg: GroupOrderConfig): Promise<void> {
  await storage.put(KV_GROUP_ORDER, JSON.stringify(cfg));
}

export function applyGroupOrder(sites: TVBoxSite[], cfg: GroupOrderConfig): TVBoxSite[] {
  if (!cfg.enabled || cfg.rules.length === 0) return sites;

  function getRuleIndex(site: TVBoxSite): number {
    const nameLower = (site.name || '').toLowerCase();
    for (let i = 0; i < cfg.rules.length; i++) {
      const rule = cfg.rules[i];
      const hit = rule.keywords.some(kw => kw && nameLower.includes(kw.toLowerCase()));
      if (hit) return i;
    }
    return -1;
  }

  const buckets: TVBoxSite[][] = cfg.rules.map(() => []);
  const unmatched: TVBoxSite[] = [];

  for (const site of sites) {
    const idx = getRuleIndex(site);
    if (idx >= 0) {
      buckets[idx].push(site);
    } else {
      unmatched.push(site);
    }
  }

  const ordered: TVBoxSite[] = [];
  const matched = buckets.flat();

  if (cfg.unmatchedPosition === 'before') {
    ordered.push(...unmatched, ...matched);
  } else {
    ordered.push(...matched, ...unmatched);
  }

  const matchedCount = matched.length;
  const unmatchedCount = unmatched.length;
  console.log(`[group-order] Applied: ${matchedCount} matched (${cfg.rules.length} rules), ${unmatchedCount} unmatched (position: ${cfg.unmatchedPosition})`);

  return ordered;
}
