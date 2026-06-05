// Request-time base URL resolution + placeholder substitution

import type { Context } from 'hono';
import { BASE_URL_PLACEHOLDER } from './config';

/**
 * Derive the effective base URL for the current request.
 *
 * Priority: Host > fallback by default.
 * When useForwardedHeaders is true, X-Forwarded-Host is honored explicitly.
 * Protocol: X-Forwarded-Proto is honored only when useForwardedHeaders is true.
 * IPv6 brackets in Host are preserved verbatim.
 * Returns `${proto}://${host}` with no trailing slash, or trimmed fallback.
 */
export function getRequestBaseUrl(c: Context, fallback: string, useForwardedHeaders = false): string {
  let host: string | undefined;

  if (useForwardedHeaders) {
    const rawForwardedHost = c.req.header('X-Forwarded-Host');
    if (rawForwardedHost) {
      const forwardedHosts = rawForwardedHost
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean);
      host = forwardedHosts.at(-1);
    }
  }

  if (!host) {
    const rawHost = c.req.header('Host');
    if (rawHost) host = rawHost;
  }
  if (!host) {
    return fallback.replace(/\/$/, '');
  }
  const proto = useForwardedHeaders
    ? c.req.header('X-Forwarded-Proto')?.split(',')[0].trim() || 'http'
    : 'http';
  return `${proto}://${host}`;
}

/**
 * 将 JSON 字符串中的 BASE_URL_PLACEHOLDER 替换为 baseUrl（无尾斜杠）。
 * 当提供 fallback 且与 baseUrl 不同时，也替换旧版 literal localBaseUrl（兼容 Phase 17 前数据）。
 */
export function applyBaseUrlPlaceholder(jsonString: string, baseUrl: string, fallback?: string): string {
  let result = jsonString.replaceAll(BASE_URL_PLACEHOLDER, baseUrl);
  if (fallback && fallback !== baseUrl) {
    result = result.replaceAll(fallback, baseUrl);
  }
  return result;
}

// ─── Security intercept helpers (Phase 18) ───────────────

/**
 * Strip port from a host header value.
 * IPv6 bracket notation: `[::1]:5678` → `::1`
 * IPv4 / hostname: `192.168.1.5:5678` → `192.168.1.5`
 * No port / no brackets: returned as-is.
 */
export function stripHostPort(host: string): string {
  if (host.startsWith('[')) {
    const closeIdx = host.indexOf(']');
    if (closeIdx === -1) return host; // malformed, return as-is
    return host.substring(1, closeIdx);
  }
  const firstColonIdx = host.indexOf(':');
  if (firstColonIdx === -1) return host;
  if (host.indexOf(':', firstColonIdx + 1) !== -1) return host;
  const colonIdx = firstColonIdx;
  return host.substring(0, colonIdx);
}

/**
 * Determine whether a host (port already stripped) is a LAN / loopback address.
 * Whitelist mode: only explicitly listed ranges return true.
 *
 * Allowed:
 *   - localhost (case-insensitive)
 *   - IPv4: 127/8, 10/8, 172.16/12, 192.168/16
 *   - IPv6: ::1, fc00::/7 (ULA), fe80::/10 (link-local)
 *
 * Rejected (even though technically "local" in some contexts):
 *   - 0.0.0.0, 255.255.255.255, multicast 224/4
 *   - IPv4-mapped IPv6 (::ffff:x.x.x.x)
 *   - .local / .lan / .internal domains
 */
export function isLanHost(host: string): boolean {
  const lower = host.toLowerCase();

  // D-04: only 'localhost' domain allowed (case-insensitive)
  if (lower === 'localhost') return true;

  // IPv4 literal check
  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    const c = Number(ipv4Match[3]);
    const d = Number(ipv4Match[4]);
    // Reject if any octet > 255 (invalid literal)
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 127) return true;     // 127.0.0.0/8
    if (a === 10) return true;      // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    return false; // Whitelist: everything else (incl. 0.0.0.0, 255.255.255.255, multicast) rejected
  }

  // IPv6 checks (host already has brackets stripped by stripHostPort or URL.hostname)
  if (lower === '::1') return true;

  // D-02: IPv4-mapped must be rejected BEFORE ULA/link-local prefix checks
  if (lower.startsWith('::ffff:')) return false;

  // fc00::/7 ULA (first byte 0xfc or 0xfd)
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;

  // fe80::/10 link-local (second hex byte high 6 bits = 1111 1110 10xx → 8/9/a/b)
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;

  // Everything else (domains, other IPv6, etc.) → rejected
  return false;
}

/**
 * Combined security gate: should this request be allowed?
 *
 * Returns true when:
 *   - actualBase equals fallback (fallback passthrough, no smartJarUrl resolution occurred)
 *   - DMZ escape hatch is enabled (DMZ=0)
 *   - The resolved hostname is a LAN/loopback address
 *
 * Returns false when:
 *   - The resolved hostname is a non-LAN address (public IP, domain, etc.)
 *   - actualBase cannot be parsed as a URL
 *
 * This function is intentionally pure — no logging. The caller logs on rejection.
 */
export function assertHostAllowed(
  actualBase: string,
  fallback: string,
  _c: Context,
  dmzEnabled: boolean,
): boolean {
  // D-06: fallback passthrough — when actualBase equals fallback, no smartJarUrl
  // resolution occurred, so treat as local
  if (actualBase === fallback) return true;

  // D-09: DMZ escape hatch — explicitly allow all hosts
  if (dmzEnabled) return true;

  // Parse hostname from actualBase URL
  let hostname: string;
  try {
    hostname = new URL(actualBase).hostname;
  } catch {
    // Unparseable URL → reject
    return false;
  }

  return isLanHost(stripHostPort(hostname));
}
