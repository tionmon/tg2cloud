import { useEffect, useMemo, useState } from 'react';

type Provider = 'local' | 'dropbox';

type StoredFile = {
  id: string;
  name: string;
  storedName: string;
  mimeType: string;
  size: number;
  source: 'web' | 'telegram';
  provider: Provider;
  path: string;
  createdAt: string;
};

type StorageConfig = {
  activeProvider: Provider;
  dropboxConnected: boolean;
  dropboxAccountName?: string;
  dropboxRedirectUri: string;
};

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:51947').replace(/\/$/, '');

function formatSize(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options?.headers || {}),
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

export default function App() {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [accountName, setAccountName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const currentProvider = useMemo(() => config?.activeProvider || 'local', [config]);

  const reload = async () => {
    const [fileData, configData] = await Promise.all([
      api<StoredFile[]>('/api/files'),
      api<StorageConfig>('/api/storage/config'),
    ]);
    setFiles(fileData);
    setConfig(configData);
  };

  useEffect(() => {
    reload().catch(error => setMessage(error.message));
    const handler = (event: MessageEvent) => {
      if (event.data === 'dropbox_auth_success') {
        setMessage('Dropbox 授权成功');
        reload().catch(error => setMessage(error.message));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const uploadFile = async (file: File) => {
    setBusy(true);
    setMessage(`正在上传 ${file.name}...`);
    try {
      const form = new FormData();
      form.append('file', file);
      await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form }).then(async response => {
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || '上传失败');
        }
      });
      setMessage('上传成功');
      await reload();
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const startDropboxAuth = async () => {
    if (!appKey || !appSecret) {
      setMessage('请填写 Dropbox App Key 和 App Secret');
      return;
    }
    setBusy(true);
    try {
      const { authUrl } = await api<{ authUrl: string }>('/api/storage/dropbox/auth-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey, appSecret, name: accountName }),
      });
      window.open(authUrl, 'DropboxAuth', 'width=620,height=760');
      setMessage('请在弹出的 Dropbox 页面完成授权');
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const switchProvider = async (provider: Provider) => {
    setBusy(true);
    try {
      await api('/api/storage/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      setMessage(`已切换到 ${provider}`);
      await reload();
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteFile = async (file: StoredFile) => {
    if (!confirm(`确定删除 ${file.name} 吗？`)) return;
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/files/${file.id}`, { method: 'DELETE' }).then(async response => {
        if (!response.ok) throw new Error((await response.json()).error || '删除失败');
      });
      setMessage('已删除');
      await reload();
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const preview = async (file: StoredFile) => {
    try {
      const { url } = await api<{ url: string }>(`/api/files/${file.id}/preview-url`);
      window.open(url.startsWith('http') ? url : `${API_BASE}${url}`, '_blank');
    } catch (error: any) {
      setMessage(error.message);
    }
  };

  return (
    <main className="app">
      <section className="hero">
        <div>
          <p className="eyebrow">Telegram → Cloud</p>
          <h1>tg2cloud</h1>
          <p>将网页上传和 Telegram Bot 收到的文件保存到本地或 Dropbox。</p>
        </div>
        <div className="badge">当前存储：{currentProvider === 'dropbox' ? 'Dropbox' : 'Local'}</div>
      </section>

      {message && <div className="message">{message}</div>}

      <section className="grid">
        <div className="card">
          <h2>上传文件</h2>
          <label className="upload">
            <input type="file" disabled={busy} onChange={e => e.target.files?.[0] && uploadFile(e.target.files[0])} />
            <span>选择文件上传到 {currentProvider}</span>
          </label>
        </div>

        <div className="card">
          <h2>存储源</h2>
          <div className="provider-row">
            <button disabled={busy || currentProvider === 'local'} onClick={() => switchProvider('local')}>切换本地</button>
            <button disabled={busy || !config?.dropboxConnected || currentProvider === 'dropbox'} onClick={() => switchProvider('dropbox')}>切换 Dropbox</button>
          </div>
          <p className="muted">Dropbox 状态：{config?.dropboxConnected ? `已连接 ${config.dropboxAccountName || ''}` : '未连接'}</p>
          <p className="muted">Redirect URI：<code>{config?.dropboxRedirectUri}</code></p>
        </div>
      </section>

      <section className="card">
        <h2>添加 Dropbox</h2>
        <div className="form-grid">
          <input placeholder="账户显示名称，可选" value={accountName} onChange={e => setAccountName(e.target.value)} />
          <input placeholder="Dropbox App Key" value={appKey} onChange={e => setAppKey(e.target.value)} />
          <input placeholder="Dropbox App Secret" type="password" value={appSecret} onChange={e => setAppSecret(e.target.value)} />
          <button disabled={busy || !appKey || !appSecret} onClick={startDropboxAuth}>保存并授权</button>
        </div>
      </section>

      <section className="card">
        <h2>文件列表</h2>
        {files.length === 0 ? <p className="muted">暂无文件</p> : (
          <div className="files">
            {files.map(file => (
              <article key={file.id} className="file">
                <div>
                  <strong>{file.name}</strong>
                  <p>{formatSize(file.size)} · {file.provider} · {file.source} · {new Date(file.createdAt).toLocaleString()}</p>
                </div>
                <div className="actions">
                  <button onClick={() => preview(file)}>预览</button>
                  <a href={`${API_BASE}/api/files/${file.id}/download`}>下载</a>
                  <button className="danger" onClick={() => deleteFile(file)}>删除</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
