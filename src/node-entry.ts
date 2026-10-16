// Node.js 入口

import { serve } from '@hono/node-server';
import * as cron from 'node-cron';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as dns from 'dns';
import { createApp } from './routes';
import { runSync } from './syncer';
import { parseMaxDataSources } from './core/source-capacity';
import { logger } from './core/logger';
import {
  DEFAULT_SITE_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  CRON_INTERVAL,
  DEFAULT_SYNC_SCHEDULE,
  syncScheduleToCron,
  parseCronSchedule,
  scheduleLabel,
} from './core/config';
import { JsonFileStorage } from './storage/json-file';
import type { Storage } from './storage/interface';
import type { AppConfig, SyncSchedule } from './core/types';
import type { RuntimeState } from './routes/admin-auth';
import { getDirtyMarker, clearDirtyMarker } from './core/dirty-marker';
import { createSyncRunner, sourceActivity } from './core/source-activity';

// 加载 .env
dotenv.config();

// ─── 存储初始化 ────────────────────

function createStorage(): { storage: Storage; jsonPath: string } {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  const newJsonPath = path.join(dataDir, 'config.json');
  const oldJsonPath = path.join(dataDir, 'tvbox-data.json');
  if (!fs.existsSync(newJsonPath) && fs.existsSync(oldJsonPath)) {
    fs.renameSync(oldJsonPath, newJsonPath);
    logger.info('storage', 'Migrated tvbox-data.json to config.json');
  }
  return { storage: new JsonFileStorage(newJsonPath), jsonPath: newJsonPath };
}

// ─── 配置 ────────────────────────────────────────────────

async function buildConfig(port: number): Promise<AppConfig> {
  const docker = isDocker();
  let lanIp = getLocalIp();
  let dockerMissingBaseUrl = false;

  if (docker && !process.env.BASE_URL) {
    try {
      const result = await dns.promises.lookup('host.docker.internal');
      lanIp = result.address;
    } catch {
      // host.docker.internal 不可用（Linux Docker 非 Desktop），保留容器 IP 但标记警告
      dockerMissingBaseUrl = true;
    }
  }

  const baseUrl = process.env.BASE_URL || `http://${lanIp || 'localhost'}:${port}`;
  return {
    maxDataSources: parseMaxDataSources(process.env.MAX_DATA_SOURCES),
    adminToken: process.env.ADMIN_TOKEN,
    refreshToken: process.env.REFRESH_TOKEN,
    siteTimeoutMs: parseInt(process.env.SITE_TIMEOUT_MS || '') || DEFAULT_SITE_TIMEOUT_MS,
    fetchTimeoutMs: parseInt(process.env.FETCH_TIMEOUT_MS || '') || DEFAULT_FETCH_TIMEOUT_MS,
    cronSchedule: process.env.CRON_SCHEDULE || undefined,
    localBaseUrl: baseUrl.replace(/\/$/, ''),
    dockerMissingBaseUrl,
    // 自动抓取（环境变量驱动）
    scrapeSourceUrl: process.env.SCRAPE_SOURCE_URL,
    scrapeSourceReferer: process.env.SCRAPE_SOURCE_REFERER,
    maccmsApiUrl: process.env.MACCMS_API_URL,
    maccmsAesKey: process.env.MACCMS_AES_KEY,
    maccmsAesIv: process.env.MACCMS_AES_IV,
  };
}

// ─── 启动 ────────────────────────────────────────────────

