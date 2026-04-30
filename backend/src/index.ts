import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { XiaohongshuService, LoginRequiredError, detectLoginState } from './services/xiaohongshu';
import { runWithConcurrency } from './utils/perf';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// 将任意错误归一化为 JSON，登录错误带上 needLogin=true
function sendError(res: Response, err: any, fallbackStatus = 500) {
  const isLoginErr =
    err instanceof LoginRequiredError ||
    (err && err.needLogin === true);
  if (isLoginErr) {
    return res.status(401).json({
      success: false,
      needLogin: true,
      message: err?.message || '登录状态失效，请先扫码登录',
      hint: '点击「扫码登录」按钮进行登录'
    });
  }
  return res.status(fallbackStatus).json({
    success: false,
    message: err?.message || '未知错误'
  });
}

// 代理域名白名单，防止被当作公共代理滥用
const PROXY_ALLOWED_HOSTS = (process.env.PROXY_ALLOWED_HOSTS || 'xhscdn.com,xiaohongshu.com,xhslink.com')
  .split(',')
  .map(h => h.trim())
  .filter(Boolean);

function isAllowedProxyUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return PROXY_ALLOWED_HOSTS.some(allow => host === allow || host.endsWith('.' + allow));
  } catch {
    return false;
  }
}

// 日志脱敏：去掉 URL 里的 xsec_token，避免临时凭证落到日志文件
// 兼容多种参数顺序，匹配到就替换为 ***（保留参数本身用于排查）
function redactUrl(url: string): string {
  if (!url) return url;
  return String(url).replace(/(xsec_token=)[^&#]+/gi, '$1***');
}

// CORS 白名单：生产环境通过 ALLOWED_ORIGINS 注入；同源 Nginx 反代场景下会留空，
// 此时不会出现跨域请求（同域），保留白名单仅作纵深防御。
// 开发态默认允许 Vite dev server (5173) 和 backend 本身 (3001)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3001')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // 允许无 Origin（同源请求 / curl / 健康检查）
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS 拒绝: ${origin} 不在白名单`));
  },
  credentials: true,
}));
app.use(express.json());

const xhsService = new XiaohongshuService();

// 当前任务ID（用于取消旧任务）
let currentTaskId = 0;

app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', message: '小红书下载服务运行中' });
});

// 检查登录状态
app.get('/api/login-status', async (req: Request, res: Response) => {
  try {
    const MEDIACRAWLER_API = process.env.MEDIACRAWLER_API || 'http://localhost:8080';

    // 检查 MediaCrawler 是否运行
    await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`, { timeout: 5000 });

    // 统一登录态检测（兼容新旧版 Chromium 的 Cookies 路径）
    const state = detectLoginState();

    res.json({
      success: true,
      data: {
        mediaCrawlerRunning: true,
        loginValid: state.valid,
        loginMessage: state.message,
        hint: state.valid ? null : '点击「扫码登录」按钮进行登录'
      }
    });
  } catch (error: any) {
    res.json({
      success: false,
      data: {
        mediaCrawlerRunning: false,
        loginValid: false,
        loginMessage: 'MediaCrawler 服务未运行',
        hint: '请启动 MediaCrawler 服务'
      }
    });
  }
});

// 触发登录（启动带界面的爬虫）
app.post('/api/login', async (req: Request, res: Response) => {
  try {
    const MEDIACRAWLER_API = process.env.MEDIACRAWLER_API || 'http://localhost:8080';

    // 启动一个带界面的搜索任务来触发登录
    const response = await axios.post(`${MEDIACRAWLER_API}/api/crawler/start`, {
      platform: 'xhs',
      login_type: 'qrcode',  // 使用二维码登录
      crawler_type: 'search',
      keywords: 'test',
      enable_comments: false,
      save_option: 'json',
      headless: false  // 显示浏览器界面
    }, { timeout: 30000 });

    res.json({
      success: true,
      message: '请在弹出的浏览器窗口中扫码登录',
      hint: '登录成功后，关闭浏览器窗口即可'
    });
  } catch (error: any) {
    console.error('[API] 登录启动错误:', error.message);
    res.status(500).json({
      success: false,
      message: '启动登录失败: ' + error.message,
      hint: '请手动在终端运行: cd MediaCrawler && python main.py --platform xhs --lt qrcode --type search --keywords test --headless false'
    });
  }
});

