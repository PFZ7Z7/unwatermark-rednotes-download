/**
 * 匿名解析器：无需登录，直接抓取小红书笔记页 HTML 提取数据
 *
 * 适用场景：URL 中已含 xsec_token（由小红书官方签发的临时访问凭证）
 * 核心思路：
 *   1. axios GET 笔记页（伪装 UA/Referer）
 *   2. 用正则抽取 SSR 注入的 window.__INITIAL_STATE__ 或 __NEXT_DATA__
 *   3. JSON 净化（替换 :undefined → :null）后解析
 *   4. 映射为项目统一的笔记结构体
 *
 * 容错策略：任何一步失败都抛出 AnonymousParseError，由上层判断是否回退到 MediaCrawler
 */

import axios from 'axios';

/** 匿名解析专用错误类：上层据此判断是否需要回退 */
export class AnonymousParseError extends Error {
  readonly anonymousFailed = true;
  constructor(message: string, readonly reason?: string) {
    super(message);
    this.name = 'AnonymousParseError';
  }
}

/** 匿名解析器返回的结构（尽量与 parseNoteData 的输出对齐，留给调用方二次映射） */
export interface AnonymousNoteRaw {
  note_id: string;
  title: string;
  desc: string;
  type: 'video' | 'image';
  user: { nickname: string; avatar: string; user_id: string };
  image_list: string[];
  video?: { url: string; duration: number; origin_video_key?: string; master_url?: string };
  liked_count: number;
  collected_count: number;
  comment_count: number;
  xsec_token: string;
}

/* ============================== 限流（防 IP ban） ============================== */
/** 匿名请求限流窗口 30s */
const RATE_WINDOW_MS = 30_000;
/** 同一 noteId 在窗口内最多尝试次数 */
const RATE_MAX_PER_NOTE = 3;
const RATE_MAX_TRACKED_NOTES = 1000;

const hitMap: Map<string, number[]> = new Map();

function isRateLimited(noteId: string): boolean {
  const now = Date.now();
  if (hitMap.size > RATE_MAX_TRACKED_NOTES) {
    pruneRateMap(now);
  }

  const oldHits = hitMap.get(noteId) || [];
  const hits: number[] = [];
  for (const t of oldHits) {
    if (now - t < RATE_WINDOW_MS) hits.push(t);
  }
  if (hits.length >= RATE_MAX_PER_NOTE) {
    hitMap.set(noteId, hits);
    return true;
  }
  hits.push(now);
  hitMap.set(noteId, hits);
  return false;
}

function pruneRateMap(now = Date.now()): void {
  for (const [id, timestamps] of hitMap) {
    const active = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (active.length > 0) {
      hitMap.set(id, active);
    } else {
      hitMap.delete(id);
    }
    if (hitMap.size <= RATE_MAX_TRACKED_NOTES) break;
  }
}

/* ============================== 核心解析 ============================== */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

const HTTP_TIMEOUT_MS = 10_000;

const httpClient = axios.create({
  headers: {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://www.xiaohongshu.com/',
  },
  timeout: HTTP_TIMEOUT_MS,
  maxRedirects: 5,
  responseType: 'text',
});

/** 风控/验证码页面的常见关键字 */
const ANTI_BOT_SIGNATURES = [
  '访问验证',
  'slide-verify',
  'captcha',
  '系统繁忙',
  '人机验证',
] as const;
const CASE_INSENSITIVE_ANTI_BOT_SIGNATURES = ['captcha'] as const;

