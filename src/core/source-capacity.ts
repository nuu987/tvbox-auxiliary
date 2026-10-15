import { DEFAULT_MAX_DATA_SOURCES } from './config';
import type { AppConfig, SourceCapacity } from './types';

export function parseMaxDataSources(raw?: string): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return DEFAULT_MAX_DATA_SOURCES;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : DEFAULT_MAX_DATA_SOURCES;
}

export function sourceLimit(config: Pick<AppConfig, 'maxDataSources'>): number {
  const value = config.maxDataSources;
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MAX_DATA_SOURCES;
}

export function sourceCapacity(current: number, limit: number, rejected = 0): SourceCapacity {
  return { limit, current, remaining: limit === 0 ? null : Math.max(0, limit - current), rejected };
}

export function selectDataSources<T>(sources: T[], limit: number): T[] {
  return limit === 0 ? sources : sources.slice(0, limit);
}

export function sourceLimitMessage(limit: number): string {
  return `接口数量已达到上限（${limit}），超出的接口未添加。`;
}
