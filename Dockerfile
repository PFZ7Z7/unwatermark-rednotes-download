# syntax=docker/dockerfile:1.6
# ─────────────────────────────────────────────────────────────
# 小红书无水印下载工具 · 单镜像多阶段构建
# 架构：前端构建 → 后端构建 → 精简 runtime
# 运行时：express 托管前端静态资源 + /api，3001 端口单入口
# MediaCrawler 不在本镜像内，通过 host.docker.internal:8080 访问
# ─────────────────────────────────────────────────────────────

# ============ Stage 1: 前端构建 ============
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend

# 先装依赖（缓存层）
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# 再拷源码 build
COPY frontend/ ./
RUN npm run build
# 产物：/app/frontend/dist


# ============ Stage 2: 后端构建（含 native 模块编译） ============
FROM node:20-slim AS backend-build
WORKDIR /app/backend

# better-sqlite3 需要编译 native 模块：python3 + make + g++
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖（包含 devDependencies，tsc 需要 @types/*）
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# 编译 TypeScript
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build
# 产物：/app/backend/dist

# 精简为生产依赖（丢掉 typescript/@types 等）
RUN npm prune --omit=dev


# ============ Stage 3: runtime（最小镜像） ============
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV FRONTEND_DIST=/app/frontend-dist

# 非 root 运行
RUN groupadd -r xhs && useradd -r -g xhs -d /app -s /usr/sbin/nologin xhs

# 后端：package.json 用于 node 解析模块 + 精简后的 node_modules + 编译产物
COPY --from=backend-build --chown=xhs:xhs /app/backend/package.json ./package.json
COPY --from=backend-build --chown=xhs:xhs /app/backend/node_modules ./node_modules
COPY --from=backend-build --chown=xhs:xhs /app/backend/dist ./dist

# 前端静态产物
COPY --from=frontend-build --chown=xhs:xhs /app/frontend/dist ./frontend-dist

USER xhs
EXPOSE 3001

# 健康检查：/api/health 必须 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3001/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
