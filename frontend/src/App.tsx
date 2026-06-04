import { useState, useCallback, useEffect, useRef } from 'react';
import './App.css';

interface NoteInfo {
  noteId: string;
  title: string;
  desc: string;
  type: 'image' | 'video';
  author: {
    nickname: string;
    avatar: string;
    userId?: string;
  };
  images: string[];
  livePhotos?: Array<{
    imageUrl: string;
    videoUrl: string;
    videoUrls?: string[];
    index: number;
    duration: number;
  }>;
  video?: {
    url: string;
    duration: number;
    backupUrls?: string[];
  };
  likes: number;
  collects: number;
  comments: number;
  shares?: number;
  publishTime?: number;
  ipLocation?: string;
  tags?: Array<{ id: string; name: string; type: string }>;
  noteUrl?: string;
  creatorUrl?: string;
  hasWatermark?: boolean; // 视频疑似带水印（登录态失效时会为 true）
  parseMode?: 'anonymous' | 'mediacrawler'; // 数据来源：匿名直解 or 增强模式
}

interface LoginStatus {
  driverRunning: boolean;
  loginValid: boolean;
  loginMessage: string;
  hint?: string | null;
  mode?: 'SHARED_COOKIE';
  canSelfLogin?: boolean;
  enhancedModeAvailable?: boolean;
  cookieConfigured?: boolean;
  cookieValidFormat?: boolean;
  cookieVerified?: boolean;
  cookieUpdatedAt?: string;
  cookieValidatedAt?: string;
  cookieAccount?: {
    nickname?: string;
    avatar?: string;
    userId?: string;
  };
}

type Mode = 'parse' | 'search' | 'creator';

// 分页配置
const PAGE_SIZE = 10;

// 进度轮询配置
const PROGRESS_POLL_INTERVAL_MS = 1000;
// 小红书单页最小爬 20 条（xhs_limit_count=20），填任何小于 20 的值也会按 20 起步
// 所以目标数量固定为 20 的倍数，下拉选择
const TARGET_COUNT_OPTIONS = [20, 40, 60, 80, 100] as const;

interface ProgressInfo {
  count: number;
  parsedCount: number;
  discoveredCount: number;
  detailTaskCount: number;
  status: 'running' | 'idle' | 'error' | 'unknown';
  elapsedMs: number;
}

type DownloadJobStatus = 'queued' | 'enriching' | 'ready' | 'downloading' | 'completed' | 'failed';

interface DownloadJobProgress {
  jobId: string;
  status: DownloadJobStatus;
  totalNotes: number;
  enrichedNotes: number;
  totalFiles: number;
  zippedFiles: number;
  downloadedBytes: number;
  message: string;
  progressUrl: string;
  downloadUrl: string;
}

type Notice = {
  type: 'success' | 'error' | 'info';
  message: string;
};

type EnhancedCookieAction = 'save' | 'clear' | null;

type ErrorTone = 'error' | 'warning' | 'login';

type ErrorSummary = {
  tone: ErrorTone;
  title: string;
  message: string;
  showLoginAction: boolean;
};

const TOPIC_PATTERN = /#([^#]+?)\[话题\]#/g;

const buildTopicUrl = (name: string): string =>
  `https://www.xiaohongshu.com/search_result/?keyword=${encodeURIComponent(encodeURIComponent(name))}&type=54&source=web_note_detail_r10`;

const formatPublishTime = (timestamp?: number): string => {
  if (!timestamp) return '';
  const normalized = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const stripTopicMarkers = (desc: string, hasStructuredTags: boolean): string =>
  hasStructuredTags ? desc.replace(TOPIC_PATTERN, '').replace(/\s{2,}/g, ' ').trim() : desc;

const getNoteKey = (note: Pick<NoteInfo, 'noteId' | 'noteUrl'>): string =>
  note.noteId || note.noteUrl || '';

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
};

const classifyErrorMessage = (message: string, needsLogin: boolean): ErrorSummary => {
  const lower = message.toLowerCase();

  if (needsLogin) {
    return {
      tone: 'login',
      title: '增强模式维护中',
      message,
      showLoginAction: true,
    };
  }

  if (message.includes('请输入') || message.includes('链接') || lower.includes('url')) {
    return {
      tone: 'warning',
      title: '链接无法识别',
      message,
      showLoginAction: false,
    };
  }

  if (message.includes('过期') || message.includes('失效') || lower.includes('expired') || lower.includes('xsec_token')) {
    return {
      tone: 'warning',
      title: '分享链接可能已失效',
      message,
      showLoginAction: false,
    };
  }

  if (message.includes('频繁') || message.includes('稍后') || lower.includes('rate') || lower.includes('too many')) {
    return {
      tone: 'warning',
      title: '请求过于频繁',
      message,
      showLoginAction: false,
    };
  }

  if (message.includes('网络') || message.includes('服务') || lower.includes('network') || lower.includes('fetch')) {
    return {
      tone: 'error',
      title: '服务连接异常',
      message,
      showLoginAction: false,
    };
  }

  return {
    tone: 'error',
    title: '解析没有完成',
    message,
    showLoginAction: false,
  };
};

