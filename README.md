# 小红书无水印下载工具 (RedNotes Downloader)

一个小红书笔记无水印下载工具，支持普通分享链接解析、图片/视频下载、关键词搜索、博主笔记获取和 ZIP 打包下载。

## 功能特性

### 核心功能

- **笔记解析**：粘贴小红书笔记链接或分享文案，解析图片/视频资源。
- **匿名直解**：普通分享链接通常无需登录，优先走匿名解析。
- **增强模式**：关键词搜索、博主笔记、登录解析会使用增强模式。
- **批量下载**：支持多选笔记打包成 ZIP 下载。
- **单条图集打包**：多图笔记可一次打包下载为 ZIP，避免浏览器连续弹出多个下载。

### 稳定性与安全

- **低内存 ZIP 打包**：ZIP 下载使用流式写入，不把所有图片一次性堆进内存，更适合 2GB RAM 等小机器。
- **运行时保洁**：定时清理历史爬取 JSON，降低 40GB 小磁盘被占满的风险。
- **缓存边界**：搜索/博主结果和单笔记解析结果使用 TTL 缓存，并设置容量上限。
- **代理白名单**：图片/视频代理和下载接口限制小红书相关域名，避免变成公共代理。
- **日志脱敏**：关键 URL 日志会隐藏 `xsec_token`、`web_session` 等临时凭证。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 18 + TypeScript + Vite |
| 后端 | Node.js + Express 5 + TypeScript |
| 增强模式 | MediaCrawler (Python + Playwright) |
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
├── docker-compose.yml
├── Dockerfile
└── README.md
```

## 快速开始

### 前置要求

- Node.js 18+
- Python 运行环境
- MediaCrawler：用于关键词搜索、博主笔记和增强模式登录

### 安装

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
| 增强模式 API | http://localhost:8080 |

## API 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/login-status` | 检查增强模式状态 |
| POST | `/api/login` | 触发扫码登录 |
| POST | `/api/logout` | 退出登录 |
| POST | `/api/parse` | 解析单个笔记 |
| POST | `/api/search` | 关键词搜索 |
| POST | `/api/creator` | 获取博主笔记 |
| GET | `/api/proxy/video` | 视频代理 |
| GET | `/api/proxy/image` | 图片代理 |
| GET | `/api/download` | 下载单个文件 |
| POST | `/api/download-zip` | ZIP 打包下载 |

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

复制示例环境变量：

```bash
cp .env.docker.example .env
```

填写宿主机上的增强模式数据目录：

```env
MC_HOST_BROWSER_DATA=/path/to/MediaCrawler/browser_data
MC_HOST_DATA=/path/to/MediaCrawler/data
```

启动：

```bash
docker compose up -d --build
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
2. 普通分享链接解析通常无需登录；关键词搜索、博主笔记和登录解析会使用增强模式。
3. 建议生产环境使用绝对路径配置 `MEDIACRAWLER_BROWSER_DATA` 和 `MEDIACRAWLER_DATA_DIR`。
4. 小红书页面结构和接口可能变化，如遇解析失败需结合最新页面结构排查。

## License

MIT License
