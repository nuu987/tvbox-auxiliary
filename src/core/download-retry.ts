// Shared retry policy for configuration acquisition and static resource downloads.

export const MAX_DOWNLOAD_ATTEMPTS = 3;
export const DOWNLOAD_DEADLINE_MS = 30_000;
const RETRY_DELAYS_MS = [1000, 2000];

export interface DownloadAttemptContext {
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  remainingMs: () => number;
}

export type DownloadAttemptResult<T> =
  | { value: T; status: 'ok' }
  | { value: T; status: 'failed' | 'timeout'; reason: string };

export interface DownloadFailure extends DownloadAttemptContext {
  status: 'failed' | 'timeout';
  reason: string;
  delayMs: number;
}

interface DownloadRetryOptions<T> {
  timeoutMs: number;
  execute: (context: DownloadAttemptContext) => Promise<DownloadAttemptResult<T>>;
  onFailure?: (failure: DownloadFailure) => void;
  onDeadline?: (attempts: number) => void;
}

export interface DownloadRetryResult<T> {
  value: T;
  attempts: number;
  outcome: 'success' | 'timeout' | 'exhausted' | 'deadline';
}

/** Callers own HTTP/decoding; this owner alone schedules retries and the total budget. */
export async function retryDownload<T>(options: DownloadRetryOptions<T>): Promise<DownloadRetryResult<T>> {
  const startedAt = Date.now();
  const remainingMs = () => DOWNLOAD_DEADLINE_MS - (Date.now() - startedAt);
  let attempt = 1;

  while (true) {
    const context: DownloadAttemptContext = {
      attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
      timeoutMs: Math.min(options.timeoutMs, Math.max(remainingMs(), 1000)), remainingMs,
    };
    const result = await options.execute(context);
    if (result.status === 'ok') return { value: result.value, attempts: attempt, outcome: 'success' };

    const delayMs = result.status === 'failed' && attempt < MAX_DOWNLOAD_ATTEMPTS
      ? RETRY_DELAYS_MS[attempt - 1] : 0;
    options.onFailure?.({ ...context, status: result.status, reason: result.reason, delayMs });
    if (!delayMs) {
      return { value: result.value, attempts: attempt, outcome: result.status === 'timeout' ? 'timeout' : 'exhausted' };
    }

    await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    if (remainingMs() <= Math.min(options.timeoutMs / 2, 5000)) {
      options.onDeadline?.(attempt);
      return { value: result.value, attempts: attempt, outcome: 'deadline' };
    }
    attempt++;
  }
}
