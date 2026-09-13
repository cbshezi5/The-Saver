import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useVideoPlayer, VideoView } from 'expo-video';
import { parsePostLink } from './shared/links.mjs';
import { defaultServer, formatBytes, formatDuration, getSessionHeaders, Media, request, SavedMedia } from './src/api';
import { ConnectedAccounts } from './src/ConnectedAccounts';

const C = { bg: '#F7F8F4', ink: '#17291F', muted: '#788178', green: '#245E43', lime: '#D9EEA3', line: '#E3E7DD', white: '#FFFFFF' };
const SAVED = 'saver:library:v1', SETTINGS = 'saver:settings:v1';
type IconName = React.ComponentProps<typeof Ionicons>['name'];
function Icon({ name, size = 22, color = C.ink }: { name: IconName; size?: number; color?: string }) { return <Ionicons name={name} size={size} color={color} />; }
function Button({ label, onPress, disabled, icon = 'arrow-down-outline', secondary = false }: { label: string; onPress: () => void; disabled?: boolean; icon?: IconName; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.button, secondary && s.secondary, disabled && { opacity: .45 }, pressed && { opacity: .75 }]}><Icon name={icon} color={secondary ? C.ink : C.white} size={20} /><Text style={[s.buttonText, secondary && { color: C.ink }]}>{label}</Text></Pressable>;
}
function Player({ media, close }: { media: SavedMedia; close: () => void }) {
  const player = useVideoPlayer(media.uri, player => { player.play(); });
  return <Modal animationType="slide" onRequestClose={close}><SafeAreaView style={{ flex: 1, backgroundColor: C.ink }}><View style={[s.row, { padding: 20 }]}><Text numberOfLines={1} style={{ color: 'white', flex: 1, fontSize: 16 }}>{media.title}</Text><Pressable accessibilityLabel="Close video" onPress={close} style={s.iconButton}><Icon name="close" color="white" /></Pressable></View><VideoView player={player} style={{ flex: 1 }} nativeControls contentFit="contain" /><Text style={{ color: C.lime, padding: 24 }}>Saved on this device · Available offline</Text></SafeAreaView></Modal>;
}