// 退出登录：清理 MediaCrawler 浏览器数据里的 Cookies 文件，下次再用需要重新扫码
//   - 先停掉可能还在跑的 crawler 子进程，避免 Windows 上 Cookies 文件被占用
//   - 删除 Cookies 及其 SQLite 伴随文件（-journal/-wal/-shm），保留 browser_data 其他配置
app.post('/api/logout', async (req: Request, res: Response) => {
  console.log('[API] 退出登录请求');
  // 1. 停止可能占用 Cookies 文件的 crawler 进程
  try {
    await xhsService.stopCrawler();
  } catch (err: any) {
    console.warn(`[API] 退出登录时 stopCrawler 异常（已忽略）: ${err.message}`);
  }

  // 2. 定位并删除 Cookies 文件（及 SQLite 伴随文件）
  const state = detectLoginState();
  if (!state.cookiesFile) {
    return res.json({ success: true, message: '当前无登录状态，无需退出' });
  }
  const base = state.cookiesFile;
  const targets = [base, `${base}-journal`, `${base}-wal`, `${base}-shm`];
  const removed: string[] = [];
  const failed: { path: string; err: string }[] = [];
  for (const p of targets) {
    if (!fs.existsSync(p)) continue;
    try {
      fs.unlinkSync(p);
      removed.push(path.basename(p));
    } catch (err: any) {
      // Windows 文件占用时降级为清空内容，让 detectLoginState 判定为无效
      try {
        fs.truncateSync(p, 0);
        removed.push(path.basename(p) + '(truncated)');
      } catch (err2: any) {
        failed.push({ path: p, err: err2.message || err.message });
      }
    }
  }

  if (failed.length > 0) {
    console.error('[API] 退出登录部分失败:', failed);
    return res.status(500).json({
      success: false,
      message: '退出失败，文件可能被占用：' + failed.map(f => path.basename(f.path)).join(', '),
      hint: '请先关闭残留的浏览器窗口后重试'
    });
  }

  console.log(`[API] 退出登录完成，已清理: ${removed.join(', ')}`);
  res.json({ success: true, message: '已退出登录', removed });
});

// 取消当前任务：不仅序号 +1，还要真正通知 MediaCrawler 停止子进程
app.post('/api/cancel', async (req: Request, res: Response) => {
  currentTaskId++;
  console.log(`[API] 取消任务，新任务ID: ${currentTaskId}`);
  // 即使 MediaCrawler 停止失败也应返回 success（前端已不再关心旧任务结果）
  try {
    await xhsService.stopCrawler();
  } catch (err: any) {
    console.warn(`[API] 取消时 stopCrawler 异常（已忽略）: ${err.message}`);
  }
  res.json({ success: true, message: '已取消当前任务' });
});

// 提前结束当前任务：只停 MediaCrawler 子进程，不递增 currentTaskId。
// 正在进行的 search/creator 请求会触发 waitForCrawlerComplete 中因 status 变为 idle 而正常退出，
// 然后继续读已爬到的部分数据并返回。跟 /api/cancel 的区别是：提前结束保留结果，取消丢弃结果。
app.post('/api/finish-early', async (req: Request, res: Response) => {
  console.log(`[API] 提前结束当前任务，保留已爬结果`);
  try {
    await xhsService.stopCrawler();
    res.json({ success: true, message: '已提前结束，正在整理已爬到的数据...' });
  } catch (err: any) {
    console.warn(`[API] 提前结束时 stopCrawler 异常（已忽略）: ${err.message}`);
    res.json({ success: true, message: '已提前结束' });
  }
});

// 解析单个笔记
app.post('/api/parse', async (req: Request, res: Response) => {
  const taskId = ++currentTaskId;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, message: '请提供小红书链接' });
    }

    console.log(`[API] 任务${taskId} 解析笔记: ${redactUrl(url)}`);
    const noteDetail = await xhsService.getNoteDetail(url, taskId, () => taskId === currentTaskId);

    // 检查任务是否被取消
    if (taskId !== currentTaskId) {
      console.log(`[API] 任务${taskId} 已被取消`);
      return res.status(499).json({ success: false, message: '任务已取消' });
    }

    res.json({ success: true, data: noteDetail });
  } catch (error: any) {
    console.error('[API] 解析错误:', error.message);
    if (taskId === currentTaskId) {
      sendError(res, error);
    }
  }
});

