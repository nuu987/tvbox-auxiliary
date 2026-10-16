import type { Storage } from '../storage/interface';
import type { AppConfig, EdgeProxyConfig } from './types';
import type { FetchProxyConfig } from './fetcher';
import { EDGE_PROXIES } from './config';

/** One runtime configuration path for import and ordinary aggregation. */
export async function loadFetchProxy(storage: Storage, config: AppConfig): Promise<FetchProxyConfig | undefined> {
  const raw = await storage.get(EDGE_PROXIES);
  if (!raw) return undefined;
  const edge: EdgeProxyConfig = JSON.parse(raw);
  const urls: string[] = [];
  if (edge.fetchProxy) urls.push(`${edge.fetchProxy}/fetch-proxy`);
  if (edge.vercel) urls.push(`${edge.vercel}/api/proxy`);
  return urls.length ? { urls, token: config.adminToken } : undefined;
}