export default function App() { return <SafeAreaProvider><Saver /></SafeAreaProvider>; }
function Saver() {
  const [tab, setTab] = useState<'save' | 'library'>('save');
  const [link, setLink] = useState('');
  const [media, setMedia] = useState<Media | null>(null);
  const [phase, setPhase] = useState<'idle' | 'resolving' | 'preparing' | 'downloading' | 'saving' | 'done'>('idle');
  const [progress, setProgress] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [library, setLibrary] = useState<SavedMedia[]>([]);
  const [server, setServer] = useState(defaultServer);
  const [serverDraft, setServerDraft] = useState('');
  const [autoPaste, setAutoPaste] = useState(true);
  const [settings, setSettings] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState<SavedMedia | null>(null);
  const requestId = useRef(0);
  const lastClipboard = useRef('');
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const transfer = useRef<FileSystem.DownloadResumable | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = ['resolving', 'preparing', 'downloading', 'saving'].includes(phase);
  busyRef.current = busy;
  const compatible = parsePostLink(link);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const [stored, prefs] = await Promise.all([AsyncStorage.getItem(SAVED), AsyncStorage.getItem(SETTINGS)]);
        if (stored) {
          const entries: SavedMedia[] = JSON.parse(stored);
          const present = Platform.OS === 'web' ? [] : (await Promise.all(entries.map(async item => (await FileSystem.getInfoAsync(item.uri)).exists ? item : null))).filter((item): item is SavedMedia => !!item);
          setLibrary(present);
        }
        if (prefs) { const value = JSON.parse(prefs); setServer(value.server || defaultServer()); setAutoPaste(value.autoPaste ?? true); }
      } catch { setNote('Some saved settings could not be restored.'); }
      finally { setLoaded(true); }
    })();
    return () => { mounted.current = false; requestId.current++; controller.current?.abort(); void transfer.current?.cancelAsync().catch(() => {}); };
  }, []);

  const acceptLink = (text: string, fromClipboard = false) => {
    if (busyRef.current) return;
    const parsed = parsePostLink(text);
    if (fromClipboard && !parsed) { setNote('Copy a public X, Instagram, or Facebook post link first.'); return; }
    setLink(parsed?.url || text); setMedia(null); setPhase('idle'); setError(''); setNote(fromClipboard ? `${parsed?.platform} link pasted from clipboard` : '');
  };
  useEffect(() => {
    if (!loaded || !autoPaste || Platform.OS === 'web') return;
    const paste = async () => {
      if (busyRef.current || AppState.currentState !== 'active') return;
      try {
        const text = await Clipboard.getStringAsync();
        if (text && text !== lastClipboard.current && parsePostLink(text)) { lastClipboard.current = text; acceptLink(text, true); }
      } catch { /* Manual paste remains available when clipboard permission is denied. */ }
    };
    void paste();
    const appListener = AppState.addEventListener('change', state => { if (state === 'active') void paste(); });
    const clipboardListener = Clipboard.addClipboardListener(() => { void paste(); });
    return () => { appListener.remove(); clipboardListener.remove(); };
  }, [loaded, autoPaste]);

  async function pasteManual() { try { acceptLink(await Clipboard.getStringAsync(), true); } catch { setError('Clipboard access was denied. Touch and hold the field to paste your link.'); } }

  async function resolve() {
    if (!compatible || busyRef.current) return;
    busyRef.current = true;
    const id = ++requestId.current;
    controller.current = new AbortController();
    setPhase('resolving'); setError(''); setNote(''); setMedia(null);
    try {
      const result = await request<Media>(server, '/resolve', { url: compatible.url }, controller.current.signal);
      if (id === requestId.current && mounted.current) { setMedia(result); setPhase('idle'); }
    } catch (e) { if (id === requestId.current && mounted.current) { setError((e as Error).message); setPhase('idle'); } }
    finally { if (id === requestId.current) busyRef.current = false; }
  }

  async function persist(items: SavedMedia[]) { await AsyncStorage.setItem(SAVED, JSON.stringify(items)); setLibrary(items); }
  async function saveToGallery(item: SavedMedia) {
    try {
      const permission = await MediaLibrary.requestPermissionsAsync(true, ['video']);
      if (!permission.granted) { setNote('Saved in the app. Allow Photos access to also save to your gallery.'); return; }
      await MediaLibrary.saveToLibraryAsync(item.uri);
      await persist(library.map(entry => entry.id === item.id ? { ...entry, gallery: true } : entry));
      setNote('Video saved to your gallery.');
    } catch { setNote('Video is saved in the app. Gallery access is unavailable; use Share to export it.'); }
  }
  async function download() {
    if (!media || busyRef.current) return;
    if (Platform.OS === 'web') { setError('Open this app in Expo Go on your phone to download and keep videos offline.'); return; }
    busyRef.current = true;
    const id = ++requestId.current;
    const current = () => id === requestId.current && mounted.current;
    controller.current = new AbortController();
    setPhase('preparing'); setProgress(0); setBytes(0); setError(''); setNote('');
    let destination: string | null = null;
    let committed = false;
    try {
      let job = await request<Media>(server, `/media/${media.id}/download`, {}, controller.current.signal);
      const deadline = Date.now() + 11 * 60 * 1000;
      while (job.status !== 'ready') {
        if (!current()) return;
        if (job.status === 'error') throw new Error(job.error || 'Unable to prepare the video.');
        if (Date.now() > deadline) throw new Error('Download preparation timed out. Try again.');
        setProgress(job.progress);
        await new Promise(resolve => setTimeout(resolve, 900));
        if (!current()) return;
        job = await request<Media>(server, `/media/${media.id}`, undefined, controller.current.signal);
      }
      if (!current()) return;
      setPhase('downloading'); setProgress(0);
      const directory = `${FileSystem.documentDirectory}saver/`;
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      destination = `${directory}${media.id}-${Date.now()}.mp4`;
      transfer.current = FileSystem.createDownloadResumable(`${server}/media/${media.id}/file`, destination, { headers: await getSessionHeaders(server) }, event => {
        if (current()) { setBytes(event.totalBytesWritten); setProgress(event.totalBytesExpectedToWrite > 0 ? event.totalBytesWritten / event.totalBytesExpectedToWrite : 0); }
      });
      const result = await transfer.current.downloadAsync();
      if (!current()) return;
      if (!result || result.status !== 200) throw new Error('The transfer failed. Please retry the download.');
      const info = await FileSystem.getInfoAsync(result.uri);
      if (!info.exists || !info.size || (job.size && info.size !== job.size)) throw new Error('The download is incomplete. Please retry.');
      setPhase('saving');
      const saved: SavedMedia = { ...job, uri: result.uri, savedAt: new Date().toISOString(), gallery: false };
      let items = [saved, ...library.filter(item => item.id !== saved.id)];
      await persist(items); committed = true;
      try {
        const permission = await MediaLibrary.requestPermissionsAsync(true, ['video']);
        if (permission.granted) { await MediaLibrary.saveToLibraryAsync(result.uri); saved.gallery = true; items = items.map(item => item.id === saved.id ? { ...saved } : item); await persist(items); }
      } catch { /* The verified local file remains playable if gallery permission or save fails. */ }
      if (current()) { setProgress(1); setPhase('done'); setNote(saved.gallery ? 'Saved to your gallery and available offline in Saved.' : 'Saved on this device. Open Saved to play or share it.'); }
    } catch (e) { if (current()) { setError((e as Error).message); setPhase('idle'); } }
    finally {
      if (destination && !committed) await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
      if (current()) transfer.current = null;
      if (current()) busyRef.current = false;
    }
  }
  async function cancel() {
    requestId.current++; controller.current?.abort();
    await transfer.current?.cancelAsync().catch(() => {});
    setPhase('idle'); setProgress(0); busyRef.current = false; setNote('Download cancelled. You can retry when ready.');
  }
  async function share(item: SavedMedia) { try { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(item.uri, { mimeType: 'video/mp4' }); else setNote('Sharing is unavailable on this device.'); } catch { setError('Unable to share this file. Please try again.'); } }
  function remove(item: SavedMedia) {
    Alert.alert('Remove this video?', 'This removes the app copy. A copy already saved to your gallery will remain.', [{ text: 'Keep', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => { void (async () => { try { await FileSystem.deleteAsync(item.uri, { idempotent: true }); await persist(library.filter(entry => entry.id !== item.id)); } catch { setError('Could not remove the video. Please try again.'); } })(); } }]);
  }
  function openSettings() { setServerDraft(server); setSettingsStatus(''); setSettings(true); }
  async function storeSettings() {
    try {
      const value = new URL(serverDraft.trim());
      if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash || value.pathname !== '/') throw new Error('Enter a server address such as http://192.168.1.10:8787');
      const next = value.origin;
      await AsyncStorage.setItem(SETTINGS, JSON.stringify({ server: next, autoPaste }));
      setServer(next); setMedia(null); setPhase('idle'); setSettings(false);
    } catch (e) { setSettingsStatus((e as Error).message); }
  }

  return <SafeAreaView style={s.safe} edges={['top', 'bottom']}><StatusBar style="dark" /><View style={s.shell}>
    <View style={s.header}><View style={s.row}><View style={s.logo}><Icon name="arrow-down" color={C.lime} size={26} /></View><Text style={s.brand}>the saver<Text style={{ color: C.green }}>.</Text></Text></View><Pressable accessibilityLabel="Settings" disabled={busy} onPress={openSettings} style={s.iconButton}><Icon name="options-outline" /></Pressable></View>
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {tab === 'save' ? <>
        <View style={s.eyebrow}><View style={s.dot} /><Text style={s.eyebrowText}>GOOD FINDS. YOURS TO KEEP.</Text></View>
        <Text style={s.hero}>Found it.{'\n'}<Text style={{ color: C.green }}>Keep it.</Text></Text>
        <Text style={s.subtitle}>Your favorite moments, one link away.{'\n'}Save videos to watch whenever.</Text>
        <View style={[s.row, { gap: 9, marginTop: 22, marginBottom: 28 }]}>{['X', 'Instagram', 'Facebook'].map(platform => <View key={platform} style={s.platform}><Icon name={platform === 'X' ? 'close' : platform === 'Instagram' ? 'logo-instagram' : 'logo-facebook'} size={16} /><Text style={s.platformText}>{platform}</Text></View>)}</View>
        <View style={s.card}>
          <View style={[s.row, { justifyContent: 'space-between' }]}><Text style={s.cardTitle}>Drop a post link</Text><View style={s.smallTag}><View style={[s.dot, { width: 5, height: 5 }]} /><Text style={s.smallTagText}>{autoPaste ? 'Auto-paste on' : 'Manual paste'}</Text></View></View>
          <View style={[s.inputWrap, compatible && { borderColor: '#A6BCA7' }]}><Icon name="link-outline" size={21} color={C.muted} /><TextInput accessibilityLabel="Post link" value={link} editable={!busy} onChangeText={text => acceptLink(text)} placeholder="Paste your link here…" placeholderTextColor="#90978D" autoCapitalize="none" autoCorrect={false} keyboardType="url" style={s.input} /><Pressable accessibilityLabel={link ? 'Clear link' : 'Paste link'} disabled={busy} onPress={link ? () => acceptLink('') : pasteManual} style={{ padding: 7 }}><Icon name={link ? 'close-circle' : 'clipboard-outline'} size={20} color={C.muted} /></Pressable></View>
          <View style={[s.row, { marginBottom: 18, gap: 6 }]}><Icon name={compatible ? 'checkmark-circle' : 'information-circle-outline'} size={15} color={compatible ? C.green : C.muted} /><Text style={s.hint}>{compatible ? `${compatible.platform} link detected · Ready to preview` : 'Use a video post from a connected account'}</Text></View>
          <Button label={phase === 'resolving' ? 'Finding your video…' : 'Preview video'} icon="sparkles-outline" onPress={resolve} disabled={!compatible || busy} />
          <Pressable disabled={busy} onPress={pasteManual} style={{ paddingTop: 16, alignSelf: 'center' }}><Text style={s.textLink}>Paste from clipboard</Text></Pressable>
        </View>
        {phase === 'resolving' && <View style={s.message}><ActivityIndicator color={C.green} /><Text style={s.messageText}>Looking for the video in your post…</Text></View>}
        {media && <View style={[s.card, { marginTop: 18 }]}>
          <View style={[s.row, { justifyContent: 'space-between', marginBottom: 14 }]}><Text style={s.cardTitle}>Your next good find</Text><Text style={s.smallTagText}>{media.platform}</Text></View>
          <View style={s.preview}>{media.thumbnail ? <Image source={{ uri: media.thumbnail }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Icon name="videocam-outline" size={54} color="#B4C7A5" />}<View style={s.previewBadge}><Icon name="videocam" size={14} color="white" /><Text style={s.previewBadgeText}>VIDEO PREVIEW</Text></View><View style={s.duration}><Text style={{ color: 'white', fontSize: 12 }}>{formatDuration(media.duration)}</Text></View></View>
          <Text style={s.videoTitle} numberOfLines={2}>{media.title}</Text><Text style={s.meta}>{media.author} · MP4{media.height ? ` · ${media.height}p` : ''}</Text>
          {['preparing', 'downloading', 'saving'].includes(phase) ? <View style={s.progressBox}><View style={[s.row, { justifyContent: 'space-between' }]}><Text style={s.progressTitle}>{phase === 'preparing' ? 'Getting your video ready' : phase === 'saving' ? 'Saving on your device' : 'Downloading to your phone'}</Text><Text style={s.progressTitle}>{Math.round(progress * 100)}%</Text></View><View style={s.track}><View style={[s.fill, { width: `${Math.max(2, progress * 100)}%` }]} /></View><View style={[s.row, { justifyContent: 'space-between' }]}><Text style={s.hint}>{phase === 'downloading' ? `${formatBytes(bytes)} transferred` : 'Keep the app open until complete'}</Text>{phase !== 'saving' && <Pressable onPress={cancel} accessibilityRole="button"><Text style={s.textLink}>Cancel</Text></Pressable>}</View></View> : phase === 'done' ? <Button label="Saved! Open your library" icon="checkmark-circle-outline" onPress={() => setTab('library')} /> : <Button label={`Download video${media.size ? ` · ${formatBytes(media.size)}` : ''}`} onPress={download} disabled={busy} />}
        </View>}
        {!media && phase !== 'resolving' && <View style={s.how}><View style={s.row}><View style={s.howIcon}><Icon name="bookmark-outline" color={C.green} /></View><Text style={s.howTitle}>A little less scrolling.{'\n'}A little more keeping.</Text></View><View style={s.steps}>{[['01', 'Copy a link'], ['02', 'See a preview'], ['03', 'Save & enjoy']].map(([num, label]) => <View key={num} style={{ flex: 1 }}><Text style={s.stepNumber}>{num}</Text><Text style={s.stepLabel}>{label}</Text></View>)}</View></View>}
        <View style={[s.row, { justifyContent: 'center', marginTop: 24, gap: 6 }]}><Icon name="phone-portrait-outline" size={14} color={C.muted} /><Text style={s.footer}>On your phone. Ready when you are.</Text></View>
      </> : <>
        <View style={s.eyebrow}><View style={s.dot} /><Text style={s.eyebrowText}>YOUR PERSONAL COLLECTION</Text></View><Text style={[s.hero, { fontSize: 43 }]}>The good stuff.</Text><Text style={s.subtitle}>{library.length} saved {library.length === 1 ? 'video' : 'videos'} · Always within reach</Text>
        {!library.length ? <View style={[s.card, { marginTop: 30, paddingVertical: 40, alignItems: 'center' }]}><View style={[s.howIcon, { width: 70, height: 70, borderRadius: 24 }]}><Icon name="albums-outline" size={34} color={C.green} /></View><Text style={[s.cardTitle, { marginTop: 22 }]}>Make room for your favorites</Text><Text style={[s.subtitle, { textAlign: 'center', marginVertical: 16 }]}>Videos you download will live here,{'\n'}ready to play even without Wi-Fi.</Text><Button label="Save your first video" icon="add" onPress={() => setTab('save')} /></View> : library.map(item => <View key={item.id} style={[s.card, { marginTop: 20 }]}><Pressable accessibilityLabel={`Play ${item.title}`} onPress={() => setPlaying(item)}><View style={[s.preview, { height: 180 }]}>{item.thumbnail && <Image source={{ uri: item.thumbnail }} style={StyleSheet.absoluteFill} resizeMode="cover" />}<View style={s.playCircle}><Icon name="play" color="white" size={28} /></View><View style={s.duration}><Text style={{ color: 'white' }}>{formatDuration(item.duration)}</Text></View></View><Text numberOfLines={2} style={s.videoTitle}>{item.title}</Text></Pressable><Text style={s.meta}>{item.platform} · {formatBytes(item.size)} · Saved locally</Text><View style={[s.row, { justifyContent: 'space-between' }]}><Pressable accessibilityLabel="Share video" onPress={() => share(item)} style={s.row}><Icon name="share-outline" size={18} /><Text style={s.textLink}> Share</Text></Pressable>{!item.gallery && <Pressable onPress={() => saveToGallery(item)}><Text style={s.textLink}>Save to gallery</Text></Pressable>}<Pressable accessibilityLabel="Remove video" onPress={() => remove(item)} style={s.iconButton}><Icon name="trash-outline" size={19} color={C.muted} /></Pressable></View></View>)}
      </>}
      {!!error && <View accessibilityRole="alert" style={[s.message, { backgroundColor: '#FBEAE5' }]}><Icon name="alert-circle-outline" color="#A34331" /><Text style={[s.messageText, { color: '#8E3929' }]}>{error}</Text></View>}
      {!!note && <View accessibilityLiveRegion="polite" style={s.message}><Icon name="checkmark-circle-outline" color={C.green} /><Text style={s.messageText}>{note}</Text></View>}
      <Text style={s.rights}>Save content you own or have permission to download.</Text>
    </ScrollView>
    <View style={s.nav}>{([{ key: 'save', icon: 'arrow-down-circle-outline', label: 'Save a link' }, { key: 'library', icon: 'albums-outline', label: 'Saved' }] as const).map(item => <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: tab === item.key }} onPress={() => setTab(item.key)} style={[s.navItem, tab === item.key && s.navActive]}><Icon name={item.icon} size={23} color={tab === item.key ? C.green : C.muted} /><Text style={[s.navText, tab === item.key && { color: C.green }]}>{item.label}{item.key === 'library' && library.length ? `  ${library.length}` : ''}</Text></Pressable>)}</View>
    </View>
    <Modal visible={settings} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSettings(false)}><SafeAreaView style={s.safe}><ScrollView contentContainerStyle={{ padding: 26, gap: 22 }} keyboardShouldPersistTaps="handled"><View style={[s.row, { justifyContent: 'space-between' }]}><Text style={s.cardTitle}>Settings</Text><Pressable accessibilityLabel="Close settings" onPress={() => setSettings(false)} style={s.iconButton}><Icon name="close" /></Pressable></View><Text style={[s.hero, { fontSize: 36 }]}>Make it yours.</Text><View style={[s.row, { justifyContent: 'space-between' }]}><View style={{ flex: 1 }}><Text style={s.cardTitle}>Auto-paste links</Text><Text style={[s.hint, { marginTop: 6 }]}>Check the clipboard when you return.</Text></View><Switch value={autoPaste} onValueChange={value => { setAutoPaste(value); void AsyncStorage.setItem(SETTINGS, JSON.stringify({ server, autoPaste: value })).catch(() => setSettingsStatus('Could not save this setting.')); }} trackColor={{ true: C.green }} /></View><Text style={s.hint}>Your phone may ask for paste permission. Manual paste is always available.</Text><View><Text style={s.cardTitle}>Media server</Text><Text style={[s.subtitle, { fontSize: 14, marginBottom: 16 }]}>Run the companion server on your computer and use the same Wi-Fi network.</Text><TextInput accessibilityLabel="Media server address" value={serverDraft} onChangeText={setServerDraft} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={[s.inputWrap, { padding: 16, color: C.ink }]} /><Button secondary label="Test connection" icon="wifi-outline" onPress={() => { setSettingsStatus('Connecting…'); void request<{ ok: boolean }>(serverDraft.trim().replace(/\/$/, ''), '/health').then(() => setSettingsStatus('Connected. Your media server is ready.')).catch(e => setSettingsStatus(e.message)); }} /></View>{!!settingsStatus && <Text style={s.messageText}>{settingsStatus}</Text>}<Button label="Save settings" icon="checkmark" onPress={storeSettings} /><ConnectedAccounts server={server} /><Text style={s.hint}>Official mode requires a connected account and access to its own media. Photo-only posts are not supported. Keep the app open during a download.</Text></ScrollView></SafeAreaView></Modal>
    {playing && <Player media={playing} close={() => setPlaying(null)} />}
  </SafeAreaView>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg }, shell: { flex: 1, width: '100%', maxWidth: 560, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' }, header: { paddingHorizontal: 25, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, logo: { backgroundColor: C.ink, height: 38, width: 38, borderRadius: 13, justifyContent: 'center', alignItems: 'center', marginRight: 10 }, brand: { fontSize: 25, color: C.ink, fontWeight: '800', letterSpacing: -1 }, iconButton: { padding: 9 }, content: { paddingHorizontal: 25, paddingTop: 27, paddingBottom: 24 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 16 }, dot: { height: 6, width: 6, borderRadius: 9, backgroundColor: C.green }, eyebrowText: { fontSize: 10, letterSpacing: 1.6, color: C.green, fontWeight: '700' }, hero: { fontSize: 59, lineHeight: 63, letterSpacing: -2.8, fontWeight: '800', color: C.ink }, subtitle: { fontSize: 15, lineHeight: 24, color: C.muted, marginTop: 13 }, platform: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: C.line, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 30, backgroundColor: '#FFFFFF90' }, platformText: { fontSize: 12, fontWeight: '500', color: C.ink },
  card: { backgroundColor: C.white, borderRadius: 23, padding: 20, borderWidth: 1, borderColor: C.line }, cardTitle: { color: C.ink, fontSize: 16, fontWeight: '700', letterSpacing: -.3 }, smallTag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#EDF5E6', paddingVertical: 5, paddingHorizontal: 7, borderRadius: 12 }, smallTagText: { color: C.green, fontSize: 10, fontWeight: '600' }, inputWrap: { marginTop: 19, marginBottom: 11, borderWidth: 1, borderColor: C.line, borderRadius: 12, backgroundColor: '#FAFBF8', flexDirection: 'row', alignItems: 'center', paddingLeft: 12, minHeight: 58 }, input: { flex: 1, minWidth: 0, padding: 11, fontSize: 14, color: C.ink }, hint: { fontSize: 11, color: C.muted, lineHeight: 17, flexShrink: 1 }, button: { backgroundColor: C.green, borderRadius: 13, padding: 17, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 9 }, buttonText: { color: 'white', fontSize: 14, fontWeight: '700' }, secondary: { backgroundColor: C.lime }, textLink: { color: C.green, fontSize: 12, fontWeight: '600' },
  how: { borderRadius: 22, backgroundColor: '#EDF0E6', padding: 22, marginTop: 23 }, howIcon: { width: 44, height: 44, borderRadius: 15, backgroundColor: '#DEE8CC', alignItems: 'center', justifyContent: 'center', marginRight: 13 }, howTitle: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: C.ink, letterSpacing: -.3 }, steps: { flexDirection: 'row', marginTop: 26 }, stepNumber: { color: '#8B9B80', fontSize: 11, fontWeight: '600', marginBottom: 8 }, stepLabel: { color: C.ink, fontSize: 11, fontWeight: '500' }, footer: { fontSize: 11, color: C.muted }, rights: { textAlign: 'center', color: '#929A90', fontSize: 10, lineHeight: 16, marginTop: 24 },
  preview: { height: 210, backgroundColor: '#243C2E', borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, previewBadge: { position: 'absolute', top: 12, left: 12, backgroundColor: '#00000070', borderRadius: 7, padding: 7, flexDirection: 'row', alignItems: 'center', gap: 5 }, previewBadgeText: { color: 'white', fontSize: 9, fontWeight: '600', letterSpacing: .8 }, duration: { position: 'absolute', right: 12, bottom: 12, backgroundColor: '#00000090', borderRadius: 5, padding: 6 }, videoTitle: { color: C.ink, fontSize: 17, fontWeight: '700', lineHeight: 23, marginTop: 16 }, meta: { color: C.muted, fontSize: 12, marginTop: 6, marginBottom: 18 }, progressBox: { backgroundColor: '#F0F5E8', padding: 15, borderRadius: 12 }, progressTitle: { color: C.green, fontWeight: '600', fontSize: 12 }, track: { backgroundColor: '#DBE4D0', height: 6, borderRadius: 8, marginVertical: 13, overflow: 'hidden' }, fill: { backgroundColor: C.green, height: 6, borderRadius: 8 }, message: { backgroundColor: '#EAF1E1', borderRadius: 13, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 17 }, messageText: { color: C.green, flex: 1, fontSize: 12, lineHeight: 19 }, playCircle: { backgroundColor: '#00000065', borderRadius: 40, width: 62, height: 62, alignItems: 'center', justifyContent: 'center' },
  nav: { flexDirection: 'row', marginHorizontal: 25, marginBottom: 10, marginTop: 8, borderRadius: 19, backgroundColor: 'white', padding: 7, borderWidth: 1, borderColor: C.line }, navItem: { flex: 1, paddingVertical: 12, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, borderRadius: 12 }, navActive: { backgroundColor: '#EEF3E5' }, navText: { fontSize: 12, fontWeight: '600', color: C.muted },
});
