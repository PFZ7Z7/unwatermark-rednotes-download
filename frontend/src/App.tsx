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
  video?: {
    url: string;
    duration: number;
  };
  likes: number;
  collects: number;
  comments: number;
  noteUrl?: string;
  creatorUrl?: string;
  hasWatermark?: boolean; // 视频疑似带水印（登录态失效时会为 true）
  parseMode?: 'anonymous' | 'mediacrawler'; // 数据来源：匿名直解 or MediaCrawler 爬取
}

interface LoginStatus {
  mediaCrawlerRunning: boolean;
  loginValid: boolean;
  loginMessage: string;
  hint?: string | null;
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
  status: 'running' | 'idle' | 'error' | 'unknown';
  elapsedMs: number;
}

function App() {
  const [mode, setMode] = useState<Mode>('parse');
  const [url, setUrl] = useState('');
  const [keywords, setKeywords] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [noteInfo, setNoteInfo] = useState<NoteInfo | null>(null);
  const [noteList, setNoteList] = useState<NoteInfo[]>([]);
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);

  // 进度相关状态
  const [targetCount, setTargetCount] = useState<number>(20);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  // 本次搜索/博主任务的目标值，任务结束后仍保留，用于在结果页提示「目标 X / 实际 Y」
  const [lastSearchTarget, setLastSearchTarget] = useState<number>(0);
  const progressTimerRef = useRef<number | null>(null);
  const searchStartTsRef = useRef<number>(0);

  // 优先用环境变量（开发态推荐设为 http://localhost:3001 连本地后端）；
  // 生产部署推荐不设该变量、走同源空字符串 + Nginx 将 /api 反代到后端。
  // 这样 build 产物不依赖部署环境的后端域名，一份镜像在多环境可重用。
  const API_BASE = import.meta.env.VITE_API_URL ?? '';

  // 获取代理URL - 解决小红书资源需要特定请求头的问题
  const getProxyUrl = useCallback((url: string, type: 'video' | 'image' = 'image'): string => {
    if (!url) return '';
    // 如果已经是代理URL，直接返回
    if (url.includes('/api/proxy/')) return url;
    // 使用后端代理
    return `${API_BASE}/api/proxy/${type}?url=${encodeURIComponent(url)}`;
  }, [API_BASE]);

  // 检查登录状态
  const checkLoginStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/login-status`);
      const data = await response.json();
      if (data.success) {
        setLoginStatus(data.data);
      }
    } catch (err) {
      setLoginStatus({
        mediaCrawlerRunning: false,
        loginValid: false,
        loginMessage: '服务连接失败'
      });
    }
  }, [API_BASE]);

  // 初始化时检查登录状态
  useEffect(() => {
    checkLoginStatus();
    // 每 10 秒刷新一次状态，让右上角徽章更快反应登录/注销的变化
    const interval = setInterval(checkLoginStatus, 10000);
    return () => clearInterval(interval);
  }, [checkLoginStatus]);

  // 触发登录
  const handleLogin = async () => {
    setLoginLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/login`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        alert(data.message);
        // 登录期间高频轮询：每 3 秒试一次，最长 2 分钟；成功即止
        let tries = 0;
        const timer = setInterval(async () => {
          tries++;
          try {
            const r = await fetch(`${API_BASE}/api/login-status`);
            const j = await r.json();
            if (j.success && j.data?.loginValid) {
              setLoginStatus(j.data);
              setShowLoginModal(false);
              clearInterval(timer);
              return;
            }
            setLoginStatus(j.data || loginStatus);
          } catch {}
          if (tries >= 40) clearInterval(timer); // 40 * 3s = 2min
        }, 3000);
      } else {
        alert(data.message + '\n\n' + data.hint);
      }
    } catch (err) {
      alert('启动登录失败，请手动运行 MediaCrawler 进行登录');
    } finally {
      setLoginLoading(false);
    }
  };

  // 退出登录：调用后端清掉 Cookies 文件后刷新状态
  const handleLogout = async () => {
    if (!confirm('确定要退出当前登录吗？\n退出后需要重新扫码才能使用搜索/博主模式。')) {
      return;
    }
    setLoginLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/logout`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        alert(data.message || '已退出登录');
        await checkLoginStatus();
        setShowLoginModal(false);
      } else {
        alert((data.message || '退出失败') + (data.hint ? '\n\n' + data.hint : ''));
      }
    } catch (err) {
      alert('退出登录请求失败，请检查后端服务是否正常');
    } finally {
      setLoginLoading(false);
    }
  };

  // 检查错误是否是登录相关
  // 优先信任后端明确的 needLogin 字段；其次按关键词兑底
  const checkLoginError = (errorMsg: string, payload?: { needLogin?: boolean }) => {
    if (payload?.needLogin === true) {
      setShowLoginModal(true);
      // 弹出后立即刷新一次状态，让弹框内的文案更准确
      checkLoginStatus();
      return true;
    }
    const loginKeywords = ['没有权限', '登录', 'cookie', '认证', 'unauthorized', 'forbidden'];
    const isLoginError = loginKeywords.some(keyword =>
      errorMsg.toLowerCase().includes(keyword.toLowerCase())
    );
    if (isLoginError) {
      setShowLoginModal(true);
      return true;
    }
    return false;
  };

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

  // 启动进度轮询
  const startProgressPolling = useCallback((
    mode: 'search' | 'creator',
    key: string,
  ) => {
    stopProgressPolling();
    // since 减 5s 缓冲区，跟后端 searchStartTs 的库存策略对齐
    const sinceMs = Date.now() - 5000;
    searchStartTsRef.current = Date.now();
    setProgress({ count: 0, status: 'running', elapsedMs: 0 });

    const tick = async () => {
      try {
        const qs = new URLSearchParams({ mode, key, since: String(sinceMs) }).toString();
        const r = await fetch(`${API_BASE}/api/progress?${qs}`);
        const j = await r.json();
        if (j?.success) {
          const elapsedMs = Date.now() - searchStartTsRef.current;
          setProgress({
            count: Number(j.data?.count) || 0,
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
  }, [API_BASE, stopProgressPolling]);

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
    return () => stopProgressPolling();
  }, [stopProgressPolling]);

  // 解析单个笔记
  const handleParse = useCallback(async () => {
    if (!url.trim()) {
      setError('请输入小红书链接');
      return;
    }

    setLoading(true);
    setError('');
    setNoteInfo(null);
    setNoteList([]);
    setSelectedNotes(new Set());
    setCurrentPage(1);

    try {
      const response = await fetch(`${API_BASE}/api/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await response.json();

      if (data.success) {
        setNoteInfo(data.data);
      } else {
        setError(data.message || '解析失败');
        checkLoginError(data.message || '', data);
      }
    } catch (err) {
      setError('网络错误，请检查后端服务是否启动');
    } finally {
      setLoading(false);
    }
  }, [url, API_BASE]);

  // 搜索笔记
  const handleSearch = useCallback(async () => {
    if (!keywords.trim()) {
      setError('请输入搜索关键词');
      return;
    }

    setLoading(true);
    setError('');
    setNoteInfo(null);
    setNoteList([]);
    setSelectedNotes(new Set());
    setCurrentPage(1);
    setLastSearchTarget(targetCount);

    // 启动进度轮询
    startProgressPolling('search', keywords.trim());

    try {
      const response = await fetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords, maxCount: targetCount }),
      });

      const data = await response.json();

      if (data.success) {
        setNoteList(data.data);
        // 默认全选第一页
        const firstPageNotes = data.data.slice(0, PAGE_SIZE);
        setSelectedNotes(new Set(firstPageNotes.map((n: NoteInfo) => n.noteId)));
      } else {
        setError(data.message || '搜索失败');
        checkLoginError(data.message || '', data);
      }
    } catch (err) {
      setError('网络错误，请检查后端服务是否启动');
    } finally {
      stopProgressPolling();
      setProgress(null);
      setLoading(false);
    }
  }, [keywords, targetCount, API_BASE, startProgressPolling, stopProgressPolling]);

  // 获取博主笔记
  const handleCreator = useCallback(async () => {
    if (!url.trim()) {
      setError('请输入博主主页链接');
      return;
    }

    setLoading(true);
    setError('');
    setNoteInfo(null);
    setNoteList([]);
    setSelectedNotes(new Set());
    setCurrentPage(1);
    setLastSearchTarget(targetCount);

    // 从 URL 中提取 userId 用于 progress 轮询
    const userIdMatch = url.match(/user\/profile\/([a-zA-Z0-9]+)/);
    const userIdForProgress = userIdMatch ? userIdMatch[1] : url.trim();
    startProgressPolling('creator', userIdForProgress);

    try {
      const response = await fetch(`${API_BASE}/api/creator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, maxCount: targetCount }),
      });

      const data = await response.json();

      if (data.success) {
        setNoteList(data.data);
        // 默认全选第一页
        const firstPageNotes = data.data.slice(0, PAGE_SIZE);
        setSelectedNotes(new Set(firstPageNotes.map((n: NoteInfo) => n.noteId)));
      } else {
        setError(data.message || '获取失败');
        checkLoginError(data.message || '', data);
      }
    } catch (err) {
      setError('网络错误，请检查后端服务是否启动');
    } finally {
      stopProgressPolling();
      setProgress(null);
      setLoading(false);
    }
  }, [url, targetCount, API_BASE, startProgressPolling, stopProgressPolling]);

  const handleDownload = useCallback((downloadUrl: string, filename: string) => {
    const link = document.createElement('a');
    link.href = `${API_BASE}/api/download?url=${encodeURIComponent(downloadUrl)}`;
    link.download = filename;
    link.click();
  }, [API_BASE]);

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
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/download-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: selectedList }),
      });

      if (!response.ok) {
        throw new Error('下载失败');
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `xiaohongshu_${Date.now()}.zip`;
      link.click();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error('批量下载失败:', err);
    }
  };

  // 页面切换
  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

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
          <div className="login-status-indicator" onClick={() => setShowLoginModal(true)}>
            {loginStatus ? (
              loginStatus.loginValid ? (
                <span className="status-badge valid">✓ 已登录</span>
              ) : (
                <span className="status-badge invalid">✗ 未登录</span>
              )
            ) : (
              <span className="status-badge checking">检查中...</span>
            )}
          </div>
        </div>
      </header>

      {/* 登录提示弹窗 */}
      {showLoginModal && (
        <div className="login-modal-overlay" onClick={() => setShowLoginModal(false)}>
          <div className="login-modal" onClick={e => e.stopPropagation()}>
            <h3>🔐 登录状态</h3>
            {loginStatus ? (
              <>
                <div className={`login-status-detail ${loginStatus.loginValid ? 'valid' : 'invalid'}`}>
                  <p><strong>服务状态:</strong> {loginStatus.mediaCrawlerRunning ? '✓ 运行中' : '✗ 未运行'}</p>
                  <p><strong>登录状态:</strong> {loginStatus.loginMessage}</p>
                  {loginStatus.hint && <p className="hint">{loginStatus.hint}</p>}
                </div>
                {!loginStatus.loginValid ? (
                  <div className="login-actions">
                    <button
                      className="login-btn"
                      onClick={handleLogin}
                      disabled={loginLoading}
                    >
                      {loginLoading ? '启动中...' : '📱 扫码登录'}
                    </button>
                    <p className="login-tip">
                      点击后将弹出浏览器窗口，请使用小红书App扫码登录
                    </p>
                  </div>
                ) : (
                  <div className="login-actions">
                    <button
                      className="logout-btn"
                      onClick={handleLogout}
                      disabled={loginLoading}
                    >
                      {loginLoading ? '处理中...' : '🚪 退出登录'}
                    </button>
                    <p className="login-tip">
                      退出后将清除本地登录凭证，下次需要重新扫码
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p>正在检查登录状态...</p>
            )}
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
            <button className={`mode-tab ${mode === 'parse' ? 'active' : ''}`} onClick={() => setMode('parse')}>
              📄 解析链接
            </button>
            <button className={`mode-tab ${mode === 'creator' ? 'active' : ''}`} onClick={() => setMode('creator')}>
              👤 博主笔记
            </button>
            <button
              className={`mode-tab experimental ${mode === 'search' ? 'active' : ''}`}
              onClick={() => setMode('search')}
              title="实验性功能：小红书原生搜索体验更佳，此处仅适合批量存档场景"
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
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleParse()}
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
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                />
                <select
                  className="count-input count-select"
                  title="目标笔记数量（小红书单页最小 20 条，按 20 的倍数选择）"
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
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleCreator()}
                />
                <select
                  className="count-input count-select"
                  title="目标笔记数量（小红书单页最小 20 条，按 20 的倍数选择）"
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
                    <span className="progress-count">已找到 <strong>{progress.count}</strong> / 目标 <strong>{targetCount}</strong> 条</span>
                    <span className="progress-elapsed">⏱ {Math.round(progress.elapsedMs / 1000)}s</span>
                    <span className={`progress-status ${progress.status}`}>
                      {progress.status === 'running' ? '🟢 爬取中' : progress.status === 'idle' ? '⚪ 空闲' : progress.status}
                    </span>
                  </div>
                  {/* 冷启动提示：count=0 时说明正在等 detail 反爬 */}
                  {progress.count === 0 && progress.status === 'running' && (
                    <div className="progress-hint">
                      ⏳ 正在建立连接并获取索引页，小红书 detail 反爬延迟通常 30–120s才会出现首条数据，请稍候…
                    </div>
                  )}
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${Math.min(100, (progress.count / Math.max(1, targetCount)) * 100)}%` }}
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
          {error && (
            <div className="error-message">
              <span className="error-icon">⚠️</span>
              {error}
              {error.includes('权限') || error.includes('登录') ? (
                <button className="error-login-btn" onClick={() => setShowLoginModal(true)}>
                  去登录
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
                onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/48'; }} />
              <span className="author-name">{noteInfo.author.nickname}</span>
              {noteInfo.parseMode && (
                <span
                  className={`parse-mode-badge ${noteInfo.parseMode}`}
                  title={noteInfo.parseMode === 'anonymous'
                    ? '通过直接解析小红书 HTML 获得，无需登录'
                    : '通过 MediaCrawler 登录后爬取获得'}
                >
                  {noteInfo.parseMode === 'anonymous' ? '🚀 匿名直解' : '🔐 登录解析'}
                </span>
              )}
            </div>
            <h2 className="note-title">{noteInfo.title}</h2>
            {noteInfo.desc && <p className="note-desc">{noteInfo.desc}</p>}
            <div className="note-stats">
              <span>❤️ {formatNumber(noteInfo.likes)}</span>
              <span>⭐ {formatNumber(noteInfo.collects)}</span>
              <span>💬 {formatNumber(noteInfo.comments)}</span>
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
                        重新登录
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
                  <button className="download-btn video-download" onClick={() => handleDownload(noteInfo.video!.url, `video_${noteInfo.noteId}.mp4`)}>
                    📥 下载视频
                  </button>
                </div>
              ) : (
                <div className="images-grid">
                  {noteInfo.images.map((img, index) => (
                    <div key={index} className="image-item">
                      <img src={getProxyUrl(img, 'image')} alt={`图片 ${index + 1}`} className="preview-image"
                        onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/400x500?text=加载失败'; }} />
                      <button className="download-btn" onClick={() => handleDownload(img, `image_${noteInfo.noteId}_${index + 1}.jpg`)}>
                        📥 下载图片 {index + 1}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {noteInfo.type === 'image' && noteInfo.images.length > 1 && (
              <button className="download-all-btn" onClick={() => {
                noteInfo.images.forEach((img, index) => {
                  setTimeout(() => handleDownload(img, `image_${noteInfo.noteId}_${index + 1}.jpg`), index * 500);
                });
              }}>
                📦 一键下载全部图片 ({noteInfo.images.length}张)
              </button>
            )}
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
              <button className="download-all-btn" onClick={handleBatchDownload} disabled={selectedNotes.size === 0}>
                📦 打包下载 ({selectedNotes.size})
              </button>
            </div>

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
              {paginatedNotes.map((note, idx) => (
                <div key={note.noteId || idx} className={`note-table-row ${selectedNotes.has(note.noteId) ? 'selected' : ''}`}>
                  <div className="col-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedNotes.has(note.noteId)}
                      onChange={() => handleToggleSelect(note.noteId)}
                    />
                  </div>
                  <div className="col-type">
                    <span className="note-type-badge">{note.type === 'video' ? '🎬' : '🖼️'}</span>
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
                        preload="metadata"
                        playsInline
                        poster={getProxyUrl(note.images[0], 'image')}
                      />
                    ) : note.images[0] ? (
                      <img
                        src={getProxyUrl(note.images[0], 'image')}
                        alt="预览"
                        className="table-image-preview"
                        onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/60x80?text=加载失败'; }}
                      />
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
                          onClick={() => {
                            navigator.clipboard.writeText(note.noteUrl!);
                          }}
                          title="复制原地址"
                        >
                          📋
                        </button>
                      )}
                      {note.creatorUrl && (
                        <button
                          className="action-btn creator-btn"
                          onClick={() => {
                            setUrl(note.creatorUrl!);
                            setMode('creator');
                          }}
                          title="查看博主"
                        >
                          👤
                        </button>
                      )}
                      {note.type === 'video' && note.video ? (
                        <button
                          className="action-btn download-btn-table"
                          onClick={() => handleDownload(note.video!.url, `video_${note.noteId}.mp4`)}
                          title="下载视频"
                        >
                          📥
                        </button>
                      ) : (
                        <button
                          className="action-btn download-btn-table"
                          onClick={() => {
                            note.images.forEach((img, index) => {
                              setTimeout(() => handleDownload(img, `image_${note.noteId}_${index + 1}.jpg`), index * 300);
                            });
                          }}
                          title="下载图片"
                        >
                          📥
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
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

export default App;