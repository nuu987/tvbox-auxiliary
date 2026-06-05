// 直播源频道级合并（方案 D+）
// 流程：下载各源 m3u/txt → 解析为频道条目 → 规范化频道名 → 按频道合并 urls → 排序 → 组装 TVBoxLiveGroup[]

import type {
  TVBoxLiveGroup,
  TVBoxLiveChannel,
  ChannelSpeedMap,
} from './types';
import { TVBOX_UA, BROWSER_UA } from './config';

// ─── 输入条目 ──────────────────────────────────────────

export interface LiveSourceInput {
  name: string;     // 源显示名
  url: string;      // m3u/txt 文件地址
  ua?: string;
  header?: Record<string, string>;
  speedMs?: number; // 源级速度（用于粗粒度排序）
}

// ─── 解析后的频道条目 ──────────────────────────────────

interface ChannelEntry {
  group: string;
  name: string;
  logo?: string;
  url: string;
  source: string;       // 源 name，用作 $ 后缀
  sourceSpeedMs?: number;
}

// ─── 频道名规范化 ──────────────────────────────────────

const TRAD_SIMP_MAP: Record<string, string> = {
  '電': '电', '視': '视', '臺': '台', '頻': '频', '道': '道',
  '綜': '综', '藝': '艺', '體': '体', '育': '育', '劇': '剧',
  '經': '经', '華': '华', '東': '东', '西': '西', '國': '国',
  '際': '际', '亞': '亚', '歐': '欧', '財': '财', '鳳': '凤',
};

const SUFFIX_PATTERNS = [
  /\s*\[?hd\]?$/i,
  /\s*\[?uhd\]?$/i,
  /\s*\[?fhd\]?$/i,
  /\s*高清$/,
  /\s*超清$/,
  /\s*蓝光$/,
  /\s*藍光$/,
  /\s*4k$/i,
  /\s*1080p?$/i,
  /\s*720p?$/i,
];

function normalizeChannelName(raw: string): string {
  let s = raw.trim();
  // 繁→简
  let out = '';
  for (const ch of s) out += TRAD_SIMP_MAP[ch] || ch;
  s = out;
  // 去后缀
  for (const p of SUFFIX_PATTERNS) s = s.replace(p, '');
  // 压空白
  s = s.replace(/\s+/g, '').trim();
  return s || raw.trim(); // 规范化空则退回原名
}

// ─── m3u/txt 解析 ──────────────────────────────────────

/**
 * 解析 m3u 格式
 *   #EXTM3U
 *   #EXTINF:-1 tvg-name="..." tvg-logo="..." group-title="央视",CCTV-1
 *   http://...
 */
function parseM3U(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  const lines = content.split(/\r?\n/);
  const out: ChannelEntry[] = [];
  let currentName = '';
  let currentGroup = '其他';
  let currentLogo: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      // 解析属性
      const grpM = line.match(/group-title="([^"]+)"/i);
      currentGroup = grpM ? grpM[1] : '其他';
      const logoM = line.match(/tvg-logo="([^"]+)"/i);
      currentLogo = logoM ? logoM[1] : undefined;
      const commaIdx = line.lastIndexOf(',');
      currentName = commaIdx > 0 ? line.slice(commaIdx + 1).trim() : '';
    } else if (line.startsWith('#')) {
      continue; // 其他指令忽略
    } else if (currentName && /^https?:\/\//i.test(line)) {
      out.push({
        group: currentGroup,
        name: currentName,
        logo: currentLogo,
        url: line,
        source,
        sourceSpeedMs,
      });
      currentName = '';
      currentLogo = undefined;
    }
  }
  return out;
}

/**
 * 解析 DIYP/txt 格式
 *   央视,#genre#
 *   CCTV-1,http://url1#http://url2
 *   CCTV-2,http://...
 */
function parseTxt(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  const lines = content.split(/\r?\n/);
  const out: ChannelEntry[] = [];
  let currentGroup = '其他';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf(',');
    if (idx <= 0) continue;
    const left = line.slice(0, idx).trim();
    const right = line.slice(idx + 1).trim();

    if (right === '#genre#') {
      currentGroup = left || '其他';
      continue;
    }

    // 右侧可能包含多个 URL，用 # 分隔
    const urls = right.split('#').filter((u) => /^https?:\/\//i.test(u.trim()));
    for (const u of urls) {
      out.push({
        group: currentGroup,
        name: left,
        url: u.trim(),
        source,
        sourceSpeedMs,
      });
    }
  }
  return out;
}

