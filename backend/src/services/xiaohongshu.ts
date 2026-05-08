import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { TTLCache } from '../utils/perf';
import { parseNoteAnonymous, AnonymousParseError, AnonymousNoteRaw } from './anonymousParser';

interface NoteInfo {
  noteId: string;
  title: string;
  desc: string;
  type: 'image' | 'video';
  author: { nickname: string; avatar: string; userId?: string; };
  images: string[];
  livePhotos?: Array<{ imageUrl: string; videoUrl: string; videoUrls?: string[]; index: number; duration: number }>;
  video?: { url: string; duration: number; backupUrls?: string[] };
  likes: number;
  collects: number;
  comments: number;
  shares?: number;
  publishTime?: number;
  ipLocation?: string;
  tags?: Array<{ id: string; name: string; type: string }>;
  noteUrl?: string;      // 笔记原地址
  creatorUrl?: string;   // 博主主页地址
  hasWatermark?: boolean; // 视频是否疑似带水印（无法拿到 origin_video_key 时为 true）
  parseMode?: 'anonymous' | 'mediacrawler'; // 数据来源：匿名直解 or MediaCrawler 爬取
}

interface DownloadResult {
  data: Buffer;
  contentType: string;
  contentDisposition: string;
}

// 登录失效专用异常类，方便上层识别
export class LoginRequiredError extends Error {
  readonly needLogin = true;
  constructor(message = '登录状态失效，请先扫码登录') {
    super(message);
    this.name = 'LoginRequiredError';
  }
}

// MediaCrawler API 地址
const MEDIACRAWLER_API = process.env.MEDIACRAWLER_API || 'http://localhost:8080';

// MediaCrawler 爬取并发度（透传给 --max_concurrency_num）
const MEDIACRAWLER_CONCURRENCY = Number(process.env.MEDIACRAWLER_CONCURRENCY || 8);

// 结果缓存：相同关键词 / 博主 + 数量 在 TTL 内复用上一次结果，避免重启 Chromium + 重新爬取
const RESULT_CACHE_TTL_MS = Number(process.env.RESULT_CACHE_TTL_MS || 5 * 60 * 1000); // 默认 5 分钟
const resultCache = new TTLCache<NoteInfo[]>(RESULT_CACHE_TTL_MS, 50);
const noteDetailCache = new TTLCache<NoteInfo>(RESULT_CACHE_TTL_MS, 100);

// 运行时数据保留策略：只清理 MediaCrawler data 目录下的 JSON 输出，不碰浏览器登录数据。
const RUNTIME_DATA_RETENTION_DAYS = Number(process.env.RUNTIME_DATA_RETENTION_DAYS || 3);
const RUNTIME_DATA_MAX_JSON_FILES = Number(process.env.RUNTIME_DATA_MAX_JSON_FILES || 200);

// 无水印视频的 CDN 特征（MediaCrawler 拿到 origin_video_key 时会拼成这个域名）
// 无水印视频的 CDN 特征（小红书当前可观察到的视频域名规律：sns-video-*.xhscdn.com / .xhscdn.net）
// 具体子域名会根据 CDN 调度变（bd/hw/qc/al/v1/v6 等），不保留精确列表
// 这条匹配规则涵盖 MediaCrawler 和匿名直解两条路径拿到的无水印源
const NO_WATERMARK_VIDEO_HOST_PATTERN = /^sns-video-[a-z0-9]+\.xhscdn\.(com|net)$/i;

const CLEAN_XHS_URL_PATTERN = /https?:\/\/[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2600-\u27bf]+/i;
const TRAILING_SHARE_PUNCTUATION_PATTERN = /[。，；：、”》）]+$/g;
const XHSLINK_PATTERN = /xhslink\.com\/([a-zA-Z0-9/]+)/;
const FULL_URL_PATTERNS = [
  /xiaohongshu\.com\/explore\/([a-zA-Z0-9]+)\?[^}]*xsec_token=/,
  /xiaohongshu\.com\/discovery\/item\/([a-zA-Z0-9]+)\?[^}]*xsec_token=/,
] as const;
const NOTE_ID_PATTERNS = [
  /xiaohongshu\.com\/explore\/([a-zA-Z0-9]+)/,
  /xiaohongshu\.com\/discovery\/item\/([a-zA-Z0-9]+)/,
  /^([a-zA-Z0-9]{24})$/,
] as const;
const USER_PROFILE_PATTERN = /user\/profile\/([a-zA-Z0-9]+)/;
const UNICODE_SLASH_PATTERN = /\\u002F/g;
const WATERMARK_PATH_PATTERN = /\/watermark\/.*/g;

