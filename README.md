> ⚠️ **Disclaimer:** You may treat this project as an AI slop. Any usage of this project is completely experimental and personal use only, **It is not recommended for production**.
>
> ⚠️ **Disclaimer:** Tvbox Auxiliary does not provide, host, or store any assets associate with any trademark or company in any form.  

# TVBox Auxiliary
A JSON Formatter & Automation Helper for TVBox.  
Forked from [tvbox-source-aggregator](https://gitee.com/tengxiaobao/tvbox-source-aggregator)  
Enhanced VOD experience with containerized, no guarantee for backward compatibility.

# Feature

- **Unified multi-source:** Combine multiple TVBox sources into one unified source. No more manually switching between different sources and wasting your time.
- **The REAL multi-source experience:** Enjoy seamless access from all VOD sources with a single entry in your TVBox.
- **Advanced regex-based filtering:** Use regular expression patterns to block VOD sources. Filters are applied automatically and immediately if you want.
- **Stay accessible with cache fallback:** If remote is unreachable for an unknown reason or you finger is not yours for a second, you could still use the latest cache on disk, this includes the lives, vod and vod static resource file.

# Usage

## Docker (Prefer)

```
wget https://raw.githubusercontent.com/nuu987/tvbox-auxiliary/refs/heads/main/docker-compose.yml
docker compose up -d
```
See yml for configs section.

## Native
Dependences:  
- Node.js 18+

```
cp .env.example .env
node scripts\start.js
```
See env for configs section.  

## Xposed
See [Xposed version](https://github.com/nuu987/taxp)  

## LICENSE
MIT LICENSE