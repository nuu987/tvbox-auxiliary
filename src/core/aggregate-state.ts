import { SOURCE_IMPORT_POLICY } from './config';
import type { Storage } from '../storage/interface';

export interface OutputState {
  version: 1;
  policy?: typeof SOURCE_IMPORT_POLICY;
  epoch: string;
  pending: boolean;
  blocked: boolean;
  activeRun?: string;
  published?: { runId: string; savedAt: string; epoch: string };
}
// A failed activation cannot durably mark the store, but must fail closed in this process.
export const activationFailures = new WeakSet<Storage>();
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function decodeOutputState(raw: string | null): OutputState | null {
  if (raw === null) return null; // Untracked legacy output, readable until its first actual run.
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || typeof value.epoch !== 'string' || !value.epoch
    || typeof value.pending !== 'boolean' || typeof value.blocked !== 'boolean'
    || (value.policy !== undefined && value.policy !== SOURCE_IMPORT_POLICY)
    || (value.activeRun !== undefined && (typeof value.activeRun !== 'string' || !value.activeRun))) {
    throw new Error('Invalid aggregate output state');
  }
  if (value.published !== undefined) {
    const p = value.published;
    if (!object(p) || typeof p.runId !== 'string' || !p.runId || typeof p.epoch !== 'string' || !p.epoch
      || typeof p.savedAt !== 'string' || !Number.isFinite(Date.parse(p.savedAt))) {
      throw new Error('Invalid aggregate publication');
    }
    // A pending deletion intentionally retains the earlier publication's epoch.
    if (!value.pending && !value.blocked && p.epoch !== value.epoch) throw new Error('Invalid publication epoch');
  } else if (!value.pending && !value.blocked) throw new Error('Missing aggregate publication');
  return value as unknown as OutputState;
}
