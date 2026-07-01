// Phase 6 VIEWER-01/02: /admin/logs SSE 端点
// D-01: 用 Hono streamSSE 助手实现 SSE 长连接
// D-09: 端点路径 /admin/logs，模块 src/routes/log-viewer.ts，导出 createLogViewerRouter 工厂
// D-10: 复用 adminAuthMiddleware，Bearer Token 走 Authorization 头
// D-12: 连接打开时先 flush log-buffer.getHistory() 历史快照，再 subscribe 实时推送

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { adminAuthMiddleware } from './admin-auth';
import { getHistory, subscribe } from '../core/log-buffer';
import { logger } from '../core/logger';
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
      // D-12 Step 1: 先 flush 历史快照（按 getHistory 顺序，最旧→最新）
      for (const entry of getHistory()) {
        await stream.writeSSE({ data: JSON.stringify(entry) });
      }

      // D-12 Step 2: 订阅实时新日志——fire-and-forget（不 await writeSSE，防阻塞 logger 调用方，Anti-pattern 5）
      // Pitfall 5: 可选 if (stream.closed) return 提前退出避免无谓 JSON.stringify
      const unsubscribe = subscribe((entry) => {
        if (stream.closed) return;
        stream.writeSSE({ data: JSON.stringify(entry) }).catch(() => {});
      });

      // D-15: keep-alive 心跳——25s 间隔 : ping 注释帧，防中间代理断连
      const heartbeat = setInterval(() => {
        if (stream.closed) return;
        stream.write(': ping\n\n').catch(() => {});
      }, 25_000);

      try {
        // Step 4: 阻塞直到连接关闭（onAbort 或 stream.close）
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        // Step 5: 清理——确保订阅释放，防连接泄漏（T-06-conn-leak）
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  return router;
}
