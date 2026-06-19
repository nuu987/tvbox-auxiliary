// 导出完整接口配置路由（含原始 URL 的快照下载，D-01..D-13）

import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth';
import type { RuntimeState } from './admin-auth';
import { EXPORT_CONFIG } from '../core/config';
import { logger } from '../core/logger';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';

export interface ExportConfigRouteDeps {
  storage: Storage;
  config: AppConfig;
  runtime: RuntimeState;
}

export function createExportConfigRouter(deps: ExportConfigRouteDeps): Hono {
  const router = new Hono();
  const { storage, config, runtime } = deps;

  router.use('/admin/*', adminAuthMiddleware(config));

  // ─── 导出完整接口配置（EXPORT_CONFIG 快照下载） ──────────
  router.get('/admin/export-config', async (c) => {
    // D-11/D-13: 同步进行中拒绝导出，避免读到半写状态
    if (runtime.isSyncing()) {
      return c.json({ error: '同步进行中，请稍后' }, 409);
    }

    // D-12: EXPORT_CONFIG KV 不存在 → 提示先同步
    const cached = await storage.get(EXPORT_CONFIG);
    if (!cached) {
      return c.json({ error: '请先同步' }, 503);
    }

    // D-09: 文件名时间戳使用本地时间（与 dashboard zh-CN 显示约定一致）
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `tvbox-config-${ts}.json`;

    logger.debugFields('export', 'download-ok', {
      filename,
      bytes: Buffer.byteLength(cached, 'utf8'),
    });

    // D-01: 快照已含原始 URL，不做 BASE_URL_PLACEHOLDER 替换
    // D-04/D-05: LIVE_DISABLED / pic 删除已在 sync/patch 时应用，路由不重复处理
    return c.body(cached, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
  });

  return router;
}
