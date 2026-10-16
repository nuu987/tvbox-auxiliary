import { createHash } from 'crypto';
import type { Storage } from '../storage/interface';
import type { JarConflict } from './merger';
import { JAR_DECLARATION_DIAGNOSTICS, MERGED_CONFIG_FULL, SOURCE_OUTPUT_STATE } from './config';
import { activationFailures, decodeOutputState } from './aggregate-state';

export interface JarWarning {
  code: 'jar_md5_conflict';
  message: string;
  url: string;
  md5s: (string | null)[];
}
export interface JarDiagnosticsInput { conflicts: JarConflict[]; generations: Record<string, string> }
const message = '同一JAR地址存在不同MD5声明，已分别保留';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function encodeJarDiagnostics(runId: string, full: string, input?: JarDiagnosticsInput): string {
  const sources: Record<string, { generation: string; warnings: JarWarning[] }> = Object.create(null);
  for (const conflict of input?.conflicts || []) for (const source of conflict.sources) {
    const generation = input?.generations[source.url];
    // Independent VOD roots only; MacCMS auxiliary identities have their own UI.
    if (!generation || source.identity !== source.url) continue;
    const target = sources[source.url] ||= { generation, warnings: [] };
    target.warnings.push({ code: 'jar_md5_conflict', message, url: conflict.url, md5s: conflict.md5s });
  }
  return JSON.stringify({ version: 1, runId, fullHash: hash(full), sources });
}

/** Caller holds source gate. Optional diagnostics never gate ordinary config availability. */
export async function readJarWarnings(storage: Storage, generations: Record<string, string>): Promise<Record<string, JarWarning[]>> {
  const result: Record<string, JarWarning[]> = Object.create(null);
  try {
    if (activationFailures.has(storage)) return result;
    const state = decodeOutputState(await storage.get(SOURCE_OUTPUT_STATE));
    if (!state?.published || state.blocked) return result;
    const full = await storage.get(MERGED_CONFIG_FULL);
    const raw = await storage.get(JAR_DECLARATION_DIAGNOSTICS);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!full || !object(value) || value.version !== 1 || value.runId !== state.published.runId
      || value.fullHash !== hash(full) || !object(value.sources)) return result;
    for (const [url, entry] of Object.entries(value.sources)) {
      if (!object(entry) || entry.generation !== generations[url] || !generations[url] || !Array.isArray(entry.warnings)) continue;
      const warnings: JarWarning[] = [];
      for (const warning of entry.warnings) {
        if (!object(warning) || warning.code !== 'jar_md5_conflict' || typeof warning.url !== 'string'
          || !Array.isArray(warning.md5s) || warning.md5s.length < 2
          || !warning.md5s.every((md5: unknown) => md5 === null || typeof md5 === 'string')) continue;
        warnings.push({ code: 'jar_md5_conflict', message, url: warning.url, md5s: warning.md5s });
      }
      if (warnings.length) result[url] = warnings;
    }
  } catch { /* Damaged/missing optional state does not fabricate a warning or fail the list. */ }
  return result;
}