async function main() {
  const { storage, jsonPath } = createStorage();
  const port = parseInt(process.env.PORT || '') || 5678;
  const config = await buildConfig(port);

  if (process.env.DMZ === '0') {
    logger.securityFields('Starting up with DMZ=0! BE SAFE!', {});
  }

  const activity = sourceActivity(storage);
  let patchLock = false;

  const runtime: RuntimeState = {
    getPatchLock: () => patchLock,
    setPatchLock: (locked: boolean) => { patchLock = locked; },
    isSyncing: () => activity.kind === 'sync',
  };

  const runWithGuard = createSyncRunner(activity, async () => {
    const dirty = await getDirtyMarker(storage);
    if (dirty) {
      logger.info('sync', 'clearing dirty marker before aggregation');
      await clearDirtyMarker(storage);
    }
    return runSync(storage, config);
  });

  // 动态 cron 管理
  let currentTask: cron.ScheduledTask | null = null;
  let currentSchedule = '';

  function scheduleCron(schedule: SyncSchedule, silent?: boolean) {
    if (currentTask) {
      currentTask.stop();
    }
    const cronExpr = syncScheduleToCron(schedule);
    if (!cronExpr) {
      currentSchedule = '';
      currentSyncSchedule = schedule;
      if (!silent) logger.info('cron', '自动同步时间设定为：禁用');
      return;
    }
    currentSchedule = cronExpr;
    currentSyncSchedule = schedule;
    currentTask = cron.schedule(cronExpr, () => {
      logger.info('cron', `Triggered at ${new Date().toISOString()}`);
      runWithGuard({ source: 'cron' });
    });
    if (!silent) logger.info('cron', `自动同步时间设定为：${scheduleLabel(schedule)} (${cronExpr})`);
  }

  // 读取 KV 中的同步频率配置
  const storedRaw = await storage.get(CRON_INTERVAL);
  let currentSyncSchedule: SyncSchedule = { ...DEFAULT_SYNC_SCHEDULE };
  const envSchedule = config.cronSchedule ? parseCronSchedule(config.cronSchedule) : null;

  // 环境变量始终优先；仅当未设置或无效时回退到 KV/网页配置
  if (envSchedule) {
    currentSyncSchedule = envSchedule;
  } else if (storedRaw) {
    try {
      const parsed = JSON.parse(storedRaw);
      if (parsed && typeof parsed === 'object' && parsed.period) {
        currentSyncSchedule = parsed as SyncSchedule;
      }
    } catch {
      // 旧格式（纯数字），视为未配置
    }
  }

  // CRON_SCHEDULE 有值但无法解析为 SyncSchedule 时发出警告
  if (config.cronSchedule && !envSchedule) {
    logger.warn('cron', `CRON_SCHEDULE="${config.cronSchedule}" 无法识别，有效格式如 "0 5 * * *"，已禁用`);
  }

  // 应用初始调度（静默，避免与上方警告重复）
  scheduleCron(currentSyncSchedule, true);

  const app = createApp({
    storage,
    config,
    runtime,
    triggerRefresh: runWithGuard,
    onCronScheduleChange: (schedule: SyncSchedule) => {
      scheduleCron(schedule);
    },
    cronEnvSchedule: envSchedule,
  });

  let displayHost = 'localhost';
  try {
    const u = new URL(config.localBaseUrl || '');
    displayHost = u.hostname;
  } catch { /* keep localhost */ }

  serve({ fetch: app.fetch, port }, (info) => {
    // 启动横幅保留 console.log：一次性运维信息，转 logger 会破坏 ASCII 多行缩进美观（D-09/D-12）
    console.log('  TVBox Auxiliary');
    if (displayHost !== 'localhost') {
      console.log(`  管理面板：http://${displayHost}:${info.port}/status`);
    }
    const cronSource = envSchedule ? '环境变量' : '网页配置';
    console.log(`  自动聚合时间为：${currentSchedule || 'disabled'} (${scheduleLabel(currentSyncSchedule)}) [${cronSource}]`);
    if (config.dockerMissingBaseUrl) {
      console.log('');
      console.log('  ⚠️  Docker 运行时，但未检测到 BASE_URL 设定');
      console.log(`     自动检测的地址为： ${displayHost}`);
      console.log('     请在 .env 或 docker-compose.yml 中设置：BASE_URL=http://宿主机IP:端口');
      console.log('     或者尝试前往网页设置中开启智能生成静态资源地址');
    }
    console.log('');
    logger.info('storage', `JSON file storage: ${jsonPath}`);
  });
}

function getLocalIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function isDocker(): boolean {
  try {
    fs.accessSync('/.dockerenv');
    return true;
  } catch {
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      return /docker|containerd/.test(cgroup);
    } catch {
      return false;
    }
  }
}

main();
