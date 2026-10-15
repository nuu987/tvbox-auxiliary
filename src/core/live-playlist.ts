/** Normalize addresses without constructing, filtering or merging a channel tree. */
export interface PlaylistFile { data: Buffer; format: 'm3u' | 'txt' }

function absolute(value: string, base: string): string {
  // Preserve custom protocols, absolute URLs, labels and fragment text verbatim.
  if (!value || /^[a-z][\w+.-]*:/i.test(value) || value.startsWith('#')) return value;
  const label = value.indexOf('$');
  const address = label < 0 ? value : value.slice(0, label);
  try { return new URL(address, base).href + (label < 0 ? '' : value.slice(label)); }
  catch { return value; }
}

export function normalizePlaylist(bytes: Buffer, contentType: string, base: string): PlaylistFile | null {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  let text: string;
  try { text = new TextDecoder(charset || 'utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('直播列表字符编码无法安全解析'); }
  if (!text.trim() || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw new Error('返回内容不是直播列表');
  // HLS streams/variants are live media, not static channel directories.
  if (/^\s*#EXT-X-/m.test(text)) return null;
  const m3u = /#EXTM3U|#EXTINF/i.test(text);
  if (!m3u && !/^\s*[^#\r\n,]+,(?:\s*#genre#|\s*(?:[a-z][\w+.-]*:|\/|\.\.?\/|[^\s,]+\/|[^\s,]+\.(?:m3u8?|ts|mp4)(?:[?#]|$)))/im.test(text)) {
    throw new Error('返回内容无法识别为 M3U/TXT 直播列表');
  }
  // Keep separators, whitespace and unknown directives; rewrite only recognized URI positions.
  let expectingUri = false;
  const normalized = text.split(/(\r\n|\r|\n)/).map(line => {
    if (/^[\r\n]+$/.test(line) || !line.trim()) return line;
    if (m3u) {
      if (line.trimStart().startsWith('#')) {
        if (/^\s*#EXTINF/i.test(line)) expectingUri = true;
        return line.replace(/((?:tvg-logo|x-tvg-url|url-tvg|URI)\s*=\s*")([^"]+)(")/gi,
          (_all, before: string, uri: string, after: string) => before + absolute(uri, base) + after);
      }
      const uri = line.trim();
      const recognized = /^[a-z][\w+.-]*:|^(?:\/|\.\.?\/)|^[^\s,]+(?:\/|\.(?:m3u8?|ts|mp4)(?:[?#]|$))/i.test(uri);
      if ((!expectingUri || uri.includes(',')) && !recognized) return line;
      expectingUri = false;
      return line.replace(/^(\s*)(.*?)(\s*)$/, (_all, start: string, uri: string, end: string) => start + absolute(uri, base) + end);
    }
    if (line.trimStart().startsWith('#')) return line;
    const comma = line.indexOf(',');
    if (comma < 0 || line.slice(comma + 1).trim() === '#genre#') return line;
    // A # immediately before another URL/path is a TXT multi-line separator, not a fragment.
    const values = line.slice(comma + 1).split(/(#)(?=(?:[a-z][\w+.-]*:\/\/|\/|\.\.?\/))/i);
    return line.slice(0, comma + 1) + values.map(value => value === '#' ? value
      : value.replace(/^(\s*)(.*?)(\s*)$/, (_all, start: string, uri: string, end: string) => start + absolute(uri, base) + end)).join('');
  }).join('');
  return { data: Buffer.from(normalized, 'utf-8'), format: m3u ? 'm3u' : 'txt' };
}