/** 自动识别 m3u 还是 txt */
function parseLiveContent(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  if (content.includes('#EXTM3U') || content.includes('#EXTINF')) {
    return parseM3U(content, source, sourceSpeedMs);
  }
  return parseTxt(content, source, sourceSpeedMs);
}

// ─── 下载 m3u/txt ──────────────────────────────────────

async function downloadLive(input: LiveSourceInput, timeoutMs: number): Promise<string | null> {
  const uas = [input.ua || TVBOX_UA, BROWSER_UA];
  for (const ua of uas) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(input.url, {
        signal: controller.signal,
        headers: { 'User-Agent': ua, ...(input.header || {}) },
      });
      clearTimeout(timer);
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.length > 20) return text;
      }
    } catch {
      clearTimeout(timer);
    }
  }
  return null;
}

// ─── 严格过滤：移除含 "type" 字段/字样的危险值 ────────

/**
 * TVBox 通过 `lives.contains("type")` 字符串匹配判断格式
 * 输出 Native 格式时，任何出现 `"type"` 字面量都会被误判为 FongMi 格式
 * 策略：对 group/name 中出现 "type" 字样做替换；URL 单独走 scrubUrlType
 */
function scrubTypeLiteral(s: string): string {
  return s.replace(/type/gi, 'tp');
}

/**
 * URL 中的 type 子串做 RFC 3986 URL-encode（首字符 t/T → %74/%54），
 * 保留原大小写以兼容 case-sensitive 的查询参数校验
 * 主流 HTTP 服务器会自动 URL-decode 还原为原串，功能不受影响
 * 用于 urls[] 元素，避免 TVBox lives.contains("type") 误判
 */
function scrubUrlType(url: string): string {
  return url.replace(/type/gi, (m) => {
    const hex = m.charCodeAt(0).toString(16).toUpperCase();
    return '%' + hex + m.slice(1);
  });
}

// ─── 主合并流程 ────────────────────────────────────────

export interface MergeLivesResult {
  groups: TVBoxLiveGroup[];
  totalChannels: number;
  totalUrls: number;
  sourcesDownloaded: number;
  sourcesFailed: number;
}

