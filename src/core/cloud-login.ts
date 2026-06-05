// 网盘扫码登录 / 密码登录

import type { CloudPlatform } from './types';
import { createHash } from 'crypto';

export type QRStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

export interface QRResult {
  qrUrl: string;    // 需要编码为二维码的内容（URL 或 token）
  token: string;    // 轮询用的会话 token
}

export interface PollResult {
  status: QRStatus;
  credential?: Record<string, string>;
  message?: string;
}

export interface PasswordLoginResult {
  success: boolean;
  credential?: Record<string, string>;
  message?: string;
}

interface PlatformLoginHandler {
  generateQR?: () => Promise<QRResult>;
  pollStatus?: (token: string) => Promise<PollResult>;
  passwordLogin?: (username: string, password: string) => Promise<PasswordLoginResult>;
}

// ─── Bilibili TV 端二维码 ────────────────────────────────

const BILI_APPKEY = '4409e2ce8ffd12b8';
const BILI_APPSEC = '59b43e04ad6965f34319062b478f83dd';

async function biliSign(params: Record<string, string>): Promise<string> {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const raw = sorted + BILI_APPSEC;
  const hash = md5(raw);
  return sorted + '&sign=' + hash;
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

const bilibiliHandler: PlatformLoginHandler = {
  async generateQR() {
    const ts = Math.floor(Date.now() / 1000).toString();
    const params: Record<string, string> = { appkey: BILI_APPKEY, local_id: '0', ts };
    const body = await biliSign(params);

    const resp = await fetch('https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await resp.json() as any;

    if (data.code !== 0) throw new Error(data.message || 'Bilibili QR generate failed');

    return {
      qrUrl: data.data.url,
      token: data.data.auth_code,
    };
  },

  async pollStatus(token: string) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const params: Record<string, string> = { appkey: BILI_APPKEY, auth_code: token, local_id: '0', ts };
    const body = await biliSign(params);

    const resp = await fetch('https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await resp.json() as any;

    if (data.code === 0) {
      // 登录成功，提取 cookie
      const cookies = data.data?.cookie_info?.cookies || [];
      const cookieParts: string[] = [];
      for (const c of cookies) {
        cookieParts.push(`${c.name}=${c.value}`);
      }
      return {
        status: 'confirmed' as QRStatus,
        credential: { cookie: cookieParts.join('; ') },
      };
    }

    if (data.code === 86090) return { status: 'scanned' as QRStatus };
    if (data.code === 86038) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 阿里云盘（Web QR 登录）─────────────────────────────

const aliyunHandler: PlatformLoginHandler = {
  async generateQR() {
    const resp = await fetch('https://passport.aliyundrive.com/newlogin/qrcode/generate.do?appName=aliyun_drive&fromSite=52&appEntrance=web&_bx-v=2.5.6', {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;
    const content = data?.content?.data;

    if (!content?.codeContent) throw new Error('Aliyun QR generate failed');

    return {
      qrUrl: content.codeContent,
      token: JSON.stringify({ t: content.t, ck: content.ck || '' }),
    };
  },

  async pollStatus(token: string) {
    const { t, ck } = JSON.parse(token);
    const body = new URLSearchParams({
      t: String(t),
      ck: ck || '',
      appName: 'aliyun_drive',
      appEntrance: 'web',
      fromSite: '52',
      '_bx-v': '2.5.6',
    });

    const resp = await fetch('https://passport.aliyundrive.com/newlogin/qrcode/query.do', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await resp.json() as any;
    const content = data?.content?.data;

    if (!content) return { status: 'error' as QRStatus, message: 'Invalid response' };

    const qrStatus = content.qrCodeStatus;
    if (qrStatus === 'CONFIRMED') {
      // bizExt 是 base64 编码的 JSON
      try {
        const bizJson = JSON.parse(atob(content.bizExt));
        const loginResult = bizJson.pds_login_result;
        return {
          status: 'confirmed' as QRStatus,
          credential: {
            refresh_token: loginResult?.refreshToken || '',
            access_token: loginResult?.accessToken || '',
          },
        };
      } catch {
        return { status: 'error' as QRStatus, message: 'Failed to parse login result' };
      }
    }

    if (qrStatus === 'SCANED') return { status: 'scanned' as QRStatus };
    if (qrStatus === 'EXPIRED') return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 夸克网盘 ────────────────────────────────────────────

const quarkHandler: PlatformLoginHandler = {
  async generateQR() {
    const requestId = crypto.randomUUID();
    const resp = await fetch(`https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=${requestId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;

    if (data.status !== 200 || !data.data?.members?.token) {
      throw new Error(data.message || 'Quark QR generate failed');
    }

    const token = data.data.members.token;
    return {
      qrUrl: `https://su.quark.cn/4_eMHBJ?token=${token}&client_id=532&ssb=weblogin`,
      token,
    };
  },

  async pollStatus(token: string) {
    const resp = await fetch(`https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&token=${token}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;

    const status = data.data?.members?.status;
    if (status === 'CONFIRMED') {
      const serviceTicket = data.data?.members?.service_ticket;
      if (!serviceTicket) return { status: 'error' as QRStatus, message: 'No service ticket' };

      // 用 service ticket 换 cookie
      try {
        const loginResp = await fetch(`https://pan.quark.cn/account/info?st=${serviceTicket}&lw=scan`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          redirect: 'manual',
        });
        const setCookies = (loginResp.headers as any).getSetCookie?.() || [];
        const cookieParts: string[] = [];
        for (const sc of setCookies) {
          const part = sc.split(';')[0];
          if (part) cookieParts.push(part);
        }
        if (cookieParts.length > 0) {
          return { status: 'confirmed' as QRStatus, credential: { cookie: cookieParts.join('; ') } };
        }
        // 如果拿不到 set-cookie，尝试从响应中提取
        return { status: 'confirmed' as QRStatus, credential: { cookie: `__st=${serviceTicket}` } };
      } catch (err) {
        return { status: 'error' as QRStatus, message: `Cookie exchange failed: ${err}` };
      }
    }

    if (status === 'SCANED') return { status: 'scanned' as QRStatus };
    if (status === 'EXPIRED') return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── UC 网盘（与夸克类似，同属 UCWeb）────────────────────

const ucHandler: PlatformLoginHandler = {
  async generateQR() {
    const requestId = crypto.randomUUID();
    const resp = await fetch(`https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin?client_id=381&v=1.2&request_id=${requestId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;

    if (data.status !== 200 || !data.data?.members?.token) {
      throw new Error(data.message || 'UC QR generate failed');
    }

    const token = data.data.members.token;
    return {
      qrUrl: `https://su.quark.cn/4_eMHBJ?token=${token}&client_id=381&ssb=weblogin`,
      token,
    };
  },

  async pollStatus(token: string) {
    const resp = await fetch(`https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=381&token=${token}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;

    const status = data.data?.members?.status;
    if (status === 'CONFIRMED') {
      const serviceTicket = data.data?.members?.service_ticket;
      if (!serviceTicket) return { status: 'error' as QRStatus, message: 'No service ticket' };

      try {
        const loginResp = await fetch(`https://drive.uc.cn/account/info?st=${serviceTicket}&lw=scan`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          redirect: 'manual',
        });
        const setCookies = (loginResp.headers as any).getSetCookie?.() || [];
        const cookieParts: string[] = [];
        for (const sc of setCookies) {
          const part = sc.split(';')[0];
          if (part) cookieParts.push(part);
        }
        if (cookieParts.length > 0) {
          return { status: 'confirmed' as QRStatus, credential: { cookie: cookieParts.join('; ') } };
        }
        return { status: 'confirmed' as QRStatus, credential: { cookie: `__st=${serviceTicket}` } };
      } catch (err) {
        return { status: 'error' as QRStatus, message: `Cookie exchange failed: ${err}` };
      }
    }

    if (status === 'SCANED') return { status: 'scanned' as QRStatus };
    if (status === 'EXPIRED') return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 115 网盘 ────────────────────────────────────────────

const pan115Handler: PlatformLoginHandler = {
  async generateQR() {
    const resp = await fetch('https://qrcodeapi.115.com/api/1.0/web/1.0/token/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;

    if (!data?.data?.uid) throw new Error('115 QR generate failed');

    return {
      qrUrl: `https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode?uid=${data.data.uid}`,
      token: JSON.stringify({ uid: data.data.uid, time: data.data.time, sign: data.data.sign }),
    };
  },

  async pollStatus(token: string) {
    const { uid, time, sign } = JSON.parse(token);
    const resp = await fetch(`https://qrcodeapi.115.com/get/status/?uid=${uid}&time=${time}&sign=${sign}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;

    if (data?.data?.status === 2) {
      // 已确认，用 uid 换取 cookie
      try {
        const loginResp = await fetch('https://passportapi.115.com/app/1.0/web/1.0/login/qrcode/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          body: `account=${uid}&app=web`,
        });
        const loginData = await loginResp.json() as any;
        const cookie = loginData?.data?.cookie;

        if (cookie) {
          // cookie 是一个对象 { CID, SEID, UID, ... }
          const parts = Object.entries(cookie).map(([k, v]) => `${k}=${v}`).join('; ');
          return { status: 'confirmed' as QRStatus, credential: { cookie: parts } };
        }

        return { status: 'error' as QRStatus, message: 'No cookie in login response' };
      } catch (err) {
        return { status: 'error' as QRStatus, message: `Login failed: ${err}` };
      }
    }

    if (data?.data?.status === 1) return { status: 'scanned' as QRStatus };
    if (data?.data?.status === -2) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 天翼云盘 ────────────────────────────────────────────

const tianyiHandler: PlatformLoginHandler = {
  async generateQR() {
    const resp = await fetch('https://open.e.189.cn/api/logbox/oauth2/getQrcImg.do', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://open.e.189.cn/',
      },
      body: 'appId=8025431004',
    });
    const data = await resp.json() as any;

    if (data?.result !== 0 || !data?.uuid) throw new Error(data?.msg || 'Tianyi QR generate failed');

    return {
      qrUrl: `https://open.e.189.cn/api/logbox/oauth2/qrImg.do?uuid=${data.uuid}`,
      token: data.uuid,
    };
  },

  async pollStatus(token: string) {
    const resp = await fetch('https://open.e.189.cn/api/logbox/oauth2/qrcodeLoginState.do', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://open.e.189.cn/',
      },
      body: `uuid=${token}&appId=8025431004`,
    });
    const data = await resp.json() as any;

    if (data?.result === 0 && data?.redirectUrl) {
      // 登录成功，从重定向 URL 获取 cookie
      try {
        const redirectResp = await fetch(data.redirectUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          redirect: 'manual',
        });
        const setCookies = (redirectResp.headers as any).getSetCookie?.() || [];
        const cookieParts: string[] = [];
        for (const sc of setCookies) {
          const part = sc.split(';')[0];
          if (part) cookieParts.push(part);
        }
        if (cookieParts.length > 0) {
          return { status: 'confirmed' as QRStatus, credential: { cookie: cookieParts.join('; ') } };
        }
      } catch {
        // fallback
      }
      return { status: 'confirmed' as QRStatus, credential: { cookie: '' } };
    }

    if (data?.result === 0 && data?.status === 1) return { status: 'scanned' as QRStatus };
    if (data?.result === -1 || data?.status === -1) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 百度网盘 ────────────────────────────────────────────

const baiduHandler: PlatformLoginHandler = {
  async generateQR() {
    const resp = await fetch('https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=' + generateGid(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;

    if (!data?.imgurl || !data?.sign) throw new Error('Baidu QR generate failed');

    return {
      qrUrl: `https://${data.imgurl}`,
      token: data.sign,
    };
  },

  async pollStatus(token: string) {
    const resp = await fetch(`https://passport.baidu.com/channel/unicast?channel_id=${token}&tpl=netdisk&gid=${generateGid()}&apiver=v3`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = await resp.json() as any;

    if (data?.errno === 0 && data?.channel_v) {
      try {
        const channelData = JSON.parse(data.channel_v);
        if (channelData.status === 0) {
          // 登录成功，需要用 v 值换取 cookie
          const loginResp = await fetch(`https://passport.baidu.com/v3/login/main/qrbdusslogin?bduss=${channelData.v}&loginVersion=v5`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            redirect: 'manual',
          });
          const setCookies = (loginResp.headers as any).getSetCookie?.() || [];
          const cookieParts: string[] = [];
          for (const sc of setCookies) {
            const part = sc.split(';')[0];
            if (part && (part.includes('BDUSS') || part.includes('STOKEN'))) {
              cookieParts.push(part);
            }
          }
          if (cookieParts.length > 0) {
            return { status: 'confirmed' as QRStatus, credential: { cookie: cookieParts.join('; ') } };
          }
          // fallback: 直接用 bduss
          return { status: 'confirmed' as QRStatus, credential: { cookie: `BDUSS=${channelData.v}` } };
        }
        if (channelData.status === 1) return { status: 'scanned' as QRStatus };
      } catch {
        // 非 JSON，可能是中间状态
      }
    }

    if (data?.errno === 1) return { status: 'waiting' as QRStatus }; // channel 无新消息
    if (data?.errno === -1) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

function generateGid(): string {
  return 'xxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16).toUpperCase();
  });
}

// ─── 123 网盘 ────────────────────────────────────────────

const pan123Handler: PlatformLoginHandler = {
  async generateQR() {
    const resp = await fetch('https://www.123pan.com/api/user/sign_in/qr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Platform': 'web',
      },
      body: JSON.stringify({}),
    });
    const data = await resp.json() as any;

    if (data?.code !== 0 || !data?.data?.qrCode) throw new Error(data?.message || '123 QR generate failed');

    return {
      qrUrl: data.data.qrCode,
      token: data.data.requestId || data.data.request_id || '',
    };
  },

  async pollStatus(token: string) {
    const resp = await fetch(`https://www.123pan.com/api/user/sign_in/qr/result?requestId=${token}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Platform': 'web',
      },
    });
    const data = await resp.json() as any;

    if (data?.code === 0 && data?.data?.token) {
      return {
        status: 'confirmed' as QRStatus,
        credential: { token: data.data.token },
      };
    }

    if (data?.data?.status === 1) return { status: 'scanned' as QRStatus };
    if (data?.code === 400 || data?.data?.expired) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 迅雷（账号密码）────────────────────────────────────

const thunderHandler: PlatformLoginHandler = {
  async passwordLogin(username: string, password: string) {
    // 迅雷使用账号密码登录，凭证直接保存
    // TVBox Spider 需要的是 username + password 明文
    if (!username || !password) {
      return { success: false, message: '请输入账号和密码' };
    }
    return {
      success: true,
      credential: { username, password },
    };
  },
};

// ─── PikPak（账号密码）──────────────────────────────────

const pikpakHandler: PlatformLoginHandler = {
  async passwordLogin(username: string, password: string) {
    if (!username || !password) {
      return { success: false, message: '请输入账号和密码' };
    }
    // 可选：验证登录有效性
    try {
      const resp = await fetch('https://user.mypikpak.com/v1/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'YNxT9w7GMdWvEOKa',
          username,
          password,
        }),
      });
      const data = await resp.json() as any;
      if (data?.access_token) {
        return {
          success: true,
          credential: { username, password },
        };
      }
      return { success: false, message: data?.error_description || '登录失败' };
    } catch (err) {
      // 验证失败不阻塞，仍然保存凭证（可能是网络问题）
      return {
        success: true,
        credential: { username, password },
      };
    }
  },
};

// ─── 统一接口 ────────────────────────────────────────────

const HANDLERS: Record<CloudPlatform, PlatformLoginHandler> = {
  bilibili: bilibiliHandler,
  aliyun: aliyunHandler,
  quark: quarkHandler,
  uc: ucHandler,
  pan115: pan115Handler,
  tianyi: tianyiHandler,
  baidu: baiduHandler,
  pan123: pan123Handler,
  thunder: thunderHandler,
  pikpak: pikpakHandler,
};

export const PASSWORD_PLATFORMS: CloudPlatform[] = ['thunder', 'pikpak'];
export const QR_PLATFORMS: CloudPlatform[] = ['bilibili', 'aliyun', 'quark', 'uc', 'pan115', 'tianyi', 'baidu', 'pan123'];

export const PLATFORM_NAMES: Record<CloudPlatform, string> = {
  aliyun: '阿里云盘',
  bilibili: 'Bilibili',
  quark: '夸克网盘',
  uc: 'UC 网盘',
  pan115: '115 网盘',
  tianyi: '天翼云盘',
  baidu: '百度网盘',
  pan123: '123 网盘',
  thunder: '迅雷',
  pikpak: 'PikPak',
};

export async function generateQR(platform: CloudPlatform): Promise<QRResult> {
  const handler = HANDLERS[platform];
  if (!handler?.generateQR) throw new Error(`Platform ${platform} does not support QR login`);
  return handler.generateQR();
}

export async function pollQRStatus(platform: CloudPlatform, token: string): Promise<PollResult> {
  const handler = HANDLERS[platform];
  if (!handler?.pollStatus) throw new Error(`Platform ${platform} does not support QR login`);
  return handler.pollStatus(token);
}

export async function passwordLogin(platform: CloudPlatform, username: string, password: string): Promise<PasswordLoginResult> {
  const handler = HANDLERS[platform];
  if (!handler?.passwordLogin) throw new Error(`Platform ${platform} does not support password login`);
  return handler.passwordLogin(username, password);
}
