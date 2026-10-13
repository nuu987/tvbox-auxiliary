import type { FlatMigrationReport } from './types';
import { SOURCE_IMPORT_POLICY } from './config';

export interface PendingIdentity { url: string; fingerprint: string; generation: string }
export interface ImportPolicyState {
  version: 1;
  policy: typeof SOURCE_IMPORT_POLICY;
  startedAt: string;
  completedAt?: string;
  remaining: PendingIdentity[];
  report: FlatMigrationReport;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function readImportPolicy(raw: string | null): ImportPolicyState | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!object(value) || value.version !== 1 || value.policy !== SOURCE_IMPORT_POLICY
      || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
      || (value.completedAt !== undefined && (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))))
      || !Array.isArray(value.remaining) || !value.remaining.every(i => object(i) && typeof i.url === 'string'
        && typeof i.fingerprint === 'string' && typeof i.generation === 'string')
      || !object(value.report) || typeof value.report.savedAt !== 'string' || !Number.isFinite(Date.parse(value.report.savedAt))
      || !Number.isInteger(value.report.added) || Number(value.report.added) < 0
      || !Number.isInteger(value.report.duplicates) || Number(value.report.duplicates) < 0
      || !Array.isArray(value.report.skipped) || !value.report.skipped.every(s => object(s) && typeof s.reason === 'string'
        && (s.url === undefined || typeof s.url === 'string') && (s.name === undefined || typeof s.name === 'string')
        && ['input', 'acquisition', 'decode', 'parse', 'preparation', 'directory'].includes(String(s.stage)))
      || !Array.isArray(value.report.removed) || !value.report.removed.every(s => object(s) && typeof s.url === 'string'
        && typeof s.name === 'string' && typeof s.reason === 'string')) return null;
    if (value.completedAt && value.remaining.length) return null;
    return value as unknown as ImportPolicyState;
  } catch { return null; }
}