function parseMetric(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解析浏览器数据目录绝对路径（支持相对/绝对路径）
 */
export function resolveBrowserDataPath(): string {
  const rawPath = process.env.MEDIACRAWLER_BROWSER_DATA
    || '../MediaCrawler/browser_data/xhs_user_data_dir';
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

/**
 * 解析 MediaCrawler 数据目录（存放爬取生成的 JSON/CSV 文件）
 * 默认与 MediaCrawler 项目同层（../MediaCrawler/data），可通过 MEDIACRAWLER_DATA_DIR 覆盖
 */
export function resolveMediaCrawlerDataDir(): string {
  const rawPath = process.env.MEDIACRAWLER_DATA_DIR || '../MediaCrawler/data';
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function isPathInsideDir(target: string, dir: string): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + path.sep);
}

function listJsonFilesRecursive(dir: string, root = dir): Array<{ abs: string; rel: string; mtimeMs: number; size: number }> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: Array<{ abs: string; rel: string; mtimeMs: number; size: number }> = [];

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (!isPathInsideDir(abs, root)) continue;

    if (entry.isDirectory()) {
      files.push(...listJsonFilesRecursive(abs, root));
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const stat = fs.statSync(abs);
    files.push({
      abs,
      rel: path.relative(root, abs),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }

  return files;
}

/**
 * 在多个候选路径中定位 Cookies 文件。
 * - 新版 Chromium (v96+): Default/Network/Cookies
 * - 旧版 Chromium / Playwright 早期版本: Default/Cookies
 * 返回第一个实际存在的绝对路径；都不存在则返回 null。
 */
export function findChromiumCookiesFile(browserDataPath: string): string | null {
  const candidates = [
    path.join(browserDataPath, 'Default', 'Network', 'Cookies'),
    path.join(browserDataPath, 'Default', 'Cookies'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 校验 Chromium Cookies SQLite 中是否存在有效的小红书 web_session cookie
 *
 * 仅靠文件大小判断不可靠：浏览器一打开扫码页就会写入大量基础 cookie（设备指纹/A/B 测试 ID/
 * 临时凭证），文件可轻易破 KB 级，但只有真正扫码登录后才会写入 `web_session` 字段。
 * 这里用 SQLite 直接读 cookies 表，校验 web_session 是否存在 + 未过期。
 *
 * 注意：
 * - readonly 模式打开，与 Playwright 持有的 SQLite 写者并存（WAL 模式下安全）
 * - Chromium 的 expires_utc 是「自 1601-01-01 UTC 起的微秒数」，0 表示 session cookie
 */
function checkWebSessionValid(cookiesFile: string): { valid: boolean; reason: string } {
  // 延迟 require 避免冷启动开销；better-sqlite3 是同步 native 模块
  let Database: typeof import('better-sqlite3');
  try {
    Database = require('better-sqlite3');
  } catch (e: any) {
    return { valid: false, reason: `better-sqlite3 未安装: ${e.message}` };
  }

  let db: import('better-sqlite3').Database | null = null;
  try {
    db = new Database(cookiesFile, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT host_key, expires_utc FROM cookies
         WHERE name = 'web_session' AND host_key LIKE '%xiaohongshu.com'`
      )
      .all() as Array<{ host_key: string; expires_utc: number }>;

    if (rows.length === 0) {
      return { valid: false, reason: '未检测到 web_session（请扫码登录）' };
    }

    // Chromium 时间戳转换：当前时间转为 Chromium UTC 微秒
    const CHROMIUM_EPOCH_DIFF_US = 11644473600000000;
    const nowChromiumUtc = Date.now() * 1000 + CHROMIUM_EPOCH_DIFF_US;
    const stillValid = rows.some(
      (r) => r.expires_utc === 0 || r.expires_utc > nowChromiumUtc
    );
    if (!stillValid) {
      return { valid: false, reason: 'web_session 已过期，请重新扫码登录' };
    }
    return { valid: true, reason: 'web_session 有效' };
  } catch (e: any) {
    return { valid: false, reason: `Cookies 校验失败: ${e.message}` };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * 统一的登录态检测逻辑 (login-status 接口 和 assertLoginValid 共用)
 *
 * 判定层级：
 *   1. 浏览器数据目录存在
 *   2. Cookies 文件存在（兼容新旧版 Chromium 路径）
 *   3. 文件大小 > 1KB（快速过滤明显空库）
 *   4. SQLite 中存在未过期的 web_session cookie ← 真正的登录凭证
 */
export function detectLoginState(): {
  valid: boolean;
  message: string;
  cookiesFile: string | null;
  cookiesSize: number;
} {
  const browserDataPath = resolveBrowserDataPath();
  if (!fs.existsSync(browserDataPath)) {
    return { valid: false, message: '浏览器数据目录不存在，请先扫码登录', cookiesFile: null, cookiesSize: 0 };
  }
  const cookiesFile = findChromiumCookiesFile(browserDataPath);
  if (!cookiesFile) {
    return { valid: false, message: '未找到 Cookies 文件，请先扫码登录', cookiesFile: null, cookiesSize: 0 };
  }
  const size = fs.statSync(cookiesFile).size;
  if (size <= 1024) {
    return { valid: false, message: '登录数据无效或已过期，请重新扫码登录', cookiesFile, cookiesSize: size };
  }

  // 关键校验：SQLite 中必须存在未过期的 web_session
  const sessionCheck = checkWebSessionValid(cookiesFile);
  if (!sessionCheck.valid) {
    return { valid: false, message: sessionCheck.reason, cookiesFile, cookiesSize: size };
  }

  return { valid: true, message: '登录状态正常', cookiesFile, cookiesSize: size };
}

export class XiaohongshuService {

  /**
   * 前置校验：确保 MediaCrawler 服务运行且登录态有效
   * - MediaCrawler 未运行 => LoginRequiredError
   * - Cookies 文件不存在/过小 => LoginRequiredError
   * 调用方法：searchNotes / getNoteDetail / getCreatorNotes 开头调用。
   */
  private async assertLoginValid(): Promise<void> {
    // 1. MediaCrawler 服务是否在线
    try {
      await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`, { timeout: 5000 });
    } catch {
      throw new LoginRequiredError('MediaCrawler 服务未运行，无法校验登录态');
    }

    // 2. 统一登录态检测（与 /api/login-status 同源）
    const { valid, message } = detectLoginState();
    if (!valid) {
      throw new LoginRequiredError(message);
    }
  }

  /**
   * 检查爬虫是否正在运行，如果正在运行则等待完成
   */
  private async ensureCrawlerReady(isTaskActive?: () => boolean): Promise<void> {
    const maxWait = 180; // 最多等待3分钟
    let waited = 0;

    while (waited < maxWait) {
      // 检查任务是否被取消
      if (isTaskActive && !isTaskActive()) {
        throw new Error('任务已取消');
      }

      const statusResponse = await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`);
      if (statusResponse.data.status !== 'running') {
        return;
      }
      await this.sleep(1000);
      waited++;
      if (waited % 10 === 0) {
        console.log(`[等待] 爬虫正在运行，等待中... (${waited}s)`);
      }
    }
    throw new Error('爬虫任务超时，请稍后重试');
  }

  /**
   * 解析短链接，获取真实URL
   */
  async resolveShortUrl(shortUrl: string): Promise<string | null> {
    try {
      console.log(`[解析短链接] ${shortUrl}`);
      const response = await axios.get(shortUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400 || status === 301 || status === 302,
        timeout: 10000
      });

      // 检查重定向头
      const redirectUrl = response.headers['location'];
      if (redirectUrl) {
        console.log(`[解析短链接] 重定向到: ${redirectUrl}`);
        return redirectUrl;
      }
      return null;
    } catch (error: any) {
      // 对于重定向，axios会抛出错误，但我们可以从错误中获取location
      if (error.response?.headers?.location) {
        return error.response.headers.location;
      }
      console.error(`[解析短链接] 失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 从粘贴文本中提取干净的小红书 URL（去除中文标题/表情/分享码等噪音）
   * 小红书分享文案常见格式：
   *   "55 【标题】 😆 TKxxxx 😆 https://www.xiaohongshu.com/..."
   * 实现思路：正则匹配首个 xiaohongshu.com 的 URL，终止于空白/中文字符
   */
  private extractCleanXhsUrl(raw: string): string | null {
    // 匹配 "http(s)://...xiaohongshu.com/..." ，终止于空白或非 URL 合法字符
    // URL 合法字符集：字母数字 - . _ ~ : / ? # [ ] @ ! $ & ' ( ) * + , ; = %
    const m = raw.match(CLEAN_XHS_URL_PATTERN);
    if (!m) return null;
    let url = m[0];
    // 尾部有时会粘到标点，去一下
    url = url.replace(TRAILING_SHARE_PUNCTUATION_PATTERN, '');
    return url;
  }

  /**
   * 从URL中提取笔记ID或完整URL
   * 如果URL包含xsec_token，返回完整URL；否则返回笔记ID
   */
  async parseNoteUrl(url: string): Promise<{ noteId: string; fullUrl: string | null }> {
    url = url.trim();

    // 0. 粘贴文案预处理：从可能含中文/表情的文本中抽纯 URL
    const cleaned = this.extractCleanXhsUrl(url);
    if (cleaned) {
      url = cleaned;
    }

    // 1. xhslink 短链需要先展开
    const xhslinkMatch = url.match(XHSLINK_PATTERN);
    if (xhslinkMatch) {
      const realUrl = await this.resolveShortUrl(url.startsWith('http') ? url : `https://${url}`);
      if (realUrl) {
        url = realUrl;
      }
    }

    // 2. 保留用户原始路径（/explore/ 或 /discovery/item/），两种格式都是合法入口。
    //   匹配失败时由 anonymousParser 内部会切换路径重试一次（互为 fallback）。

    // 3. 含 xsec_token 的完整URL直接当 fullUrl、同时抽 noteId
    for (const pattern of FULL_URL_PATTERNS) {
      const m = url.match(pattern);
      if (m) {
        return { noteId: m[1], fullUrl: url };
      }
    }

    // 4. 只有 noteId / 无 xsec_token 的链接
    for (const pattern of NOTE_ID_PATTERNS) {
      const match = url.match(pattern);
      if (match) return { noteId: match[1], fullUrl: null };
    }

    return { noteId: '', fullUrl: null };
  }

  /**
   * 获取笔记详情 - 调用 MediaCrawler API
   */
  async getNoteDetail(url: string, taskId?: number, isTaskActive?: () => boolean): Promise<NoteInfo> {
    const { noteId, fullUrl } = await this.parseNoteUrl(url);

    if (!noteId) {
      throw new Error('无效的小红书链接');
    }

    // 日志脱敏：不输出完整 fullUrl（含 xsec_token临时凭证），仅输出 noteId 以便排查
    console.log(`[解析] 笔记ID: ${noteId}, 含完整URL: ${fullUrl ? '是' : '否'}`);

    const detailCacheKey = fullUrl ? `detail:${fullUrl}` : `detail:${noteId}`;
    const cachedDetail = noteDetailCache.get(detailCacheKey);
    if (cachedDetail) {
      console.log(`[解析][缓存命中] noteId=${noteId}, parseMode=${cachedDetail.parseMode}`);
      return cachedDetail;
    }

    // 【1】优先尝试匿名直解（需要完整 URL 含 xsec_token）
    // 这条路径不需要登录、不需要 MediaCrawler，秒级返回
    if (fullUrl) {
      try {
        const raw = await parseNoteAnonymous(fullUrl);
        const note = this.mapAnonymousToNoteInfo(raw, noteId);
        noteDetailCache.set(detailCacheKey, note);
        console.log(`[匿名解析][成功] noteId=${noteId}, title="${note.title.slice(0, 30)}"`);
        return note;
      } catch (e: any) {
        const reason = e instanceof AnonymousParseError ? (e.reason || 'unknown') : 'exception';
        if (reason === 'rate_limited') {
          throw new Error('匿名解析请求过于频繁，请等待约 30 秒后再重试');
        }
        console.warn(`[匿名解析][失败，回退 MediaCrawler] noteId=${noteId}, reason=${reason}, msg=${e.message}`);
        // 继续走下面的 MediaCrawler 逻辑
      }
    }

    // 【2】Fallback 路径：MediaCrawler（需要登录）
    await this.assertLoginValid();
    await this.ensureCrawlerReady(isTaskActive);

    try {
      const specifiedId = fullUrl || noteId;

      // 1. 启动爬虫任务 (detail模式)
      await axios.post(`${MEDIACRAWLER_API}/api/crawler/start`, {
        platform: 'xhs',
        login_type: 'cookie',
        crawler_type: 'detail',
        specified_ids: specifiedId,
        enable_comments: false,
        save_option: 'json',
        headless: true
      }, {
        timeout: 30000
      });

      console.log(`[MediaCrawler] 任务已启动`);

      // 2. 等待任务完成
      let status = 'running';
      let attempts = 0;
      const maxAttempts = 60; // 最多等待60秒

      while (status === 'running' && attempts < maxAttempts) {
        await this.sleep(1000);

        // 检查任务是否被取消
        if (isTaskActive && !isTaskActive()) {
          throw new Error('任务已取消');
        }

        const statusResponse = await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`);
        status = statusResponse.data.status;
        attempts++;
        console.log(`[MediaCrawler] 状态: ${status}, 等待中... (${attempts}s)`);
      }

      if (status === 'error') {
        throw new Error('爬虫任务执行失败');
      }

      // 3. 获取爬取的数据
      const dataResponse = await axios.get(`${MEDIACRAWLER_API}/api/data/files`, {
        params: { platform: 'xhs', file_type: 'json' }
      });

      const files = dataResponse.data.files;
      if (!files || files.length === 0) {
        throw new Error('未获取到数据');
      }

      // 4. 读取最新的数据文件
      const latestFile = files[0];
      console.log(`[MediaCrawler] 读取文件: ${latestFile.path}`);

      const contentResponse = await axios.get(`${MEDIACRAWLER_API}/api/data/files/${encodeURIComponent(latestFile.path)}`, {
        params: { preview: false }
      });

      // API 返回的数据可能是 { data: [...] } 或直接是数组
      let noteDataList = contentResponse.data.data || contentResponse.data;
      if (!Array.isArray(noteDataList) || noteDataList.length === 0) {
        console.error(`[MediaCrawler] 数据解析失败, response:`, JSON.stringify(contentResponse.data).substring(0, 500));
        throw new Error('数据解析失败');
      }

      // 取匹配的数据（优先按 noteId 精确匹配，避免文件内多笔记时串数据）
      const noteData = noteDataList.find((item: any) => item && item.note_id === noteId)
        || noteDataList[noteDataList.length - 1];
      console.log(`[MediaCrawler] 解析成功: ${noteData.title}`);

      const note = this.parseNoteData(noteData, noteId);
      noteDetailCache.set(detailCacheKey, note);
      return note;

    } catch (error: any) {
      console.error(`[MediaCrawler] 错误: ${error.message}`);
      throw new Error(`解析失败: ${error.message}`);
    }
  }

  /**
   * 解析笔记数据
   */
  private parseNoteData(data: any, noteId: string): NoteInfo {
    // 提取图片 - image_list 可能是字符串（逗号分隔）或数组
    const images: string[] = [];
    const livePhotos: NonNullable<NoteInfo['livePhotos']> = [];
    const imageList = data.image_list;
    if (imageList) {
      if (typeof imageList === 'string') {
        // 字符串类型，按逗号分割
        for (const item of imageList.split(',')) {
          const url = item.trim();
          if (!url) continue;
          // 将 HTTP 转换为 HTTPS
          images.push(this.toHttps(this.cleanUrl(url)));
        }
      } else if (Array.isArray(imageList)) {
        // 数组类型
        imageList.forEach((img, index) => {
          const url = img.url_default || img.url || img;
          const imageUrl = typeof url === 'string' ? this.toHttps(this.cleanUrl(url)) : '';
          if (imageUrl) {
            images.push(imageUrl);
          }

          const videoUrls = this.collectStreamUrls(img?.stream);
          if (img?.livePhoto === true && imageUrl && videoUrls.length > 0) {
            livePhotos.push({
              imageUrl,
              videoUrl: videoUrls[0],
              videoUrls,
              index,
              duration: img?.stream?.duration || img?.duration || 0,
            });
          }
        });
      }
    }

    // 提取视频：优先自己从 consumer.origin_video_key 拼接无水印 URL
    // 只有当 MediaCrawler 还保留了原始 video 对象时这一分支才会命中
    // （默认 JSON 存储不保留 video 结构，因此主路径仍是读 data.video_url）
    let video: { url: string; duration: number; backupUrls?: string[] } | undefined;
    let hasWatermark = false;

    const originKey = data.video?.consumer?.origin_video_key
      || data.video?.consumer?.originVideoKey
      || '';

    if (originKey) {
      // ✅ 最优：自己用 origin_video_key 拼无水印 URL
      video = {
        url: `https://sns-video-bd.xhscdn.com/${originKey}`,
        duration: data.video?.duration || 0
      };
      hasWatermark = false;
    } else if (data.video_url) {
      // 次优：MediaCrawler 已拼好的 URL（可能无水印也可能已退化为带水印）
      // 按域名识别是否为无水印源
      const httpsUrl = this.toHttps(data.video_url);
      video = { url: httpsUrl, duration: 0 };
      hasWatermark = !this.isNoWatermarkVideoUrl(httpsUrl);
    } else {
      // 兄底：master_url 带水印
      const streamUrls = this.collectStreamUrls(data.video?.media?.stream);
      if (streamUrls.length > 0) {
        video = { url: streamUrls[0], duration: data.video?.duration || 0, backupUrls: streamUrls.slice(1) };
        hasWatermark = true;
      }
    }

    // 提取用户ID
    const userId = data.user_id || data.user?.user_id || '';

    // 构建原地址和博主地址
    const xsecToken = data.xsec_token || '';
    const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}${xsecToken ? `?xsec_token=${xsecToken}&xsec_source=pc_search` : ''}`;
    const creatorUrl = userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : '';

    return {
      noteId,
      title: data.title || '',
      desc: data.desc || '',
      type: data.type === 'video' ? 'video' : 'image',
      author: {
        nickname: data.user?.nickname || data.nickname || '未知',
        avatar: this.toHttps(data.user?.avatar || data.avatar || ''),
        userId
      },
      images,
      livePhotos: livePhotos.length > 0 ? livePhotos : undefined,
      video,
      likes: parseMetric(data.liked_count) || parseMetric(data.likes),
      collects: parseMetric(data.collected_count) || parseMetric(data.collects),
      comments: parseMetric(data.comment_count) || parseMetric(data.comments),
      shares: parseMetric(data.share_count) || parseMetric(data.shares) || parseMetric(data.interactInfo?.shareCount),
      publishTime: Number(data.time || data.publish_time || data.publishTime || data.last_modify_ts || 0) || undefined,
      ipLocation: data.ip_location || data.ipLocation || '',
      tags: this.normalizeTags(data),
      noteUrl,
      creatorUrl,
      // 仅对 video 类型有意义；image 类型固定为 false
      hasWatermark: data.type === 'video' ? hasWatermark : false,
      parseMode: 'mediacrawler',
    };
  }

  /**
   * 检测视频 URL 是否属于无水印 CDN
   * 按域名模式匹配：sns-video-*.xhscdn.com|net（CDN 调度子域名任意）
   */
  private isNoWatermarkVideoUrl(url: string): boolean {
    if (!url) return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return NO_WATERMARK_VIDEO_HOST_PATTERN.test(host);
    } catch {
      return false;
    }
  }

  private collectStreamUrls(stream: any): string[] {
    const urls: string[] = [];
    for (const codec of ['h264', 'h265', 'av1', 'h266']) {
      const value = stream?.[codec];
      const items = Array.isArray(value) ? value : value ? [value] : [];
      for (const item of items) {
        const master = item?.master_url || item?.masterUrl || '';
        if (typeof master === 'string' && master) urls.push(this.toHttps(this.cleanUrl(master)));
        const backups = item?.backup_urls || item?.backupUrls || [];
        if (Array.isArray(backups)) {
          for (const backup of backups) {
            if (typeof backup === 'string' && backup) urls.push(this.toHttps(this.cleanUrl(backup)));
          }
        }
      }
    }
    return Array.from(new Set(urls));
  }

  private normalizeTags(data: any): Array<{ id: string; name: string; type: string }> {
    const rawTags = data?.tagList || data?.tag_list || data?.tags || [];
    if (!Array.isArray(rawTags)) return [];
    return rawTags
      .map((tag: any) => ({
        id: String(tag?.id || tag?.tag_id || ''),
        name: String(tag?.name || tag?.tag_name || '').trim(),
        type: String(tag?.type || ''),
      }))
      .filter(tag => tag.name);
  }

  /**
   * 将匿名解析的结果映射为统一的 NoteInfo
   * 与 parseNoteData 不同的是：匿名结果已经是规范化结构，直接搭
   */
  private mapAnonymousToNoteInfo(raw: AnonymousNoteRaw, noteId: string): NoteInfo {
    let video: { url: string; duration: number; backupUrls?: string[] } | undefined;
    let hasWatermark = false;
    if (raw.video) {
      video = { url: raw.video.url, duration: raw.video.duration, backupUrls: raw.video.backup_urls };
      // 有 origin_video_key 就是无水印；只有 master_url 就是带水印
      hasWatermark = !raw.video.origin_video_key && !this.isNoWatermarkVideoUrl(raw.video.url);
      // 诊断日志：便于将来小红书上新域名时快速呼出
      try {
        const host = new URL(raw.video.url).hostname;
        console.log(`[匿名解析][视频] host=${host}, origin_video_key=${raw.video.origin_video_key ? 'yes' : 'no'}, hasWatermark=${hasWatermark}`);
      } catch { /* ignore */ }
    }

    const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`
      + (raw.xsec_token ? `?xsec_token=${raw.xsec_token}&xsec_source=pc_search` : '');
    const creatorUrl = raw.user.user_id
      ? `https://www.xiaohongshu.com/user/profile/${raw.user.user_id}`
      : '';

    return {
      noteId,
      title: raw.title,
      desc: raw.desc,
      type: raw.type,
      author: {
        nickname: raw.user.nickname,
        avatar: raw.user.avatar,
        userId: raw.user.user_id,
      },
      images: raw.image_list,
      livePhotos: raw.live_photos?.map(item => ({
        imageUrl: item.image_url,
        videoUrl: item.video_url,
        videoUrls: item.video_urls,
        index: item.index,
        duration: item.duration || 0,
      })),
      video,
      likes: raw.liked_count,
      collects: raw.collected_count,
      comments: raw.comment_count,
      shares: raw.share_count,
      publishTime: raw.publish_time,
      ipLocation: raw.ip_location,
      tags: raw.tags,
      noteUrl,
      creatorUrl,
      hasWatermark,
      parseMode: 'anonymous',
    };
  }

  /**
   * 清理URL
   */
  private cleanUrl(url: string): string {
    if (!url) return '';
    return url.replace(UNICODE_SLASH_PATTERN, '/').replace(WATERMARK_PATH_PATTERN, '');
  }

  /**
   * 将 HTTP URL 转换为 HTTPS（浏览器安全策略要求）
   */
  private toHttps(url: string): string {
    if (!url) return '';
    if (url.startsWith('http://')) {
      return `https://${url.slice(7)}`;
    }
    return url;
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 下载文件
   */
  async downloadFile(url: string): Promise<DownloadResult> {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.xiaohongshu.com/',
      },
      maxRedirects: 5,
      timeout: 60000
    });

    const contentType = String(response.headers['content-type'] || 'application/octet-stream');
    const ext = contentType.includes('video') ? 'mp4' : 'jpg';

    return {
      data: response.data,
      contentType,
      contentDisposition: `attachment; filename="xiaohongshu_${Date.now()}.${ext}"`
    };
  }

  /**
   * 关键词搜索笔记
   */
  async searchNotes(keywords: string, maxCount: number = 20, taskId?: number, isTaskActive?: () => boolean): Promise<NoteInfo[]> {
    // 登录态前置校验
    await this.assertLoginValid();

    // 缓存命中则直接返回（避免重复请求 MediaCrawler 重启浏览器）
    const cacheKey = `search:${keywords.trim()}:${maxCount}`;
    const cached = resultCache.get(cacheKey);
    if (cached) {
      console.log(`[搜索][缓存命中] keywords=${keywords}，返回 ${cached.length} 条缓存结果`);
      return cached.slice(0, maxCount);
    }

    console.log(`[搜索] 关键词: ${keywords}, 最大数量: ${maxCount}`);

    try {
      // 先停止可能存在的旧任务（新任务优先，不等旧任务自行跑完）
      await this.stopCrawler();

      // 激进模式：清干历史 search JSON，确保本次爬取从空开始
      await this.clearHistoryData('search');

      // 记录本次任务开始时间戳（过滤「本次新爬」数据，减 5s 缓冲区防时钟小偏差）
      const searchStartTs = Date.now() - 5000;

      // 1. 启动搜索爬虫（透传 max_notes 与并发度）
      await axios.post(`${MEDIACRAWLER_API}/api/crawler/start`, {
        platform: 'xhs',
        login_type: 'cookie',
        crawler_type: 'search',
        keywords: keywords,
        max_notes: maxCount,
        max_concurrency_num: MEDIACRAWLER_CONCURRENCY,
        enable_comments: false,
        save_option: 'json',
        headless: true
      }, { timeout: 30000 });

      console.log(`[MediaCrawler] 搜索任务已启动，关键词: ${keywords}，max_notes=${maxCount}，concurrency=${MEDIACRAWLER_CONCURRENCY}`);

      // 2. 等待任务完成（600s 兜底，超时不抛错。主路径是用户从前端手动「提前结束」触发取消）
      const { timedOut } = await this.waitForCrawlerComplete(600, isTaskActive);
      if (timedOut) {
        console.warn(`[搜索] 达到兜底超时 600s，主动停止爬虫并读取已爬取的部分结果...`);
        await this.stopCrawler();
      }

      // 3. 获取搜索结果（按 keywords + 本次 startTs 过滤，避免历史数据污染）
      const notes = await this.getSearchResultsData(keywords, maxCount, searchStartTs);
      console.log(`[搜索] 获取到 ${notes.length} 条结果${timedOut ? '（超时降级）' : ''}`);

      // 零结果路径细分提示：
      // - 超时 + 0 条：关键词过冷门 / 网络不畅
      // - 不超时 + 0 条：MediaCrawler 任务跑完了但没拿到本次新数据，最常见原因是登录态
      //   表面有效但实际失效（比如 Cookie 文件存在但 web_session 已被风控）。
      //   这里抛 LoginRequiredError 让前端弹「需要登录」提示，避免用户面对空列表懵圈。
      if (notes.length === 0) {
        if (timedOut) {
          throw new Error(`搜索超时且未爬到任何笔记（关键词可能过于冷门，建议换关键词或调小数量）`);
        }
        throw new LoginRequiredError(
          '本次搜索未获取到新数据，可能是登录态已失效或 Cookies 被风控，请重新扫码登录后重试'
        );
      }

      // getSearchResultsData 已按 sinceMs 过滤为「本次的」，这里不再裁切。
      // 一旦 MediaCrawler 因 xhs 单页强制 20 条而超过 maxCount，或用户提前结束但这次已爬超 maxCount，
      // 尽量保留全部结果，不要在最后一步把数据丢掉（进度卡片和结果口径对齐）
      if (!timedOut && notes.length > 0) {
        resultCache.set(cacheKey, notes);
      }
      return notes;

    } catch (error: any) {
      console.error(`[搜索] 错误: ${error.message}`);
      throw new Error(`搜索失败: ${error.message}`);
    }
  }

  /**
   * 停止爬虫任务（对外暴露：取消按钮会直接调用）
   *
   * 原实现用的是固定 sleep(2000)，但 MediaCrawler /api/crawler/stop 内部已同步等 SIGTERM 完成，
   * 因此这里改成短轮询：假如 stop 接口尚未收完尾，最多再等 2s，一旦 idle 立即放行。
   */
  async stopCrawler(): Promise<void> {
    try {
      const statusResponse = await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`, { timeout: 5000 });
      if (statusResponse.data.status === 'running') {
        console.log(`[MediaCrawler] 停止旧任务...`);
        await axios.post(`${MEDIACRAWLER_API}/api/crawler/stop`, {}, { timeout: 20000 });
        // 短轮询最多 2s，避免大多数情况下白白多等
        for (let i = 0; i < 10; i++) {
          try {
            const s = await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`, { timeout: 3000 });
            if (s.data.status !== 'running') return;
          } catch {
            // 忽略瞬时的状态查询异常
          }
          await this.sleep(200);
        }
      }
    } catch (error: any) {
      // 忽略停止失败（MediaCrawler 服务挂掉时也不应阻塞新请求）
      console.warn(`[MediaCrawler] 停止旧任务失败（已忽略）: ${error.message}`);
    }
  }

  /**
   * 清理 MediaCrawler 历史 JSON 数据文件（激进模式）
   * 每次搜索/博主爬取启动前调用，避免当天历史数据累积导致 JSON 爆胀
   * 和轮询性能下降。since 过滤的兆级保险仍然保留。
   * @param mode 'search' 只清 search_contents_*；'creator' 清 creator_contents_* / creator_creator_*
   */
  async clearHistoryData(mode: 'search' | 'creator'): Promise<void> {
    const dataDir = resolveMediaCrawlerDataDir();
    if (!fs.existsSync(dataDir)) {
      console.log(`[清理] 数据目录不存在，跳过: ${dataDir}`);
      return;
    }

    // 走 MediaCrawler API 拿文件相对路径（傅布于 DATA_DIR），避免猴生重写 walk 逻辑
    let files: any[] = [];
    try {
      const r = await axios.get(`${MEDIACRAWLER_API}/api/data/files`, {
        params: { platform: 'xhs', file_type: 'json' },
        timeout: 5000,
      });
      files = r.data?.files || [];
    } catch (e: any) {
      console.warn(`[清理] 获取文件列表失败（已忽略）: ${e.message}`);
      return;
    }

    // 按模式筛选目标文件：search 只删 search 开头的；creator 删 creator/detail 类
    const targets = files.filter((f: any) => {
      const p = String(f?.path || '').toLowerCase();
      if (!p.endsWith('.json')) return false;
      if (mode === 'search') return p.includes('search');
      // creator 模式：creator_contents / creator_creator / detail 都清
      return p.includes('creator') || p.includes('detail');
    });

    if (targets.length === 0) {
      console.log(`[清理] 无需清理的历史 ${mode} JSON 文件`);
      return;
    }

    let ok = 0;
    let failed = 0;
    for (const f of targets) {
      const rel = String(f.path);
      // 防范路径穿越：拼接后必须仍在 dataDir 下
      const abs = path.resolve(dataDir, rel);
      if (!abs.startsWith(path.resolve(dataDir))) {
        console.warn(`[清理] 跳过越界路径: ${rel}`);
        continue;
      }
      try {
        fs.unlinkSync(abs);
        ok++;
      } catch (e: any) {
        failed++;
        console.warn(`[清理] 删除失败（已忽略）: ${rel} - ${e.message}`);
      }
    }
    console.log(`[清理][${mode}] 已删除 ${ok} 个历史文件${failed > 0 ? `，失败 ${failed} 个` : ''}`);
  }

  /**
   * 定期清理 MediaCrawler data 目录下的 JSON 输出，防止小盘机器长期运行后被历史爬取结果占满。
   *
   * 策略：
   * - 只处理 .json 文件，不碰浏览器登录数据、Cookies、构建产物或用户下载内容。
   * - 删除超过 RUNTIME_DATA_RETENTION_DAYS 天的旧 JSON。
   * - 同时保留最新 RUNTIME_DATA_MAX_JSON_FILES 个 JSON，超过数量的更旧文件会被删除。
   */
  cleanupRuntimeDataRetention(reason = 'scheduled'): void {
    const dataDir = resolveMediaCrawlerDataDir();
    if (!fs.existsSync(dataDir)) {
      console.log(`[保洁] 数据目录不存在，跳过: ${dataDir}`);
      return;
    }

    const maxAgeDays = Math.max(0, RUNTIME_DATA_RETENTION_DAYS);
    const maxFiles = Math.max(0, RUNTIME_DATA_MAX_JSON_FILES);
    if (maxAgeDays === 0 && maxFiles === 0) {
      console.log('[保洁] 运行时数据保洁已关闭');
      return;
    }

    let files: Array<{ abs: string; rel: string; mtimeMs: number; size: number }> = [];
    try {
      files = listJsonFilesRecursive(dataDir);
    } catch (e: any) {
      console.warn(`[保洁] 扫描数据目录失败（已忽略）: ${e.message}`);
      return;
    }

    if (files.length === 0) {
      console.log(`[保洁] 无 JSON 历史文件需要检查 (${reason})`);
      return;
    }

    const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : 0;
    const byNewest = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keepByCount = new Set<string>(
      maxFiles > 0 ? byNewest.slice(0, maxFiles).map(f => f.abs) : byNewest.map(f => f.abs)
    );

    const targets = files.filter((file) => {
      const expired = maxAgeDays > 0 && file.mtimeMs < cutoff;
      const overflow = maxFiles > 0 && !keepByCount.has(file.abs);
      return expired || overflow;
    });

    if (targets.length === 0) {
      console.log(`[保洁] JSON 历史文件健康: ${files.length} 个，无需清理 (${reason})`);
      return;
    }

    let removed = 0;
    let removedBytes = 0;
    let failed = 0;
    for (const file of targets) {
      if (!isPathInsideDir(file.abs, dataDir)) {
        console.warn(`[保洁] 跳过越界路径: ${file.rel}`);
        continue;
      }
      try {
        fs.unlinkSync(file.abs);
        removed++;
        removedBytes += file.size;
      } catch (e: any) {
        failed++;
        console.warn(`[保洁] 删除失败（已忽略）: ${file.rel} - ${e.message}`);
      }
    }

    const mb = (removedBytes / 1024 / 1024).toFixed(2);
    console.log(`[保洁] 已清理 ${removed}/${targets.length} 个 JSON，释放约 ${mb} MB${failed > 0 ? `，失败 ${failed} 个` : ''} (${reason})`);
  }

  /**
   * 获取搜索结果数据
   * @param keywords    本次搜索的关键词，用于按 source_keyword 精准过滤，防止历史追加数据污染
   * @param maxCount    期望返回的最大条数（仅作底层共同约定，本函数不再主动截断）
   * @param sinceMs     可选：只返回 last_modify_ts 大于此值的数据（本次新爬）
   */
  private async getSearchResultsData(keywords?: string, maxCount: number = 20, sinceMs?: number): Promise<NoteInfo[]> {
    const dataResponse = await axios.get(`${MEDIACRAWLER_API}/api/data/files`, {
      params: { platform: 'xhs', file_type: 'json' }
    });

    const files = dataResponse.data.files;
    if (!files || files.length === 0) {
      throw new Error('未获取到数据');
    }

    // 找到搜索结果文件
    const searchFile = files.find((f: any) => f.path.includes('search'));
    if (!searchFile) {
      throw new Error('未找到搜索结果文件');
    }

    const contentResponse = await axios.get(`${MEDIACRAWLER_API}/api/data/files/${encodeURIComponent(searchFile.path)}`, {
      params: { preview: false }
    });

    const noteDataList = contentResponse.data.data || contentResponse.data;
    if (!Array.isArray(noteDataList)) {
      return [];
    }

    // 单次扫描同时完成关键词和时间过滤，避免大结果 JSON 被多次 filter 分配。
    const kw = keywords?.trim() || '';
    const hasSince = typeof sinceMs === 'number' && sinceMs > 0;
    const filtered: any[] = [];
    let beforeTime = 0;
    for (const d of noteDataList) {
      if (kw) {
        const sk = String(d?.source_keyword || '').trim();
        if (sk !== kw && !sk.includes(kw)) continue;
      }
      beforeTime++;
      if (hasSince) {
        const ts = Number(d?.last_modify_ts);
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
      }
      filtered.push(d);
    }
    console.log(`[搜索] 过滤结果: ${filtered.length}/${beforeTime}/${noteDataList.length} 条 (keywords=${keywords || '未指定'}, since=${sinceMs ? new Date(sinceMs).toISOString() : '无'})`);

    // 不再主动 slice(-maxCount) 截断：返回本次过滤后的全部（与进度卡片口径一致）
    return filtered.map((data: any) => this.parseNoteData(data, data.note_id || ''));
  }

  /**
   * 获取博主笔记列表
   */
  async getCreatorNotes(url: string, maxCount: number = 30, taskId?: number, isTaskActive?: () => boolean): Promise<NoteInfo[]> {
    // 登录态前置校验
    await this.assertLoginValid();

    console.log(`[博主] URL: ${url}`);

    // 从 URL 中精确提取用户ID；若未命中，只有输入本身看起来像 ID 时才采用。
    const userIdMatch = url.match(USER_PROFILE_PATTERN);
    const userId = userIdMatch
      ? userIdMatch[1]
      : (/^[a-zA-Z0-9]+$/.test(url) ? url : '');

    if (!userId) {
      throw new Error('无法从链接中解析博主 ID，请确认链接格式（应包含 /user/profile/<id>）');
    }

    // 缓存命中则直接返回
    const cacheKey = `creator:${userId}:${maxCount}`;
    const cached = resultCache.get(cacheKey);
    if (cached) {
      console.log(`[博主][缓存命中] userId=${userId}，返回 ${cached.length} 条缓存结果`);
      return cached.slice(0, maxCount);
    }

    try {
      // 先停止可能存在的旧任务
      await this.stopCrawler();

      // 激进模式：清干历史 creator JSON，确保本次爬取从空开始
      await this.clearHistoryData('creator');

      // 本次任务开始时间戳，用于过滤「本次新爬」条数（减 5s 缓冲区）
      const crawlStartTs = Date.now() - 5000;

      // 1. 启动创作者爬虫（creator_ids 必须传博主 ID，不能传整段 URL）
      await axios.post(`${MEDIACRAWLER_API}/api/crawler/start`, {
        platform: 'xhs',
        login_type: 'cookie',
        crawler_type: 'creator',
        creator_ids: userId,
        max_notes: maxCount,
        max_concurrency_num: MEDIACRAWLER_CONCURRENCY,
        enable_comments: false,
        save_option: 'json',
        headless: true
      }, { timeout: 30000 });

      console.log(`[MediaCrawler] 博主任务已启动，userId=${userId}，max_notes=${maxCount}，concurrency=${MEDIACRAWLER_CONCURRENCY}`);

      // 2. 等待任务完成（600s 兜底，超时不抛错。主路径是用户手动「提前结束」）
      const { timedOut } = await this.waitForCrawlerComplete(600, isTaskActive);
      if (timedOut) {
        console.warn(`[博主] 达到兜底超时 600s，主动停止爬虫并读取已爬取的部分结果...`);
        await this.stopCrawler();
      }

      // 3. 获取数据（按 userId + 本次 startTs 过滤）
      const notes = await this.getCreatorResults(userId, crawlStartTs);
      console.log(`[博主] 获取到 ${notes.length} 条结果${timedOut ? '（超时降级）' : ''}`);

      if (timedOut && notes.length === 0) {
        throw new Error(`博主笔记爬取超时且未爬到任何内容（请稍后重试或调小数量）`);
      }

      // 保留全部本次爬到的，不再 slice(0, maxCount) 截断
      if (!timedOut && notes.length > 0) {
        resultCache.set(cacheKey, notes);
      }
      return notes;

    } catch (error: any) {
      console.error(`[博主] 错误: ${error.message}`);
      throw new Error(`获取博主笔记失败: ${error.message}`);
    }
  }

  /**
   * 获取博主笔记结果
   */
  private async getCreatorResults(userId: string, sinceMs?: number): Promise<NoteInfo[]> {
    const dataResponse = await axios.get(`${MEDIACRAWLER_API}/api/data/files`, {
      params: { platform: 'xhs', file_type: 'json' }
    });

    const files = dataResponse.data.files;
    if (!files || files.length === 0) {
      throw new Error('未获取到数据');
    }

    // 找到博主结果文件
    const creatorFile = files.find((f: any) => f.path.includes('creator'));
    const targetFile = creatorFile || files.find((f: any) => f.path.includes('detail')) || files[0];

    const contentResponse = await axios.get(`${MEDIACRAWLER_API}/api/data/files/${encodeURIComponent(targetFile.path)}`, {
      params: { preview: false }
    });

    const noteDataList = contentResponse.data.data || contentResponse.data;
    if (!Array.isArray(noteDataList)) {
      return [];
    }

    // 单次扫描完成 userId 过滤和时间候选收集；保留原有“时间过滤为空则回退 userId 结果”的策略。
    let filteredData: any[] = [];
    const withTs: any[] = [];
    const hasSince = typeof sinceMs === 'number' && sinceMs > 0;
    for (const data of noteDataList) {
      if (userId && data.user_id !== userId) continue;
      filteredData.push(data);
      if (hasSince) {
        const ts = Number(data?.last_modify_ts);
        if (Number.isFinite(ts) && ts >= sinceMs) {
          withTs.push(data);
        }
      }
    }
    const beforeTime = filteredData.length;

    // 按本次任务开始时间戳过滤
    if (hasSince) {
      filteredData = withTs.length > 0 ? withTs : filteredData;
    }
    console.log(`[博主] 过滤结果: ${filteredData.length}/${beforeTime}/${noteDataList.length} 条 (userId=${userId || '未解析'}, since=${sinceMs ? new Date(sinceMs).toISOString() : '无'})`);

    return filteredData.map((data: any) => this.parseNoteData(data, data.note_id || ''));
  }

  /**
   * 获取当前爬取进度（给 /api/progress 轮询用）
   *
   * 不抛错、容忍文件不存在，返回实时已爬取的笔记条数 + MediaCrawler 状态。
   * mode='search'：按 source_keyword 过滤
   * mode='creator'：按 user_id 过滤
   */
  async getLiveProgress(mode: 'search' | 'creator', key: string, sinceMs?: number): Promise<{
    count: number;
    status: 'running' | 'idle' | 'error' | 'unknown';
  }> {
    // 1. 拿 MediaCrawler 状态（任何异常都归为 unknown）
    let status: 'running' | 'idle' | 'error' | 'unknown' = 'unknown';
    try {
      const s = await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`, { timeout: 3000 });
      const raw = String(s.data?.status || '').toLowerCase();
      if (raw === 'running' || raw === 'idle' || raw === 'error') status = raw;
    } catch {
      // 服务不在就当 unknown，不报错
    }

    // 2. 拿文件列表（文件还没生成时 count=0）
    let files: any[] = [];
    try {
      const r = await axios.get(`${MEDIACRAWLER_API}/api/data/files`, {
        params: { platform: 'xhs', file_type: 'json' },
        timeout: 5000,
      });
      files = r.data?.files || [];
    } catch {
      return { count: 0, status };
    }
    if (!files.length) return { count: 0, status };

    // 3. 根据模式选文件
    const target = mode === 'search'
      ? files.find((f: any) => String(f.path).includes('search'))
      : (files.find((f: any) => String(f.path).includes('creator'))
          || files.find((f: any) => String(f.path).includes('detail'))
          || files[0]);
    if (!target) return { count: 0, status };

    // 4. 读文件内容，容忍任何解析错误
    let noteDataList: any[] = [];
    try {
      const c = await axios.get(
        `${MEDIACRAWLER_API}/api/data/files/${encodeURIComponent(target.path)}`,
        { params: { preview: false }, timeout: 5000 }
      );
      const raw = c.data?.data || c.data;
      if (Array.isArray(raw)) noteDataList = raw;
    } catch {
      return { count: 0, status };
    }

    // 5. 按 key 和 sinceMs 单次扫描计数，返回「本次新爬」的数目（与最终结果口径对齐）
    const trimmed = (key || '').trim();
    const hasSince = typeof sinceMs === 'number' && sinceMs > 0;
    let count = 0;
    for (const d of noteDataList) {
      if (trimmed) {
        if (mode === 'search') {
          const sk = String(d?.source_keyword || '').trim();
          if (sk !== trimmed && !sk.includes(trimmed)) continue;
        } else if (String(d?.user_id || '') !== trimmed) {
          continue;
        }
      }
      if (hasSince) {
        const ts = Number(d?.last_modify_ts);
        if (!Number.isFinite(ts) || ts < sinceMs) {
          continue;
        }
      }
      count++;
    }
    return { count, status };
  }

  /**
   * 等待爬虫完成（自适应轮询：前 10s 高频 500ms，之后 1s，60s 后 2s）
   *
   * 超时**不再抛错**，而是返回 { timedOut: true } ，由调用方决定是否读取部分数据。
   * MediaCrawler 对冷门关键词会一直翻页直到凑足 max_notes，这里不等它自己吊死。
   */
  private async waitForCrawlerComplete(maxSeconds: number = 60, isTaskActive?: () => boolean): Promise<{ timedOut: boolean }> {
    let status = 'running';
    const startTs = Date.now();
    const deadline = startTs + maxSeconds * 1000;
    let pollCount = 0;

    while (status === 'running' && Date.now() < deadline) {
      // 自适应间隔：前 10s 越密越好，之后适当放缓
      const elapsed = Date.now() - startTs;
      const interval = elapsed < 10_000 ? 500 : elapsed < 60_000 ? 1000 : 2000;
      await this.sleep(interval);

      // 检查任务是否被取消
      if (isTaskActive && !isTaskActive()) {
        throw new Error('任务已取消');
      }

      const statusResponse = await axios.get(`${MEDIACRAWLER_API}/api/crawler/status`, { timeout: 5000 });
      status = statusResponse.data.status;
      pollCount++;
      if (pollCount % 10 === 0) {
        console.log(`[MediaCrawler] 状态: ${status}, 等待中... (${Math.round(elapsed / 1000)}s)`);
      }
    }

    if (status === 'error') {
      throw new Error('爬虫任务执行失败');
    }
    return { timedOut: status === 'running' };
  }

  /**
   * 获取最新的笔记数据
   */
  private async getLatestNotesData(): Promise<NoteInfo[]> {
    const dataResponse = await axios.get(`${MEDIACRAWLER_API}/api/data/files`, {
      params: { platform: 'xhs', file_type: 'json' }
    });

    const files = dataResponse.data.files;
    if (!files || files.length === 0) {
      throw new Error('未获取到数据');
    }

    const latestFile = files[0];
    const contentResponse = await axios.get(`${MEDIACRAWLER_API}/api/data/files/${encodeURIComponent(latestFile.path)}`, {
      params: { preview: false }
    });

    const noteDataList = contentResponse.data.data || contentResponse.data;
    if (!Array.isArray(noteDataList)) {
      return [];
    }

    return noteDataList.map((data: any) => this.parseNoteData(data, data.note_id || ''));
  }
}
