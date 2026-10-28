// 导出完整接口配置路由（含原始 URL 的快照下载，D-01..D-13）

import { Hono } from 'hono';
import { readAggregateOutputs } from '../core/aggregate-output';
import { adminAuthMiddleware } from './admin-auth';
import type { RuntimeState } from './admin-auth';
import { logger } from '../core/logger';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import { projectLiveJson } from '../core/live-policy';
import { SITE_NAME_EMOJI_REMOVAL } from '../core/config';
import { removeEmojiFromSiteNames } from '../core/cleaner';

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
    const outputs = await readAggregateOutputs(storage);
    const cached = outputs?.exported;
    if (!outputs || !cached) {
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

    // Original resource URLs stay unchanged; manual lives reflect current declarations.
    const emojiRemovalEnabled = await storage.get(SITE_NAME_EMOJI_REMOVAL) === 'true';
    let body: string;
    try {
      body = projectLiveJson(
        cached,
        outputs.livePolicy,
        undefined,
        '',
        emojiRemovalEnabled ? removeEmojiFromSiteNames : undefined,
      );
    }
    catch { return c.json({ error: 'Config parse error' }, 500); }
    return c.body(body, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
  });

  return router;
}
