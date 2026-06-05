// 站点名称定制：前缀后缀

import type { TVBoxConfig, NameTransformConfig } from './types';

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
