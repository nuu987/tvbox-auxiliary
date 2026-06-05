// Cookie 注入引擎

import type { TVBoxSite, CloudPlatform, CloudCredential, CredentialPolicyConfig } from './types';
import { assessSourceRisk, type RiskLevel } from './credential-risk';

// ─── 注入规则 ────────────────────────────────────────────

export interface InjectionRule {
  apiPattern: string | RegExp;
  platforms: CloudPlatform[];
  inject: (ext: any, credentials: Map<CloudPlatform, CloudCredential>, baseUrl?: string) => any;
}

/**
 * 解析 ext：string → 尝试 JSON.parse → 返回 object
 * 保留原始格式标记以便注入后恢复
 */
function parseExt(ext: any): { obj: Record<string, any>; wasString: boolean; wasJson: boolean } {
  if (typeof ext !== 'string') {
    return { obj: ext || {}, wasString: false, wasJson: false };
  }

  // 尝试 JSON.parse
  try {
    const parsed = JSON.parse(ext);
    if (typeof parsed === 'object' && parsed !== null) {
      return { obj: parsed, wasString: true, wasJson: true };
    }
  } catch {
    // 不是 JSON
  }

  // 无法解析为 object，返回空对象（调用方应直接操作 string）
  return { obj: {}, wasString: true, wasJson: false };
}

/** 恢复 ext 原始格式 */
function restoreExt(obj: Record<string, any>, wasString: boolean, wasJson: boolean): any {
  if (!wasString) return obj;
  if (wasJson) return JSON.stringify(obj);
  return obj;
}

function getCredValue(creds: Map<CloudPlatform, CloudCredential>, platform: CloudPlatform, field: string): string {
  return creds.get(platform)?.credential[field] || '';
}

// ─── 内置注入规则表 ─────────────────────────────────────

