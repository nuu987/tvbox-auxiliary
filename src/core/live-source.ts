import type { LiveSourceEntry, TVBoxLive } from './types';
import { sourceDisplayName } from './source-name';

/** Validate our declarations only; downloaded TVBox objects remain permissive. */
export function decodeLiveSources(raw: string | null): LiveSourceEntry[] {
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('Invalid manual live source list');
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('url' in entry) || typeof entry.url !== 'string'
      || !entry.url.trim() || ('name' in entry && typeof entry.name !== 'string')) {
      throw new Error('Invalid manual live source entry');
    }
    new URL(entry.url);
    const name = 'name' in entry && typeof entry.name === 'string' ? entry.name : '';
    return { name: sourceDisplayName({ name, url: entry.url }), url: entry.url };
  });
}

export function liveAddress(entry: TVBoxLive): string {
  return entry.url || entry.api || '';
}

export function supportedLives(entries: TVBoxLive[]): TVBoxLive[] {
  return entries.filter(entry => entry && typeof entry === 'object' && !('channels' in entry)
    && (!!liveAddress(entry) || (entry.type != null && Number(entry.type) !== 0)));
}

export function cacheableLive(entry: TVBoxLive): boolean {
  return !('channels' in entry) && (entry.type == null || Number(entry.type) === 0)
    && /^https?:\/\//i.test(liveAddress(entry));
}