// 获取当前爬取进度（前端搜索/博主中轮询）
//   GET /api/progress?mode=search&key=搜索关键词&since=任务开始时间戳(ms)
//   GET /api/progress?mode=creator&key=博主用户ID&since=任务开始时间戳(ms)
app.get('/api/progress', async (req: Request, res: Response) => {
  try {
    const rawMode = String(req.query.mode || 'search');
    const mode: 'search' | 'creator' = rawMode === 'creator' ? 'creator' : 'search';
    const key = String(req.query.key || '');
    const sinceRaw = Number(req.query.since);
    const sinceMs = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;
    const progress = await xhsService.getLiveProgress(mode, key, sinceMs);
    res.json({
      success: true,
      data: {
        mode,
        key,
        count: progress.count,
        status: progress.status,
        taskId: currentTaskId,
      },
    });
  } catch (error: any) {
    // progress 接口不应该因为后端细节出错而让轮询断掉
    res.json({ success: true, data: { count: 0, status: 'unknown', taskId: currentTaskId } });
  }
});

// 关键词搜索
app.post('/api/search', async (req: Request, res: Response) => {
  const taskId = ++currentTaskId;

  try {
    const { keywords, maxCount = 20 } = req.body;

    if (!keywords) {
      return res.status(400).json({ success: false, message: '请提供搜索关键词' });
    }

    console.log(`[API] 任务${taskId} 搜索关键词: ${keywords}`);
    const notes = await xhsService.searchNotes(keywords, maxCount, taskId, () => taskId === currentTaskId);

    // 检查任务是否被取消
    if (taskId !== currentTaskId) {
      console.log(`[API] 任务${taskId} 已被取消`);
      return res.status(499).json({ success: false, message: '任务已取消' });
    }

    res.json({ success: true, data: notes });
  } catch (error: any) {
    console.error('[API] 搜索错误:', error.message);
    if (taskId === currentTaskId) {
      sendError(res, error);
    }
  }
});

// 获取博主笔记
app.post('/api/creator', async (req: Request, res: Response) => {
  const taskId = ++currentTaskId;

  try {
    const { url, maxCount = 30 } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, message: '请提供博主主页链接' });
    }

    console.log(`[API] 任务${taskId} 获取博主笔记: ${redactUrl(url)}`);
    const notes = await xhsService.getCreatorNotes(url, maxCount, taskId, () => taskId === currentTaskId);

    // 检查任务是否被取消
    if (taskId !== currentTaskId) {
      console.log(`[API] 任务${taskId} 已被取消`);
      return res.status(499).json({ success: false, message: '任务已取消' });
    }

    res.json({ success: true, data: notes });
  } catch (error: any) {
    console.error('[API] 获取博主笔记错误:', error.message);
    if (taskId === currentTaskId) {
      sendError(res, error);
    }
  }
});

