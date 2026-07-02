const VERBOSE_TRUE = new Set(['1', 'true', 'yes', 'on']);

export type LogFields = Record<string, unknown>;

// Phase 6 VIEWER-02: sink 钩子结构化日志条目。
// D-06: 每条缓冲条目存结构化对象 {ts, level, scope, message}，复用 formatTimestamp 产出。
export type LogLevel = 'info' | 'warn' | 'error' | 'security' | 'debug';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
}

// D-05: sink 订阅机制——logger 内部维护订阅者 Set，subscribeLogSink 返回取消订阅函数。
type LogSink = (entry: LogEntry) => void;
const sinks = new Set<LogSink>();

// 注册 sink 订阅者，返回取消订阅函数。log-buffer 模块加载时自动调用。
export function subscribeLogSink(fn: LogSink): () => void {
  sinks.add(fn);
  return () => { sinks.delete(fn); };
}

// 遍历订阅者，每个回调独立 try/catch 包裹（T-06-sink: 一个订阅者异常不阻塞 logger 调用方）。
// catch 块静默——不输出，防 sink→logger→sink 递归（Pitfall 1）。
function emitSink(entry: LogEntry): void {
  for (const fn of sinks) {
    try { fn(entry); } catch { /* 静默：防递归与阻塞 */ }
  }
}

export function isVerbose(): boolean {
  return VERBOSE_TRUE.has(String(process.env.VERBOSE || '').trim().toLowerCase());
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function maskSecret(value: unknown): string {
  const raw = String(value || '');
  if (!raw) return '(none)';
  if (raw.length <= 6) return `${raw[0] || '*'}***`;
  return `${raw.slice(0, 3)}...${raw.slice(-2)}(len=${raw.length})`;
}

export function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const raw = formatValue(value).replace(/\s+/g, ' ').trim();
      if (!raw) return `${key}=""`;
      if (/^[A-Za-z0-9_./:@?&=%+\-[\],]+$/.test(raw)) return `${key}=${raw}`;
      return `${key}=${JSON.stringify(raw)}`;
    })
    .join(' ');
}

// D-03: 手动拼接 YYYY-MM-DD HH:MM:SS 时间戳，避免 toLocaleString 的 locale 不确定性。
// D-02: 时区跟随 process.env.TZ（new Date() 本地时区），不显式硬编码 Asia/Shanghai。
function formatTimestamp(): string {
  const d = new Date();
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

// D-08: formatLineFromTs 私有函数统一拼接预计算时间戳 + level 标签 + 条件 scope。
// D-05/D-06: VERBOSE=true 保留 [scope]，VERBOSE=false 移除 [scope]。
// D-07: security 不例外，走同一逻辑。
// 接收预计算 ts（D-06：避免 sink 和 console 各算一次时间戳，保证同一 ts）。
// 不缓存 isVerbose() 结果——每次调用都读 env，避免 vi.stubEnv 测试间污染。
// 2026-07-02: 新增 level 参数，padEnd(8) 对齐网页日志格式（排除 ANSI 着色）。
function formatLineFromTs(ts: string, level: string, scope: string, message: string): string {
  const label = level.padEnd(8);
  if (isVerbose()) return `${ts} ${label} [${scope}] ${message}`;
  return `${ts} ${label} ${message}`;
}

export const logger = {
  info(scope: string, message: string): void {
    const ts = formatTimestamp();
    emitSink({ ts, level: 'info', scope, message });
    console.log(formatLineFromTs(ts, 'INFO', scope, message));
  },

  infoFields(scope: string, event: string, fields: LogFields): void {
    this.info(scope, `${event} ${formatFields(fields)}`.trim());
  },

  // D-13/Pitfall 6: 严格顺序——if (!isVerbose()) return 必须在 emitSink 之前，
  // VERBOSE=false 时直接 return，不构造 entry 不触发 sink（DEBUG gate）。
  debug(scope: string, message: string): void {
    if (!isVerbose()) return;
    const ts = formatTimestamp();
    emitSink({ ts, level: 'debug', scope, message });
    console.log(formatLineFromTs(ts, 'DEBUG', scope, message));
  },

  debugFields(scope: string, event: string, fields: LogFields): void {
    this.debug(scope, `${event} ${formatFields(fields)}`.trim());
  },

  warn(scope: string, message: string): void {
    const ts = formatTimestamp();
    emitSink({ ts, level: 'warn', scope, message });
    console.warn(formatLineFromTs(ts, 'WARN', scope, message));
  },

  warnFields(scope: string, event: string, fields: LogFields): void {
    this.warn(scope, `${event} ${formatFields(fields)}`.trim());
  },

  error(scope: string, message: string): void {
    const ts = formatTimestamp();
    emitSink({ ts, level: 'error', scope, message });
    console.error(formatLineFromTs(ts, 'ERROR', scope, message));
  },

  errorFields(scope: string, event: string, fields: LogFields): void {
    this.error(scope, `${event} ${formatFields(fields)}`.trim());
  },

  // D-07: security 走同一 scope 逻辑（scope='security'），不例外。
  security(message: string): void {
    const ts = formatTimestamp();
    emitSink({ ts, level: 'security', scope: 'security', message });
    console.warn(formatLineFromTs(ts, 'SECURITY', 'security', message));
  },

  securityFields(event: string, fields: LogFields): void {
    this.security(`${event} ${formatFields(fields)}`.trim());
  },
};
