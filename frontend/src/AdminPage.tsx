import { useCallback, useState } from 'react';

type CookieStatus = {
  present: boolean;
  validFormat: boolean;
  message: string;
  updatedAt?: string;
  validatedAt?: string;
  status?: 'active';
};

type AdminStatus = {
  mode?: 'ADMIN_COOKIE';
  canSelfLogin?: boolean;
  driverRunning?: boolean;
  enhancedModeAvailable?: boolean;
  loginValid?: boolean;
  loginMessage?: string;
  hint?: string | null;
  cookieConfigured?: boolean;
  cookieValidFormat?: boolean;
  cookieUpdatedAt?: string;
  cookieValidatedAt?: string;
  cookieStatus?: CookieStatus;
};

type ApiResponse<T> = {
  success: boolean;
  message?: string;
  data?: T;
};

type Notice = {
  type: 'success' | 'error' | 'info';
  message: string;
};

type AdminPageProps = {
  apiBase: string;
};

function formatDate(value?: string): string {
  if (!value) return '无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无';
  return date.toLocaleString('zh-CN');
}

function AdminPage({ apiBase }: AdminPageProps) {
  const [token, setToken] = useState('');
  const [cookie, setCookie] = useState('');
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const tokenReady = token.trim().length > 0;
  const cookieStatus = status?.cookieStatus;
  const hasFetchedStatus = status !== null;
  const enhancedAvailable = hasFetchedStatus && Boolean(status?.enhancedModeAvailable || status?.loginValid);
  const statusBadgeClass = hasFetchedStatus ? (enhancedAvailable ? 'valid' : 'invalid') : 'checking';
  const statusBadgeText = hasFetchedStatus
    ? (enhancedAvailable ? '增强模式已可用' : '增强模式维护中')
    : '待刷新';

  const requestAdmin = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> => {
    if (!tokenReady) {
      throw new Error('请先填写管理员令牌');
    }

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token.trim()}`);

    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.message || '请求失败');
    }
    return data;
  }, [apiBase, token, tokenReady]);

  const runAction = useCallback(async (action: string, task: () => Promise<void>) => {
    setBusyAction(action);
    setNotice(null);
    try {
      await task();
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '操作失败',
      });
    } finally {
      setBusyAction(null);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    await runAction('status', async () => {
      const data = await requestAdmin<AdminStatus>('/api/admin/auth/status');
      setStatus(data.data || null);
      setNotice({ type: 'success', message: '状态已刷新' });
    });
  }, [requestAdmin, runAction]);

  const saveCookie = useCallback(async () => {
    await runAction('save', async () => {
      const data = await requestAdmin<AdminStatus>('/api/admin/auth/cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie }),
      });
      setStatus(data.data || null);
      setCookie('');
      setNotice({ type: 'success', message: data.message || 'Cookie 已保存' });
    });
  }, [cookie, requestAdmin, runAction]);

  const clearCookie = useCallback(async () => {
    if (!window.confirm('确认清除服务器端保存的 Xiaohongshu Cookie？')) return;
    await runAction('clear', async () => {
      await requestAdmin('/api/admin/auth/clear', { method: 'POST' });
      const data = await requestAdmin<AdminStatus>('/api/admin/auth/status');
      setStatus(data.data || null);
      setNotice({ type: 'success', message: 'Cookie 已清除' });
    });
  }, [requestAdmin, runAction]);

  const stopCrawler = useCallback(async () => {
    await runAction('stop', async () => {
      await requestAdmin('/api/admin/crawler/stop', { method: 'POST' });
      const data = await requestAdmin<AdminStatus>('/api/admin/auth/status');
      setStatus(data.data || null);
      setNotice({ type: 'success', message: '已请求停止当前任务' });
    });
  }, [requestAdmin, runAction]);

  return (
    <div className="app admin-app">
      <header className="header">
        <div className="header-content">
          <a className="logo admin-logo" href="/">
            <span className="logo-icon">📕</span>
            <span className="logo-text">增强模式管理</span>
          </a>
          <span className={`status-badge ${statusBadgeClass}`}>
            {statusBadgeText}
          </span>
        </div>
      </header>

      {notice && (
        <div className={`app-notice ${notice.type}`} role="status" aria-live="polite">
          {notice.message}
        </div>
      )}

      <main className="admin-main">
        <section className="admin-toolbar">
          <div>
            <h1>增强模式管理</h1>
            <p>提交管理员维护的 Xiaohongshu Cookie，并查看驱动器与 Cookie 状态。</p>
          </div>
          <button
            type="button"
            className="admin-secondary-btn"
            onClick={refreshStatus}
            disabled={!tokenReady || busyAction !== null}
          >
            {busyAction === 'status' ? '刷新中...' : '刷新状态'}
          </button>
        </section>

        <section className="admin-grid">
          <div className="admin-panel">
            <h2>管理员认证</h2>
            <label className="admin-field">
              <span>管理员令牌</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                placeholder="填写 ADMIN_TOKEN"
              />
            </label>
          </div>

          <div className="admin-panel">
            <h2>Cookie 提交</h2>
            <label className="admin-field">
              <span>Cookie</span>
              <textarea
                value={cookie}
                onChange={(event) => setCookie(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="粘贴浏览器请求里的 Cookie header，需包含 web_session"
                rows={9}
              />
            </label>
            <div className="admin-actions">
              <button
                type="button"
                className="admin-primary-btn"
                onClick={saveCookie}
                disabled={!tokenReady || !cookie.trim() || busyAction !== null}
              >
                {busyAction === 'save' ? '保存中...' : '保存并验证'}
              </button>
              <button
                type="button"
                className="admin-danger-btn"
                onClick={clearCookie}
                disabled={!tokenReady || busyAction !== null}
              >
                {busyAction === 'clear' ? '清除中...' : '清除 Cookie'}
              </button>
            </div>
          </div>

          <div className="admin-panel">
            <h2>运行状态</h2>
            <dl className="admin-status-list">
              <div>
                <dt>增强模式</dt>
                <dd>{status?.loginMessage || '待刷新'}</dd>
              </div>
              <div>
                <dt>驱动器</dt>
                <dd>{status ? (status.driverRunning ? '运行中' : '未运行') : '待刷新'}</dd>
              </div>
              <div>
                <dt>Cookie</dt>
                <dd>{cookieStatus ? cookieStatus.message : '待刷新'}</dd>
              </div>
              <div>
                <dt>Cookie 更新时间</dt>
                <dd>{formatDate(cookieStatus?.updatedAt || status?.cookieUpdatedAt)}</dd>
              </div>
              <div>
                <dt>格式校验时间</dt>
                <dd>{formatDate(cookieStatus?.validatedAt || status?.cookieValidatedAt)}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="admin-secondary-btn full"
              onClick={stopCrawler}
              disabled={!tokenReady || busyAction !== null}
            >
              {busyAction === 'stop' ? '停止中...' : '停止当前任务'}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

export default AdminPage;
