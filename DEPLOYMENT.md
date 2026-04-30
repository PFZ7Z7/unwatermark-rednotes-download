# 部署文档

本项目提供两种部署方式，推荐用 Docker：

| 方式 | 推荐场景 | 特点 |
| --- | --- | --- |
| **🐳 Docker（主推）** | 生产部署、AI 远程 SSH 部署、跨机器模板化 | 单镜像自包含前后端、幂等、无需 Nginx、零环境污染 |
| 🔧 PM2 + Nginx（备选） | 无 Docker 环境、需要深度定制 | 源码部署、精细控制 |

> **MediaCrawler 始终跑在宿主机**（Python + Playwright + Chromium，不被容器化）。
> Docker 方案下，容器内后端通过 `host.docker.internal:8080` 访问宿主机 MediaCrawler。

---

## 🐳 方式一：Docker 部署（推荐）

### 1. 架构概览

```
宿主机
├─ Docker 容器 xhs-downloader  (端口 3001)
│    ├─ express :3001
│    │    ├─ /          → 前端静态资源 (/app/frontend-dist)
│    │    └─ /api/...   → 后端 API
│    └─ 挂载卷
│         ├─ /mnt/mediacrawler/browser_data ←→ 宿主机 MediaCrawler/browser_data
│         └─ /mnt/mediacrawler/data         ←→ 宿主机 MediaCrawler/data
└─ MediaCrawler (Python 进程直接跑在宿主机 :8080)
     └─ 容器通过 host.docker.internal:8080 访问
```

### 2. 前置清单

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Docker | ≥ 20.10 | 必需 |
| Docker Compose | v2（命令 `docker compose`） | 必需 |
| Python | ≥ 3.9 | MediaCrawler 运行时 |
| 图形环境 | X11 / RDP / VNC / 本地机 | **首次扫码登录必需**，长期运行后不再需要 |
| MediaCrawler | 预装好 + 已扫码登录 | 见下文第 3 节 |

---

### 3. MediaCrawler 预装（宿主机，一次性）

> MediaCrawler 是独立项目，本仓库不包含其代码。类似 Python 项目的 `requirements.txt`，以下步骤照抄即可。

#### 3.1 Linux 系统依赖（Chromium 运行时）

```bash
sudo apt-get update
sudo apt-get install -y \
  python3 python3-pip python3-venv git \
  libnss3 libatk1.0-0 libxkbcommon0 libgbm1 libasound2 \
  libxcomposite1 libxdamage1 libxrandr2 libpangocairo-1.0-0 libcairo2 libcups2
```

Windows：装 Python 3.10+ 和 Git 即可，Chromium 由 Playwright 自动搞定。

#### 3.2 clone + 装依赖

```bash
git clone https://github.com/NanmiCoder/MediaCrawler.git /opt/MediaCrawler
cd /opt/MediaCrawler

python3 -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate

pip install -r requirements.txt
playwright install chromium
playwright install-deps chromium       # Linux 专用，装系统库
```

#### 3.3 启动 api_server

```bash
cd /opt/MediaCrawler
source .venv/bin/activate
uvicorn api_server:app --host 0.0.0.0 --port 8080

# 另一个终端自检
curl http://localhost:8080/api/crawler/status
# 期望返回：{"status":"idle"}
```

#### 3.4 首次扫码登录（必须有图形界面）

```bash
cd /opt/MediaCrawler
source .venv/bin/activate
python main.py --platform xhs --lt qrcode --type search --keywords test --headless false
# 弹出 Chromium 窗口 → 手机扫码 → 登录成功后关闭窗口
```

验证：

```bash
ls -lh /opt/MediaCrawler/browser_data/xhs_user_data_dir/Default/Cookies
# 应有一个 > 20KB 的文件
```

> **无头服务器的替代方案**：本地机上完成扫码后 `scp -r ./browser_data user@server:/opt/MediaCrawler/`

#### 3.5 MediaCrawler 开机自启

**Linux（systemd，推荐）**：写入 `/etc/systemd/system/mediacrawler.service`

```ini
[Unit]
Description=MediaCrawler API Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/opt/MediaCrawler
Environment=PATH=/opt/MediaCrawler/.venv/bin
ExecStart=/opt/MediaCrawler/.venv/bin/uvicorn api_server:app --host 0.0.0.0 --port 8080
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mediacrawler
sudo systemctl status mediacrawler
```

**跨平台（PM2）**：

```bash
pm2 start "/opt/MediaCrawler/.venv/bin/uvicorn api_server:app --host 0.0.0.0 --port 8080" \
  --name mediacrawler --cwd /opt/MediaCrawler
pm2 save
pm2 startup
```

