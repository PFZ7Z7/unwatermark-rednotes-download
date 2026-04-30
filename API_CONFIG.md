# 小红书无水印下载工具 - API配置指南

## 问题说明

小红书有严格的反爬机制：
1. **PC端限制** - 部分笔记显示"当前笔记暂时无法浏览"，需要扫码
2. **API签名验证** - 需要复杂的签名参数（x-s, x-t等）
3. **移动端限制** - 同样有访问限制

## 解决方案

### 方案1: 使用第三方解析API（推荐）

市面上有多个提供小红书解析API的服务：

| 服务商 | 说明 | 价格 |
|--------|------|------|
| 易解析 | 提供小红书视频/图片解析 | 搜索了解 |
| 红薯库 | 专门的小红书解析 | 搜索了解 |
| RapidAPI | 国际API平台 | 搜索"xiaohongshu" |

**配置方法：**

1. 购买/注册一个API服务
2. 在 `backend/.env` 文件中配置：

```env
XHS_API_URL=https://api.xxx.com/xiaohongshu/parse
XHS_API_KEY=your_api_key_here
```

### 方案2: 自建解析服务

如果你有能力逆向小红书签名算法，可以自建解析服务：

1. 逆向小红书Web端签名算法（x-s, x-t参数）
2. 部署一个解析服务
3. 配置 `SELF_API_URL`

### 方案3: 使用Cookie + Playwright

通过登录后获取Cookie，绕过部分限制：

```typescript
// 在代码中添加Cookie配置
const cookies = [
  { name: 'a1', value: 'your_a1_cookie' },
  { name: 'webId', value: 'your_webId' },
];
await context.addCookies(cookies);
```

## 部署到服务器

### 服务器环境要求

- Debian Linux
- Node.js 18+
- PM2（进程管理）
- Nginx（反向代理）

### 部署步骤

```bash
# 1. 上传代码到服务器
scp -r xiaohongshv-clone user@server:/var/www/

# 2. 安装依赖
cd /var/www/xiaohongshv-clone/backend
npm install
cd ../frontend
npm install
npm run build

# 3. 配置环境变量
cd ../backend
nano .env  # 配置API地址和密钥

# 4. 使用PM2启动后端
pm2 start npm --name "xhs-api" -- run start
pm2 save

# 5. 配置Nginx
# 见下方Nginx配置
```

### Nginx配置

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 前端静态文件
    location / {
        root /var/www/xiaohongshv-clone/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # 后端API
    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 推荐的第三方API

以下是几个常见的解析API（请自行搜索了解）：

1. **易解析** - 支持多种平台解析
2. **各大API市场** - RapidAPI、APIStore等
3. **开源项目** - GitHub搜索"xiaohongshu parser"

---

**下一步：**

请告诉我：
1. 你是否有第三方API的地址和密钥？
2. 或者你想让我帮你搜索可用的API服务？
3. 或者你已经有服务器信息，我可以帮你部署？