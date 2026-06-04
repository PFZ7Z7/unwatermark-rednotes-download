import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { XiaohongshuService, LoginRequiredError, type NoteInfo } from './services/xiaohongshu';
import { createDownloadJobStore } from './services/downloadJobStore';
import {
  AdminCookieValidationError,
  clearAdminCookie,
  getAdminCookieStatus,
  saveAdminCookie,
} from './services/adminCookieStore';
import { verifyXhsCookie, XhsCookieVerificationError } from './services/xhsCookieValidator';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MEDIACRAWLER_API = process.env.MEDIACRAWLER_API || 'http://localhost:8080';

const ENHANCED_MODE_READY_MESSAGE = '增强模式已可用';
const ENHANCED_MODE_MAINTENANCE_MESSAGE = '增强模式维护中，普通链接下载不受影响';

// 将任意错误归一化为 JSON，登录错误带上 needLogin=true
function sendError(res: Response, err: any, fallbackStatus = 500) {
  const isLoginErr =
    err instanceof LoginRequiredError ||
    (err && err.needLogin === true);
  if (isLoginErr) {
    return res.status(401).json({
      success: false,
      needLogin: true,
      message: err?.message || ENHANCED_MODE_MAINTENANCE_MESSAGE,
      hint: '请在右上角启用增强模式；普通链接下载不受影响'
    });
  }
  return res.status(fallbackStatus).json({
    success: false,
    message: err?.message || '未知错误'
  });
}

// 代理域名白名单，防止被当作公共代理滥用
const PROXY_ALLOWED_HOSTS = (process.env.PROXY_ALLOWED_HOSTS || 'xhscdn.com,xhscdn.net,xiaohongshu.com,xhslink.com')
  .split(',')
  .map(h => h.trim().toLowerCase())
  .filter(Boolean);

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '1mb';
const MAX_ZIP_ITEMS = Math.max(1, Number(process.env.MAX_ZIP_ITEMS || 500));
const MEDIA_ENRICH_CONCURRENCY = Math.max(1, Number(process.env.MEDIA_ENRICH_CONCURRENCY || 5));
const ZIP_COMPRESSION_LEVEL = Math.min(9, Math.max(0, Number(process.env.ZIP_COMPRESSION_LEVEL || 3)));
const DOWNLOAD_JOB_TTL_MS = Math.max(60_000, Number(process.env.DOWNLOAD_JOB_TTL_MS || 30 * 60 * 1000));
const DOWNLOAD_JOB_MAX_JOBS = Math.max(1, Number(process.env.DOWNLOAD_JOB_MAX_JOBS || 50));
const RUNTIME_CLEANUP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.RUNTIME_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000)
);

type DownloadItem = {
  url: string;
  filename: string;
  fallbackUrls?: string[];
};

const DOWNLOAD_JOB_ID_PATTERN = /^[a-f0-9]{24}$/i;
const downloadJobs = createDownloadJobStore<NoteInfo, DownloadItem>({
  ttlMs: DOWNLOAD_JOB_TTL_MS,
  maxJobs: DOWNLOAD_JOB_MAX_JOBS,
});

function isAllowedProxyUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
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
  return String(url).replace(/((?:xsec_token|web_session|token|sign)=)[^&#]+/gi, '$1***');
}

function sanitizeFileSegment(value: unknown, fallback: string): string {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+$/g, '_')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function parseFallbackUrls(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function getSingleParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

function createUniqueFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let i = 2;
  while (used.has(`${base}_${i}${ext}`)) i++;
  const next = `${base}_${i}${ext}`;
  used.add(next);
  return next;
}

function waitForReadableEnd(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

function collectDownloadItems(notes: NoteInfo[]): DownloadItem[] {
  const downloadItems: DownloadItem[] = [];
  const usedFilenames = new Set<string>();
  for (const note of notes) {
    const noteId = sanitizeFileSegment(note?.noteId, 'note');
    if (note.type === 'video' && note.video?.url && isAllowedProxyUrl(note.video.url)) {
      const filename = createUniqueFilename(`${noteId}_video.mp4`, usedFilenames);
      downloadItems.push({
        url: note.video.url,
        filename,
        fallbackUrls: Array.isArray(note.video.backupUrls) ? note.video.backupUrls : undefined,
      });
    } else if (note.images && note.images.length > 0) {
      const livePhotoImageIndexes = new Set<number>();
      if (Array.isArray(note.livePhotos) && note.livePhotos.length > 0) {
        note.livePhotos.forEach((item: any, idx: number) => {
          const liveIndex = Number.isInteger(item?.index) ? Number(item.index) : idx;
          if (isAllowedProxyUrl(item?.imageUrl)) {
            livePhotoImageIndexes.add(liveIndex);
            downloadItems.push({
              url: item.imageUrl,
              filename: createUniqueFilename(`${noteId}_live${liveIndex + 1}.jpg`, usedFilenames),
            });
          }
          if (isAllowedProxyUrl(item?.videoUrl)) {
            downloadItems.push({
              url: item.videoUrl,
              filename: createUniqueFilename(`${noteId}_live${liveIndex + 1}.mp4`, usedFilenames),
              fallbackUrls: Array.isArray(item?.videoUrls)
                ? item.videoUrls.filter((url: string) => url !== item.videoUrl)
                : undefined,
            });
          }
        });
      }

      note.images.forEach((img: string, idx: number) => {
        if (!livePhotoImageIndexes.has(idx) && isAllowedProxyUrl(img)) {
          downloadItems.push({
            url: img,
            filename: createUniqueFilename(`${noteId}_img${idx + 1}.jpg`, usedFilenames),
          });
        }
      });
    }
  }
  return downloadItems;
}

function buildDownloadJobPayload(jobId: string) {
  const progress = downloadJobs.getProgress(jobId);
  if (!progress) return null;
  return {
    ...progress,
    progressUrl: `/api/download-jobs/${jobId}/progress`,
    downloadUrl: `/api/download-jobs/${jobId}/file`,
  };
}

async function streamZipDownloadItems(
  downloadItems: DownloadItem[],
  res: Response,
  options: { jobId?: string } = {}
): Promise<void> {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="xiaohongshu_${Date.now()}.zip"`);

  const archive = archiver('zip', { zlib: { level: ZIP_COMPRESSION_LEVEL } });
  archive.on('warning', (err) => {
    console.warn(`[打包] ZIP 警告: ${err.message}`);
  });
  archive.on('error', (err) => {
    console.error(`[打包] ZIP 错误: ${err.message}`);
    if (options.jobId) downloadJobs.markFailed(options.jobId, err);
    if (!res.destroyed) res.destroy(err);
  });
  archive.pipe(res);

  const failedItems: string[] = [];
  for (const item of downloadItems) {
    const candidateUrls = Array.from(new Set([
      item.url,
      ...(item.fallbackUrls || []),
    ])).filter(isAllowedProxyUrl);
    let added = false;
    let lastError = '';

    for (const candidateUrl of candidateUrls) {
      if (added) break;
      try {
        const response = await axios.get(candidateUrl, {
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.xiaohongshu.com/',
          },
          timeout: 30000,
        });
        if (options.jobId) {
          response.data.on('data', (chunk: Buffer) => {
            downloadJobs.recordFileBytes(options.jobId!, chunk.length);
          });
        }
        archive.append(response.data, { name: item.filename });
        await waitForReadableEnd(response.data);
        if (options.jobId) downloadJobs.recordFileAdded(options.jobId);
        console.log(`[打包] 流式添加: ${item.filename}`);
        added = true;
      } catch (err: any) {
        lastError = err.message;
        console.error(`[打包] 失败: ${item.filename} - ${err.message}`);
      }
    }

    if (!added) {
      failedItems.push(`${item.filename}: ${lastError || '所有备用地址均不可用'}`);
    }
  }

  if (failedItems.length > 0) {
    archive.append(
      `以下文件下载失败，已跳过：\n${failedItems.join('\n')}\n`,
      { name: '_download_errors.txt' }
    );
  }

  await archive.finalize();
}

// CORS 白名单：生产环境通过 ALLOWED_ORIGINS 注入；同源 Nginx 反代场景下会留空，
// 此时不会出现跨域请求（同域），保留白名单仅作纵深防御。
// 开发态默认允许 Vite dev server (5173) 和 backend 本身 (3001)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174,http://localhost:3001,http://127.0.0.1:3001')
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
app.use((req: Request, res: Response, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: JSON_BODY_LIMIT }));

const xhsService = new XiaohongshuService();

async function prepareDownloadJob(jobId: string): Promise<void> {
  const job = downloadJobs.get(jobId);
  if (!job) return;

  try {
    downloadJobs.markEnriching(jobId);
    const enrichedNotes = await xhsService.enrichNotesMedia(
      job.notes,
      MEDIA_ENRICH_CONCURRENCY,
      () => downloadJobs.recordNoteEnriched(jobId)
    );
    const downloadItems = collectDownloadItems(enrichedNotes);
    if (downloadItems.length === 0) {
      throw new Error('没有可下载的内容');
    }
    if (downloadItems.length > MAX_ZIP_ITEMS) {
      throw new Error(`一次最多打包 ${MAX_ZIP_ITEMS} 个文件，请减少选择数量或调整 MAX_ZIP_ITEMS`);
    }
    downloadJobs.setDownloadItems(jobId, downloadItems);
    downloadJobs.markReady(jobId, downloadItems.length);
  } catch (error) {
    downloadJobs.markFailed(jobId, error);
  }
}

type MediaCrawlerSnapshot = {
  driverRunning: boolean;
  message: string;
};

async function getMediaCrawlerSnapshot(): Promise<MediaCrawlerSnapshot> {
  try {
    await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`, { timeout: 5000 });
    return {
      driverRunning: true,
      message: '驱动器运行中',
    };
  } catch {
    return {
      driverRunning: false,
      message: '驱动器未运行',
    };
  }
}

