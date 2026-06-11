
# TVBox Auxiliary
A JSON Formatter & Automation Helper for TVBox
基于 https://gitee.com/tengxiaobao/tvbox-source-aggregator 二次开发，不考虑兼容性，专为容器版开发
> ⚠️ 警告：本项目**纯使用** AI 辅助开发，不推荐也不应将此项目用于生产等环境中。  
> ⚠️ 警告：本项目不提供也不存储任何影片资源与资产。
> 

## 改进功能 
1. **热重载多数配置项**：站点编辑后无须重新聚合，应用更改即可立即生效
2. **点播站点屏蔽增强**：使用正则表达式进行自动化匹配屏蔽，减少每次聚合后的人工介入操作量
3. **网页UX交互增强**：无须精确点击复选框，点击行条目的任意空白处即可勾选
4. **智能响应静态资源地址**：判断客户端访问接口时的主机地址并复用为该客户端生成动态静态资源地址
5. **优化自动聚合操作**：改进了自动聚合的定时操作体验，修正了容器的时区问题
6. **增强日志记录能力**：项目运行时将输出更多日志信息以提供给用户调查问题
7. **屏蔽直播功能**：提供一键屏蔽直播功能开关，避免臃肿化接口数据文件
8. ~~还有但是忘了……~~


## 重大变更
1. 不再支持 Cloudflare Worker 部署
2. 不推荐使用 Native 本地时运行，仅推荐 Docker 容器部署
3. 智能响应功能默认情况下不支持非局域网访问
4. 不再支持统一管理网盘类点播站点用户凭据功能，已计划完整移除
5. 不再支持 i18n
6. 不再支持多网页主题样式，仅保留亮暗两种主题
7. 不再支持 SQLite3，仅保留 Json 数据持久化
8. 不再支持站点分类接口标签
9. 等等……
  

## 用法
### Docker Compose (首选)
```
wget https://raw.githubusercontent.com/nuu987/tvbox-auxiliary/refs/heads/main/docker-compose.yml
docker compose up -d
```

### Native 运行
本地时运行未经过实际使用测试，仅供开发过程使用。  
前置依赖：
- Node.js v20  
```
node scripts/start.js
```

## LICENSE
MIT LICENSE