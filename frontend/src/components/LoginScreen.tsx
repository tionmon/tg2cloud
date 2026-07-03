import { FormEvent, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import type { User } from '../types';

type LoginScreenProps = {
  initialError?: string;
  onAuthenticated: (user: User) => void;
};

export function LoginScreen({ initialError = '', onAuthenticated }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(initialError);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await api<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-shell" aria-labelledby="login-title">
        <div className="login-brand">
          <div className="brand-lockup brand-lockup--light">
            <span className="brand-mark"><Icon name="cloud" size={24} /></span>
            <span>tg2cloud</span>
          </div>
          <div className="login-brand-copy">
            <p className="kicker">PRIVATE FILE BRIDGE</p>
            <h1>把文件安全地送到你的云端。</h1>
            <p>集中管理网页上传、Telegram 文件与 Dropbox 存储，不让控制台暴露在公网。</p>
          </div>
          <ul className="security-list" aria-label="安全特性">
            <li><Icon name="lock" />HttpOnly 安全会话</li>
            <li><Icon name="check" />所有文件接口均需登录</li>
            <li><Icon name="check" />登录失败自动限速</li>
          </ul>
        </div>

        <div className="login-panel">
          <div className="login-panel__inner">
            <span className="login-icon"><Icon name="lock" size={22} /></span>
            <p className="kicker kicker--blue">SECURE ACCESS</p>
            <h2 id="login-title">登录控制台</h2>
            <p className="login-intro">请输入管理员凭据继续访问你的文件空间。</p>

            <form className="login-form" onSubmit={submit}>
              <label htmlFor="username">用户名</label>
              <div className="input-shell">
                <Icon name="user" />
                <input
                  autoComplete="username"
                  autoFocus
                  id="username"
                  onChange={event => setUsername(event.target.value)}
                  placeholder="管理员用户名"
                  required
                  value={username}
                />
              </div>

              <label htmlFor="password">密码</label>
              <div className="input-shell">
                <Icon name="lock" />
                <input
                  autoComplete="current-password"
                  id="password"
                  onChange={event => setPassword(event.target.value)}
                  placeholder="管理员密码"
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  className="icon-button input-action"
                  onClick={() => setShowPassword(value => !value)}
                  type="button"
                >
                  <Icon name={showPassword ? 'eye-off' : 'eye'} />
                </button>
              </div>

              {error && <p className="form-error" role="alert">{error}</p>}

              <button className="button button--primary button--large" disabled={submitting} type="submit">
                {submitting ? <span className="spinner" /> : <Icon name="lock" />}
                {submitting ? '正在验证…' : '安全登录'}
              </button>
            </form>
            <p className="login-footnote">会话凭据只保存在安全 Cookie 中。</p>
          </div>
        </div>
      </section>
    </main>
  );
}