const BUILTIN_RULES: InjectionRule[] = [
  // csp_Bili / csp_BiliR: ext.cookie = bilibili cookie
  {
    apiPattern: /^csp_Bili/,
    platforms: ['bilibili'],
    inject: (ext, creds) => {
      const { obj, wasString, wasJson } = parseExt(ext);
      obj.cookie = getCredValue(creds, 'bilibili', 'cookie');
      return restoreExt(obj, wasString, wasJson);
    },
  },

  // csp_Wobg / csp_Wogg (token.json 派): 替换 token.json URL
  {
    apiPattern: /^csp_Wo[bg]g$/,
    platforms: ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak'],
    inject: (ext, creds, baseUrl?: string) => {
      if (typeof ext !== 'string') return ext;
      if (!baseUrl) return ext;
      // $$$ 分隔格式：token.json_url$$$site_url$$$proxy$$$num$$$config
      // 替换第一段的 token.json URL
      return ext.replace(/https?:\/\/[^$\s]+token[_.]?json[^$\s]*/i, `${baseUrl}/credential/token.json`);
    },
  },

  // csp_Mogg: 多字段注入
  {
    apiPattern: 'csp_Mogg',
    platforms: ['quark', 'aliyun', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'],
    inject: (ext, creds) => {
      const { obj, wasString, wasJson } = parseExt(ext);
      if ('cookie' in obj) obj.cookie = getCredValue(creds, 'quark', 'cookie');
      if ('token' in obj) obj.token = getCredValue(creds, 'aliyun', 'refresh_token');
      if ('uccookie' in obj) obj.uccookie = getCredValue(creds, 'uc', 'cookie');
      if ('tyitoken' in obj) obj.tyitoken = getCredValue(creds, 'tianyi', 'cookie');
      if ('dutoken' in obj) obj.dutoken = getCredValue(creds, 'baidu', 'cookie');
      if ('p123token' in obj) obj.p123token = getCredValue(creds, 'pan123', 'token');
      if ('tuctoken' in obj) obj.tuctoken = getCredValue(creds, 'thunder', 'token');
      return restoreExt(obj, wasString, wasJson);
    },
  },

  // csp_Pan115: ext.cookie = 115 cookie
  {
    apiPattern: 'csp_Pan115',
    platforms: ['pan115'],
    inject: (ext, creds) => {
      const { obj, wasString, wasJson } = parseExt(ext);
      obj.cookie = getCredValue(creds, 'pan115', 'cookie');
      return restoreExt(obj, wasString, wasJson);
    },
  },
];

// ─── 规则匹配 ────────────────────────────────────────────

function matchRule(api: string, rule: InjectionRule): boolean {
  if (typeof rule.apiPattern === 'string') {
    return api === rule.apiPattern;
  }
  return rule.apiPattern.test(api);
}

export function findMatchingRule(site: TVBoxSite): InjectionRule | null {
  for (const rule of BUILTIN_RULES) {
    if (matchRule(site.api, rule)) return rule;
  }
  return null;
}

// ─── 注入引擎 ────────────────────────────────────────────

export interface InjectionReport {
  injected: number;
  skippedSafe: number;
  skippedDenied: number;
  skippedHighRisk: number;
  skippedUnaudited: number;
  skippedNoRule: number;
  skippedNoCredential: number;
}

/**
 * 对 merged.sites 执行凭证注入
 * 返回注入后的 sites 数组和注入报告
 */
export function injectCredentials(
  sites: TVBoxSite[],
  credentials: Map<CloudPlatform, CloudCredential>,
  policy: CredentialPolicyConfig,
  baseUrl?: string,
): { sites: TVBoxSite[]; report: InjectionReport } {
  const report: InjectionReport = {
    injected: 0,
    skippedSafe: 0,
    skippedDenied: 0,
    skippedHighRisk: 0,
    skippedUnaudited: 0,
    skippedNoRule: 0,
    skippedNoCredential: 0,
  };

  const deniedSet = new Set(policy.deniedKeys);
  const allowedSet = new Set(policy.allowedHighRiskKeys);

  const result = sites.map(site => {
    const risk = assessSourceRisk(site);

    // A类：源不需要凭证
    if (risk.neededPlatforms.length === 0) {
      report.skippedSafe++;
      return site;
    }

    // 用户手动拉黑
    if (deniedSet.has(site.key)) {
      report.skippedDenied++;
      return site;
    }

    // 高风险/未审计：需用户放行
    if (risk.riskLevel === 'high' || risk.riskLevel === 'unaudited') {
      if (!allowedSet.has(site.key)) {
        risk.riskLevel === 'high' ? report.skippedHighRisk++ : report.skippedUnaudited++;
        return site;
      }
    }

    // 查找匹配的注入规则
    const rule = findMatchingRule(site);
    if (!rule) {
      report.skippedNoRule++;
      return site;
    }

    // 检查是否有该源需要的凭证
    const hasAnyCredential = rule.platforms.some(p => credentials.has(p));
    if (!hasAnyCredential) {
      report.skippedNoCredential++;
      return site;
    }

    // 执行注入
    const newExt = rule.inject(site.ext, credentials, baseUrl);
    report.injected++;
    return { ...site, ext: newExt };
  });

  return { sites: result, report };
}

/**
 * 生成自托管 token.json 内容
 * 格式与公共 token.json 一致，只填充用户已登录的网盘凭证
 */
export function generateTokenJson(
  credentials: Map<CloudPlatform, CloudCredential>,
  neededPlatforms?: CloudPlatform[],
): Record<string, any> {
  const token: Record<string, any> = {};

  const platforms = neededPlatforms || [...credentials.keys()];

  for (const platform of platforms) {
    const cred = credentials.get(platform);
    if (!cred) continue;

    switch (platform) {
      case 'aliyun':
        if (cred.credential.refresh_token) token.refresh_token = cred.credential.refresh_token;
        if (cred.credential.open_token) token.open_token = cred.credential.open_token;
        break;
      case 'quark':
        if (cred.credential.cookie) token.quark_cookie = cred.credential.cookie;
        break;
      case 'uc':
        if (cred.credential.cookie) token.uc_cookie = cred.credential.cookie;
        break;
      case 'pan115':
        if (cred.credential.cookie) token['115_cookie'] = cred.credential.cookie;
        break;
      case 'thunder':
        if (cred.credential.username) {
          token.thunder_username = cred.credential.username;
          token.thunder_password = cred.credential.password;
        }
        break;
      case 'pikpak':
        if (cred.credential.username) {
          token.pikpak_username = cred.credential.username;
          token.pikpak_password = cred.credential.password;
        }
        break;
      case 'bilibili':
        if (cred.credential.cookie) token.bili_cookie = cred.credential.cookie;
        break;
      case 'tianyi':
        if (cred.credential.cookie) token.tianyi_cookie = cred.credential.cookie;
        break;
      case 'baidu':
        if (cred.credential.cookie) token.baidu_cookie = cred.credential.cookie;
        break;
      case 'pan123':
        if (cred.credential.token) token['123_token'] = cred.credential.token;
        break;
    }
  }

  return token;
}
