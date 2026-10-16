import type { Storage } from '../storage/interface';
import { logger } from './logger';
import type { SyncResult, SyncRunResult } from './types';

/** Runtime ownership, distinct from the short, non-reentrant persistence gate. */
export class SourceActivity {
  private owner?: { kind: 'import' | 'sync' };
  get kind(): 'import' | 'sync' | undefined { return this.owner?.kind; }
  acquire(kind: 'import' | 'sync'): (() => void) | null {
    if (this.owner) return null;
    const owner = this.owner = { kind };
    return () => { if (this.owner === owner) this.owner = undefined; };
  }
}
const activities = new WeakMap<Storage, SourceActivity>();
export function sourceActivity(storage: Storage): SourceActivity {
  let activity = activities.get(storage);
  if (!activity) { activity = new SourceActivity(); activities.set(storage, activity); }
  return activity;
}
export function activityBusyMessage(activity: SourceActivity): string {
  return activity.kind === 'import' ? '接口正在导入，请完成后重试' : '正在聚合，请完成后重试';
}

/** The response deadline never releases a still-running task's ownership. */
export function createSyncRunner(activity: SourceActivity, work: () => Promise<SyncResult>, timeoutMs = 300_000) {
  return async (_opts?: { source?: 'cron' | 'manual' }): Promise<SyncRunResult> => {
    const release = activity.acquire('sync');
    if (!release) return { ran: false, outcome: 'busy', message: activityBusyMessage(activity) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = (async (): Promise<SyncResult> => {
      try { return await work(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('sync', `Error: ${message}`);
        return { outcome: 'failed', message };
      } finally { release(); }
    })();
    try {
      const result = await Promise.race([running, new Promise<{ outcome: 'timeout'; message: string }>(resolve => {
        timer = setTimeout(() => {
          const message = '等待聚合结果超时，任务可能仍在执行，请稍后查看状态';
          logger.warn('sync', message);
          resolve({ outcome: 'timeout', message });
        }, timeoutMs);
      })]);
      return { ran: true, ...result };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
}
