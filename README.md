# 小红书无水印下载工具 (RedNotes Downloader)

一个小红书笔记无水印下载工具，支持普通分享链接解析、图片/视频下载、关键词搜索、博主笔记获取和 ZIP 打包下载。

## 功能特性

### 核心功能

- **笔记解析**：粘贴小红书笔记链接或分享文案，解析图片/视频资源。
- **匿名直解**：普通分享链接通常无需登录，优先走匿名解析。
- **增强模式**：关键词搜索、博主笔记和媒体补全会使用增强模式。
- **批量下载**：支持多选笔记创建下载任务，浏览器原生下载 ZIP。
- **单条图集打包**：多图笔记可一次打包下载为 ZIP，避免浏览器连续弹出多个下载。
- **实况图组件**：识别实况图的图片和动态 MP4 组件，支持成对打包保存，并保留动态视频备用地址。
- **笔记元信息**：结果页展示发布时间、IP 属地、点赞/收藏/评论/分享等信息。
- **话题跳转**：结构化提取话题标签，点击标签可在新标签页打开小红书话题搜索。

### 稳定性与安全

- **低内存 ZIP 打包**：ZIP 下载使用流式写入，不把所有图片一次性堆进内存，更适合 2GB RAM 等小机器。
- **任务式大文件下载**：批量 ZIP 先创建任务并显示补全/打包/字节进度，再交给浏览器原生下载，避免前端 `blob` 吃掉大文件内存。
- **下载回退**：单文件下载和 ZIP 打包都会按主地址、备用地址顺序尝试，提升实况视频和视频资源下载成功率。
- **运行时保洁**：定时清理历史爬取 JSON，降低 40GB 小磁盘被占满的风险。
- **缓存边界**：搜索/博主结果和单笔记解析结果使用 TTL 缓存，并设置容量上限。
- **代理白名单**：图片/视频代理和下载接口限制小红书相关域名，避免变成公共代理。
- **日志脱敏**：关键 URL 日志会隐藏 `xsec_token`、`web_session` 等临时凭证。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 18 + TypeScript + Vite |
| 后端 | Node.js + Express 5 + TypeScript |
| 增强模式 | Docker sidecar 内安装固定版本 MediaCrawler + Playwright + Chromium |
| 本地检测 | SQLite (better-sqlite3) |

## 项目结构

```text
unwatermark-rednotes-download/
├── frontend/                    # 前端项目
│   ├── src/
│   │   ├── App.tsx              # 主组件：解析/搜索/博主三种模式
│   │   └── App.css              # 样式
│   └── package.json
├── backend/                     # 后端项目
│   ├── src/
│   │   ├── index.ts             # API、代理、下载、静态资源托管
│   │   ├── services/
│   │   │   ├── xiaohongshu.ts   # 核心服务与增强模式交互
│   │   │   └── anonymousParser.ts
│   │   └── utils/
│   │       └── perf.ts          # TTL 缓存、并发工具
│   └── package.json
├── scripts/                     # 本地启停脚本
├── docker/driver/                # 增强模式驱动器镜像
├── docker-compose.yml
├── Dockerfile
└── README.md
```

## 快速开始

### 前置要求

- 本地开发：Node.js 18+
- Docker 部署：Docker + Docker Compose
- 默认 Docker 部署会自动构建增强模式驱动器，不需要手工安装 MediaCrawler。

### Docker 一键部署

默认完整部署：

```bash
git clone https://github.com/PFZ7Z7/unwatermark-rednotes-download.git
cd unwatermark-rednotes-download
docker compose up -d --build
```

访问：

```text
http://127.0.0.1:3001
```

打开首页后，普通分享链接可直接解析。关键词搜索和博主笔记需要点击右上角“启用增强模式”，提交 Xiaohongshu Cookie 并通过账号实效校验后使用；Cookie 会保存在 Docker volume 中，重建容器不会丢失。

注意：增强模式 Cookie 是站点级共享状态，能访问页面的用户都可以提交、覆盖或清除它。提交新 Cookie 校验失败时，后端会清除旧 Cookie，避免继续使用上一个账号。

国内网络构建慢或失败时：

```bash
cp .env.docker.example .env
```

按文件内说明启用 npm、pip、apt、Playwright 镜像源后重新构建。

轻量模式只启动主服务：

```bash
docker compose up -d --build --no-deps xhs
```

轻量模式下普通链接下载可用，增强模式会显示维护中。

### 本地开发安装

```bash
git clone https://github.com/PFZ7Z7/unwatermark-rednotes-download.git
cd unwatermark-rednotes-download

cd frontend && npm install
cd ../backend && npm install
```

复制后端配置：

```bash
cd backend
cp .env.example .env
```