function buildEnhancedModeStatus() {
  const cookieStatus = getAdminCookieStatus();
  return getMediaCrawlerSnapshot().then((crawler) => {
    const enhancedModeAvailable = crawler.driverRunning && cookieStatus.present && cookieStatus.validFormat && cookieStatus.verified;
    return {
      crawler,
      cookieStatus,
      data: {
        mode: 'SHARED_COOKIE',
        canSelfLogin: true,
        driverRunning: crawler.driverRunning,
        loginValid: enhancedModeAvailable,
        enhancedModeAvailable,
        loginMessage: enhancedModeAvailable ? ENHANCED_MODE_READY_MESSAGE : ENHANCED_MODE_MAINTENANCE_MESSAGE,
        hint: enhancedModeAvailable ? null : '请在右上角启用增强模式并提交 Cookie，或等待驱动器恢复',
        cookieConfigured: cookieStatus.present,
        cookieValidFormat: cookieStatus.validFormat,
        cookieVerified: cookieStatus.verified,
        cookieUpdatedAt: cookieStatus.updatedAt,
        cookieValidatedAt: cookieStatus.validatedAt,
        cookieAccount: cookieStatus.account,
      },
    };
  });
}

function clearEnhancedRuntimeState() {
  clearAdminCookie();
  xhsService.clearRuntimeCaches();
}

function runRuntimeCleanup(reason: string) {
  try {
    xhsService.cleanupRuntimeDataRetention(reason);
  } catch (e: any) {
    console.warn(`[保洁] 运行失败（已忽略）: ${e.message}`);
  }
}

const cleanupStartupTimer = setTimeout(() => runRuntimeCleanup('startup'), 10_000);
cleanupStartupTimer.unref?.();
const cleanupInterval = setInterval(() => runRuntimeCleanup('interval'), RUNTIME_CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

// 当前任务ID（用于取消旧任务）
let currentTaskId = 0;

app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', message: '小红书下载服务运行中' });
});

// 检查登录状态
app.get('/api/login-status', async (req: Request, res: Response) => {
  const status = await buildEnhancedModeStatus();
  res.json({ success: true, data: status.data });
});

app.post('/api/enhanced-cookie', async (req: Request, res: Response) => {
  try {
    const verified = await verifyXhsCookie(req.body?.cookie);
    saveAdminCookie(verified.cookie, verified.account);
    xhsService.clearRuntimeCaches();
    const status = await buildEnhancedModeStatus();
    res.json({
      success: true,
      message: verified.account?.nickname
        ? `Cookie 校验通过：${verified.account.nickname}`
        : 'Cookie 已通过实效校验',
      data: status.data,
    });
  } catch (error: any) {
    clearEnhancedRuntimeState();
    if (error instanceof AdminCookieValidationError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error instanceof XhsCookieVerificationError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: '保存 Cookie 失败' });
  }
});

app.post('/api/enhanced-cookie/clear', async (req: Request, res: Response) => {
  clearEnhancedRuntimeState();
  const status = await buildEnhancedModeStatus();
  res.json({
    success: true,
    message: 'Cookie 已清除',
    data: status.data,
  });
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
    const targetRaw = Number(req.query.target);
    const targetCount = Number.isFinite(targetRaw) && targetRaw > 0 ? targetRaw : undefined;
    const progress = await xhsService.getLiveProgress(mode, key, sinceMs);
    res.json({
      success: true,
      data: {
        mode,
        key,
        targetCount,
        count: progress.count,
        parsedCount: progress.parsedCount,
        discoveredCount: progress.discoveredCount,
        detailTaskCount: progress.detailTaskCount,
        status: progress.status,
        taskId: currentTaskId,
      },
    });
  } catch (error: any) {
    // progress 接口不应该因为后端细节出错而让轮询断掉
    res.json({ success: true, data: { count: 0, parsedCount: 0, discoveredCount: 0, detailTaskCount: 0, status: 'unknown', taskId: currentTaskId } });
  }
});

