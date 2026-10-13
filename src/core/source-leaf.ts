import type { SourceEntry, TVBoxConfig } from './types';
import { normalizeConfig } from './parser';

/** Existing preparation only, on a copy; this is not a client-field schema. */
export function prepareSourceLeaf(source: SourceEntry, raw: TVBoxConfig): TVBoxConfig {
  const prepared = normalizeConfig({ sourceUrl: source.url, sourceName: source.name,
    config: JSON.parse(JSON.stringify(raw)) as TVBoxConfig });
  prepared.config.sites = (prepared.config.sites || []).filter(site => site.key && site.api);
  if (!prepared.config.sites.length) throw new Error('Configuration has no valid VOD sites');
  return prepared.config;
}
