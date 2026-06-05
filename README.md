# TVBox Auxiliary

将多个 TVBox 配置源合并成一个稳定的聚合地址。自动测速筛选、站点级去重、Spider JAR 智能分配。

支持两种部署方式：**Docker**（一行命令）、**本地运行**（一键脚本）。

## 功能

- **多源聚合** — 添加多个 TVBox 配置 JSON 地址，自动合并为一个
- **站点去重** — 不同源中的相同站点只保留一份
- **Spider JAR 智能分配** — 自动处理 type:3 站点的 JAR 依赖冲突
- **测速筛选**（可选） — 自动过滤不可达或高延迟的源
- **管理后台** — 网页端添加/删除源，触发刷新
- **定时更新** — 每天自动重新聚合，客户端无感知
- **容错设计** — 聚合失败时保留上次有效缓存

---

## 部署方式一：Docker（推荐）

最简单的部署方式，适合有服务器/NAS 的用户。

### 1. 克隆仓库

```bash
git clone https://gitee.com/tengxiaobao/tvbox-source-aggregator.git
cd tvbox-source-aggregator
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少修改 `ADMIN_TOKEN`：

```
ADMIN_TOKEN=你的管理密码
PORT=5678
```

### 3. 启动

```bash
docker compose up -d
```

完成！访问 `http://你的IP:5678/admin` 管理源。

### 常用命令

```bash
docker compose logs -f      # 查看日志
docker compose restart      # 重启
docker compose down         # 停止
docker compose up -d --build  # 重新构建并启动
```

---

## 部署方式二：一键脚本

适合没有 Docker 但有 Node.js 环境的用户（需要 Node.js 18+）。

### 1. 克隆仓库

```bash
git clone https://gitee.com/tengxiaobao/tvbox-source-aggregator.git
cd tvbox-source-aggregator
```

### 2. 一键启动

**Mac 用户**：双击项目目录中的 `start.command` 文件

**Windows 用户**：双击项目目录中的 `start.bat` 文件

**命令行用户**：
```bash
node scripts/start.js
```

首次启动会自动完成：
- 检查 Node.js 版本
- 安装依赖
- 创建数据目录
- 引导配置 `.env`（提示设置管理密码）
- 检查端口是否可用
- 编译并启动服务

### 后台运行

```bash
# 使用 pm2
npm install -g pm2
pm2 start scripts/start.js --name tvbox

# 或使用 nohup
nohup node scripts/start.js > tvbox.log 2>&1 &
```

---

## 使用

### 添加源

打开管理后台 `http://你的地址/admin`，输入密码登录：

- **添加源**：输入 TVBox 配置 JSON URL，点击 Add
- **删除源**：点击源旁边的 Remove
- **刷新**：点击 Refresh 触发一次聚合

### TVBox 配置

将你的聚合地址填入 TVBox 的接口地址：

```
http://你的地址:5678/
```

### 端点说明

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | TVBox 配置 JSON（客户端填这个地址） |
| `/status` | GET | 监控仪表盘页面 |
| `/status-data` | GET | 状态数据 JSON |
| `/admin` | GET | 管理后台（密码保护） |
| `/admin/sources` | GET/POST/DELETE | 源管理 API（密码保护） |
| `/refresh` | POST | 手动触发聚合刷新 |

---

## 可选：测速功能

注册 [zbape.com](https://www.zbape.com) 获取免费 API Key。

**Docker / 本地**：在 `.env` 中设置：
```
ZBAPE_API_KEY=your-api-key
```

开启后，每次聚合会自动测速并过滤高延迟源。

---

## 项目结构

```
├── src/
│   ├── core/              # 业务逻辑
│   │   ├── fetcher.ts     # 批量 fetch 配置 JSON
│   │   ├── parser.ts      # 配置规范化
│   │   ├── merger.ts      # 站点级合并引擎
│   │   ├── dedup.ts       # 去重逻辑
│   │   ├── speedtest.ts   # zbape.com 测速 API
│   │   ├── admin.ts       # 管理后台页面
│   │   ├── dashboard.ts   # 监控仪表盘页面
│   │   ├── types.ts       # TypeScript 类型
│   │   └── config.ts      # 配置常量
│   ├── storage/           # 存储抽象层
│   │   ├── interface.ts   # Storage 接口
│   │   └── json-file.ts   # JSON 文件存储
│   ├── routes.ts          # HTTP 路由（Hono）
│   ├── aggregator.ts      # 聚合流程编排
│   └── node-entry.ts      # Node.js 入口
├── scripts/
│   ├── start.js           # 一键启动脚本
│   └── build.js           # Node.js 构建脚本
├── Dockerfile
├── docker-compose.yml
├── .env.example           # 环境变量模板
└── package.json
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ADMIN_TOKEN` | 管理后台密码（必填） | - |
| `PORT` | 服务端口（Docker/本地） | `5678` |
| `CRON_SCHEDULE` | 定时同步 Cron（UTC），设置后管理页面同步频率为只读 | `0 5 * * *` |
| `ZBAPE_API_KEY` | zbape.com 测速 API 密钥 | - |
| `REFRESH_TOKEN` | 刷新接口独立 Token | - |
| `SPEED_TIMEOUT_MS` | 源延迟阈值 | `5000` |
| `FETCH_TIMEOUT_MS` | fetch 配置超时 | `5000` |
| `DATA_DIR` | JSON 数据存储目录（Docker/本地，写入 `tvbox-data.json`） | `./data` |
| `VERBOSE` | 详细诊断日志开关，接受 `1`、`true`、`yes`、`on` | - |

## 日志

默认日志会输出接口源清单（名称、URL/API、inline/remote 类型）、MacCMS 源清单、聚合步骤输入输出、测速结果、黑名单移除项、搜索配额、凭证注入、直播合并、JAR 改写和最终写入摘要。安全日志始终输出，不依赖 `VERBOSE`。

开启 `VERBOSE=1` 后，会额外输出逐源 fetch/decode/proxy/parse/multi-repo 展开、source-scraper 页面提取、不可测站点跳过等诊断细节。日志会屏蔽敏感值，不输出完整 token、完整 AES key 或解密后的配置正文。

PowerShell:

```powershell
$env:VERBOSE = "1"
npm start
Remove-Item Env:VERBOSE
```

Docker:

```powershell
docker run -e VERBOSE=1 ...
```

## License

MIT
