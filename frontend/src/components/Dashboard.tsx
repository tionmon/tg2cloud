import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, apiOrigin, apiUrl } from '../api';
import { Icon } from '../icons';
import type { Provider, StorageConfig, StoredFile } from '../types';

type DashboardProps = {
  username: string;
  onLogout: () => Promise<void>;
};

type Notice = {
  text: string;
  tone: 'success' | 'error' | 'info';
};

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function sourceLabel(source: StoredFile['source']): string {
  return source === 'telegram' ? 'Telegram' : '网页上传';
}

function providerLabel(provider: Provider): string {
  if (provider === 'dropbox') return 'Dropbox';
  if (provider === 'google-drive') return 'Google Drive';
  return '本地存储';
}

export function Dashboard({ username, onLogout }: DashboardProps) {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [accountName, setAccountName] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<'all' | Provider>('all');
  const fileInput = useRef<HTMLInputElement>(null);

  const notify = useCallback((text: string, tone: Notice['tone'] = 'success') => {
    setNotice({ text, tone });
  }, []);

  const reload = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const [fileData, configData] = await Promise.all([
        api<StoredFile[]>('/api/files'),
        api<StorageConfig>('/api/storage/config'),
      ]);
      setFiles(fileData);
      setConfig(configData);
    } catch (error) {
      notify(error instanceof Error ? error.message : '数据加载失败。', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void reload(true);

    const oauthHandler = (event: MessageEvent) => {
      if (event.origin !== apiOrigin()) return;
      if (event.data === 'dropbox_auth_success') {
        notify('Dropbox 已连接，并切换为当前存储源。');
        void reload();
      }
      if (event.data === 'google_auth_success') {
        notify('Google Drive 已连接，并切换为当前存储源。');
        void reload();
      }
    };
    window.addEventListener('message', oauthHandler);
    return () => window.removeEventListener('message', oauthHandler);
  }, [notify, reload]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const currentProvider = config?.activeProvider || 'local';
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const telegramCount = useMemo(
    () => files.filter(file => file.source === 'telegram').length,
    [files],
  );
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return files.filter(file => (
      (providerFilter === 'all' || file.provider === providerFilter)
      && (!normalizedQuery || file.name.toLocaleLowerCase().includes(normalizedQuery))
    ));
  }, [files, providerFilter, query]);

  const uploadFile = async (file: File) => {
    setBusyAction('upload');
    notify(`正在上传 ${file.name}…`, 'info');
    try {
      const form = new FormData();
      form.append('file', file);
      await api('/api/upload', { method: 'POST', body: form });
      notify(`${file.name} 上传成功。`);
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : '上传失败。', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (selected) void uploadFile(selected);
  };

  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busyAction) return;
    const selected = event.dataTransfer.files?.[0];
    if (selected) void uploadFile(selected);
  };

  const switchProvider = async (provider: Provider) => {
    setBusyAction(`provider-${provider}`);
    try {
      await api('/api/storage/switch', {
        method: 'POST',
        body: JSON.stringify({ provider }),
      });
      notify(`已切换到 ${providerLabel(provider)}。`);
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : '切换失败。', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const startOauth = async (
    provider: 'dropbox' | 'google',
    path: string,
    body?: Record<string, string>,
  ) => {
    const title = provider === 'dropbox' ? 'Dropbox' : 'Google Drive';
    const popup = window.open('', `${provider}Auth`, 'width=620,height=760');
    if (!popup) {
      notify('浏览器拦截了授权窗口，请允许本站打开弹窗。', 'error');
      return;
    }

    setBusyAction(`${provider}-auth`);
    try {
      const { authUrl } = await api<{ authUrl: string }>(path, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      popup.location.href = authUrl;
      notify(`请在弹出的 ${title} 页面完成授权。`, 'info');
    } catch (error) {
      popup.close();
      notify(error instanceof Error ? error.message : `无法开始 ${title} 授权。`, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const startDropboxAuth = () => {
    if (!appKey.trim() || !appSecret) {
      notify('请填写 Dropbox App Key 和 App Secret。', 'error');
      return;
    }
    void startOauth('dropbox', '/api/storage/dropbox/auth-url', {
      appKey: appKey.trim(),
      appSecret,
      name: accountName.trim(),
    });
  };

  const previewFile = async (file: StoredFile) => {
    const previewWindow = window.open('', '_blank');
    try {
      const { url } = await api<{ url: string }>(`/api/files/${file.id}/preview-url`);
      const target = url.startsWith('http') ? url : apiUrl(url);
      if (previewWindow) previewWindow.location.href = target;
      else window.location.href = target;
    } catch (error) {
      previewWindow?.close();
      notify(error instanceof Error ? error.message : '无法预览文件。', 'error');
    }
  };

  const deleteFile = async (file: StoredFile) => {
    if (!window.confirm(`确定删除“${file.name}”吗？此操作无法撤销。`)) return;
    setBusyAction(`delete-${file.id}`);
    try {
      await api(`/api/files/${file.id}`, { method: 'DELETE' });
      setFiles(current => current.filter(item => item.id !== file.id));
      notify(`${file.name} 已删除。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '删除失败。', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark"><Icon name="cloud" size={24} /></span>
          <span>tg2cloud</span>
        </div>
        <nav className="sidebar-nav" aria-label="主要导航">
          <a className="nav-item nav-item--active" href="#overview"><Icon name="files" />概览</a>
          <a className="nav-item" href="#files">
            <Icon name="file" />文件<span className="nav-count">{files.length}</span>
          </a>
          <a className="nav-item" href="#storage"><Icon name="hard-drive" />存储设置</a>
        </nav>
        <div className="sidebar-security">
          <Icon name="lock" />
          <div><strong>安全连接</strong><span>控制台已受保护</span></div>
        </div>
        <button className="nav-item nav-item--button" onClick={() => void onLogout()} type="button">
          <Icon name="log-out" />退出登录
        </button>
      </aside>

      <main className="dashboard-main" id="overview">
        <header className="topbar">
          <div className="mobile-brand brand-lockup">
            <span className="brand-mark"><Icon name="cloud" size={22} /></span>
            <span>tg2cloud</span>
          </div>
          <div className="topbar-copy">
            <p className="kicker kicker--blue">FILE COMMAND CENTER</p>
            <h1>文件控制台</h1>
          </div>
          <div className="user-chip">
            <span className="user-avatar">{username.slice(0, 1).toUpperCase()}</span>
            <span><small>当前账户</small><strong>{username}</strong></span>
            <button aria-label="退出登录" className="icon-button" onClick={() => void onLogout()} type="button">
              <Icon name="log-out" />
            </button>
          </div>
        </header>

        {notice && (
          <div className={`toast toast--${notice.tone}`} role="status">
            <Icon name={notice.tone === 'error' ? 'x' : 'check'} />
            <span>{notice.text}</span>
            <button aria-label="关闭通知" className="icon-button" onClick={() => setNotice(null)} type="button">
              <Icon name="x" size={18} />
            </button>
          </div>
        )}

        <section className="welcome-row">
          <div>
            <h2>欢迎回来，{username}</h2>
            <p>从网页或 Telegram 收集文件，再统一送往你的存储空间。</p>
          </div>
          <span className="provider-status">
            <i className="status-dot" />当前写入 {providerLabel(currentProvider)}
          </span>
        </section>

        <section className="stats-grid" aria-label="存储概览">
          <article className="stat-card">
            <span className="stat-icon stat-icon--blue"><Icon name="files" /></span>
            <div><span>文件总数</span><strong>{files.length}</strong></div>
          </article>
          <article className="stat-card">
            <span className="stat-icon stat-icon--amber"><Icon name="hard-drive" /></span>
            <div><span>占用空间</span><strong>{formatSize(totalSize)}</strong></div>
          </article>
          <article className="stat-card">
            <span className="stat-icon stat-icon--violet"><Icon name="telegram" /></span>
            <div><span>来自 Telegram</span><strong>{telegramCount}</strong></div>
          </article>
        </section>

        <section className="content-grid">
          <article className="panel upload-panel">
            <div className="panel-heading">
              <div><p className="kicker kicker--blue">QUICK UPLOAD</p><h2>上传文件</h2></div>
              <span className="panel-badge">最大 2 GB</span>
            </div>
            <div
              className={`drop-zone${dragging ? ' drop-zone--active' : ''}`}
              onDragEnter={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              onDragOver={event => event.preventDefault()}
              onDrop={dropFile}
            >
              <input
                disabled={Boolean(busyAction)}
                id="file-upload"
                onChange={selectFile}
                ref={fileInput}
                type="file"
              />
              <span className="drop-zone__icon">
                {busyAction === 'upload'
                  ? <span className="spinner spinner--blue" />
                  : <Icon name="upload" size={28} />}
              </span>
              <strong>{busyAction === 'upload' ? '正在上传文件…' : '拖放文件到这里'}</strong>
              <span>或从设备中选择一个文件</span>
              <button
                className="button button--primary"
                disabled={Boolean(busyAction)}
                onClick={() => fileInput.current?.click()}
                type="button"
              >
                <Icon name="upload" />选择文件
              </button>
            </div>
            <p className="panel-note">
              <Icon name="lock" size={16} />文件会直接写入当前的 {providerLabel(currentProvider)}。
            </p>
          </article>

          <article className="panel storage-panel" id="storage">
            <div className="panel-heading">
              <div><p className="kicker kicker--blue">DESTINATION</p><h2>存储位置</h2></div>
              <Icon name="settings" />
            </div>
            <div className="provider-options">
              <button
                className={`provider-option${currentProvider === 'local' ? ' provider-option--active' : ''}`}
                disabled={Boolean(busyAction) || currentProvider === 'local'}
                onClick={() => void switchProvider('local')}
                type="button"
              >
                <span className="provider-option__icon"><Icon name="hard-drive" /></span>
                <span><strong>本地存储</strong><small>服务器数据目录</small></span>
                <span className="radio-dot" />
              </button>
              <button
                className={`provider-option${currentProvider === 'dropbox' ? ' provider-option--active' : ''}`}
                disabled={Boolean(busyAction) || !config?.dropboxConnected || currentProvider === 'dropbox'}
                onClick={() => void switchProvider('dropbox')}
                type="button"
              >
                <span className="provider-option__icon provider-option__icon--dropbox"><Icon name="cloud" /></span>
                <span>
                  <strong>Dropbox</strong>
                  <small>{config?.dropboxConnected ? config.dropboxAccountName || '已连接' : '尚未连接'}</small>
                </span>
                <span className="radio-dot" />
              </button>
              <button
                className={`provider-option${currentProvider === 'google-drive' ? ' provider-option--active' : ''}`}
                disabled={Boolean(busyAction) || !config?.googleDriveConnected || currentProvider === 'google-drive'}
                onClick={() => void switchProvider('google-drive')}
                type="button"
              >
                <span className="provider-option__icon provider-option__icon--google"><Icon name="cloud" /></span>
                <span>
                  <strong>Google Drive</strong>
                  <small>{config?.googleDriveConnected ? config.googleDriveAccountName || '已连接' : '尚未连接'}</small>
                </span>
                <span className="radio-dot" />
              </button>
            </div>

            <div className="google-settings">
              <div>
                <span className="provider-option__icon provider-option__icon--google"><Icon name="cloud" /></span>
                <span>
                  <strong>Google Drive</strong>
                  <small>
                    {config?.googleDriveConnected
                      ? `已连接 ${config.googleDriveAccountName || ''}`
                      : config?.googleDriveConfigured
                        ? 'OAuth 已配置，可以开始连接'
                        : '请先配置服务端 OAuth 环境变量'}
                  </small>
                </span>
              </div>
              <button
                className="button button--secondary"
                disabled={Boolean(busyAction) || !config?.googleDriveConfigured}
                onClick={() => void startOauth('google', '/api/storage/google/auth-url')}
                type="button"
              >
                {busyAction === 'google-auth'
                  ? <span className="spinner spinner--blue" />
                  : <Icon name="cloud" />}
                {config?.googleDriveConnected ? '重新连接 Google' : '使用 Google 账号连接'}
              </button>
            </div>

            <details className="dropbox-settings">
              <summary>
                <span><Icon name="settings" />配置 Dropbox</span>
                <Icon className="summary-chevron" name="chevron" />
              </summary>
              <div className="settings-form">
                <label htmlFor="account-name">显示名称 <span>可选</span></label>
                <input
                  id="account-name"
                  onChange={event => setAccountName(event.target.value)}
                  placeholder="例如：个人 Dropbox"
                  value={accountName}
                />
                <label htmlFor="app-key">App Key</label>
                <input
                  autoComplete="off"
                  id="app-key"
                  onChange={event => setAppKey(event.target.value)}
                  placeholder="Dropbox App Key"
                  value={appKey}
                />
                <label htmlFor="app-secret">App Secret</label>
                <input
                  autoComplete="off"
                  id="app-secret"
                  onChange={event => setAppSecret(event.target.value)}
                  placeholder="Dropbox App Secret"
                  type="password"
                  value={appSecret}
                />
                <p className="redirect-note">
                  回调地址：<code>{config?.dropboxRedirectUri || '加载中…'}</code>
                </p>
                <button
                  className="button button--primary"
                  disabled={Boolean(busyAction) || !appKey.trim() || !appSecret}
                  onClick={startDropboxAuth}
                  type="button"
                >
                  {busyAction === 'dropbox-auth'
                    ? <span className="spinner" />
                    : <Icon name="cloud" />}
                  保存并授权
                </button>
              </div>
            </details>
          </article>
        </section>

        <section className="panel files-panel" id="files">
          <div className="files-toolbar">
            <div>
              <p className="kicker kicker--blue">LIBRARY</p>
              <h2>文件列表 <span>{files.length}</span></h2>
            </div>
            <div className="files-controls">
              <label className="search-box">
                <span className="sr-only">搜索文件</span>
                <Icon name="search" />
                <input
                  onChange={event => setQuery(event.target.value)}
                  placeholder="搜索文件名…"
                  value={query}
                />
              </label>
              <select
                aria-label="按存储位置筛选"
                onChange={event => setProviderFilter(event.target.value as 'all' | Provider)}
                value={providerFilter}
              >
                <option value="all">全部位置</option>
                <option value="local">本地存储</option>
                <option value="dropbox">Dropbox</option>
                <option value="google-drive">Google Drive</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="file-skeletons" aria-label="正在加载文件">
              {[0, 1, 2].map(item => <span className="file-skeleton" key={item} />)}
            </div>
          ) : filteredFiles.length === 0 ? (
            <div className="empty-state">
              <span><Icon name={files.length ? 'search' : 'file'} size={28} /></span>
              <h3>{files.length ? '没有匹配的文件' : '还没有文件'}</h3>
              <p>
                {files.length
                  ? '试试其他关键词或筛选条件。'
                  : '上传第一个文件，或把文件发送给 Telegram Bot。'}
              </p>
            </div>
          ) : (
            <div className="file-list">
              {filteredFiles.map(file => (
                <article className="file-row" key={file.id}>
                  <span className="file-type-icon"><Icon name="file" /></span>
                  <div className="file-info">
                    <strong title={file.name}>{file.name}</strong>
                    <p>
                      <span>{formatSize(file.size)}</span>
                      <span>{sourceLabel(file.source)}</span>
                      <span>{formatDate(file.createdAt)}</span>
                    </p>
                  </div>
                  <span className={`source-pill source-pill--${file.provider}`}>
                    {providerLabel(file.provider)}
                  </span>
                  <div className="file-actions">
                    <button
                      aria-label={`预览 ${file.name}`}
                      className="icon-button"
                      onClick={() => void previewFile(file)}
                      type="button"
                    >
                      <Icon name="eye" />
                    </button>
                    <a
                      aria-label={`下载 ${file.name}`}
                      className="icon-button"
                      href={apiUrl(`/api/files/${file.id}/download`)}
                    >
                      <Icon name="download" />
                    </a>
                    <button
                      aria-label={`删除 ${file.name}`}
                      className="icon-button icon-button--danger"
                      disabled={busyAction === `delete-${file.id}`}
                      onClick={() => void deleteFile(file)}
                      type="button"
                    >
                      {busyAction === `delete-${file.id}`
                        ? <span className="spinner spinner--small" />
                        : <Icon name="trash" />}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <footer className="dashboard-footer">
          <span><Icon name="lock" size={15} />tg2cloud 安全控制台</span>
          <span>所有操作均需通过身份验证</span>
        </footer>
      </main>
    </div>
  );
}
