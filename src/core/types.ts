// TVBox JSON 配置完整类型定义

export interface TVBoxSite {
  key: string;
  name?: string;
  type: number; // 0=XML, 1=JSON, 3=JAR, 4=Remote
  api: string;
  searchable?: number; // 0|1
  quickSearch?: number; // 0|1
  filterable?: number; // 0|1
  playUrl?: string;
  playerType?: number; // -1|0|1|2|10
  jar?: string; // per-site JAR override
  ext?: string | Record<string, unknown>;
  categories?: string[];
  click?: string;
  style?: string;
}

export interface TVBoxParse {
  name: string;
  url: string;
  type?: number; // 0=sniffer, 1=JSON, 2=JSON extended, 3=synced, 4=super
  ext?: string | Record<string, unknown>;
}

export interface TVBoxLiveChannel {
  name: string;
  urls: string[];
}

export interface TVBoxLiveGroup {
  group: string;
  channels: TVBoxLiveChannel[];
}

export interface TVBoxLive {
  name?: string;
  type?: number; // 0=M3U/TXT, 3=JAR/Python
  url?: string;
  api?: string;
  jar?: string;
  epg?: string;
  ua?: string;
  header?: Record<string, string>;
  playerType?: number;
  ext?: string | Record<string, unknown>;
  // Native 格式（live-merger 产物）— 与 FongMi 共用同一数组元素类型
  group?: string;
  channels?: TVBoxLiveChannel[];
}

export interface TVBoxRule {
  host?: string;
  hosts?: string[];
  rule?: string[];
  filter?: string[];
  regex?: string[];
  script?: string[];
}

export interface TVBoxDoh {
  name: string;
  url: string;
}

export interface TVBoxConfig {
  spider?: string;
  jarCache?: boolean | string;
  wallpaper?: string;
  pic?: string; // 图片代理前缀，TVBox 客户端加载图片时自动拼接
  sites?: TVBoxSite[];
  parses?: TVBoxParse[];
  // lives 兼容两种 TVBox 格式（同一数组类型，字段可选）：
  //   FongMi 格式（含 type/url）— 来自各源 config 的原始 lives
  //   Native 格式（含 group/channels）— live-merger 合并后产物
  lives?: TVBoxLive[];
  hosts?: string[];
  rules?: TVBoxRule[];
  doh?: TVBoxDoh[];
  ads?: string[];
  flags?: string[];
}

// MacCMS 源条目
export interface MacCMSSourceEntry {
  key: string;    // TVBox site key，如 "hongniuzy"
  name: string;   // 显示名，如 "红牛资源站"
  api: string;    // 原始 API，如 "https://www.hongniuzy2.com/api.php/provide/vod/from/hnm3u8/at/json/"
}

// 直播源条目
export interface LiveSourceEntry {
  name: string;
  url: string;
}

// 源条目
export interface SourceEntry {
  name: string;
  url: string;
  configKey?: string; // AES ECB 解密密钥（来自 URL 的 ;pk; 后缀）
}

// 内部处理用：带来源标记的配置
export interface SourcedConfig {
  sourceUrl: string;
  sourceName: string;
  config: TVBoxConfig;
  speedMs?: number; // 配置 URL 响应时间
}

// 名称定制配置
export interface NameTransformConfig {
  prefix?: string;
  suffix?: string;
}

// JSON 导入结果
export interface ImportResult {
  type: 'multi' | 'single';
  added: number;
  duplicates: number;
  sources: string[];
}

// JSON 解析验证错误类别
export type ParseErrorCategory = 'empty' | 'syntax' | 'structure';

// parseConfigJson 结构化验证结果
export interface ParseValidationResult {
  ok: boolean;
  config?: TVBoxConfig;
  errorCategory?: ParseErrorCategory;
  message?: string;
  preview?: string;
}

// 单次 fetch 结果（内部传递，不持久化）
export type SourceFetchStatus = 'ok' | 'http_error' | 'decode_error' | 'parse_error' | 'timeout' | 'network_error';

export interface SourceFetchResult {
  url: string;
  name: string;
  status: SourceFetchStatus;
  errorMessage?: string;
  speedMs?: number;
  validationError?: ParseValidationResult;
}

// 持久化的源健康记录
export interface SourceHealthRecord {
  url: string;
  name: string;
  latestStatus: SourceFetchStatus;
  consecutiveFailures: number;
  lastSuccessTime?: string;
  lastFailTime?: string;
  lastFailReason?: string;
  lastSpeedMs?: number;
}

// 同步频率周期类型
export type SyncPeriod = 'daily' | 'weekly' | 'disabled';

