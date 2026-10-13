// Phase 6 VIEWER-01/02: /admin/logs SSE 端点
// D-01: 用 Hono streamSSE 助手实现 SSE 长连接
// D-09: 端点路径 /admin/logs，模块 src/routes/log-viewer.ts，导出 createLogViewerRouter 工厂
// D-10: 复用 adminAuthMiddleware，Bearer Token 走 Authorization 头
// Snapshot and subscribe synchronously, then serialize history and queued live logs.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { adminAuthMiddleware } from './admin-auth';
import { getHistory, subscribe } from '../core/log-buffer';
import type { LogEntry } from '../core/logger';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';

export interface LogViewerRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createLogViewerRouter(deps: LogViewerRouteDeps): Hono {
  const router = new Hono();
  const { config } = deps;

  // D-10: 复用 adminAuthMiddleware，与所有 /admin/* 端点一致
  router.use('/admin/*', adminAuthMiddleware(config));

  // D-09/D-12: GET /admin/logs SSE 端点，连接时回放历史 + 订阅实时
  router.get('/admin/logs', (c) => {
    return streamSSE(c, async (stream) => {
      // No await between the snapshot and subscription: live logs cannot fall in a gap.
      const pending: (LogEntry | null)[] = getHistory();
      let stopped = false;
      let wake: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const signal = c.req.raw.signal;
      const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
      const unsubscribe = subscribe((entry) => {
        if (stopped || stream.closed || stream.aborted) return;
        pending.push(entry); // Never wait for network I/O inside the logger sink.
        notify();
      });
      const abort = () => stream.abort();
      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        if (heartbeat !== undefined) clearInterval(heartbeat);
        signal.removeEventListener('abort', abort);
        pending.length = 0;
        notify();
      };
      // Cleanup is registered before replay, including disconnect during a blocked write.
      stream.onAbort(cleanup);
      signal.addEventListener('abort', abort);
      try {
        if (signal.aborted || stream.aborted || stream.closed) { abort(); return; }
        heartbeat = setInterval(() => {
          if (stopped || stream.closed || stream.aborted) return;
          pending.push(null); // Heartbeats share the writer so data frames stay ordered.
          notify();
        }, 25_000);
        while (!stopped && !stream.closed && !stream.aborted) {
          if (pending.length === 0) {
            await new Promise<void>((resolve) => { wake = resolve; });
            continue;
          }
          const entry = pending.shift()!;
          if (entry === null) await stream.write(': ping\n\n');
          else await stream.writeSSE({ data: JSON.stringify(entry) });
        }
      } finally {
        cleanup();
      }
    });
  });

  return router;
}
