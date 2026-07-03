import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Dashboard } from './components/Dashboard';
import { LoginScreen } from './components/LoginScreen';
import { Icon } from './icons';
import type { SessionResponse, User } from './types';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [connectionError, setConnectionError] = useState('');

  const clearSession = useCallback(() => {
    setUser(null);
    setConnectionError('');
  }, []);

  useEffect(() => {
    api<SessionResponse>('/api/auth/session')
      .then(session => setUser(session.authenticated ? session.user : null))
      .catch(error => setConnectionError(
        error instanceof Error ? error.message : '无法连接服务器。',
      ))
      .finally(() => setCheckingSession(false));

    window.addEventListener('auth:unauthorized', clearSession);
    return () => window.removeEventListener('auth:unauthorized', clearSession);
  }, [clearSession]);

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      clearSession();
    }
  };

  if (checkingSession) {
    return (
      <main className="session-loader">
        <span className="brand-mark"><Icon name="cloud" size={28} /></span>
        <span className="spinner spinner--blue" />
        <p>正在验证安全会话…</p>
      </main>
    );
  }

  if (!user) {
    return <LoginScreen initialError={connectionError} onAuthenticated={setUser} />;
  }

  return <Dashboard onLogout={logout} username={user.username} />;
}