const INITIAL_STATE_PATTERN = /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/;
const NEXT_DATA_PATTERN = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/;
const JSON_UNDEFINED_VALUE_PATTERN = /:\s*undefined\b/g;
const JSON_UNDEFINED_ARRAY_ITEM_PATTERN = /,\s*undefined\s*(?=[,\]])/g;
const NOTE_PATH_PATTERN = /\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/;
const XSEC_TOKEN_PATTERN = /[?&]xsec_token=([^&#]+)/;
const NON_DIGIT_PATTERN = /[^\d]/g;

function parseMetric(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = parseInt(String(value || '').replace(NON_DIGIT_PATTERN, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从 HTML 中提取嵌入的 JSON 数据块
 * 小红书页面会有两种形态：
 *   1. window.__INITIAL_STATE__ = {...}</script>
 *   2. __NEXT_DATA__ 类（少见）
 */
function extractInitialState(html: string): any {
  // 形态 1：__INITIAL_STATE__
  const m1 = html.match(INITIAL_STATE_PATTERN);
  if (m1) {
    return safeParseJson(m1[1]);
  }

  // 形态 2：__NEXT_DATA__（放在 <script id="__NEXT_DATA__" type="application/json">）
  const m2 = html.match(NEXT_DATA_PATTERN);
  if (m2) {
    return safeParseJson(m2[1]);
  }

  return null;
}

/**
 * 小红书 SSR 的 JSON 里含 undefined 字面量（非标准 JSON），需要先净化
 */
function safeParseJson(raw: string): any {
  try {
    // 大多数页面是标准 JSON；只有出现 undefined 时才分配新字符串做净化。
    const cleaned = raw.includes('undefined')
      ? raw
          .replace(JSON_UNDEFINED_VALUE_PATTERN, ':null')
          // 处理像 ,undefined, 这种极少见情况（数组里）
          .replace(JSON_UNDEFINED_ARRAY_ITEM_PATTERN, ',null')
      : raw;
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** 提取 note 节点：__INITIAL_STATE__ 下 note.noteDetailMap[noteId].note */
function findNoteNode(state: any, noteId: string): any {
  const direct = state?.note?.noteDetailMap?.[noteId]?.note;
  if (direct && typeof direct === 'object') return direct;

  // __NEXT_DATA__ 形态的兜底路径
  const pageProps = state?.props?.pageProps;
  const nextNote = pageProps?.noteDetailMap?.[noteId]?.note || pageProps?.note;
  if (nextNote && typeof nextNote === 'object') return nextNote;

  return null;
}

/** HTTP → HTTPS */
function toHttps(url: string): string {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

/** 从 note 节点映射成项目统一结构 */
function mapNoteNode(note: any, noteId: string, xsecToken: string): AnonymousNoteRaw {
  // 图片
  const images: string[] = [];
  const imageList = note.imageList || note.image_list || [];
  if (Array.isArray(imageList)) {
    for (const img of imageList) {
      const url = img?.urlDefault || img?.url_default || img?.url || img;
      if (typeof url === 'string' && url) images.push(toHttps(url));
    }
  }

  // 视频：origin_video_key → sns-video-bd.xhscdn.com
  let video: AnonymousNoteRaw['video'] | undefined;
  const originKey =
    note.video?.consumer?.originVideoKey ||
    note.video?.consumer?.origin_video_key ||
    '';
  const masterUrl = note.video?.media?.stream?.h264?.[0]?.masterUrl
    || note.video?.media?.stream?.h264?.[0]?.master_url
    || '';
  if (originKey) {
    video = {
      url: `https://sns-video-bd.xhscdn.com/${originKey}`,
      duration: note.video?.capa?.duration || note.video?.duration || 0,
      origin_video_key: originKey,
    };
  } else if (masterUrl) {
    video = {
      url: toHttps(masterUrl),
      duration: note.video?.capa?.duration || note.video?.duration || 0,
      master_url: masterUrl,
    };
  }

  // 用户
  const user = note.user || {};
  const userId = user.userId || user.user_id || note.userId || '';

  const interact = note.interactInfo || note.interact_info || {};

  const type: 'video' | 'image' =
    note.type === 'video' || note.noteType === 'video' || video ? 'video' : 'image';

  return {
    note_id: noteId,
    title: note.title || '',
    desc: note.desc || '',
    type,
    user: {
      nickname: user.nickname || user.nickName || '未知',
      avatar: toHttps(user.avatar || user.avatarUrl || ''),
      user_id: userId,
    },
    image_list: images,
    video,
    liked_count: parseMetric(interact.likedCount ?? interact.liked_count ?? note.likedCount),
    collected_count: parseMetric(interact.collectedCount ?? interact.collected_count ?? note.collectedCount),
    comment_count: parseMetric(interact.commentCount ?? interact.comment_count ?? note.commentCount),
    xsec_token: xsecToken,
  };
}

/**
 * 从 URL 里提取 noteId 和 xsec_token
 * @throws AnonymousParseError 如果无法提取
 */
function extractIds(url: string): { noteId: string; xsecToken: string } {
  const m = url.match(NOTE_PATH_PATTERN);
  if (!m) throw new AnonymousParseError('无法从 URL 提取 noteId', 'no_note_id');
  const tokenMatch = url.match(XSEC_TOKEN_PATTERN);
  if (!tokenMatch) throw new AnonymousParseError('URL 缺少 xsec_token', 'no_xsec_token');
  return { noteId: m[1], xsecToken: decodeURIComponent(tokenMatch[1]) };
}

/**
 * 切换笔记 URL 的路径风格：/explore/ ⇄ /discovery/item/
 * 保留 query string（含 xsec_token 等）不变
 * 返回 null 表示无法切换（URL 不是这两种格式之一）
 */
function swapNotePath(url: string): string | null {
  if (url.includes('/explore/')) {
    return url.replace('/explore/', '/discovery/item/');
  }
  if (url.includes('/discovery/item/')) {
    return url.replace('/discovery/item/', '/explore/');
  }
  return null;
}

/**
 * 内部核心抽取：按给定 URL 抽一次 HTML 并提取数据，失败抛 AnonymousParseError
 * 不包含限流和外层 fallback 逻辑（那些由 parseNoteAnonymous 统筹）
 */
async function fetchAndExtract(
  targetUrl: string,
  noteId: string,
  xsecToken: string
): Promise<AnonymousNoteRaw> {
  // 抓 HTML
  let html: string;
  try {
    const resp = await httpClient.get<string>(targetUrl, {
      validateStatus: (s) => s >= 200 && s < 400,
    });
    html = String(resp.data || '');
  } catch (e: any) {
    throw new AnonymousParseError(`HTML 抓取失败: ${e.message}`, 'http_error');
  }

  // 风控识别
  for (const sig of ANTI_BOT_SIGNATURES) {
    if (html.includes(sig)) {
      throw new AnonymousParseError(`命中风控关键字: ${sig}`, 'anti_bot');
    }
  }
  let lowerHtml: string | null = null;
  for (const sig of CASE_INSENSITIVE_ANTI_BOT_SIGNATURES) {
    lowerHtml ??= html.toLowerCase();
    if (lowerHtml.includes(sig)) {
      throw new AnonymousParseError(`命中风控关键字: ${sig}`, 'anti_bot');
    }
  }

  // 提取 SSR JSON
  const state = extractInitialState(html);
  if (!state) {
    throw new AnonymousParseError('未在 HTML 中找到 __INITIAL_STATE__', 'no_state');
  }

  // 定位 note 节点
  const note = findNoteNode(state, noteId);
  if (!note) {
    throw new AnonymousParseError(`state 中未找到 noteId=${noteId} 的数据`, 'no_note');
  }

  // 映射
  return mapNoteNode(note, noteId, xsecToken);
}

/** 可切换重试的失败原因（预期用另一条路径能绕开的） */
const RETRY_REASONS = new Set(['no_state', 'no_note', 'http_error']);

/**
 * 对外主入口：匿名解析笔记
 * @param fullUrl 必须是含 xsec_token 的完整 URL，路径可为 /explore/ 或 /discovery/item/
 * 内部策略：
 *   1. 先按原路径抓一次
 *   2. 失败且原因可由路径差异解决时（no_state/no_note/http_error），切换至另一路径再抽一次
 *   3. 两次都失败则抛出最后一次的错误
 * @throws AnonymousParseError
 */
export async function parseNoteAnonymous(fullUrl: string): Promise<AnonymousNoteRaw> {
  const { noteId, xsecToken } = extractIds(fullUrl);

  // 限流按 noteId 统一做，两条路径共享一个名额（避免被多扣 quota）
  if (isRateLimited(noteId)) {
    throw new AnonymousParseError('匿名请求限流，已达窗口上限', 'rate_limited');
  }

  // 第一次：按原 URL 请求
  try {
    return await fetchAndExtract(fullUrl, noteId, xsecToken);
  } catch (e: any) {
    const reason: string | undefined = e instanceof AnonymousParseError ? e.reason : undefined;
    const altUrl = reason && RETRY_REASONS.has(reason) ? swapNotePath(fullUrl) : null;
    if (!altUrl) {
      throw e;
    }
    // 第二次：切换路径重试
    console.log(`[匿名解析][路径切换重试] noteId=${noteId}, first_reason=${reason}, alt=${altUrl}`);
    try {
      return await fetchAndExtract(altUrl, noteId, xsecToken);
    } catch (e2) {
      // 两次都失败，向上抛第二次的错误（更接近实际超进结果）
      throw e2;
    }
  }
}