export async function mergeLivesToNative(
  sources: LiveSourceInput[],
  fetchTimeoutMs: number,
  channelSpeedMap?: ChannelSpeedMap,
): Promise<MergeLivesResult> {
  if (sources.length === 0) {
    return { groups: [], totalChannels: 0, totalUrls: 0, sourcesDownloaded: 0, sourcesFailed: 0 };
  }

  console.log(`[live-merger] Downloading ${sources.length} live source files...`);

  // 并发下载
  const downloadResults = await Promise.allSettled(
    sources.map((s) => downloadLive(s, fetchTimeoutMs).then((content) => ({ input: s, content }))),
  );

  let sourcesDownloaded = 0;
  let sourcesFailed = 0;
  const allEntries: ChannelEntry[] = [];

  for (const r of downloadResults) {
    if (r.status === 'fulfilled' && r.value.content) {
      sourcesDownloaded++;
      try {
        const entries = parseLiveContent(r.value.content, r.value.input.name, r.value.input.speedMs);
        allEntries.push(...entries);
      } catch (err) {
        console.warn(`[live-merger] Parse failed for ${r.value.input.name}: ${err}`);
      }
    } else {
      sourcesFailed++;
    }
  }

  console.log(
    `[live-merger] Downloaded ${sourcesDownloaded}/${sources.length} sources, ` +
    `parsed ${allEntries.length} channel entries`,
  );

  // 按频道名（规范化）+ group 合并 urls
  // key: normalizedName → { group, rawName, logo, urls: Map<url, ChannelEntry> }
  interface AggChannel {
    group: string;        // 使用第一次出现的 group 名
    rawName: string;      // 使用第一次出现的 raw name（最常用的）
    logo?: string;
    urls: Map<string, ChannelEntry>; // url → entry（含源名、速度）
  }
  const channelMap = new Map<string, AggChannel>();

  for (const e of allEntries) {
    const normName = normalizeChannelName(e.name);
    if (!normName) continue;

    let agg = channelMap.get(normName);
    if (!agg) {
      agg = {
        group: e.group || '其他',
        rawName: e.name,
        logo: e.logo,
        urls: new Map(),
      };
      channelMap.set(normName, agg);
    }
    if (!agg.urls.has(e.url)) {
      agg.urls.set(e.url, e);
    }
    if (!agg.logo && e.logo) agg.logo = e.logo;
  }

  // 按 group 组织
  const groupMap = new Map<string, TVBoxLiveChannel[]>();
  let totalUrls = 0;

  for (const [, agg] of channelMap) {
    // 对 urls 排序
    const urlList = Array.from(agg.urls.values());
    urlList.sort((a, b) => {
      // 优先用 URL 级测速缓存
      const sa = channelSpeedMap?.[a.url];
      const sb = channelSpeedMap?.[b.url];
      const fa = sa && sa.kind !== 'fail' ? sa.speedMs : undefined;
      const fb = sb && sb.kind !== 'fail' ? sb.speedMs : undefined;

      if (fa != null && fb != null) return fa - fb;
      if (fa != null) return -1;
      if (fb != null) return 1;

      // 失败的 URL 排到末尾
      const failA = sa?.kind === 'fail';
      const failB = sb?.kind === 'fail';
      if (failA && !failB) return 1;
      if (!failA && failB) return -1;

      // 降级：源级 speedMs
      const ssA = a.sourceSpeedMs ?? Infinity;
      const ssB = b.sourceSpeedMs ?? Infinity;
      return ssA - ssB;
    });

    // 拼 $ 源名（URL 预防性 encode 避免 type 泄漏）
    const urlStrs = urlList.map((e) => `${scrubUrlType(e.url)}$${scrubTypeLiteral(e.source)}`);
    totalUrls += urlStrs.length;

    const channel: TVBoxLiveChannel = {
      name: scrubTypeLiteral(agg.rawName),
      urls: urlStrs,
    };
    // TVBoxLiveChannel 定义只有 name/urls，logo 不加（避免意外引入 type 风险字段）

    const groupKey = scrubTypeLiteral(agg.group || '其他');
    let list = groupMap.get(groupKey);
    if (!list) {
      list = [];
      groupMap.set(groupKey, list);
    }
    list.push(channel);
  }

  // 组装 groups
  const groups: TVBoxLiveGroup[] = [];
  for (const [group, channels] of groupMap) {
    groups.push({ group, channels });
  }

  // 最终安全校验（双保险第二道）：
  //   1) 先移除 "type" 字段名（若意外进入）
  //   2) 再扫描 value 内 type 子串，统一 URL-encode 替换为 %74ype
  let finalJson = JSON.stringify(groups);
  let cleanedGroups: TVBoxLiveGroup[] = groups;

  if (/"type"\s*:/i.test(finalJson)) {
    console.warn('[live-merger] WARNING: "type" field leaked into output, stripping...');
    finalJson = finalJson
      .replace(/,\s*"type"\s*:\s*("[^"]*"|[\d.]+|null|true|false)/gi, '')
      .replace(/"type"\s*:\s*("[^"]*"|[\d.]+|null|true|false)\s*,?/gi, '');
    cleanedGroups = JSON.parse(finalJson);
  }

  // value 内 type 子串兜底：排除字段名（"xxx":）位置，其他全部 encode
  if (/type/i.test(finalJson)) {
    console.warn('[live-merger] WARNING: "type" substring in value, encoding to %74ype...');
    finalJson = finalJson.replace(/type/gi, (m) => {
      const hex = m.charCodeAt(0).toString(16).toUpperCase();
      return '%' + hex + m.slice(1);
    });
    cleanedGroups = JSON.parse(finalJson);
    return {
      groups: cleanedGroups,
      totalChannels: channelMap.size,
      totalUrls,
      sourcesDownloaded,
      sourcesFailed,
    };
  }

  if (cleanedGroups !== groups) {
    return {
      groups: cleanedGroups,
      totalChannels: channelMap.size,
      totalUrls,
      sourcesDownloaded,
      sourcesFailed,
    };
  }

  console.log(
    `[live-merger] Merged ${channelMap.size} channels / ${totalUrls} URLs across ${groups.length} groups`,
  );

  return {
    groups,
    totalChannels: channelMap.size,
    totalUrls,
    sourcesDownloaded,
    sourcesFailed,
  };
}

/**
 * 从合并后的 groups 提取所有 (url, sourceSpeedMs) 对供 channel-probe 测速
 * URL 是 `$源名` 剥离后的裸 URL
 */
export function extractAllUrls(groups: TVBoxLiveGroup[]): string[] {
  const set = new Set<string>();
  for (const g of groups) {
    for (const ch of g.channels) {
      for (const u of ch.urls) {
        const idx = u.lastIndexOf('$');
        const bare = idx > 0 ? u.slice(0, idx) : u;
        if (bare) set.add(bare);
      }
    }
  }
  return Array.from(set);
}