function PublicApp({ apiBase }: { apiBase: string }) {
  const [mode, setMode] = useState<Mode>('parse');
  const [url, setUrl] = useState('');
  const [keywords, setKeywords] = useState('');
  const [loading, setLoading] = useState(false);
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [noteDownloading, setNoteDownloading] = useState(false);
  const [error, setError] = useState('');
  const [errorNeedsLogin, setErrorNeedsLogin] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [noteInfo, setNoteInfo] = useState<NoteInfo | null>(null);
  const [noteList, setNoteList] = useState<NoteInfo[]>([]);
  const [previewIndexes, setPreviewIndexes] = useState<Record<string, number>>({});
  const [enrichingNoteIds, setEnrichingNoteIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<DownloadJobProgress | null>(null);
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [enhancedCookie, setEnhancedCookie] = useState('');
  const [enhancedCookieAction, setEnhancedCookieAction] = useState<EnhancedCookieAction>(null);

  // 进度相关状态
  const [targetCount, setTargetCount] = useState<number>(20);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  // 本次搜索/博主任务的目标值，任务结束后仍保留，用于在结果页提示「目标 X / 实际 Y」
  const [lastSearchTarget, setLastSearchTarget] = useState<number>(0);
  const progressTimerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const batchProgressTimerRef = useRef<number | null>(null);
  const requestInFlightRef = useRef(false);
  const enrichPromisesRef = useRef<Map<string, Promise<NoteInfo>>>(new Map());
  const searchStartTsRef = useRef<number>(0);

  // 优先用环境变量（开发态推荐设为 http://localhost:3001 连本地后端）；
  // 生产部署推荐不设该变量、走同源空字符串 + Nginx 将 /api 反代到后端。
  // 这样 build 产物不依赖部署环境的后端域名，一份镜像在多环境可重用。
  const API_BASE = apiBase;

  const handleModeChange = useCallback((nextMode: Mode) => {
    setMode(nextMode);
    setError('');
    setErrorNeedsLogin(false);
  }, []);

  // 获取代理URL - 解决小红书资源需要特定请求头的问题
  const getProxyUrl = useCallback((url: string, type: 'video' | 'image' = 'image'): string => {
    if (!url) return '';
    // 如果已经是代理URL，直接返回
    if (url.includes('/api/proxy/')) return url;
    // 使用后端代理
    return `${API_BASE}/api/proxy/${type}?url=${encodeURIComponent(url)}`;
  }, [API_BASE]);

  const showNotice = useCallback((type: Notice['type'], message: string) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    setNotice({ type, message });
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 4000);
  }, []);

  // 检查登录状态
  const checkLoginStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/login-status`);
      const data = await response.json();
      if (data.data) {
        setLoginStatus(data.data);
      }
    } catch {
      setLoginStatus({
        driverRunning: false,
        loginValid: false,
        loginMessage: '服务连接失败'
      });
    }
  }, [API_BASE]);

  const handleSaveEnhancedCookie = useCallback(async () => {
    const cookie = enhancedCookie.trim();
    if (!cookie) {
      showNotice('error', '请先粘贴 Cookie');
      return;
    }

    setEnhancedCookieAction('save');
    try {
      const response = await fetch(`${API_BASE}/api/enhanced-cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success || !payload?.data) {
        throw new Error(payload?.message || '保存 Cookie 失败');
      }
      setLoginStatus(payload.data);
      setEnhancedCookie('');
      showNotice('success', payload.message || 'Cookie 已保存');
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存 Cookie 失败';
      showNotice('error', message);
      checkLoginStatus();
    } finally {
      setEnhancedCookieAction(null);
    }
  }, [API_BASE, checkLoginStatus, enhancedCookie, showNotice]);

  const handleClearEnhancedCookie = useCallback(async () => {
    setEnhancedCookieAction('clear');
    try {
      const response = await fetch(`${API_BASE}/api/enhanced-cookie/clear`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success || !payload?.data) {
        throw new Error(payload?.message || '清除 Cookie 失败');
      }
      setLoginStatus(payload.data);
      setEnhancedCookie('');
      showNotice('success', payload.message || 'Cookie 已清除');
    } catch (err) {
      const message = err instanceof Error ? err.message : '清除 Cookie 失败';
      showNotice('error', message);
    } finally {
      setEnhancedCookieAction(null);
    }
  }, [API_BASE, showNotice]);

  // 初始化时检查登录状态
  useEffect(() => {
    const initialTimer = window.setTimeout(checkLoginStatus, 0);
    // 每 10 秒刷新一次状态，让右上角徽章更快反应登录/注销的变化
    const interval = window.setInterval(checkLoginStatus, 10000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [checkLoginStatus]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!showLoginModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowLoginModal(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showLoginModal]);

  // 检查错误是否是登录相关
  // 优先信任后端明确的 needLogin 字段；其次按关键词兑底
  const checkLoginError = useCallback((
    errorMsg: string,
    payload?: { needLogin?: boolean },
    options: { openModal?: boolean } = {},
  ) => {
    const openModal = options.openModal ?? true;
    if (payload?.needLogin === true) {
      if (openModal) {
        setShowLoginModal(true);
      }
      // 弹出后立即刷新一次状态，让弹框内的文案更准确
      checkLoginStatus();
      return true;
    }
    const loginKeywords = ['没有权限', '登录', 'cookie', '认证', 'unauthorized', 'forbidden'];
    const isLoginError = loginKeywords.some(keyword =>
      errorMsg.toLowerCase().includes(keyword.toLowerCase())
    );
    if (isLoginError && openModal) {
      setShowLoginModal(true);
    }
    return isLoginError;
  }, [checkLoginStatus]);

  // 计算分页数据
  const totalPages = Math.ceil(noteList.length / PAGE_SIZE);
  const paginatedNotes = noteList.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // 停止进度轮询（用于清理 setInterval）
  const stopProgressPolling = useCallback(() => {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const stopBatchProgressPolling = useCallback(() => {
    if (batchProgressTimerRef.current !== null) {
      window.clearInterval(batchProgressTimerRef.current);
      batchProgressTimerRef.current = null;
    }
  }, []);

  const triggerNativeDownload = useCallback((downloadUrl: string) => {
    const link = document.createElement('a');
    link.href = `${API_BASE}${downloadUrl}`;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [API_BASE]);

  const startBatchProgressPolling = useCallback((initialProgress: DownloadJobProgress) => {
    stopBatchProgressPolling();
    setBatchProgress(initialProgress);
    let nativeDownloadStarted = false;

    const tick = async () => {
      try {
        const response = await fetch(`${API_BASE}${initialProgress.progressUrl}`);
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.success || !payload?.data) {
          throw new Error(payload?.message || '下载任务进度查询失败');
        }

        const next = payload.data as DownloadJobProgress;
        setBatchProgress(next);

        if (next.status === 'ready' && !nativeDownloadStarted) {
          nativeDownloadStarted = true;
          triggerNativeDownload(next.downloadUrl);
        }

        if (next.status === 'completed') {
          stopBatchProgressPolling();
          setBatchDownloading(false);
          showNotice('success', '批量下载已完成');
        } else if (next.status === 'failed') {
          stopBatchProgressPolling();
          setBatchDownloading(false);
          throw new Error(next.message || '批量下载失败');
        }
      } catch (err) {
        stopBatchProgressPolling();
        setBatchDownloading(false);
        const message = err instanceof Error ? err.message : '批量下载失败';
        setError(message);
        setErrorNeedsLogin(false);
        showNotice('error', message);
      }
    };

    tick();
    batchProgressTimerRef.current = window.setInterval(tick, PROGRESS_POLL_INTERVAL_MS);
  }, [API_BASE, showNotice, stopBatchProgressPolling, triggerNativeDownload]);

  // 启动进度轮询
  const startProgressPolling = useCallback((
    mode: 'search' | 'creator',
    key: string,
  ) => {
    stopProgressPolling();
    // since 减 5s 缓冲区，跟后端 searchStartTs 的库存策略对齐
    const sinceMs = Date.now() - 5000;
    searchStartTsRef.current = Date.now();
    setProgress({ count: 0, parsedCount: 0, discoveredCount: 0, detailTaskCount: 0, status: 'running', elapsedMs: 0 });

    const tick = async () => {
      try {
        const qs = new URLSearchParams({ mode, key, since: String(sinceMs), target: String(targetCount) }).toString();
        const r = await fetch(`${API_BASE}/api/progress?${qs}`);
        const j = await r.json();
        if (j?.success) {
          const elapsedMs = Date.now() - searchStartTsRef.current;
          const parsedCount = Number(j.data?.parsedCount ?? j.data?.count) || 0;
          setProgress({
            count: parsedCount,
            parsedCount,
            discoveredCount: Number(j.data?.discoveredCount) || parsedCount,
            detailTaskCount: Number(j.data?.detailTaskCount) || 0,
            status: j.data?.status || 'unknown',
            elapsedMs,
          });
        }
      } catch {
        // 轮询出错不影响主流程
      }
    };
    tick();
    progressTimerRef.current = window.setInterval(tick, PROGRESS_POLL_INTERVAL_MS);
  }, [API_BASE, stopProgressPolling, targetCount]);

  // 提前结束（将已爬到的部分结果正常返回）
  const handleFinishEarly = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/api/finish-early`, { method: 'POST' });
    } catch {
      // 即使接口异常，前端也不会因此阻塞
    }
  }, [API_BASE]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      stopProgressPolling();
      stopBatchProgressPolling();
    };
  }, [stopBatchProgressPolling, stopProgressPolling]);

  // 解析单个笔记
  const handleParse = useCallback(async () => {
    if (requestInFlightRef.current) return;
    const nextUrl = url.trim();
    if (!nextUrl) {
      setError('请输入小红书链接');
      setErrorNeedsLogin(false);
      return;
    }

    requestInFlightRef.current = true;
    setLoading(true);
    setError('');
    setErrorNeedsLogin(false);
    setNoteInfo(null);
    setNoteList([]);
    setPreviewIndexes({});
    setEnrichingNoteIds(new Set());
    setSelectedNotes(new Set());
    setCurrentPage(1);

    try {
      const response = await fetch(`${API_BASE}/api/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: nextUrl }),
      });

      const data = await response.json();

      if (data.success) {
        setNoteInfo(data.data);
      } else {
        const message = data.message || '解析失败';
        const needsLogin = checkLoginError(message, data, { openModal: false });
        setError(message);
        setErrorNeedsLogin(needsLogin);
      }
    } catch {
      setError('网络错误，请检查后端服务是否启动');
      setErrorNeedsLogin(false);
    } finally {
      requestInFlightRef.current = false;
      setLoading(false);
    }
  }, [url, API_BASE, checkLoginError]);

  // 搜索笔记
  const handleSearch = useCallback(async () => {
    if (requestInFlightRef.current) return;
    const nextKeywords = keywords.trim();
    if (!nextKeywords) {
      setError('请输入搜索关键词');
      setErrorNeedsLogin(false);
      return;
    }
    if (!loginStatus?.loginValid) {
      setError('请先在右上角启用增强模式后再使用关键词搜索');
      setErrorNeedsLogin(true);
      setShowLoginModal(true);
      checkLoginStatus();
      return;
    }

    requestInFlightRef.current = true;
    setLoading(true);
    setError('');
    setErrorNeedsLogin(false);
    setNoteInfo(null);
    setNoteList([]);
    setPreviewIndexes({});
    setEnrichingNoteIds(new Set());
    setSelectedNotes(new Set());
    setCurrentPage(1);
    setLastSearchTarget(targetCount);

    // 启动进度轮询
    startProgressPolling('search', nextKeywords);

    try {
      const response = await fetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: nextKeywords, maxCount: targetCount }),
      });

      const data = await response.json();

      if (data.success) {
        setNoteList(data.data);
        // 默认全选第一页
        const firstPageNotes = data.data.slice(0, PAGE_SIZE);
        setSelectedNotes(new Set(firstPageNotes.map((n: NoteInfo) => n.noteId)));
      } else {
        const message = data.message || '搜索失败';
        const needsLogin = checkLoginError(message, data);
        setError(message);
        setErrorNeedsLogin(needsLogin);
      }
    } catch {
      setError('网络错误，请检查后端服务是否启动');
      setErrorNeedsLogin(false);
    } finally {
      requestInFlightRef.current = false;
      stopProgressPolling();
      setProgress(null);
      setLoading(false);
    }
  }, [keywords, loginStatus?.loginValid, targetCount, API_BASE, startProgressPolling, stopProgressPolling, checkLoginError, checkLoginStatus]);

  // 获取博主笔记
  const handleCreator = useCallback(async () => {
    if (requestInFlightRef.current) return;
    const nextUrl = url.trim();
    if (!nextUrl) {
      setError('请输入博主主页链接');
      setErrorNeedsLogin(false);
      return;
    }
    if (!loginStatus?.loginValid) {
      setError('请先在右上角启用增强模式后再获取博主笔记');
      setErrorNeedsLogin(true);
      setShowLoginModal(true);
      checkLoginStatus();
      return;
    }

    requestInFlightRef.current = true;
    setLoading(true);
    setError('');
    setErrorNeedsLogin(false);
    setNoteInfo(null);
    setNoteList([]);
    setPreviewIndexes({});
    setEnrichingNoteIds(new Set());
    setSelectedNotes(new Set());
    setCurrentPage(1);
    setLastSearchTarget(targetCount);

    // 从 URL 中提取 userId 用于 progress 轮询
    const userIdMatch = nextUrl.match(/user\/profile\/([a-zA-Z0-9]+)/);
    const userIdForProgress = userIdMatch ? userIdMatch[1] : nextUrl;
    startProgressPolling('creator', userIdForProgress);

    try {
      const response = await fetch(`${API_BASE}/api/creator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: nextUrl, maxCount: targetCount }),
      });

      const data = await response.json();

      if (data.success) {
        setNoteList(data.data);
        // 默认全选第一页
        const firstPageNotes = data.data.slice(0, PAGE_SIZE);
        setSelectedNotes(new Set(firstPageNotes.map((n: NoteInfo) => n.noteId)));
      } else {
        const message = data.message || '获取失败';
        const needsLogin = checkLoginError(message, data);
        setError(message);
        setErrorNeedsLogin(needsLogin);
      }
    } catch {
      setError('网络错误，请检查后端服务是否启动');
      setErrorNeedsLogin(false);
    } finally {
      requestInFlightRef.current = false;
      stopProgressPolling();
      setProgress(null);
      setLoading(false);
    }
  }, [url, loginStatus?.loginValid, targetCount, API_BASE, startProgressPolling, stopProgressPolling, checkLoginError, checkLoginStatus]);

  const handleDownload = useCallback((downloadUrl: string, filename: string, fallbackUrls: string[] = []) => {
    const params = new URLSearchParams({ url: downloadUrl });
    if (fallbackUrls.length > 0) {
      params.set('fallbackUrls', JSON.stringify(fallbackUrls));
    }
    const link = document.createElement('a');
    link.href = `${API_BASE}/api/download?${params.toString()}`;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [API_BASE]);

  const updateNoteInState = useCallback((nextNote: NoteInfo) => {
    const key = getNoteKey(nextNote);
    if (!key) return;

    setNoteList(prev => prev.map(item => getNoteKey(item) === key ? nextNote : item));
    setNoteInfo(prev => prev && getNoteKey(prev) === key ? nextNote : prev);
  }, []);

  const ensureNoteMedia = useCallback(async (note: NoteInfo, options: { silent?: boolean } = {}): Promise<NoteInfo> => {
    const key = getNoteKey(note);
    if (!key || note.parseMode === 'anonymous') return note;

    const existing = enrichPromisesRef.current.get(key);
    if (existing) return existing;

    setEnrichingNoteIds(prev => new Set(prev).add(key));
    const promise = fetch(`${API_BASE}/api/enrich-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    })
      .then(async response => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.success || !payload?.data) {
          throw new Error(payload?.message || '补全媒体信息失败');
        }
        const enriched = payload.data as NoteInfo;
        updateNoteInState(enriched);
        return enriched;
      })
      .catch(err => {
        if (!options.silent) {
          const message = err instanceof Error ? err.message : '补全媒体信息失败';
          showNotice('error', message);
        }
        return note;
      })
      .finally(() => {
        enrichPromisesRef.current.delete(key);
        setEnrichingNoteIds(prev => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      });

    enrichPromisesRef.current.set(key, promise);
    return promise;
  }, [API_BASE, showNotice, updateNoteInState]);

  const handleDownloadNoteMedia = useCallback(async (note: NoteInfo) => {
    setNoteDownloading(true);
    setError('');
    setErrorNeedsLogin(false);
    try {
      if (note.parseMode !== 'anonymous') {
        showNotice('info', '正在补全媒体信息');
      }
      const enriched = await ensureNoteMedia(note);

      if (enriched.type === 'video' && enriched.video?.url) {
        handleDownload(enriched.video.url, `video_${enriched.noteId}.mp4`, enriched.video.backupUrls || []);
        showNotice('success', '已开始下载视频');
        return;
      }

      const livePhotoCount = enriched.livePhotos?.length || 0;
      if (livePhotoCount === 0 && enriched.images.length <= 1) {
        if (enriched.images[0]) {
          handleDownload(enriched.images[0], `image_${enriched.noteId}_1.jpg`);
          showNotice('success', '已开始下载图片');
        }
        return;
      }

      const response = await fetch(`${API_BASE}/api/download-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: [enriched] }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || '打包下载失败');
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `xiaohongshu_${enriched.noteId || Date.now()}.zip`;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 0);
      showNotice('success', livePhotoCount > 0
        ? `已开始打包下载 ${livePhotoCount} 组实况组件`
        : `已开始打包下载 ${enriched.images.length} 张图片`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '打包下载失败';
      setError(message);
      setErrorNeedsLogin(false);
      showNotice('error', message);
    } finally {
      setNoteDownloading(false);
    }
  }, [API_BASE, ensureNoteMedia, handleDownload, showNotice]);

  const handlePreviewStep = useCallback((note: NoteInfo, delta: number) => {
    const key = getNoteKey(note);
    const total = Math.max(1, note.images.length);
    if (!key || total <= 1) return;

    ensureNoteMedia(note, { silent: true });
    setPreviewIndexes(prev => {
      const current = Math.min(prev[key] || 0, total - 1);
      return { ...prev, [key]: (current + delta + total) % total };
    });
  }, [ensureNoteMedia]);

  const handleOpenNoteDetail = useCallback(async (note: NoteInfo) => {
    const enriched = await ensureNoteMedia(note, { silent: true });
    setNoteInfo(enriched);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [ensureNoteMedia]);

  const handleCopyUrl = useCallback(async (noteUrl: string) => {
    try {
      await navigator.clipboard.writeText(noteUrl);
      showNotice('success', '已复制原地址');
    } catch {
      showNotice('error', '复制失败，请手动复制链接');
    }
  }, [showNotice]);

  const formatNumber = (num: number): string => {
    if (num >= 10000) {
      return (num / 10000).toFixed(1) + 'w';
    }
    return num.toString();
  };

  // 全选当前页
  const handleSelectAllPage = () => {
    const pageNoteIds = paginatedNotes.map(n => n.noteId);
    const newSelected = new Set(selectedNotes);

    // 检查当前页是否全选
    const allPageSelected = pageNoteIds.every(id => newSelected.has(id));

    if (allPageSelected) {
      // 取消当前页选择
      pageNoteIds.forEach(id => newSelected.delete(id));
    } else {
      // 选择当前页
      pageNoteIds.forEach(id => newSelected.add(id));
    }
    setSelectedNotes(newSelected);
  };

  // 切换单个选择
  const handleToggleSelect = (noteId: string) => {
    const newSelected = new Set(selectedNotes);
    if (newSelected.has(noteId)) {
      newSelected.delete(noteId);
    } else {
      newSelected.add(noteId);
    }
    setSelectedNotes(newSelected);
  };

  // 批量下载 - 打包成ZIP
  const handleBatchDownload = async () => {
    const selectedList = noteList.filter(n => selectedNotes.has(n.noteId));
    if (selectedList.length === 0) {
      setError('请选择要下载的笔记');
      setErrorNeedsLogin(false);
      return;
    }

    setBatchDownloading(true);
    setBatchProgress(null);
    setError('');
    setErrorNeedsLogin(false);
    try {
      const response = await fetch(`${API_BASE}/api/download-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: selectedList }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success || !payload?.data) {
        throw new Error(payload?.message || '下载失败');
      }

      startBatchProgressPolling(payload.data as DownloadJobProgress);
      showNotice('info', `已创建打包任务，正在处理 ${selectedList.length} 条笔记`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '批量下载失败';
      setError(message);
      setErrorNeedsLogin(false);
      showNotice('error', message);
      setBatchDownloading(false);
    }
  };

  // 页面切换
  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const currentError = error ? classifyErrorMessage(error, errorNeedsLogin) : null;
  const notePublishTime = formatPublishTime(noteInfo?.publishTime);
  const noteDisplayDesc = noteInfo ? stripTopicMarkers(noteInfo.desc, Boolean(noteInfo.tags?.length)) : '';

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="logo">
            <span className="logo-icon">📕</span>
            <span className="logo-text">小红书无水印下载</span>
          </div>
          {/* 登录状态指示器 */}
          <button
            type="button"
            className="login-status-indicator"
            onClick={() => setShowLoginModal(true)}
            aria-label="启用或查看增强模式状态"
          >
            {loginStatus ? (
              loginStatus.loginValid ? (
                <span className="status-badge valid">✓ 增强模式已启用</span>
              ) : (
                <span className="status-badge invalid">启用增强模式</span>
              )
            ) : (
              <span className="status-badge checking">检查中...</span>
            )}
          </button>
        </div>
      </header>

      {notice && (
        <div className={`app-notice ${notice.type}`} role="status" aria-live="polite">
          {notice.message}
        </div>
      )}

      {/* 增强模式状态弹窗 */}
      {showLoginModal && (
        <div className="login-modal-overlay" onClick={() => setShowLoginModal(false)}>
          <div
            className="login-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-modal-title"
            onClick={e => e.stopPropagation()}
          >
            <h3 id="login-modal-title">启用增强模式</h3>
            <p className="login-mode-note">
              普通分享链接解析和下载默认可用；关键词搜索和博主笔记需要提交 Xiaohongshu Cookie 后使用。
            </p>
            {loginStatus ? (
              <div className={`login-status-detail ${loginStatus.loginValid ? 'valid' : 'invalid'}`}>
                <p className="login-status-title"><strong>{loginStatus.loginMessage}</strong></p>
                <p className="login-status-line">
                  驱动器：{loginStatus.driverRunning ? '运行中' : '未运行'}
                </p>
                <p className="login-status-line cookie-line">
                  Cookie：
                  {loginStatus.cookieConfigured
                    ? (loginStatus.cookieVerified ? '已通过实效校验' : (loginStatus.cookieValidFormat ? '待重新校验' : '格式异常'))
                    : '未配置'}
                </p>
                {loginStatus.cookieAccount && (
                  <div className="login-account">
                    {loginStatus.cookieAccount.avatar ? (
                      <img
                        src={loginStatus.cookieAccount.avatar}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="login-account-avatar-fallback" aria-hidden="true">
                        {(loginStatus.cookieAccount.nickname || '小').slice(0, 1)}
                      </span>
                    )}
                    <div>
                      <strong>{loginStatus.cookieAccount.nickname || '小红书用户'}</strong>
                    </div>
                  </div>
                )}
                {loginStatus.cookieUpdatedAt && (
                  <p className="login-status-line">更新时间：{new Date(loginStatus.cookieUpdatedAt).toLocaleString('zh-CN')}</p>
                )}
                {loginStatus.cookieValidatedAt && (
                  <p className="login-status-line">实效校验时间：{new Date(loginStatus.cookieValidatedAt).toLocaleString('zh-CN')}</p>
                )}
                {loginStatus.hint && <p className="hint">{loginStatus.hint}</p>}
              </div>
            ) : (
              <p>正在检查增强模式状态...</p>
            )}
            <label className="enhanced-cookie-field">
              <span>Cookie</span>
              <textarea
                value={enhancedCookie}
                onChange={(e) => setEnhancedCookie(e.target.value)}
                placeholder="粘贴浏览器请求里的 Cookie header，需包含 web_session"
                spellCheck={false}
              />
            </label>
            <div className="enhanced-cookie-actions">
              <button
                className="login-btn"
                onClick={handleSaveEnhancedCookie}
                disabled={enhancedCookieAction !== null}
              >
                {enhancedCookieAction === 'save' ? '校验中...' : '保存并校验'}
              </button>
              <button
                className="logout-btn"
                onClick={handleClearEnhancedCookie}
                disabled={enhancedCookieAction !== null}
              >
                {enhancedCookieAction === 'clear' ? '清除中...' : '清除 Cookie'}
              </button>
            </div>
            <button className="login-btn secondary" onClick={checkLoginStatus}>
              刷新状态
            </button>
            <button className="close-modal-btn" onClick={() => setShowLoginModal(false)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="main">
        {/* Hero Section */}
        <section className="hero-section">
          <h1 className="hero-title">小红书无水印下载工具</h1>
          <p className="hero-desc">
            粘贴小红书链接，一键下载无水印图片和视频
          </p>

          {/* Mode Tabs */}
          <div className="mode-tabs">
            <button className={`mode-tab ${mode === 'parse' ? 'active' : ''}`} onClick={() => handleModeChange('parse')} aria-pressed={mode === 'parse'}>
              📄 解析链接
            </button>
            <button className={`mode-tab ${mode === 'creator' ? 'active' : ''}`} onClick={() => handleModeChange('creator')} aria-pressed={mode === 'creator'}>
              👤 博主笔记
            </button>
            <button
              className={`mode-tab experimental ${mode === 'search' ? 'active' : ''}`}
              onClick={() => handleModeChange('search')}
              title="实验性功能：小红书原生搜索体验更佳，此处仅适合批量存档场景"
              aria-pressed={mode === 'search'}
            >
              🔍 关键词搜索 <span className="experimental-tag">实验性</span>
            </button>
          </div>

          {/* Input Section */}
          <div className="input-section">
            {mode === 'parse' && (
              <div className="input-wrapper">
                <input
                  type="text"
                  className="url-input"
                  placeholder="粘贴小红书笔记链接或完整分享文案"
                  aria-label="小红书笔记链接或完整分享文案"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !loading && handleParse()}
                />
                <button className="parse-btn" onClick={handleParse} disabled={loading}>
                  {loading ? <span className="loading-spinner"></span> : '解析'}
                </button>
              </div>
            )}

            {mode === 'search' && (
              <div className="input-wrapper">
                <input
                  type="text"
                  className="url-input"
                  placeholder="输入搜索关键词，如：美食 旅游 化妆"
                  aria-label="搜索关键词"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !loading && handleSearch()}
                />
                <select
                  className="count-input count-select"
                  title="目标笔记数量（小红书单页最小 20 条，按 20 的倍数选择）"
                  aria-label="目标笔记数量"
                  value={targetCount}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v)) setTargetCount(v);
                  }}
                  disabled={loading}
                >
                  {TARGET_COUNT_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n} 条</option>
                  ))}
                </select>
                <button className="parse-btn" onClick={handleSearch} disabled={loading}>
                  {loading ? <span className="loading-spinner"></span> : '搜索'}
                </button>
              </div>
            )}

            {mode === 'creator' && (
              <div className="input-wrapper">
                <input
                  type="text"
                  className="url-input"
                  placeholder="粘贴博主主页链接或完整分享文案"
                  aria-label="博主主页链接或完整分享文案"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !loading && handleCreator()}
                />
                <select
                  className="count-input count-select"
                  title="目标笔记数量（小红书单页最小 20 条，按 20 的倍数选择）"
                  aria-label="目标笔记数量"
                  value={targetCount}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v)) setTargetCount(v);
                  }}
                  disabled={loading}
                >
                  {TARGET_COUNT_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n} 条</option>
                  ))}
                </select>
                <button className="parse-btn" onClick={handleCreator} disabled={loading}>
                  {loading ? <span className="loading-spinner"></span> : '获取'}
                </button>
              </div>
            )}

            {/* Usage Tips */}
            {mode === 'parse' && (
              <div className="supported-formats">
                <span className="format-tip">💡 在小红书 App 或网页点击「分享」，复制链接后粘到此处即可</span>
                <span className="format-tip">✨ 从浏览器地址栏复制的完整链接，解析速度更快</span>
              </div>
            )}

            {mode === 'search' && (
              <div className="supported-formats">
                <span className="format-tip">⏳ 搜索需要翻页拉取数据，通常需要 30 秒 ∼ 数分钟，请耐心等待</span>
                <span className="format-tip">💡 目标数量越大耗时越长，如需提前拿到结果可点「提前结束」</span>
              </div>
            )}

            {mode === 'creator' && (
              <div className="supported-formats">
                <span className="format-tip">⏳ 拉取博主笔记需要至少几十秒，笔记越多等待越久，请保持页面打开</span>
                <span className="format-tip">💡 建议先以较小的目标数量试用，确认结果符合预期后再拉取更多</span>
              </div>
            )}

            {/* 搜索/博主进度卡片 */}
            {loading && progress && (mode === 'search' || mode === 'creator') && (
              <div className="progress-card">
                <div className="progress-header">
                  <span className="progress-icon">🔍</span>
                  <span className="progress-title">
                    {mode === 'search' ? '正在搜索：' : '正在获取博主笔记：'}
                    <strong>{mode === 'search' ? keywords : (url || '').slice(0, 40)}</strong>
                  </span>
                </div>
                <div className="progress-body">
                  <div className="progress-stats">
                    <span className="progress-count">已发现索引：<strong>{progress.discoveredCount}</strong> 条</span>
                    <span className="progress-count">已解析详情：<strong>{progress.parsedCount}</strong> / 目标 <strong>{targetCount}</strong> 条</span>
                    <span className="progress-elapsed">⏱ {Math.round(progress.elapsedMs / 1000)}s</span>
                    <span className={`progress-status ${progress.status}`}>
                      {progress.status === 'running' ? '🟢 爬取中' : progress.status === 'idle' ? '⚪ 空闲' : progress.status}
                    </span>
                  </div>
                  {/* 冷启动提示：count=0 时说明正在等 detail 反爬 */}
                  {progress.parsedCount === 0 && progress.status === 'running' && (
                    <div className="progress-hint">
                      ⏳ 正在建立连接并获取索引页，小红书 detail 反爬延迟通常 30–120s才会出现首条数据，请稍候…
                    </div>
                  )}
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${Math.min(100, (progress.parsedCount / Math.max(1, targetCount)) * 100)}%` }}
                    />
                  </div>
                  <button className="finish-early-btn" onClick={handleFinishEarly}>
                    ✂ 提前结束，展示已找到的
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Error Message */}
          {currentError && (
            <div className={`error-message ${currentError.tone}`} role="alert">
              <span className="error-icon">⚠️</span>
              <div className="error-copy">
                <strong>{currentError.title}</strong>
                <span>{currentError.message}</span>
              </div>
              {currentError.showLoginAction ? (
                <button className="error-login-btn" onClick={() => setShowLoginModal(true)}>
                  启用增强模式
                </button>
              ) : null}
            </div>
          )}
        </section>

        {/* Single Note Result */}
        {noteInfo && (
          <section className="result-section">
            <div className="author-info">
              <img src={noteInfo.author.avatar} alt={noteInfo.author.nickname} className="author-avatar"
                loading="lazy"
                decoding="async"
                onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/48'; }} />
              <span className="author-name">{noteInfo.author.nickname}</span>
              {noteInfo.parseMode && (
                <span
                  className={`parse-mode-badge ${noteInfo.parseMode}`}
                  title={noteInfo.parseMode === 'anonymous'
                    ? '通过直接解析小红书 HTML 获得，无需登录'
                    : '通过增强模式获得'}
                >
                  {noteInfo.parseMode === 'anonymous' ? '🚀 匿名直解' : '🔐 增强模式解析'}
                </span>
              )}
            </div>
            <h2 className="note-title">{noteInfo.title}</h2>
            {noteDisplayDesc && <p className="note-desc">{noteDisplayDesc}</p>}
            <div className="note-stats">
              <span>❤️ {formatNumber(noteInfo.likes)}</span>
              <span>⭐ {formatNumber(noteInfo.collects)}</span>
              <span>💬 {formatNumber(noteInfo.comments)}</span>
              {typeof noteInfo.shares === 'number' && noteInfo.shares > 0 && (
                <span>↗ {formatNumber(noteInfo.shares)}</span>
              )}
            </div>
            {(notePublishTime || noteInfo.ipLocation) && (
              <div className="note-meta-line">
                {notePublishTime && <span>发布于 {notePublishTime}</span>}
                {noteInfo.ipLocation && <span>IP 属地 {noteInfo.ipLocation}</span>}
              </div>
            )}
            {noteInfo.tags && noteInfo.tags.length > 0 && (
              <div className="topic-tags" aria-label="话题标签">
                {noteInfo.tags.map((tag) => (
                  <a
                    key={`${tag.id || tag.name}-${tag.name}`}
                    className="topic-tag"
                    href={buildTopicUrl(tag.name)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tag.name}
                  </a>
                ))}
              </div>
            )}
            <div className="result-toolbar">
              <div className="result-summary">
                <span className="media-type-pill">
                  {noteInfo.type === 'video' ? '视频' : '图集'} · {noteInfo.type === 'video' ? '1 个文件' : `${noteInfo.images.length} 张图片`}
                </span>
                {(noteInfo.livePhotos?.length || 0) > 0 && (
                  <span className="live-photo-pill">
                    实况图 · {noteInfo.livePhotos!.length} 组
                  </span>
                )}
                {noteInfo.type === 'video' && (
                  <span className={`watermark-pill ${noteInfo.hasWatermark ? 'warning' : 'ok'}`}>
                    {noteInfo.hasWatermark ? '视频源可能带水印' : '视频源无水印'}
                  </span>
                )}
              </div>
              <div className="result-actions">
                {noteInfo.noteUrl && (
                  <button className="secondary-action-btn" onClick={() => handleCopyUrl(noteInfo.noteUrl!)}>
                    复制原文链接
                  </button>
                )}
                {noteInfo.creatorUrl && (
                  <a className="secondary-action-btn" href={noteInfo.creatorUrl} target="_blank" rel="noreferrer">
                    打开博主
                  </a>
                )}
                {noteInfo.type === 'video' && noteInfo.video ? (
                  <button className="primary-action-btn" onClick={() => handleDownloadNoteMedia(noteInfo)} disabled={noteDownloading}>
                    下载视频
                  </button>
                ) : noteInfo.images.length > 0 ? (
                  <button
                    className="primary-action-btn"
                    onClick={() => handleDownloadNoteMedia(noteInfo)}
                    disabled={noteDownloading}
                  >
                    {noteDownloading
                      ? '打包中...'
                      : (noteInfo.livePhotos?.length || 0) > 0
                        ? `打包下载实况组件 (${noteInfo.livePhotos!.length})`
                        : noteInfo.images.length > 1
                        ? `打包下载图片 (${noteInfo.images.length})`
                        : '下载图片'}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="media-section">
              {noteInfo.type === 'video' && noteInfo.video ? (
                <div className="video-container">
                  {noteInfo.hasWatermark && (
                    <div className="watermark-warning">
                      ⚠️ 未能获取无水印源，当前视频可能带有水印。建议
                      <button
                        className="watermark-login-btn"
                        onClick={() => setShowLoginModal(true)}
                      >
                        启用增强模式
                      </button>
                      后重试
                    </div>
                  )}
                  <video
                    key={noteInfo.video.url}
                    src={getProxyUrl(noteInfo.video.url, 'video')}
                    controls
                    className="video-player"
                    poster={getProxyUrl(noteInfo.images[0], 'image')}
                    preload="metadata"
                    playsInline
                  />
                </div>
              ) : (
                <div className="images-grid">
                  {noteInfo.images.map((img, index) => {
                    const livePhoto = noteInfo.livePhotos?.find(item => item.index === index);
                    return (
                      <div key={index} className="image-item">
                        {livePhoto && <span className="live-photo-badge">实况</span>}
                        <img src={getProxyUrl(img, 'image')} alt={`图片 ${index + 1}`} className="preview-image"
                          loading="lazy"
                          decoding="async"
                          onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/400x500?text=加载失败'; }} />
                        <div className="image-actions">
                          <button className="download-btn" onClick={() => handleDownload(img, `image_${noteInfo.noteId}_${index + 1}.jpg`)}>
                            📥 图片 {index + 1}
                          </button>
                          {livePhoto && (
                            <button className="download-btn live-download" onClick={() => handleDownload(livePhoto.videoUrl, `live_${noteInfo.noteId}_${index + 1}.mp4`, (livePhoto.videoUrls || []).filter(item => item !== livePhoto.videoUrl))}>
                              🎞 动态
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Note List Result - 表格布局 */}
        {noteList.length > 0 && (
          <section className="result-section list-result">
            <div className="list-header">
              <div className="list-header-left">
                <label className="select-all-label">
                  <input
                    type="checkbox"
                    checked={paginatedNotes.every(n => selectedNotes.has(n.noteId))}
                    onChange={handleSelectAllPage}
                    aria-label="选择或取消选择本页笔记"
                  />
                  <span>本页全选</span>
                </label>
                <h2>共 {noteList.length} 条，已选 {selectedNotes.size} 条</h2>
                {lastSearchTarget > 0 && noteList.length !== lastSearchTarget && (
                  <span className="result-note-hint" title="本次目标数量与实际结果不一致">
                    {noteList.length > lastSearchTarget
                      ? `目标 ${lastSearchTarget} 条 · 实际 ${noteList.length} 条 — 小红书单页最小 20 条，已全部保留`
                      : `目标 ${lastSearchTarget} 条 · 实际 ${noteList.length} 条 — 小红书已返回所有可用结果，或您提前结束了任务`}
                  </span>
                )}
              </div>
              <button className="download-all-btn" onClick={handleBatchDownload} disabled={selectedNotes.size === 0 || batchDownloading}>
                {batchDownloading
                  ? batchProgress?.status === 'enriching'
                    ? `补全中 ${batchProgress.enrichedNotes}/${batchProgress.totalNotes}`
                    : batchProgress?.status === 'downloading'
                      ? `打包中 ${batchProgress.zippedFiles}/${Math.max(1, batchProgress.totalFiles)}`
                      : '准备下载...'
                  : `📦 打包下载 (${selectedNotes.size})`}
              </button>
            </div>

            {batchProgress && (
              <div className={`batch-progress-card ${batchProgress.status}`} role="status" aria-live="polite">
                <div className="batch-progress-header">
                  <strong>{batchProgress.message}</strong>
                  <span>{batchProgress.status === 'completed' ? '已完成' : batchProgress.status === 'failed' ? '失败' : '处理中'}</span>
                </div>
                <div className="batch-progress-stats">
                  <span>补全：{batchProgress.enrichedNotes} / {batchProgress.totalNotes}</span>
                  <span>加入 ZIP：{batchProgress.zippedFiles} / {batchProgress.totalFiles || '-'}</span>
                  <span>已下载：{formatBytes(batchProgress.downloadedBytes)}</span>
                </div>
              </div>
            )}

            {/* 表格布局 */}
            <div className="note-table">
              <div className="note-table-header">
                <div className="col-checkbox">选择</div>
                <div className="col-type">类型</div>
                <div className="col-preview">预览</div>
                <div className="col-title">标题</div>
                <div className="col-author">作者</div>
                <div className="col-stats">数据</div>
                <div className="col-actions">操作</div>
              </div>
              {paginatedNotes.map((note, idx) => {
                const noteKey = getNoteKey(note) || String(idx);
                const previewIndex = Math.min(previewIndexes[noteKey] || 0, Math.max(0, note.images.length - 1));
                const previewImage = note.images[previewIndex] || note.images[0] || '';
                const previewLivePhoto = note.livePhotos?.find(item => item.index === previewIndex);
                const isEnriching = enrichingNoteIds.has(noteKey);
                return (
                <div key={noteKey} className={`note-table-row ${selectedNotes.has(note.noteId) ? 'selected' : ''}`}>
                  <div className="col-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedNotes.has(note.noteId)}
                      onChange={() => handleToggleSelect(note.noteId)}
                      aria-label={`选择笔记 ${note.title || note.noteId || idx + 1}`}
                    />
                  </div>
                  <div className="col-type">
                    <span className="note-type-badge">{note.type === 'video' ? '🎬' : '🖼️'}</span>
                    {(note.livePhotos?.length || 0) > 0 && (
                      <span className="live-table-badge" title="包含实况图动态组件">实况</span>
                    )}
                    {note.type === 'video' && note.hasWatermark && (
                      <span className="watermark-badge" title="未获取到无水印源，可能带水印">水印</span>
                    )}
                  </div>
                  <div className="col-preview">
                    {note.type === 'video' && note.video ? (
                      <video
                        key={note.video.url}
                        src={getProxyUrl(note.video.url, 'video')}
                        className="table-video-preview"
                        controls
                        preload="none"
                        playsInline
                        poster={getProxyUrl(note.images[0], 'image')}
                      />
                    ) : previewImage ? (
                      <div className="table-preview-carousel">
                        <button
                          className="preview-image-button"
                          type="button"
                          onClick={() => handleOpenNoteDetail(note)}
                          aria-label="查看笔记详情"
                        >
                          {previewLivePhoto && <span className="preview-live-badge">实况</span>}
                          {isEnriching && <span className="preview-enriching-badge">补全中</span>}
                          <img
                            src={getProxyUrl(previewImage, 'image')}
                            alt={`预览 ${previewIndex + 1}`}
                            className="table-image-preview"
                            loading="lazy"
                            decoding="async"
                            onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/60x80?text=加载失败'; }}
                          />
                        </button>
                        {note.images.length > 1 && (
                          <div className="preview-carousel-controls" aria-label="图片切换">
                            <button
                              className="preview-nav-btn"
                              type="button"
                              onClick={() => handlePreviewStep(note, -1)}
                              aria-label="上一张图片"
                            >
                              ‹
                            </button>
                            <span className="preview-counter">{previewIndex + 1}/{note.images.length}</span>
                            <button
                              className="preview-nav-btn"
                              type="button"
                              onClick={() => handlePreviewStep(note, 1)}
                              aria-label="下一张图片"
                            >
                              ›
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="no-preview">无预览</div>
                    )}
                  </div>
                  <div className="col-title">
                    <div className="note-title-text">{note.title || '无标题'}</div>
                    {note.desc && <div className="note-desc-text">{note.desc.substring(0, 50)}...</div>}
                  </div>
                  <div className="col-author">
                    <img
                      src={getProxyUrl(note.author.avatar, 'image')}
                      alt={note.author.nickname}
                      className="table-avatar"
                      loading="lazy"
                      decoding="async"
                      onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/32'; }}
                    />
                    <span className="table-author-name">{note.author.nickname}</span>
                  </div>
                  <div className="col-stats">
                    <span>❤️ {formatNumber(note.likes)}</span>
                    <span>⭐ {formatNumber(note.collects)}</span>
                  </div>
                  <div className="col-actions">
                    <div className="action-buttons">
                      {note.noteUrl && (
                        <button
                          className="action-btn copy-btn"
                          onClick={() => handleCopyUrl(note.noteUrl!)}
                          title="复制原地址"
                          aria-label="复制原地址"
                        >
                          📋
                        </button>
                      )}
                      {note.creatorUrl && (
                        <button
                          className="action-btn creator-btn"
                          onClick={() => {
                            setUrl(note.creatorUrl!);
                            handleModeChange('creator');
                          }}
                          title="查看博主"
                          aria-label="查看博主"
                        >
                          👤
                        </button>
                      )}
                      {note.type === 'video' && note.video ? (
                        <button
                          className="action-btn download-btn-table"
                          onClick={() => handleDownloadNoteMedia(note)}
                          title="下载视频"
                          aria-label="下载视频"
                        >
                          📥
                        </button>
                      ) : (
                        <button
                          className="action-btn download-btn-table"
                          onClick={() => handleDownloadNoteMedia(note)}
                          title={(note.livePhotos?.length || 0) > 0 ? '打包下载实况组件' : '下载图片'}
                          aria-label={(note.livePhotos?.length || 0) > 0 ? '打包下载实况组件' : '下载图片'}
                        >
                          📥
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="pagination">
                <button
                  className="page-btn"
                  disabled={currentPage === 1}
                  onClick={() => handlePageChange(1)}
                >
                  首页
                </button>
                <button
                  className="page-btn"
                  disabled={currentPage === 1}
                  onClick={() => handlePageChange(currentPage - 1)}
                >
                  上一页
                </button>
                <div className="page-numbers">
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNum: number;
                    if (totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (currentPage <= 3) {
                      pageNum = i + 1;
                    } else if (currentPage >= totalPages - 2) {
                      pageNum = totalPages - 4 + i;
                    } else {
                      pageNum = currentPage - 2 + i;
                    }
                    return (
                      <button
                        key={pageNum}
                        className={`page-num ${currentPage === pageNum ? 'active' : ''}`}
                        onClick={() => handlePageChange(pageNum)}
                      >
                        {pageNum}
                      </button>
                    );
                  })}
                </div>
                <button
                  className="page-btn"
                  disabled={currentPage === totalPages}
                  onClick={() => handlePageChange(currentPage + 1)}
                >
                  下一页
                </button>
                <button
                  className="page-btn"
                  disabled={currentPage === totalPages}
                  onClick={() => handlePageChange(totalPages)}
                >
                  末页
                </button>
                <span className="page-info">第 {currentPage}/{totalPages} 页</span>
              </div>
            )}
          </section>
        )}

      </main>

      {/* Footer */}
      <footer className="footer">
        <p>仅供学习交流使用，请勿用于商业用途</p>
      </footer>
    </div>
  );
}

function App() {
  const apiBase = import.meta.env.VITE_API_URL ?? '';
  return <PublicApp apiBase={apiBase} />;
}

export default App;
