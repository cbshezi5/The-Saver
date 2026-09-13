import React, { useEffect, useState } from 'react';
import { AppState, Linking, Pressable, Text, View } from 'react-native';
import { request } from './api';

type Account = { provider: 'x' | 'meta'; configured: boolean; connected: boolean; expired: boolean; name?: string; lastError?: string };
export function ConnectedAccounts({ server }: { server: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('official');
  async function refresh() {
    try {
      const data = await request<{ mode: string; accounts: Account[] }>(server, '/auth/accounts');
      setAccounts(data.accounts); setMode(data.mode);
      setMessage(data.accounts.find(a => a.lastError)?.lastError || '');
    } catch (error) { setMessage((error as Error).message); }
  }
  useEffect(() => {
    void refresh();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => listener.remove();
  }, [server]);
  async function act(account: Account, disconnect = false) {
    setBusy(true); setMessage('');
    try {
      if (disconnect) await request(server, `/auth/${account.provider}/disconnect`, {});
      else {
        const result = await request<{ url: string }>(server, `/auth/${account.provider}/connect`, {});
        const url = new URL(result.url);
        if (url.protocol !== 'https:' || !['x.com', 'www.facebook.com'].includes(url.hostname)) throw new Error('Invalid authorization destination.');
        await Linking.openURL(result.url);
        setMessage('Complete consent in the browser, then return and tap Refresh accounts.');
      }
      if (disconnect) await refresh();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <View style={{ gap: 14, padding: 18, borderRadius: 16, backgroundColor: '#EDF0E6' }}>
    <Text style={{ fontSize: 17, fontWeight: '700', color: '#17291F' }}>Connected accounts</Text>
    <Text style={{ fontSize: 12, lineHeight: 19, color: '#536353' }}>{mode === 'official' ? 'Save your X posts, Facebook Page videos, and linked Instagram professional-account videos.' : 'This server is in public legacy mode. Switch MEDIA_ACCESS_MODE to official on the computer to use these accounts for downloads.'}</Text>
    {accounts.map(account => <View key={account.provider} style={{ gap: 8 }}>
      <Text style={{ color: '#17291F', fontWeight: '600' }}>{account.provider === 'x' ? 'X' : 'Facebook + Instagram'}</Text>
      <Text style={{ fontSize: 12, color: '#536353' }}>{!account.configured ? 'Developer app setup required on the computer' : account.connected ? `${account.name}${account.expired ? ' · Authorization expired' : ' · Connected'}` : 'Not connected'}</Text>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Pressable accessibilityRole="button" disabled={busy || !account.configured} onPress={() => act(account)} style={{ opacity: busy || !account.configured ? .4 : 1, paddingVertical: 8 }}><Text style={{ color: '#245E43', fontWeight: '700' }}>{account.connected ? 'Reconnect' : 'Connect account'}</Text></Pressable>
        {account.connected && <Pressable accessibilityRole="button" disabled={busy} onPress={() => act(account, true)} style={{ paddingVertical: 8 }}><Text style={{ color: '#8E3929' }}>Disconnect here</Text></Pressable>}
      </View>
    </View>)}
    <Pressable accessibilityRole="button" disabled={busy} onPress={refresh}><Text style={{ color: '#245E43', fontWeight: '700' }}>Refresh accounts</Text></Pressable>
    {!!message && <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, lineHeight: 18, color: '#245E43' }}>{message}</Text>}
    <Text style={{ fontSize: 11, lineHeight: 17, color: '#536353' }}>Connections last for this server session. Disconnecting here forgets the grant locally; you can revoke app access in X or Meta settings.</Text>
  </View>;
}
