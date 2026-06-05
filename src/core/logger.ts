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

export const logger = {
  info(scope: string, message: string): void {
    console.log(`[${scope}] ${message}`);
  },

  infoFields(scope: string, event: string, fields: LogFields): void {
    this.info(scope, `${event} ${formatFields(fields)}`.trim());
  },

  debug(scope: string, message: string): void {
    if (isVerbose()) console.log(`[${scope}] ${message}`);
  },

  debugFields(scope: string, event: string, fields: LogFields): void {
    this.debug(scope, `${event} ${formatFields(fields)}`.trim());
  },

  warn(scope: string, message: string): void {
    console.warn(`[${scope}] ${message}`);
  },

  warnFields(scope: string, event: string, fields: LogFields): void {
    this.warn(scope, `${event} ${formatFields(fields)}`.trim());
  },

  error(scope: string, message: string): void {
    console.error(`[${scope}] ${message}`);
  },

  errorFields(scope: string, event: string, fields: LogFields): void {
    this.error(scope, `${event} ${formatFields(fields)}`.trim());
  },

  security(message: string): void {
    console.warn(`[security] ${message}`);
  },

  securityFields(event: string, fields: LogFields): void {
    this.security(`${event} ${formatFields(fields)}`.trim());
  },
};
