// UI 页面路由

import { Hono } from 'hono';
import { adminHtml } from '../core/admin';
import { dashboardHtml } from '../core/dashboard';
import { configEditorHtml } from '../core/config-editor';
import type { AppConfig } from '../core/types';

export function createUiPagesRouter(deps: { config: AppConfig }): Hono {
  const router = new Hono();

  router.get('/admin', (c) => {
    return c.html(adminHtml);
  });

  router.get('/status', (c) => {
    return c.html(dashboardHtml);
  });

  router.get('/admin/config-editor', (c) => {
    return c.html(configEditorHtml);
  });

  return router;
}
