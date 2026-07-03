export type Provider = 'local' | 'dropbox' | 'google-drive';

export type StoredFile = {
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

export type StorageConfig = {
  activeProvider: Provider;
  dropboxConnected: boolean;
  dropboxAccountName?: string;
  dropboxRedirectUri: string;
  googleDriveConnected: boolean;
  googleDriveAccountName?: string;
  googleDriveConfigured: boolean;
  googleDriveRedirectUri: string;
};

export type User = {
  username: string;
};

export type SessionResponse = {
  authenticated: boolean;
  user: User | null;
};