// 视频代理 - 解决浏览器无法直接播放的问题
app.get('/api/proxy/video', async (req: Request, res: Response) => {
  try {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, message: '请提供视频链接' });
    }

    if (!isAllowedProxyUrl(url)) {
      return res.status(403).json({ success: false, message: '禁止代理白名单外的域名' });
    }

    console.log(`[代理] 视频请求: ${url.substring(0, 100)}...`);

    const response = await axios.get(url, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.xiaohongshu.com/',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: 60000
    });

    // 设置响应头
    const contentType = String(response.headers['content-type'] || 'video/mp4');
    const contentLength = response.headers['content-length'];

    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', String(contentLength));
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 流式传输
    response.data.pipe(res);

  } catch (error: any) {
    console.error('[代理] 视频代理错误:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 图片代理 - 解决跨域问题
app.get('/api/proxy/image', async (req: Request, res: Response) => {
  try {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, message: '请提供图片链接' });
    }

    if (!isAllowedProxyUrl(url)) {
      return res.status(403).json({ success: false, message: '禁止代理白名单外的域名' });
    }

    const response = await axios.get(url, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.xiaohongshu.com/',
      },
      timeout: 30000
    });

    const contentType = String(response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');

    response.data.pipe(res);

  } catch (error: any) {
    console.error('[代理] 图片代理错误:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 下载单个文件
app.get('/api/download', async (req: Request, res: Response) => {
  try {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, message: '请提供下载链接' });
    }

    if (!isAllowedProxyUrl(url)) {
      return res.status(403).json({ success: false, message: '禁止下载白名单外的域名' });
    }

    const result = await xhsService.downloadFile(url);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', result.contentDisposition);
    res.send(result.data);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 批量下载 - 打包成ZIP
app.post('/api/download-zip', async (req: Request, res: Response) => {
  try {
    const { notes } = req.body;

    if (!notes || !Array.isArray(notes)) {
      return res.status(400).json({ success: false, message: '请提供笔记列表' });
    }

    console.log(`[API] 打包下载: ${notes.length} 个笔记`);

    // 收集所有下载URL（同时过滤白名单外的链接）
    const downloadItems: { url: string; filename: string }[] = [];
    for (const note of notes) {
      if (note.type === 'video' && note.video?.url && isAllowedProxyUrl(note.video.url)) {
        downloadItems.push({
          url: note.video.url,
          filename: `${note.noteId}_video.mp4`
        });
      } else if (note.images && note.images.length > 0) {
        note.images.forEach((img: string, idx: number) => {
          if (isAllowedProxyUrl(img)) {
            downloadItems.push({
              url: img,
              filename: `${note.noteId}_img${idx + 1}.jpg`
            });
          }
        });
      }
    }

    if (downloadItems.length === 0) {
      return res.status(400).json({ success: false, message: '没有可下载的内容' });
    }

    // 设置响应头
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="xiaohongshu_${Date.now()}.zip"`);

    // 创建zip流
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // 并发下载（默认 5 路并发，可通过 DOWNLOAD_CONCURRENCY 调整）
    const concurrency = Math.max(1, Number(process.env.DOWNLOAD_CONCURRENCY || 5));
    const buffers = await runWithConcurrency(downloadItems, concurrency, async (item) => {
      try {
        const response = await axios.get(item.url, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.xiaohongshu.com/',
          },
          timeout: 30000
        });
        return { ok: true as const, item, data: Buffer.from(response.data) };
      } catch (err: any) {
        console.error(`[打包] 失败: ${item.filename} - ${err.message}`);
        return { ok: false as const, item, error: err.message as string };
      }
    });

    // 按原顺序 append 到 zip（archiver 内部是流，顺序添加更高效）
    for (const r of buffers) {
      if (r.ok) {
        archive.append(r.data, { name: r.item.filename });
        console.log(`[打包] 添加: ${r.item.filename}`);
      }
    }

    await archive.finalize();

  } catch (error: any) {
    console.error('[API] 打包错误:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ───────────────────────────────────────────────────────────
// 前端静态资源托管（Docker / 单机自包含部署）
// ───────────────────────────────────────────────────────────
// 约定：容器内前端产物放在 /app/frontend-dist，可通过 FRONTEND_DIST 覆盖。
// 必须放在所有 /api 路由之后，避免拦截 API 请求。
// 只对非 /api GET 请求兜底 index.html，支持前端 SPA 路由。
const FRONTEND_DIST = process.env.FRONTEND_DIST
  || path.resolve(__dirname, '../frontend-dist');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST, { maxAge: '1h', index: false }));
  app.use((req: Request, res: Response, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'), (err: any) => {
      if (err) next(err);
    });
  });
  console.log(`[static] 前端静态资源托管自: ${FRONTEND_DIST}`);
} else {
  console.log(`[static] 未检测到 ${FRONTEND_DIST}，跳过前端托管（纯 API 模式）`);
}

// 启动前的必填配置校验：生产环境决不能跑默认值
function validateConfigOrExit() {
  const isProd = process.env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  // 生产环境必须显式设置 ALLOWED_ORIGINS
  if (isProd && !process.env.ALLOWED_ORIGINS) {
    errors.push('ALLOWED_ORIGINS 未设置（生产环境必填，逗号分隔的前端域名列表）');
  }
  // MediaCrawler 路径：警告不屏蔡，避免运行时才报错
  const browserPath = process.env.MEDIACRAWLER_BROWSER_DATA;
  if (!browserPath) {
    warnings.push('MEDIACRAWLER_BROWSER_DATA 未设置，将使用默认相对路径 ../MediaCrawler/browser_data/xhs_user_data_dir，生产环境建议设为绝对路径');
  } else if (!path.isAbsolute(browserPath)) {
    warnings.push(`MEDIACRAWLER_BROWSER_DATA 为相对路径（${browserPath}），生产环境建议改用绝对路径避免 cwd 依赖`);
  }
  if (errors.length > 0) {
    console.error('\n❌ 配置校验失败，服务拒绝启动：');
    errors.forEach(e => console.error(`   • ${e}`));
    console.error('\n请参考 backend/.env.example 填写 .env 后重试\n');
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.warn('\n⚠️  配置警告：');
    warnings.forEach(w => console.warn(`   • ${w}`));
    console.warn('');
  }
}

validateConfigOrExit();

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║   📕 小红书无水印下载服务              ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║   🚀 端口: ${PORT}                          ║`);
  console.log(`║   🌍 环境: ${process.env.NODE_ENV || 'development'}                  ║`);
  console.log(`║   🔒 CORS: ${ALLOWED_ORIGINS.length} 个允许源                    ║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
});
