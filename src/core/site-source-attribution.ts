import { createHash } from 'crypto';

/** Private editor metadata, aligned to the exact complete output and its publication. */
interface SiteSourceAttribution {
  version: 1;
  runId: string;
  fullHash: string;
  rows: string[][];
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function encodeSiteSourceAttribution(runId: string, full: string, rows: string[][]): string {
  const data: SiteSourceAttribution = { version: 1, runId, fullHash: hash(full), rows };
  return JSON.stringify(data);
}

/** Missing or damaged auxiliary metadata must not make ordinary output unavailable. */
export function readSiteSourceNames(raw: string | null, config: string | null, publishedRunId?: string): string[][] | null {
  if (!raw || !config || !publishedRunId) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || data.runId !== publishedRunId || data.fullHash !== hash(config)
      || !Array.isArray(data.rows)) return null;
    const rows: unknown[] = data.rows;
    if (!rows.every((row): row is string[] => Array.isArray(row)
      && row.every(name => typeof name === 'string' && name.length > 0))) return null;
    const parsed: unknown = JSON.parse(config);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const sites = (parsed as Record<string, unknown>).sites;
    if (!Array.isArray(sites) || rows.length !== sites.length) return null;
    return rows;
  } catch {
    return null;
  }
}
