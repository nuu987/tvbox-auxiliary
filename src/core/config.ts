import type { SyncSchedule } from './types';

// 默认阈值
export const DEFAULT_SPEED_TIMEOUT_MS = 5000; // 配置 URL 超时（fetch 耗时筛选）
export const DEFAULT_SITE_TIMEOUT_MS = 3000;  // 站点 API 超时
export const DEFAULT_FETCH_TIMEOUT_MS = 30000; // fetch 配置 JSON 超时（30s，部分源响应较慢）

// Storage keys
export const MERGED_CONFIG = 'merged_config';
export const MERGED_CONFIG_FULL = 'merged_config_full'; // 黑名单过滤前的完整配置（供配置编辑器使用）
export const SOURCE_URLS = 'source_urls';
export const LAST_UPDATE = 'last_update';
export const MANUAL_SOURCES = 'manual_sources';
export const MACCMS_SOURCES = 'maccms_sources';
export const LIVE_SOURCES = 'live_sources';
export const LIVE_SCRAPED = 'live_scraped';

// 直播源代理缓存 TTL（秒）
export const LIVE_PROXY_TTL = 7200; // 2 小时

// 图片代理缓存 TTL（秒）
export const IMG_PROXY_TTL = 604800; // 7 天

// 黑名单
export const BLACKLIST = 'blacklist';

// JSON 导入：内联配置前缀
export const INLINE_PREFIX = 'inline_config_';

// 名称定制配置
export const NAME_TRANSFORM = 'name_transform';

// 源健康状态
export const SOURCE_HEALTH = 'source_health';

// 站点测速开关（默认启用）
export const SPEED_TEST_ENABLED = 'speed_test_enabled';

// 智能 JAR 地址开关（默认关闭）— 启用时输出路由按请求 host 替换 BASE_URL_PLACEHOLDER
export const SMART_JAR_URL_ENABLED = 'smart_jar_url_enabled';

// 直播功能禁用开关（默认开启）— 禁用时跳过直播源合并、清空输出 lives、锁定直播源编辑 UI
export const LIVE_DISABLED = 'live_disabled';

// JAR/MacCMS/凭证 URL 占位符：聚合时写入，输出时替换为实际 host
export const BASE_URL_PLACEHOLDER = '__TVBOX_BASE_URL__';

// TVBox 客户端 UA（源服务器按此 UA 返回 JSON 而非 HTML）
export const TVBOX_UA = 'okhttp/3.12.0';
// 浏览器 UA 回退（部分源只接受浏览器 UA）
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.54 Safari/537.36';

// 定时任务间隔（分钟）— KV 键名保留，格式改为 SyncSchedule JSON
export const CRON_INTERVAL = 'cron_interval';
export const DEFAULT_SYNC_SCHEDULE: SyncSchedule = { period: 'disabled', hour: 5, minute: 0 };

/** 将 SyncSchedule 转为 cron 表达式 */
export function syncScheduleToCron(schedule: SyncSchedule): string {
  const { period, hour, minute } = schedule;
  switch (period) {
    case 'disabled': return '';
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekly': return `${minute} ${hour} * * ${schedule.dayOfWeek ?? 1}`;
    default: return '';
  }
}

/** 从 CRON_SCHEDULE 环境变量尽力解析为 SyncSchedule，无法解析返回 null */
export function parseCronSchedule(cronExpr: string): SyncSchedule | null {
  if (!cronExpr) return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minStr, hourStr, domStr, , dowStr] = parts;
  const minute = parseInt(minStr);
  const hour = parseInt(hourStr);

  // 每天: M H * * *
  if (domStr === '*' && dowStr === '*') {
    return { period: 'daily', hour, minute };
  }
  // 每周: M H * * DOW
  if (domStr === '*' && dowStr !== '*') {
    return { period: 'weekly', hour, minute, dayOfWeek: parseInt(dowStr) };
  }
  return null;
}

/** SyncSchedule 转可读标签 */
export function scheduleLabel(schedule: SyncSchedule): string {
  switch (schedule.period) {
    case 'disabled': return '禁用';
    case 'daily': return `每天 ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
    case 'weekly': {
      const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return `每${days[schedule.dayOfWeek ?? 1]} ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
    }
    default: return '未知';
  }
}

// 边缘函数代理
export const EDGE_PROXIES = 'edge_proxies';

// 网盘凭证
export const CLOUD_CREDENTIALS = 'cloud_credentials';
export const CREDENTIAL_POLICY = 'credential_policy';
export const CREDENTIAL_ENCRYPTION_KEY = 'credential_encryption_key';

// 搜索配额
export const SEARCH_QUOTA = 'search_quota';
export const SEARCH_QUOTA_REPORT = 'search_quota_report';

// ═══ 直播频道级测速（方案 D+）══════════════════════════
export const CHANNEL_SPEED_MAP = 'channel_speed_map';
export const CHANNEL_PROBE_ENABLED = 'channel_probe_enabled';
export const CHANNEL_PROBE_STATUS = 'channel_probe_status';
export const CHANNEL_MERGED_TREE = 'channel_merged_tree'; // 最近一次合并的频道树（供 probe 使用）

// 聚合日志
export const KV_AGG_LOGS = 'agg_logs';
export const AGG_LOGS_MAX = 50;
export const KV_SITE_SNAPSHOT = 'site_snapshot';

// 背景设置
export const KV_BG_SETTINGS = 'bg_settings';

// 分组排序
export const KV_GROUP_ORDER = 'group_order';

// 高级去重配置
export const KV_DEDUP_CONFIG = 'dedup_config';

// 频道测速 cron：每 12 小时
export const CHANNEL_PROBE_CRON = '0 */12 * * *';
// 并发与超时
export const CHANNEL_PROBE_CONCURRENCY = 50;
export const CHANNEL_PROBE_TIMEOUT_MS = 5000;
// 缓存过期（7 天）
export const CHANNEL_SPEED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 同步状态标志（成功/失败）
export const SYNC_STATUS = 'sync_status';