// 同步频率配置
export interface SyncSchedule {
  period: SyncPeriod;
  hour: number;       // 0-23
  minute: number;     // 0-59
  dayOfWeek?: number; // 0=Sunday, 1=Monday, ... 6=Saturday (weekly only)
}

// 平台无关的应用配置
export interface AppConfig {
  adminToken?: string;
  refreshToken?: string;
  speedTimeoutMs: number;
  siteTimeoutMs: number;
  fetchTimeoutMs: number;
  cronSchedule?: string;
  localBaseUrl?: string;   // Node.js 版设置，如 "http://192.168.1.100:5678"；用于 JAR 代理
  dockerMissingBaseUrl?: boolean;  // Docker 环境未配置 BASE_URL 时为 true
  // 自动抓取配置（环境变量驱动，未配置则不启用）
  scrapeSourceUrl?: string;
  scrapeSourceReferer?: string;
  maccmsApiUrl?: string;
  maccmsAesKey?: string;
  maccmsAesIv?: string;
}

// 边缘函数代理配置
export interface EdgeProxyConfig {
  fetchProxy?: string;
  vercel?: string;
}

// 网盘平台
export type CloudPlatform =
  | 'aliyun'      // 阿里云盘
  | 'bilibili'    // Bilibili
  | 'quark'       // 夸克网盘
  | 'uc'          // UC 网盘
  | 'pan115'      // 115 网盘
  | 'tianyi'      // 天翼云盘
  | 'baidu'       // 百度网盘
  | 'pan123'      // 123 网盘
  | 'thunder'     // 迅雷
  | 'pikpak';     // PikPak

// 单个平台的凭证
export interface CloudCredential {
  platform: CloudPlatform;
  credential: Record<string, string>;
  obtainedAt: string;   // ISO 时间
  expiresAt?: string;
  status: 'valid' | 'expired' | 'unknown';
}

// 凭证注入策略
export interface CredentialPolicyConfig {
  allowedHighRiskKeys: string[];  // 用户手动放行的高风险源 key
  deniedKeys: string[];           // 用户手动拉黑的源 key
}

// 搜索配额配置（持久化到 KV）
export interface SearchQuotaConfig {
  maxSearchable: number;        // 可搜索源上限，0 = 不限制
  pinnedKeys: string[];         // 置顶源 key 列表（排到 sites 最前面）
}

// 搜索配额报告
export interface SearchQuotaReport {
  totalSites: number;           // 站点总数
  jsExcluded: number;           // JS 源排除数
  searchable: number;           // 最终可搜索数
  pinnedCount: number;          // 置顶源命中数
  truncated: number;            // 被截断数（maxSearchable > 0 时）
}

// ═══ 聚合日志 ══════════════════════════════════════════

export interface AggLogFailedSource {
  url: string;
  name: string;
  status: SourceFetchStatus;
  errorMessage?: string;
}

export interface AggLogSiteChange {
  key: string;
  name?: string;
}

export interface SyncLog {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  totalSources: number;
  okSources: number;
  failedSources: AggLogFailedSource[];
  addedSites: AggLogSiteChange[];
  removedSites: AggLogSiteChange[];
  finalSiteCount: number;
  finalParseCount: number;
  finalLiveCount: number;
  blacklistRemovedSites: number;
  blacklistRemovedParses: number;
  blacklistRemovedLives: number;
}

// ═══ 直播频道级测速（方案 D+）══════════════════════════

// URL → 延迟 ms 的映射（持久化到 CHANNEL_SPEED_MAP）
export interface ChannelSpeedEntry {
  speedMs: number;          // TTFB 或连通耗时
  probedAt: string;         // ISO 时间
  kind: 'm3u8' | 'ts' | 'tcp' | 'fail';
}
export type ChannelSpeedMap = Record<string, ChannelSpeedEntry>;

// 频道测速任务状态
export type ChannelProbeState = 'idle' | 'running' | 'done' | 'error';

export interface ChannelProbeStatus {
  state: ChannelProbeState;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  totalUrls: number;
  probed: number;            // 当前已测完数
  success: number;           // 成功
  failed: number;            // 超时/失败
  totalChannels: number;     // 合并后频道数
  coverage: number;          // 覆盖率（success/totalUrls，百分比）
  error?: string;
}

// 正则屏蔽规则
export interface RegexRule {
  id: string;        // 自动生成的 UUID
  pattern: string;   // 正则模式
  createdAt: string; // ISO 时间
}

// 正则验证结果
export interface RegexValidationResult {
  valid: boolean;
  error?: string;  // 中文错误消息
}
