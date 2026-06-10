// 网盘凭证管理 + 扫码/密码登录 + token.json

import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, CloudPlatform, CloudCredential, TVBoxConfig } from '../core/types';
import { generateQR, pollQRStatus, passwordLogin, PLATFORM_NAMES, QR_PLATFORMS, PASSWORD_PLATFORMS } from '../core/cloud-login';
import { loadCredentials, saveCredential, deleteCredential, loadCredentialPolicy, saveCredentialPolicy } from '../core/credential-store';
import { assessAllSources } from '../core/credential-risk';
import { generateTokenJson } from '../core/credential-injector';
import { MERGED_CONFIG_FULL } from '../core/config';
import { applyBaseUrlPlaceholder } from '../core/base-url';

export interface CloudCredRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function createCloudCredRouter(deps: CloudCredRouteDeps): Hono {
  const router = new Hono();
  const { storage, config } = deps;

  // 查看所有已登录平台状态
  router.get('/admin/cloud-credentials', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const creds = await loadCredentials(storage);
    const result: Record<string, any> = {};
    for (const [platform, cred] of creds) {
      result[platform] = {
        platform: cred.platform,
        status: cred.status,
        obtainedAt: cred.obtainedAt,
        expiresAt: cred.expiresAt,
        hasCredential: Object.keys(cred.credential).length > 0,
      };
    }
    return c.json({ platforms: PLATFORM_NAMES, credentials: result });
  });

  // 注销指定平台
  router.delete('/admin/cloud-credentials/:platform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PLATFORM_NAMES[platform]) return c.json({ error: 'Unknown platform' }, 400);
    await deleteCredential(storage, platform);
    return c.json({ success: true });
  });

  // 手动粘贴凭证
  router.post('/admin/cloud-credentials/:platform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PLATFORM_NAMES[platform]) return c.json({ error: 'Unknown platform' }, 400);

    let body: { credential?: Record<string, string> };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.credential || typeof body.credential !== 'object') {
      return c.json({ error: 'credential object is required' }, 400);
    }

    const cred: CloudCredential = {
      platform,
      credential: body.credential,
      obtainedAt: new Date().toISOString(),
      status: 'valid',
    };
    await saveCredential(storage, cred);
    return c.json({ success: true });
  });

  // 生成二维码
  router.post('/admin/cloud-login/:platform/qr', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!QR_PLATFORMS.includes(platform)) {
      return c.json({ error: `Platform ${platform} does not support QR login` }, 400);
    }

    try {
      const result = await generateQR(platform);
      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 502);
    }
  });

  // 轮询扫码状态
  router.get('/admin/cloud-login/:platform/poll', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    const token = c.req.query('token');
    if (!token) return c.json({ error: 'token is required' }, 400);

    try {
      const result = await pollQRStatus(platform, token);

      // 登录成功：自动保存凭证
      if (result.status === 'confirmed' && result.credential) {
        const cred: CloudCredential = {
          platform,
          credential: result.credential,
          obtainedAt: new Date().toISOString(),
          status: 'valid',
        };
        await saveCredential(storage, cred);
      }

      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg, status: 'error' }, 502);
    }
  });

  // 密码登录（迅雷/PikPak）
  router.post('/admin/cloud-login/:platform/password', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PASSWORD_PLATFORMS.includes(platform)) {
      return c.json({ error: `Platform ${platform} does not support password login` }, 400);
    }

    let body: { username?: string; password?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    try {
      const result = await passwordLogin(platform, body.username || '', body.password || '');
      if (result.success && result.credential) {
        const cred: CloudCredential = {
          platform,
          credential: result.credential,
          obtainedAt: new Date().toISOString(),
          status: 'valid',
        };
        await saveCredential(storage, cred);
      }
      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, message: msg }, 502);
    }
  });

  // 凭证注入策略
  router.get('/admin/credential-policy', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(await loadCredentialPolicy(storage));
  });

  router.put('/admin/credential-policy', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { allowedHighRiskKeys?: string[]; deniedKeys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const policy = await loadCredentialPolicy(storage);
    if (Array.isArray(body.allowedHighRiskKeys)) policy.allowedHighRiskKeys = body.allowedHighRiskKeys;
    if (Array.isArray(body.deniedKeys)) policy.deniedKeys = body.deniedKeys;
    await saveCredentialPolicy(storage, policy);
    return c.json({ success: true, ...policy });
  });

  // 风险分级报告
  router.get('/admin/credential-risk-report', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const configRaw = await storage.get(MERGED_CONFIG_FULL);
    if (!configRaw) return c.json({ error: 'No config available. Run sync first.' }, 404);

    const adminBase = (config.localBaseUrl || '').replace(/\/$/, '');
    const substituted = applyBaseUrlPlaceholder(configRaw, adminBase);
    const parsed: TVBoxConfig = JSON.parse(substituted);
    const sites = parsed.sites || [];
    const assessments = assessAllSources(sites);
    const policy = await loadCredentialPolicy(storage);

    const summary = { safe: 0, low: 0, high: 0, unaudited: 0 };
    for (const a of assessments) {
      summary[a.riskLevel]++;
    }

    return c.json({ summary, assessments, policy });
  });

  // 自托管 token.json（PUBLIC — 无需认证）
  router.get('/credential/token.json', async (c) => {
    const creds = await loadCredentials(storage);
    if (creds.size === 0) {
      return c.json({}, 200, { 'Access-Control-Allow-Origin': '*' });
    }
    const tokenJson = generateTokenJson(creds);
    return c.json(tokenJson, 200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
  });

  return router;
}

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${token}`;
}
