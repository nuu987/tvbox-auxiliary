// 本地字体文件路由

import { Hono } from 'hono';

const FONTS: Record<string, { path: string; type: string }> = {
  'jetbrains-mono-latin-ext.woff2': { path: 'static/fonts/jetbrains-mono-latin-ext.woff2', type: 'font/woff2' },
  'jetbrains-mono-latin.woff2':     { path: 'static/fonts/jetbrains-mono-latin.woff2',     type: 'font/woff2' },
  'outfit-latin-ext.woff2':         { path: 'static/fonts/outfit-latin-ext.woff2',         type: 'font/woff2' },
  'outfit-latin.woff2':             { path: 'static/fonts/outfit-latin.woff2',             type: 'font/woff2' },
};

export function createStaticAssetsRouter(): Hono {
  const router = new Hono();

  router.get('/fonts/:name', async (c) => {
    const entry = FONTS[c.req.param('name')];
    if (!entry) return c.text('Not Found', 404);
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(__dirname, entry.path);
    try {
      const data = await fs.promises.readFile(filePath);
      return c.body(data, 200, {
        'Content-Type': entry.type,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } catch {
      return c.text('Not Found', 404);
    }
  });

  return router;
}
