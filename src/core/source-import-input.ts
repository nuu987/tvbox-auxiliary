import type { SourceEntry, SourceCapacity } from './types';
import { sourceDisplayName } from './source-name';

export class SourceImportError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 500 | 502 | 504, readonly capacity?: SourceCapacity) { super(message); }
}
/** Internal normalization; suffix-derived keys remain valid after persistence. */
export function importSourceEntry(source: SourceEntry): SourceEntry {
  const [url, ...keys] = source.url.trim().split(';pk;');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new SourceImportError('需要完整HTTP(S)接口地址', 400); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new SourceImportError('需要完整HTTP(S)接口地址', 400);
  const configKey = source.configKey?.trim() || keys.join(';pk;');
  return { name: sourceDisplayName({ name: source.name, url }), url, ...(configKey ? { configKey } : {}) };
}
/** Validate external fields before suffix normalization creates an internal key. */
export function externalSourceEntry(value: { url?: unknown; name?: unknown; configKey?: unknown }): SourceEntry {
  if (value.configKey !== undefined && typeof value.configKey !== 'string') throw new SourceImportError('无效的独立解密字段', 400);
  if (typeof value.configKey === 'string' && value.configKey.trim()) throw new SourceImportError('不支持独立解密的接口', 400);
  if (typeof value.url !== 'string' || !value.url.trim()) throw new SourceImportError('需要完整HTTP(S)接口地址', 400);
  if (value.name !== undefined && typeof value.name !== 'string') throw new SourceImportError('无效的接口名称', 400);
  return importSourceEntry({ url: value.url, name: typeof value.name === 'string' ? value.name.trim() : '' });
}
