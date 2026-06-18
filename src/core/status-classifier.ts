// 集中化的下载状态分类模块
// D-05: classifyStatus() 单一分类函数，依据 D-01/D-02/D-03 硬编码规则
// D-06: STATUS_LABELS 标签映射一并集中到此模块
// D-04: 分类规则硬编码，不支持 API 动态配置

import type { SourceFetchStatus } from './types';

// D-10: 三级分类级别
export type StatusLevel = 'OK' | 'WARN' | 'ERR';

/**
 * 根据原始 fetch 状态和连续失败次数计算 OK/WARN/ERR 分类级别
 *
 * 分类规则（per D-01/D-02/D-03, operator decision W3 调整 ok 优先级）：
 * 1. status === 'ok' → 'OK'  (D-01; ok 始终重置，优先级高于连续失败阈值)
 * 2. consecutiveFailures >= 3 → 'ERR'  (D-02; 非 ok 状态下阈值覆盖)
 * 3. status === 'timeout' → 'WARN'  (D-01)
 * 4. 其余所有错误细分（HTTP / 网络 / decode / parse / unknown）→ 'ERR'  (D-01, D-03)
 *
 * @param status 原始 fetch 状态细分
 * @param consecutiveFailures 连续失败次数（ok 后由 syncer 重置为 0）
 */
export function classifyStatus(
  status: SourceFetchStatus,
  consecutiveFailures: number,
): StatusLevel {
  // D-01 + W3: ok 优先级最高，无论连续失败次数多少都返回 OK
  if (status === 'ok') return 'OK';
  // D-02: 非 ok 状态下连续失败 ≥3 次升级为 ERR
  if (consecutiveFailures >= 3) return 'ERR';
  // D-01: timeout 低于阈值时为 WARN
  if (status === 'timeout') return 'WARN';
  // D-01/D-03: 所有 HTTP / 网络 / decode / parse 错误细分及未知值均为 ERR
  return 'ERR';
}

// D-06: STATUS_LABELS 标签映射，覆盖所有 SourceFetchStatus 变体
// 包含 2 个 legacy 条目（http_error / network_error），随 Plan 02 一并移除
// 表达式级 satisfies 提供：(1) 编译期 exhaustive 键覆盖 (2) 值类型必须为 string 的校验
export const STATUS_LABELS = {
  ok: 'OK',
  timeout: 'TIMEOUT',
  decode_error: 'DECODE ERR',
  parse_error: 'PARSE ERR',
  // HTTP 错误细分
  http_403: 'HTTP ERR',
  http_404: 'HTTP ERR',
  http_429: 'HTTP ERR',
  http_502: 'HTTP ERR',
  http_503: 'HTTP ERR',
  http_504: 'HTTP ERR',
  http_4xx: 'HTTP ERR',
  http_5xx: 'HTTP ERR',
  // 网络错误细分
  dns_error: 'NET ERR',
  conn_refused: 'NET ERR',
  conn_reset: 'NET ERR',
  tls_error: 'NET ERR',
  host_unreachable: 'NET ERR',
  net_unreachable: 'NET ERR',
  fetch_failed: 'NET ERR',
  // legacy — removed in Plan 02 after fetcher.ts migration
  http_error: 'HTTP ERR',
  // legacy — removed in Plan 02 after fetcher.ts migration
  network_error: 'NET ERR',
} satisfies Record<SourceFetchStatus, string>;
