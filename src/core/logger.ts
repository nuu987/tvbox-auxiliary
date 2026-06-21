const VERBOSE_TRUE = new Set(['1', 'true', 'yes', 'on']);

export type LogFields = Record<string, unknown>;

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

// D-08: formatLine 私有函数统一拼接时间戳 + 条件 scope。
// D-05/D-06: VERBOSE=true 保留 [scope]，VERBOSE=false 移除 [scope]。
// D-07: security 不例外，走同一逻辑。
// 不缓存 isVerbose() 结果——每次调用都读 env，避免 vi.stubEnv 测试间污染。
function formatLine(scope: string, message: string): string {
  const ts = formatTimestamp();
  if (isVerbose()) return `${ts} [${scope}] ${message}`;
  return `${ts} ${message}`;
}

export const logger = {
  info(scope: string, message: string): void {
    console.log(formatLine(scope, message));
  },

  infoFields(scope: string, event: string, fields: LogFields): void {
    this.info(scope, `${event} ${formatFields(fields)}`.trim());
  },

  debug(scope: string, message: string): void {
    if (isVerbose()) console.log(formatLine(scope, message));
  },

  debugFields(scope: string, event: string, fields: LogFields): void {
    this.debug(scope, `${event} ${formatFields(fields)}`.trim());
  },

  warn(scope: string, message: string): void {
    console.warn(formatLine(scope, message));
  },

  warnFields(scope: string, event: string, fields: LogFields): void {
    this.warn(scope, `${event} ${formatFields(fields)}`.trim());
  },

  error(scope: string, message: string): void {
    console.error(formatLine(scope, message));
  },

  errorFields(scope: string, event: string, fields: LogFields): void {
    this.error(scope, `${event} ${formatFields(fields)}`.trim());
  },

  security(message: string): void {
    console.warn(formatLine('security', message));
  },

  securityFields(event: string, fields: LogFields): void {
    this.security(`${event} ${formatFields(fields)}`.trim());
  },
};
