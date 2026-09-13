import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const sessions = new Map<string, string>();
const pendingSessions = new Map<string, Promise<string>>();
const sessionKey = (server: string) => `saver.session.${server.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
export async function getSessionHeaders(server: string): Promise<Record<string, string>> {
  if (!sessions.has(server)) {
    let pending = pendingSessions.get(server);
    if (!pending) {
      pending = (async () => {
        let token = Platform.OS === 'web' ? null : await SecureStore.getItemAsync(sessionKey(server));
        if (!token) {
          const response = await fetch(`${server}/auth/session`, { method: 'POST', signal: AbortSignal.timeout(15000) });
          const body = await response.json();
          if (!response.ok || !body.token) throw new Error(body.error || 'Cannot create a secure session.');
          token = body.token as string;
          if (Platform.OS !== 'web') await SecureStore.setItemAsync(sessionKey(server), token);
        }
        sessions.set(server, token);
        return token;
      })().finally(() => pendingSessions.delete(server));
      pendingSessions.set(server, pending);
    }
    await pending;
  }
  return { Authorization: `Bearer ${sessions.get(server)}` };
}
async function clearSession(server: string) {
  sessions.delete(server);
  if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(sessionKey(server));
}

export type Media = {
  id: string; title: string; author: string; platform: string;
  thumbnail: string | null; duration: number; size: number | null;
  width?: number; height?: number;
  status: 'preview' | 'preparing' | 'ready' | 'error'; progress: number; error?: string;
};
export type SavedMedia = Media & { uri: string; savedAt: string; gallery: boolean };

export function defaultServer() {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host || (Platform.OS === 'android' ? '10.0.2.2' : 'localhost')}:8787`;
}
export async function request<T>(server: string, path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, 125000);
  try {
    const send = async () => fetch(`${server}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(path === '/health' ? {} : await getSessionHeaders(server)) }, body: body ? JSON.stringify(body) : undefined, signal: timeout.signal });
    let response = await send();
    if (response.status === 401 && path !== '/health') { await clearSession(server); response = await send(); }
    const data = await response.json();
    if (!response.ok) throw new Error((data.error || 'The server could not complete this request.') + (data.retryAfter ? ` Try again in ${data.retryAfter} seconds.` : ''));
    return data as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Request timed out or was cancelled. Please try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach the media server. Start it on your computer and connect both devices to the same Wi-Fi. Check the address in Settings.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const formatBytes = (bytes: number | null) => bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : 'Size available after download';
export const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