app.post('/api/enrich-note', async (req: Request, res: Response) => {
  try {
    const { note } = req.body || {};
    if (!note || typeof note !== 'object') {
      return res.status(400).json({ success: false, message: '请提供需要补全的笔记' });
    }

    const enriched = await xhsService.enrichNoteMedia(note);
    res.json({ success: true, data: enriched });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || '补全媒体信息失败' });
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

    console.log(`[代理] 视频请求: ${redactUrl(url).substring(0, 100)}...`);

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
    const { url, fallbackUrls } = req.query;
    const candidateUrls = typeof url === 'string'
      ? Array.from(new Set([url, ...parseFallbackUrls(fallbackUrls)])).filter(isAllowedProxyUrl)
      : [];
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, message: '请提供下载链接' });
    }

    if (!isAllowedProxyUrl(url)) {
      return res.status(403).json({ success: false, message: '禁止下载白名单外的域名' });
    }

    let result = null;
    let lastError = '';
    for (const candidateUrl of candidateUrls) {
      try {
        result = await xhsService.downloadFile(candidateUrl);
        break;
      } catch (err: any) {
        lastError = err.message;
        console.warn(`[下载] 候选地址失败: ${redactUrl(candidateUrl)} - ${err.message}`);
      }
    }

    if (!result) {
      return res.status(502).json({ success: false, message: lastError || 'download failed' });
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', result.contentDisposition);
    res.send(result.data);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 创建批量下载任务：后台补全媒体信息，前端轮询进度后用浏览器原生下载 ZIP
app.post('/api/download-jobs', async (req: Request, res: Response) => {
  try {
    const { notes } = req.body;

    if (!notes || !Array.isArray(notes)) {
      return res.status(400).json({ success: false, message: '请提供笔记列表' });
    }

    if (notes.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要下载的笔记' });
    }

    if (notes.length > MAX_ZIP_ITEMS) {
      return res.status(413).json({
        success: false,
        message: `一次最多提交 ${MAX_ZIP_ITEMS} 条笔记，请减少选择数量或调整 MAX_ZIP_ITEMS`,
      });
    }

    const job = downloadJobs.create(notes as NoteInfo[]);
    console.log(`[API] 创建打包任务: jobId=${job.jobId}, notes=${notes.length}`);
    void prepareDownloadJob(job.jobId);

    res.status(202).json({
      success: true,
      data: buildDownloadJobPayload(job.jobId),
    });
  } catch (error: any) {
    console.error('[API] 创建打包任务错误:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/download-jobs/:jobId/progress', async (req: Request, res: Response) => {
  const jobId = getSingleParam(req.params.jobId);
  if (!DOWNLOAD_JOB_ID_PATTERN.test(jobId)) {
    return res.status(400).json({ success: false, message: '下载任务 ID 无效' });
  }

  const payload = buildDownloadJobPayload(jobId);
  if (!payload) {
    return res.status(404).json({ success: false, message: '下载任务不存在或已过期' });
  }

  res.json({ success: true, data: payload });
});

app.get('/api/download-jobs/:jobId/file', async (req: Request, res: Response) => {
  const jobId = getSingleParam(req.params.jobId);
  if (!DOWNLOAD_JOB_ID_PATTERN.test(jobId)) {
    return res.status(400).json({ success: false, message: '下载任务 ID 无效' });
  }

  const job = downloadJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: '下载任务不存在或已过期' });
  }
  if (job.status === 'failed') {
    return res.status(409).json({ success: false, message: job.message || '下载任务失败' });
  }
  if (job.status !== 'ready' || !job.downloadItems?.length) {
    return res.status(409).json({ success: false, message: '下载任务尚未准备完成' });
  }

  try {
    downloadJobs.markDownloading(jobId);
    await streamZipDownloadItems(job.downloadItems, res, { jobId });
    downloadJobs.markCompleted(jobId);
  } catch (error: any) {
    downloadJobs.markFailed(jobId, error);
    console.error('[API] 任务打包错误:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
});

// 批量下载 - 打包成 ZIP（旧接口保留，兼容单帖图片/实况组件下载）
app.post('/api/download-zip', async (req: Request, res: Response) => {
  try {
    const { notes } = req.body;

    if (!notes || !Array.isArray(notes)) {
      return res.status(400).json({ success: false, message: '请提供笔记列表' });
    }

    console.log(`[API] 打包下载: ${notes.length} 个笔记`);
    const enrichedNotes = await xhsService.enrichNotesMedia(notes, MEDIA_ENRICH_CONCURRENCY);
    const downloadItems = collectDownloadItems(enrichedNotes);

    if (downloadItems.length === 0) {
      return res.status(400).json({ success: false, message: '没有可下载的内容' });
    }

    if (downloadItems.length > MAX_ZIP_ITEMS) {
      return res.status(413).json({
        success: false,
        message: `一次最多打包 ${MAX_ZIP_ITEMS} 个文件，请减少选择数量或调整 MAX_ZIP_ITEMS`
      });
    }

    await streamZipDownloadItems(downloadItems, res);

  } catch (error: any) {
    console.error('[API] 打包错误:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message });
    }
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
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
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