按实际路径填写 `.env` 中的 `MEDIACRAWLER_API`、`MEDIACRAWLER_BROWSER_DATA`、`MEDIACRAWLER_DATA_DIR`。

### 启动

推荐使用根目录脚本：

```bash
npm run start
```

如端口被旧进程占用，可使用：

```bash
npm run start:clean
```

也可以分别启动：

```bash
# 后端
cd backend
npm run dev

# 前端
cd frontend
npm run dev
```

访问地址：

| 服务 | 地址 |
| --- | --- |
| 前端 | http://localhost:5173 |
| 后端 API | http://localhost:3001 |
| 增强模式 API | http://localhost:8080 或 Docker 内的 http://xhs-driver:8080 |

## API 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/login-status` | 检查增强模式状态 |
| POST | `/api/enhanced-cookie` | 保存并实效校验增强模式 Cookie |
| POST | `/api/enhanced-cookie/clear` | 清除增强模式 Cookie |
| POST | `/api/parse` | 解析单个笔记 |
| POST | `/api/search` | 关键词搜索 |
| POST | `/api/creator` | 获取博主笔记 |
| GET | `/api/proxy/video` | 视频代理 |
| GET | `/api/proxy/image` | 图片代理 |
| GET | `/api/download` | 下载单个文件，支持备用地址回退 |
| POST | `/api/download-jobs` | 创建批量 ZIP 下载任务 |
| GET | `/api/download-jobs/:jobId/progress` | 查询批量下载进度 |
| GET | `/api/download-jobs/:jobId/file` | 浏览器原生下载任务 ZIP |
| POST | `/api/download-zip` | 兼容旧 ZIP 打包接口，支持单帖图集/实况组件 |

## 支持的链接格式

| 类型 | 示例 |
| --- | --- |
| 标准链接 | `https://www.xiaohongshu.com/explore/xxxxx?xsec_token=yyy` |
| 发现链接 | `https://www.xiaohongshu.com/discovery/item/xxxxx` |
| 短链接 | `https://xhslink.com/xxxxx` |
| 笔记 ID | 直接输入 24 位字符的笔记 ID |
| 分享文案 | `55 【标题】 https://www.xiaohongshu.com/...` |

## 环境变量

常用配置见 [backend/.env.example](backend/.env.example)。

```env
# 服务配置
PORT=3001
NODE_ENV=development
XHS_COOKIE_STORE_PATH=runtime/xhs-cookie.json
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
PROXY_ALLOWED_HOSTS=xhscdn.com,xhscdn.net,xiaohongshu.com,xhslink.com

# 增强模式集成
MEDIACRAWLER_API=http://localhost:8080
MEDIACRAWLER_BROWSER_DATA=../MediaCrawler/browser_data/xhs_user_data_dir
MEDIACRAWLER_DATA_DIR=../MediaCrawler/data
MEDIACRAWLER_CONCURRENCY=8

# 缓存
RESULT_CACHE_TTL_MS=300000

# 磁盘保洁
RUNTIME_DATA_RETENTION_DAYS=3
RUNTIME_DATA_MAX_JSON_FILES=200
RUNTIME_CLEANUP_INTERVAL_MS=21600000
```

### 磁盘保洁说明

服务启动后会自动检查增强模式的数据目录，并默认每 6 小时清理一次历史 JSON：

- 默认保留最近 3 天。
- 默认最多保留 200 个 JSON 文件。
- 只清理 `MEDIACRAWLER_DATA_DIR` 下的 `.json` 结果文件。
- 不会清理浏览器登录数据、Cookies、构建产物或用户下载内容。

## Docker 部署

默认无需 `.env`：

```bash
docker compose up -d --build
```

默认会启动 `xhs-downloader` 和 `xhs-driver` 两个容器。`xhs-driver` 构建时会 clone 固定 MediaCrawler commit 并安装 Playwright/Chromium。

验证：

```bash
docker compose ps
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3001/api/login-status
```

`docker-compose.yml` 已配置容器日志轮转，默认最多约 30MB：

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

## 生产部署

```bash
cd frontend && npm run build
cd ../backend && npm run build

# 可选：让后端托管前端静态文件
cp -r ../frontend/dist ./frontend-dist

npm ci --omit=dev
node dist/index.js
```

如果不复制 `frontend/dist` 到 `backend/frontend-dist`，后端会以纯 API 模式运行，前端需要单独部署或由 Vite/Nginx 提供。

## 注意事项

1. 本项目仅供学习交流，请合理使用。
2. 普通分享链接解析通常无需登录；关键词搜索、博主笔记和媒体补全会使用增强模式。
3. Docker 默认使用固定命名 volume 保存共享 Cookie、驱动器浏览器数据和输出数据；不要误删这些 volume。
4. 小红书页面结构和接口可能变化，如遇解析失败需结合最新页面结构排查。

## License

MIT License
