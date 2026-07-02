
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

### Docker 部署（首选）

```
wget https://raw.githubusercontent.com/nuu987/tvbox-auxiliary/refs/heads/main/docker-compose.yml
docker compose up -d
```

- 默认端口 5678，数据持久化于宿主机 `./data` 目录。
- 必须修改 `docker-compose.yml` 中 `ADMIN_TOKEN` 为强密码（示例值 `test123` 仅为占位）。
- `BASE_URL` 建议填写为宿主机可达地址如 `http://192.168.1.100:5678`；不填则需在网页设置中开启「智能响应静态资源地址」。
- `CRON_SCHEDULE` 为自动聚合 cron 表达式，默认 `0 5 * * *`（每天 5 点）。
- 管理页面与认证方式见下方「管理页面与认证」小节。

### 本地运行（仅供开发）

> 本地运行未经过实际使用测试，仅供开发过程使用，生产请用 Docker（见「重大变更」#2）。

#### 环境要求

- Node.js 20+（项目要求 20+，与 Dockerfile 保持一致）
- npm（随 Node.js 附带）

#### 安装依赖

```
npm install
```

#### 配置 .env

```
cp .env.example .env
```

复制后编辑 `.env`，至少将 `ADMIN_TOKEN` 修改为强密码。`.env.example` 含全量环境变量模板，常用项：

- `ADMIN_TOKEN`（必需）：管理后台 Bearer 令牌，必填，无默认值。
- `PORT`：默认 `5678`。
- `BASE_URL`：服务对外可达地址，留空则自动检测局域网 IP。
- `CRON_SCHEDULE`：自动聚合 cron 表达式，留空禁用。
- `VERBOSE`：`true/1/yes/on` 开启 debug 日志。
- `DMZ`：设为 `0` 时关闭局域网主机校验，仅开发调试用，生产勿设（详见「管理页面与认证」）。

关于 `ADMIN_TOKEN` 的用途见下方「管理页面与认证」小节。

也可直接运行 `npm start`（即 `node scripts/start.js`），该脚本会交互式引导首次 `.env` 初始化（提示输入 `ADMIN_TOKEN` 与端口，并自动基于 `.env.example` 生成 `.env`）。

#### 构建与运行

两条路径任选其一：

1. 一键启动（推荐开发）：

```
npm start
```

等价于 `node scripts/start.js`，自动检查依赖、`.env`、端口、按需编译并启动。

2. 手动分步：

```
npm run build:node
node dist/server.js
```

`npm run build:node` 通过 esbuild 编译到 `dist/server.js`，随后 `node dist/server.js` 运行。

默认监听 http://localhost:5678。

### 管理页面与认证

- 访问路径：浏览器打开 http://localhost:5678/status（Docker 中替换 `localhost` 为宿主机 IP）。
- 认证方式：请求需携带 `Authorization: Bearer <ADMIN_TOKEN>` 头；网页管理页面在登录处输入 `ADMIN_TOKEN`。
- `ADMIN_TOKEN` 为管理 API 的 Bearer 令牌，必填，无默认值；`REFRESH_TOKEN` 为可选独立刷新接口令牌，一般留空。
- 安全提示：`DMZ` 环境变量设为 `0` 时关闭局域网主机校验，允许任意 host 智能响应静态资源——仅开发调试用，生产环境勿设 `DMZ=0`。
- 云凭证（若启用网盘类站点）使用 AES-256-GCM 加密存储。

## LICENSE
MIT LICENSE