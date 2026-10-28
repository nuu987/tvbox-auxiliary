// 站点名称转换：前缀后缀与发布时 Emoji 过滤

import emojiRegex from 'emoji-regex';
import type { TVBoxConfig, NameTransformConfig } from './types';

function removeEmoji(name: string): string {
  const cleaned = name.replace(emojiRegex(), '');
  return cleaned === name ? name : cleaned.trim();
}

export function transformSiteNames(config: TVBoxConfig, transform: NameTransformConfig): TVBoxConfig {
  if (!config.sites || config.sites.length === 0) return config;

  const sites = config.sites.map((site) => {
    let name = site.name || '';

    if (transform.prefix) name = transform.prefix + name;
    if (transform.suffix) name = name + transform.suffix;

    if (!name.trim()) name = site.key;

    return { ...site, name };
  });

  return { ...config, sites };
}

/** Remove emoji only from VOD site names in an output projection. */
export function removeEmojiFromSiteNames(config: TVBoxConfig): TVBoxConfig {
  if (!Array.isArray(config.sites) || config.sites.length === 0) return config;

  let changed = false;
  const sites = config.sites.map((site) => {
    if (!site || typeof site !== 'object' || typeof site.name !== 'string') return site;
    const name = removeEmoji(site.name);
    if (name === site.name) return site;
    changed = true;
    return { ...site, name };
  });

  return changed ? { ...config, sites } : config;
}
