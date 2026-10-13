import { createHash, randomUUID } from 'crypto';
import type { Storage } from '../storage/interface';
import { EXPORT_CONFIG, LAST_UPDATE, MERGED_CONFIG, MERGED_CONFIG_FULL, SOURCE_OUTPUT_STATE, SOURCE_IMPORT_POLICY } from './config';
import { withSourceGate } from './source-gate';

interface OutputState {
  version: 1;
  policy?: typeof SOURCE_IMPORT_POLICY;
  epoch: string;
  pending: boolean;
  blocked: boolean;
  activeRun?: string;
  published?: { runId: string; savedAt: string; epoch: string };
}
export interface OutputRunTicket { runId: string; epoch: string }
export interface AggregateOutputs {
  merged: string | null;
  full: string | null;
  exported: string | null;
  /** Private comparison token; never return it through an API. */
  token: string;
}

// A failed activation cannot durably mark the store, but must fail closed in this process.
const activationFailures = new WeakSet<Storage>();
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function decode(raw: string | null): OutputState | null {
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
async function recoverableState(storage: Storage): Promise<OutputState> {
  const raw = await storage.get(SOURCE_OUTPUT_STATE);
  try {
    return decode(raw) || { version: 1, epoch: randomUUID(), pending: false, blocked: true };
  } catch {
    return { version: 1, epoch: randomUUID(), pending: false, blocked: true };
  }
}

/** Caller holds the source gate; include this value in the root/list batch. */
export async function pendingOutputState(storage: Storage): Promise<string> {
  const raw = await storage.get(SOURCE_OUTPUT_STATE);
  let state: OutputState;
  try {
    // Keep legacy output readable until the next actual aggregation starts.
    state = decode(raw) || { version: 1, epoch: randomUUID(), pending: true, blocked: false };
  } catch {
    state = { version: 1, epoch: randomUUID(), pending: true, blocked: true };
  }
  return JSON.stringify({ ...state, epoch: randomUUID(), pending: true });
}

/** Caller holds the source gate. Activate invalidation before any network work or early exit. */
export async function activateOutputRun(storage: Storage, revoked: boolean, values: Record<string, string>): Promise<OutputRunTicket> {
  try {
    const state = await recoverableState(storage);
    if (state.policy !== SOURCE_IMPORT_POLICY) {
      state.epoch = randomUUID(); state.blocked = true; state.policy = SOURCE_IMPORT_POLICY;
    }
    if (revoked) { state.epoch = randomUUID(); state.pending = true; }
    if (state.pending || !state.published) state.blocked = true;
    state.pending = false;
    const ticket = { runId: randomUUID(), epoch: state.epoch };
    state.activeRun = ticket.runId;
    await storage.putMany({ ...values, [SOURCE_OUTPUT_STATE]: JSON.stringify(state) });
    activationFailures.delete(storage);
    return ticket;
  } catch (error) {
    activationFailures.add(storage);
    throw error;
  }
}

/** Caller holds the gate. Rebase only the current owner, never create a newer run. */
export async function migrationOutputState(storage: Storage, ticket: OutputRunTicket, changed: boolean): Promise<{ ticket: OutputRunTicket; value: string }> {
  const state = decode(await storage.get(SOURCE_OUTPUT_STATE));
  if (activationFailures.has(storage) || !state || state.pending || state.activeRun !== ticket.runId || state.epoch !== ticket.epoch) {
    throw new Error('Migration run superseded or sources revoked; run again');
  }
  if (changed) { state.epoch = randomUUID(); state.blocked = true; }
  return { ticket: { runId: ticket.runId, epoch: state.epoch }, value: JSON.stringify(state) };
}

/** Caller holds the source gate and has checked source membership revision. */
export async function publishAggregateOutputs(storage: Storage, ticket: OutputRunTicket, outputs: Omit<AggregateOutputs, 'token'>, savedAt: string): Promise<void> {
  const state = decode(await storage.get(SOURCE_OUTPUT_STATE));
  if (activationFailures.has(storage) || !state || state.pending || state.epoch !== ticket.epoch || state.activeRun !== ticket.runId) {
    throw new Error('Aggregate output run superseded or sources revoked; run again');
  }
  if (outputs.merged === null || outputs.full === null || outputs.exported === null) throw new Error('Incomplete aggregate output');
  await storage.putMany({
    [MERGED_CONFIG]: outputs.merged, [MERGED_CONFIG_FULL]: outputs.full, [EXPORT_CONFIG]: outputs.exported,
    [LAST_UPDATE]: savedAt,
    [SOURCE_OUTPUT_STATE]: JSON.stringify({ ...state, pending: false, blocked: false,
      published: { runId: ticket.runId, epoch: ticket.epoch, savedAt } }),
  });
}

async function readUnlocked(storage: Storage): Promise<AggregateOutputs | null> {
  if (activationFailures.has(storage)) return null;
  try {
    const raw = await storage.get(SOURCE_OUTPUT_STATE);
    if (decode(raw)?.blocked) return null;
    const merged = await storage.get(MERGED_CONFIG);
    const full = await storage.get(MERGED_CONFIG_FULL);
    const exported = await storage.get(EXPORT_CONFIG);
    // Include payloads: two legacy/instant patches may have identical state metadata.
    const token = createHash('sha256').update(JSON.stringify([raw, merged, full, exported])).digest('hex');
    return { merged, full, exported, token };
  } catch { return null; }
}
export async function readAggregateOutputs(storage: Storage): Promise<AggregateOutputs | null> {
  return withSourceGate(storage, () => readUnlocked(storage));
}

/** A timed-out older round must not overwrite a newer round's success marker. */
export async function recordAggregateFailure(storage: Storage, ticket: OutputRunTicket, reason: string): Promise<void> {
  await withSourceGate(storage, async () => {
    const state = decode(await storage.get(SOURCE_OUTPUT_STATE));
    if (state?.activeRun === ticket.runId) {
      await storage.put(LAST_UPDATE, `ERROR @ ${new Date().toISOString()}: ${reason}`);
    }
  });
}

/** Never certify legacy output, clear pending invalidation or unblock a patch's old input. */
export async function publishAggregatePatch(storage: Storage, token: string, merged: string, exported: string): Promise<boolean> {
  return withSourceGate(storage, async () => {
    const current = await readUnlocked(storage);
    if (!current || current.token !== token) return false;
    await storage.putMany({ [MERGED_CONFIG]: merged, [EXPORT_CONFIG]: exported, [LAST_UPDATE]: new Date().toISOString() });
    return true;
  });
}
