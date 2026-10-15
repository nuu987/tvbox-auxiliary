import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import { readLiveFile } from '../core/live-cache';

export function createLiveCacheRouter({ storage, config }: { storage: Storage; config: AppConfig }): Hono {
  const router = new Hono();
  router.get('/live/:filename', async c => {
    const match = /^([a-f0-9]{64})\.(m3u|txt)$/.exec(c.req.param('filename'));
    if (!match) return c.notFound();
    const [, key, requestedFormat] = match;
    const result = await readLiveFile(storage, key, config.fetchTimeoutMs);
    if (!result) return c.notFound();
    if (result.redirect) return new Response(null, { status: 302,
      headers: { Location: result.redirect, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
    const format = result.file?.endsWith('.m3u') ? 'm3u' : 'txt';
    if (requestedFormat !== format) {
      return new Response(null, { status: 302, headers: {
        Location: `./${key}.${format}`, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
    }
    const etag = `"${result.file}"`;
    const headers = { ETag: etag, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*',
      'Content-Type': format === 'm3u' ? 'application/x-mpegurl; charset=utf-8' : 'text/plain; charset=utf-8' };
    return new Response(c.req.header('If-None-Match') === etag ? null : result.data,
      { status: c.req.header('If-None-Match') === etag ? 304 : 200, headers });
  });
  return router;
}
