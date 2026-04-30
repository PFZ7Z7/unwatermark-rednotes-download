# 小红书无水印下载工具 (RedNotes Downloader)

一个功能强大的小红书笔记无水印下载工具，支持图片、视频解析下载，关键词搜索，博主笔记批量获取。

## ✨ 功能特性

### 核心功能
- 🔗 **笔记解析** - 支持多种小红书链接格式，自动提取无水印图片/视频
- 🔍 **关键词搜索** - 搜索指定关键词的笔记，支持批量下载
- 👤 **博主笔记** - 获取指定博主的所有笔记，一键打包下载
- 📦 **批量下载** - 多选笔记打包成ZIP下载

### 技术亮点
- ⚡ **匿名直解** - 部分笔记无需登录即可秒级解析
- 🔄 **智能代理** - 视频/图片通过后端代理，解决跨域和防盗链问题
- 🔐 **登录检测** - 实时检测Cookie有效性，过期自动提示扫码登录
- 📊 **进度轮询** - 搜索/博主爬取实时显示进度

## 🛠 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite |
| 后端 | Node.js + Express 5 + TypeScript |
| 爬虫 | MediaCrawler (Python + Playwright) |
| 存储 | SQLite (better-sqlite3) |

## 📁 项目结构

```
xiaohongshv-clone/
├── frontend/                    # 前端项目
│   ├── src/
│   │   ├── App.tsx             # 主组件（解析/搜索/博主三种模式）
│   │   └── App.css             # 样式（响应式设计）
│   └── package.json
├── backend/                     # 后端项目
│   ├── src/
│   │   ├── index.ts            # API入口（路由、代理、登录状态）
│   │   ├── services/
│   │   │   ├── xiaohongshu.ts  # 核心服务（MediaCrawler交互）
│   │   │   └── anonymousParser.ts  # 匿名直解（无需登录）
│   │   └── utils/
│   │       └── perf.ts         # TTL缓存、并发控制
│   └── package.json
├── API_CONFIG.md               # API配置指南
└── README.md
```

## 🚀 快速开始

### 前置要求

1. **Node.js 18+**
2. **MediaCrawler** (用于搜索和博主功能)
   ```bash
   git clone https://github.com/NanmiCoder/MediaCrawler.git
   cd MediaCrawler
   pip install -r requirements.txt
   ```

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/your-username/unwatermark-rednotes-download.git
cd unwatermark-rednotes-download

# 2. 安装前端依赖
cd frontend && npm install

# 3. 安装后端依赖
cd ../backend && npm install

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env 填写 MediaCrawler 路径等配置
```

### 启动服务

```bash
# 终端1: 启动 MediaCrawler API
cd MediaCrawler
python -m api.main

# 终端2: 启动后端
cd unwatermark-rednotes-download/backend
npm run dev

# 终端3: 启动前端
cd unwatermark-rednotes-download/frontend
npm run dev
```

### 访问地址

| 服务 | 地址 |
|------|------|
| 前端 | http://localhost:5173 |
| 后端 API | http://localhost:3001 |
| MediaCrawler | http://localhost:8080 |

## 📝 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/login-status` | 检查登录状态 |
| POST | `/api/login` | 触发扫码登录 |
| POST | `/api/logout` | 退出登录 |
| POST | `/api/parse` | 解析单个笔记 |
| POST | `/api/search` | 关键词搜索 |
| POST | `/api/creator` | 获取博主笔记 |
| GET | `/api/proxy/video` | 视频代理 |
| GET | `/api/proxy/image` | 图片代理 |
| GET | `/api/download` | 下载单个文件 |
| POST | `/api/download-zip` | 批量打包下载 |

## 🔗 支持的链接格式

| 类型 | 示例 |
|------|------|
| 标准链接 | `https://www.xiaohongshu.com/explore/xxxxx?xsec_token=yyy` |
| 发现链接 | `https://www.xiaohongshu.com/discovery/item/xxxxx` |
| 短链接 | `https://xhslink.com/xxxxx` |
| 笔记ID | 直接输入24位字符的笔记ID |
| 分享文案 | `55 【标题】😆 https://www.xiaohongshu.com/...` |

## ⚙️ 环境变量配置

```env
# MediaCrawler 配置
MEDIACRAWLER_API=http://localhost:8080
MEDIACRAWLER_BROWSER_DATA=../MediaCrawler/browser_data/xhs_user_data_dir
MEDIACRAWLER_DATA_DIR=../MediaCrawler/data

# 服务配置
PORT=3001
NODE_ENV=development

# CORS 白名单（生产环境必填）
ALLOWED_ORIGINS=https://your-domain.com

# 代理域名白名单
PROXY_ALLOWED_HOSTS=xhscdn.com,xiaohongshu.com,xhslink.com

# 性能调优
MEDIACRAWLER_CONCURRENCY=8
RESULT_CACHE_TTL_MS=300000
DOWNLOAD_CONCURRENCY=5
```

## 🐳 Docker 部署

```bash
# 构建镜像
docker build -t rednotes-downloader .

# 运行容器
docker run -d \
  -p 3001:3001 \
  -e NODE_ENV=production \
  -e ALLOWED_ORIGINS=https://your-domain.com \
  rednotes-downloader
```

## 📦 生产部署

```bash
# 1. 构建前端
cd frontend && npm run build

# 2. 构建后端
cd ../backend && npm run build

# 3. 复制前端产物到后端目录
cp -r ../frontend/dist ./frontend-dist

# 4. 使用 PM2 运行
pm2 start dist/index.js --name rednotes-api
```

## ⚠️ 注意事项

1. **仅供学习交流** - 请勿用于商业用途
2. **登录状态** - 搜索和博主功能需要扫码登录小红书
3. **频率限制** - 请合理控制请求频率，避免被封禁
4. **API变更** - 小红书API可能随时更新，如遇问题请提Issue

## 📄 License

MIT License