**Windows**：用 [NSSM](https://nssm.cc/) 将 uvicorn 包成服务。

---

### 4. 本项目一键启动

```bash
# Linux / macOS
cd /opt/xiaohongshv-clone
cp .env.docker.example .env
vim .env
# 必填两项（宿主机 MediaCrawler 的绝对路径）：
#   MC_HOST_BROWSER_DATA=/opt/MediaCrawler/browser_data
#   MC_HOST_DATA=/opt/MediaCrawler/data

docker compose up -d --build
docker compose logs -f xhs
```

Windows PowerShell 对应：

```powershell
cd C:\Users\PFZ7Z7\xiaohongshv-clone
copy .env.docker.example .env
notepad .env
# MC_HOST_BROWSER_DATA=C:/Users/PFZ7Z7/MediaCrawler/browser_data
# MC_HOST_DATA=C:/Users/PFZ7Z7/MediaCrawler/data

docker compose up -d --build
docker compose logs -f xhs
```

访问 `http://<宿主机地址>:3001/`。

---

### 5. 常用运维命令

```bash
docker compose ps                     # 查看状态
docker compose logs -f xhs            # 跟日志
docker compose restart xhs            # 重启
docker compose down                   # 停止并移除容器（镜像/卷保留）
docker compose up -d --build          # 改代码后重构并启动
docker exec -it xhs-downloader sh     # 进容器排查
docker image prune -f                 # 清理旧镜像
```

### 6. 升级 / 回滚

```bash
# 升级
git pull
docker compose up -d --build

# 回滚
git checkout <旧 tag 或 commit>
docker compose up -d --build
```

### 7. 验证清单

```bash
# 后端健康
curl http://localhost:3001/api/health
# 期望：{"status":"ok","message":"小红书下载服务运行中"}

# 登录态（需 MediaCrawler 已起 + Cookies 已挂载）
curl http://localhost:3001/api/login-status

# 前端页
浏览器打开 http://localhost:3001/

# 容器健康检查状态
docker inspect --format='{{.State.Health.Status}}' xhs-downloader
```

### 8. 故障排查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `ERROR: MC_HOST_BROWSER_DATA is required` | `.env` 没写路径 | 按 `.env.docker.example` 填完 |
| 登录状态总是未登录 | Cookies 挂载路径不对 | `docker exec -it xhs-downloader ls /mnt/mediacrawler/browser_data/xhs_user_data_dir/Default/Cookies` |
| 无法连 MediaCrawler | 宿主机 MC 未启动 / 端口不是 8080 | 宿主机 `curl http://localhost:8080/api/crawler/status` 自检 |
| Linux 上 `host.docker.internal` 不通 | 需 Docker ≥ 20.10 | compose 已加 `extra_hosts`，升级 Docker 即可 |
| 要暴露 80 端口 | 改端口映射 | `docker-compose.yml` 里改成 `"80:3001"`（需 root） |
| 镜像构建慢 | 首次下载基础镜像 | 正常，二次构建会复用层缓存 |

### 9. HTTPS（对外暴露时）

容器内不做 TLS。在宿主机跑 Nginx / Caddy / Traefik 反代到 `http://127.0.0.1:3001`：

```nginx
server {
    listen 443 ssl http2;
    server_name xhs.example.com;

    ssl_certificate     /etc/letsencrypt/live/xhs.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xhs.example.com/privkey.pem;

    client_max_body_size 64m;
    proxy_read_timeout   600s;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

同时在 `.env` 设置：

```
ALLOWED_ORIGINS=https://xhs.example.com
```

---

## 🔧 方式二：PM2 + Nginx（备选）

源码部署，后端用 PM2 守护，前端静态资源交给 Nginx。

### 目录规划

```
/opt/xhs/
├── frontend-dist/        ← frontend/dist 内容
├── backend/
│   ├── dist/             ← backend/dist 内容
│   ├── package.json
│   ├── package-lock.json
│   ├── node_modules/     ← npm ci --omit=dev 生成
│   └── .env              ← 生产配置
└── MediaCrawler/         ← 同 Docker 方案第 3 节预装
```

### 打包 + 上传

```bash
# 构建机
cd frontend && npm ci && npm run build && cd ..
cd backend  && npm ci && npm run build && cd ..

tar czf release.tar.gz \
  frontend/dist backend/dist backend/package.json backend/package-lock.json backend/.env.example
scp release.tar.gz user@server:/opt/xhs/
```

### 安装与启动

```bash
cd /opt/xhs/backend
npm ci --omit=dev
cp .env.example .env && vim .env    # 按下表填必填项
```

**生产 `.env` 必填**：

```ini
PORT=3001
NODE_ENV=production
ALLOWED_ORIGINS=https://xhs.example.com
MEDIACRAWLER_API=http://localhost:8080
MEDIACRAWLER_BROWSER_DATA=/opt/xhs/MediaCrawler/browser_data/xhs_user_data_dir
MEDIACRAWLER_DATA_DIR=/opt/xhs/MediaCrawler/data
```

⚠️ 路径必须绝对路径。

**PM2 启动**（`/opt/xhs/backend/ecosystem.config.js`）：

```js
module.exports = {
  apps: [{
    name: 'xhs-backend',
    script: 'dist/index.js',
    cwd: '/opt/xhs/backend',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '1G',
    env: { NODE_ENV: 'production' },
    error_file: '/opt/xhs/logs/backend-err.log',
    out_file:   '/opt/xhs/logs/backend-out.log',
    time: true,
  }]
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

**Nginx 配置**：

```nginx
server {
  listen 443 ssl http2;
  server_name xhs.example.com;
  ssl_certificate     /etc/nginx/ssl/xhs.crt;
  ssl_certificate_key /etc/nginx/ssl/xhs.key;

  root /opt/xhs/frontend-dist;
  index index.html;

  # SPA 路由 fallback
  location / { try_files $uri $uri/ /index.html; }

  # 后端 API 反向代理
  location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;
    client_max_body_size 64m;
  }
}
```

MediaCrawler 的安装与开机自启，照抄 Docker 方案的第 3 节。

---

## 附录 A：SSH 远程部署 Playbook（给 AI 用）

让 Claude Code 等 AI 通过 SSH 帮忙部署时，把以下内容连同 DEPLOYMENT.md 一起发给它：

```
【规范】每步执行完必须验证，失败立即停，不要自作主张"修"，把日志发回来。

1. 系统检查
   命令：docker --version && docker compose version && python3 --version
   期望：都输出版本号

2. 预置 MediaCrawler（若服务器没装）
   - git clone https://github.com/NanmiCoder/MediaCrawler.git /opt/MediaCrawler
   - cd /opt/MediaCrawler && python3 -m venv .venv && source .venv/bin/activate
   - pip install -r requirements.txt
   - playwright install chromium && playwright install-deps chromium
   验证：curl http://localhost:8080/api/crawler/status（启动 uvicorn 之后）

3. browser_data（由我本地上传，AI 不扫码）
   - 我已用 scp 把 browser_data.tar.gz 放到 /tmp/
   - 解压：tar xzf /tmp/browser_data.tar.gz -C /opt/MediaCrawler/
   验证：ls /opt/MediaCrawler/browser_data/xhs_user_data_dir/Default/Cookies

4. 注册 MediaCrawler systemd 服务
   - 按 DEPLOYMENT.md 第 3.5 节写 /etc/systemd/system/mediacrawler.service
   - sudo systemctl daemon-reload && sudo systemctl enable --now mediacrawler
   验证：systemctl is-active mediacrawler  → active

5. 本项目
   - git clone <本仓库> /opt/xiaohongshv-clone
   - cd /opt/xiaohongshv-clone
   - cp .env.docker.example .env
   - 编辑 .env：MC_HOST_BROWSER_DATA=/opt/MediaCrawler/browser_data
                MC_HOST_DATA=/opt/MediaCrawler/data
   - docker compose up -d --build
   验证：curl http://localhost:3001/api/health → {"status":"ok",...}

6. Nginx 反代（可选，仅在要挂域名时）
   - 只动 /etc/nginx/sites-available/xhs.conf
   - nginx -t 通过后 sudo systemctl reload nginx

【AI 禁止动作】
- 不要手动 npm install / pip install 到本项目目录（Docker 包好了）
- 不要改 /etc/nginx/nginx.conf 主配置，只能在 sites-available 新增文件
- 不要自己生成 .env 里的路径，必须用我指定的值
- 不要 sudo systemctl restart docker 之类重启底层服务
```

---

## 附录 B：文件总览

部署涉及的配置文件：

| 文件 | 作用 |
| --- | --- |
| [Dockerfile](./Dockerfile) | 三阶段构建：前端 → 后端（含 native 模块编译）→ 精简 runtime |
| [docker-compose.yml](./docker-compose.yml) | 编排 + 挂载 MediaCrawler 目录 + host.docker.internal |
| [.env.docker.example](./.env.docker.example) | 宿主机 MediaCrawler 路径模板 |
| [.dockerignore](./.dockerignore) | 构建时排除 node_modules/.env/调试文件 |
| [backend/.env.example](./backend/.env.example) | PM2 方式使用的后端环境变量模板 |

不打进部署包的文件：`backend/debug.ts`、`backend/test_*.jpg`、`**/node_modules`、`**/.env`、`**/dist`（容器内重新构建）。
