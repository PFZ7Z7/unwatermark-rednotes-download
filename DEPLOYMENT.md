# Docker Deployment Guide

This guide describes the default deployment path for the Xiaohongshu downloader.

## Default Goal

One command should deploy the complete stack:

```bash
docker compose up -d --build
```

The default stack starts:

- `xhs-downloader`: frontend + backend + public API.
- `xhs-driver`: enhanced-mode driver with a pinned MediaCrawler revision, Playwright, and Chromium.

MediaCrawler source code is not committed into this repository. The driver image clones a pinned revision at build time.

## Requirements

- Docker
- Docker Compose

No local Node.js, Python, Playwright, Chromium, or MediaCrawler install is required for Docker deployment.

## Quick Start

```bash
git clone https://github.com/PFZ7Z7/unwatermark-rednotes-download.git
cd unwatermark-rednotes-download
docker compose up -d --build
```

Check status:

```bash
docker compose ps
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3001/api/login-status
```

Open:

```text
http://127.0.0.1:3001
```

After opening the app:

1. Normal shared-note parsing works without enhanced mode.
2. For keyword search or creator notes, click the top-right enhanced-mode button.
3. Submit a Xiaohongshu Cookie that contains `web_session`, then refresh status and confirm enhanced mode is available.

The enhanced-mode Cookie is shared at site level. Anyone who can access the page can submit, overwrite, or clear it.

## Persistent Data

The stack uses explicit named volumes:

| Volume | Purpose |
| --- | --- |
| `xhs_downloader_runtime` | Shared enhanced-mode Cookie |
| `xhs_driver_browser_data` | Driver browser login state |
| `xhs_driver_data` | Driver output data |

Do not remove these volumes unless you intentionally want to reset Cookie, browser state, and crawler output.

## Production Reverse Proxy

The default Compose port mapping binds to localhost only:

```yaml
ports:
  - "${XHS_BIND_ADDR:-127.0.0.1}:${XHS_PORT:-3001}:3001"
```

Recommended Nginx reverse proxy:

```nginx
server {
  listen 80;
  server_name xhs.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name xhs.example.com;

  ssl_certificate     /etc/nginx/ssl/xhs.example.com.pem;
  ssl_certificate_key /etc/nginx/ssl/xhs.example.com.key;

  client_max_body_size 64m;
  proxy_read_timeout 600s;
  proxy_send_timeout 600s;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Validate:

```bash
nginx -t
systemctl reload nginx
curl -Ik https://xhs.example.com/
curl https://xhs.example.com/api/health
```

## Domestic Mirror Configuration

If the server is in mainland China or GitHub/CDN downloads are unstable:

```bash
cp .env.docker.example .env
```

Enable the mirror-related values:

```env
NODE_IMAGE=public.ecr.aws/docker/library/node:20-slim
PYTHON_IMAGE=python:3.11-slim-bookworm
USE_ALIYUN_APT_MIRROR=true
NPM_REGISTRY=https://registry.npmmirror.com
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
```

The driver is pinned by default:

```env
MEDIACRAWLER_REPO=https://github.com/NanmiCoder/MediaCrawler.git
MEDIACRAWLER_REF=165776886faf56d44651d4dbd290b015582a97f2
```

If GitHub is unreachable, point `MEDIACRAWLER_REPO` to a reachable mirror repository that contains the same commit.

## Download Performance

Batch ZIP downloads use a job flow:

- `POST /api/download-jobs` creates the job and starts media enrichment.
- `GET /api/download-jobs/:jobId/progress` reports enrichment count, ZIP file count, and downloaded bytes.
- `GET /api/download-jobs/:jobId/file` lets the browser perform a native ZIP download.

This still uses server bandwidth for `Xiaohongshu CDN -> server -> browser`, but the frontend no longer buffers the full ZIP with `fetch().blob()`.

Useful defaults:

```env
ZIP_COMPRESSION_LEVEL=3
DOWNLOAD_JOB_TTL_MS=1800000
DOWNLOAD_JOB_MAX_JOBS=50
```

Images and videos are already compressed, so increasing `ZIP_COMPRESSION_LEVEL` usually costs CPU without materially reducing file size.

## Lightweight Mode

To run only the main service without the driver:

```bash
docker compose up -d --build --no-deps xhs
```

In lightweight mode:

- Normal link parsing and download can still work.
- Enhanced keyword search and creator search show maintenance state until a driver is available.

## Reset Shared Cookie

The easiest reset path is the top-right enhanced-mode dialog in the app.

If you intentionally want to reset runtime state from the server, remove the runtime volume:

```bash
docker compose down
docker volume rm xhs_downloader_runtime
docker compose up -d
```

This removes the saved enhanced-mode Cookie.

## Common Commands

```bash
docker compose ps
docker compose logs -f xhs
docker compose logs -f xhs-driver
docker compose restart xhs
docker compose restart xhs-driver
docker compose up -d --build
docker compose down
```

## Health Checks

Main service:

```bash
curl http://127.0.0.1:3001/api/health
```

Public enhanced-mode status:

```bash
curl http://127.0.0.1:3001/api/login-status
```

Driver from inside the Compose network:

```bash
docker compose exec xhs node -e "require('http').get('http://xhs-driver:8080/api/crawler/status', r => r.pipe(process.stdout)).on('error', e => { console.error(e.message); process.exit(1); })"
```

If the driver is down, normal downloads should remain available and enhanced mode should show maintenance state.

Cookie validation:

```bash
curl -i -X POST http://127.0.0.1:3001/api/enhanced-cookie \
  -H 'Content-Type: application/json' \
  -d '{"cookie":"web_session=invalid"}'
```

Expected result for invalid input:

- HTTP 400 or 503 depending on whether the driver can complete the validation request.
- `/app/runtime/xhs-cookie.json` is not created or is removed.
- `/api/login-status` reports `cookieConfigured: false` and `cookieVerified: false`.

## Troubleshooting

### Build Fails While Cloning MediaCrawler

Cause: GitHub is unreachable or unstable.

Fix:

- Set `MEDIACRAWLER_REPO` to a reachable mirror repository.
- Keep `MEDIACRAWLER_REF` pinned to the compatible commit.

### Build Fails While Downloading Chromium

Cause: Playwright CDN is unreachable.

Fix:

```env
PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
```

Then rebuild:

```bash
docker compose build xhs-driver
docker compose up -d
```

### Enhanced Mode Shows Maintenance

Check:

```bash
docker compose ps
docker compose logs -f xhs-driver
curl http://127.0.0.1:3001/api/login-status
```

Common causes:

- `xhs-driver` is still building or starting.
- Enhanced-mode Cookie has not been submitted from the top-right dialog.
- Cookie format is invalid or missing `web_session`.

### Public Port Is Not Reachable

Default deployment binds to localhost for reverse proxy safety.

For direct public access, set:

```env
XHS_BIND_ADDR=0.0.0.0
```

Then restart:

```bash
docker compose up -d
```

## Deployment Boundary

This guide does not require merging into `main` or `master`. You can deploy any branch by checking out that branch and running:

```bash
docker compose up -d --build
```
