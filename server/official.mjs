import { randomBytes, createHash, createHmac } from 'node:crypto';

export class ApiError extends Error {
  constructor(message, status = 400, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
const random = () => randomBytes(32).toString('base64url');
const providers = ['x', 'meta'];
export function createOfficialAccess({ env = process.env, fetcher = fetch, now = Date.now } = {}) {
  // Deliberately memory-only for the development companion. Restarting drops all grants.
  const sessions = new Map(), states = new Map();
  const version = env.META_GRAPH_VERSION;
  const graph = `https://graph.facebook.com/${version}`;
  function clean() {
    for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
    for (const [key, value] of states) if (value.expires <= now()) states.delete(key);
  }
  function createSession() {
    clean();
    if (sessions.size >= 100) throw new ApiError('Too many active sessions. Try later.', 429, 60);
    const token = random();
    sessions.set(token, { id: random(), expires: now() + 24 * 60 * 60 * 1000, accounts: {}, epochs: {} });
    return { token };
  }
  function session(req) {
    clean();
    const value = sessions.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!value) throw new ApiError('Session expired. Reopen Connected accounts and reconnect.', 401);
    return value;
  }
  function configured(provider) {
    return !!(env.OAUTH_PUBLIC_BASE_URL && (provider === 'x' ? env.X_CLIENT_ID : env.META_APP_ID && env.META_APP_SECRET && /^v\d+\.\d+$/.test(version || '')));
  }
  function callback(provider) {
    const origin = new URL(env.OAUTH_PUBLIC_BASE_URL);
    if (origin.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.protocol === 'http:')) throw new ApiError('OAuth callback must use HTTPS outside localhost.');
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new ApiError('OAUTH_PUBLIC_BASE_URL must be an origin without a path.');
    return `${origin.origin}/oauth/${provider}/callback`;
  }
  function status(s) {
    return providers.map(provider => ({ provider, configured: configured(provider), connected: !!s.accounts[provider], name: s.accounts[provider]?.name, expiresAt: s.accounts[provider]?.expires, expired: !!s.accounts[provider] && s.accounts[provider].expires <= now(), lastError: s.lastError }));
  }
  async function json(url, options = {}) {
    let response;
    try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new ApiError('Cannot reach the official API. Check the server connection.', 502); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 429 || [4, 17, 32, 613].includes(data.error?.code)) {
      const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
      const delay = Number(response.headers.get('retry-after')) || (reset > now() ? Math.ceil((reset - now()) / 1000) : 60);
      throw new ApiError('Official API rate limit reached. Please wait before retrying.', 429, delay);
    }
    if (response.status === 401 || data.error?.code === 190) throw new ApiError('Account authorization expired or was revoked. Reconnect in Settings.', 403);
    if (!response.ok || data.error || data.errors?.length) throw new ApiError('The official API denied this request. Check app permissions, account access, and API entitlement.', 403);
    return data;
  }
  function xToken(params) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (env.X_CLIENT_SECRET) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(env.X_CLIENT_ID)}:${encodeURIComponent(env.X_CLIENT_SECRET)}`).toString('base64')}`;
    return json('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body: new URLSearchParams({ client_id: env.X_CLIENT_ID, ...params }).toString() });
  }
  async function meta(path, token, params = {}) {
    const proof = createHmac('sha256', env.META_APP_SECRET).update(token).digest('hex');
    return json(`${graph}/${path}?${new URLSearchParams({ ...params, appsecret_proof: proof })}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  function begin(s, provider) {
    if (!providers.includes(provider) || !configured(provider)) throw new ApiError('Developer app is not configured yet. Follow docs/OFFICIAL_APIS.md on the computer.', 503);
    clean();
    for (const [key, value] of states) if (value.session === s && value.provider === provider) states.delete(key);
    const state = random(), verifier = random();
    const redirect = callback(provider);
    s.epochs[provider] = (s.epochs[provider] || 0) + 1;
    states.set(state, { session: s, provider, verifier, epoch: s.epochs[provider], expires: now() + 10 * 60 * 1000 });
    s.lastError = undefined;
    const url = new URL(provider === 'x' ? 'https://x.com/i/oauth2/authorize' : `https://www.facebook.com/${version}/dialog/oauth`);
    const params = { response_type: 'code', client_id: provider === 'x' ? env.X_CLIENT_ID : env.META_APP_ID, redirect_uri: redirect, state, scope: provider === 'x' ? 'tweet.read users.read offline.access' : 'pages_show_list,pages_read_engagement,instagram_basic' };
    if (provider === 'x') Object.assign(params, { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    url.search = new URLSearchParams(params).toString();
    return { url: url.toString() };
  }
  async function complete(provider, query) {
    const state = query.get('state'), pending = states.get(state);
    if (!pending || pending.provider !== provider || pending.expires <= now() || pending.session.expires <= now()) throw new ApiError('Invalid or expired sign-in. Start again from the app.');
    states.delete(state); // one use, including denials and failed exchanges
    const s = pending.session;
    try {
      if (query.has('error') || !query.get('code')) throw new ApiError('Sign-in was cancelled or consent was declined.');
      let token, me;
      if (provider === 'x') {
        token = await xToken({ grant_type: 'authorization_code', code: query.get('code'), redirect_uri: callback(provider), code_verifier: pending.verifier });
        const scopes = new Set((token.scope || '').split(' '));
        if (!['tweet.read', 'users.read'].every(scope => scopes.has(scope))) throw new ApiError('Read permissions were not granted. Reconnect and approve them.');
        me = (await json('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${token.access_token}` } })).data;
      } else {
        const short = await json(`${graph}/oauth/access_token?${new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: callback(provider), code: query.get('code') })}`);
        token = await json(`${graph}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: short.access_token })}`);
        me = await meta('me', token.access_token, { fields: 'id,name' });
      }
      if (!me?.id || !token.access_token) throw new ApiError('The provider did not return a usable account.');
      if (s.epochs[provider] !== pending.epoch || s.expires <= now()) throw new ApiError('This connection attempt was cancelled. Start again from the app.');
      s.accounts[provider] = { id: me.id, name: me.username || me.name || provider, token: token.access_token, refresh: token.refresh_token, expires: now() + Number(token.expires_in || 3600) * 1000 };
    } catch (error) { s.lastError = error.message; throw error; }
  }
  async function account(s, provider) {
    const value = s.accounts[provider];
    if (!value) throw new ApiError(`Connect ${provider === 'x' ? 'X' : 'Facebook / Instagram'} in Settings first.`, 403);
    if (value.expires > now() + 60000) return value;
    if (provider !== 'x' || !value.refresh) throw new ApiError('Account authorization expired. Reconnect in Settings.', 403);
    value.refreshing ||= xToken({ grant_type: 'refresh_token', refresh_token: value.refresh }).then(token => {
      if (!token.access_token) throw new ApiError('Reconnect your X account.', 403);
      Object.assign(value, { token: token.access_token, refresh: token.refresh_token || value.refresh, expires: now() + Number(token.expires_in || 7200) * 1000 });
    }).finally(() => { delete value.refreshing; });
    await value.refreshing;
    return value;
  }
  async function disconnect(s, provider) {
    if (!providers.includes(provider)) throw new ApiError('Unknown provider.');
    delete s.accounts[provider];
    s.epochs[provider] = (s.epochs[provider] || 0) + 1;
    for (const [key, value] of states) if (value.session === s && value.provider === provider) states.delete(key);
  }
  async function resolve(s, link) {
    if (link.platform === 'X') {
      const a = await account(s, 'x');
      const id = new URL(link.url).pathname.match(/\/status\/(\d+)/)?.[1];
      const data = await json(`https://api.x.com/2/tweets/${id}?${new URLSearchParams({ 'tweet.fields': 'author_id,attachments', expansions: 'attachments.media_keys', 'media.fields': 'type,variants,preview_image_url,duration_ms,width,height' })}`, { headers: { Authorization: `Bearer ${a.token}` } });
      if (data.data?.author_id !== a.id) throw new ApiError('Only posts authored by the connected X account can be downloaded in official mode.', 403);
      const keys = new Set(data.data?.attachments?.media_keys || []);
      const media = data.includes?.media?.find(m => keys.has(m.media_key) && ['video', 'animated_gif'].includes(m.type));
      const variant = media?.variants?.filter(v => v.content_type === 'video/mp4').sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
      if (!variant) throw new ApiError('X did not return an MP4 for this post.');
      return { url: variant.url, title: data.data.text || 'X video', uploader: a.name, thumbnail: media.preview_image_url, duration: (media.duration_ms || 0) / 1000, width: media.width, height: media.height };
    }
    const a = await account(s, 'meta');
    const pages = await meta('me/accounts', a.token, { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '25' });
    const target = new URL(link.url);
    const shortcode = target.pathname.match(/^\/(?:p|reel|reels|tv)\/([\w-]+)/)?.[1];
    const videoId = target.searchParams.get('v') || target.pathname.match(/\/(?:videos|reel)\/(\d+)/)?.[1];
    if ((link.platform === 'Instagram' && !shortcode) || (link.platform === 'Facebook' && !videoId)) throw new ApiError('Use the original Instagram post/reel URL or Facebook video URL with its numeric ID; shortened share links are not supported by official mode.');
    for (const page of (pages.data || []).slice(0, 25)) {
      const ig = page.instagram_business_account;
      if (!page.access_token || (link.platform === 'Instagram' && !ig)) continue;
      const edge = link.platform === 'Instagram' ? `${ig.id}/media` : `${page.id}/videos`;
      const fields = link.platform === 'Instagram' ? 'id,caption,media_type,media_url,thumbnail_url,permalink,children{id,media_type,media_url,thumbnail_url}' : 'id,description,source,permalink_url,length,picture';
      let after;
      for (let batch = 0; batch < 2; batch++) {
        const list = await meta(edge, page.access_token, { fields, limit: '50', ...(after ? { after } : {}) });
        const found = list.data?.find(m => link.platform === 'Instagram' ? m.permalink?.match(/\/(?:p|reel|reels|tv)\/([\w-]+)/)?.[1] === shortcode : m.id === videoId);
        if (found) {
          const video = link.platform === 'Instagram' ? (found.media_type === 'VIDEO' ? found : found.children?.data?.find(m => m.media_type === 'VIDEO')) : found;
          const url = video?.media_url || video?.source;
          if (!url) throw new ApiError('Meta did not return a downloadable video source for this authorized post.');
          return { url, title: found.caption || found.description || 'My video', uploader: ig?.username || page.name, thumbnail: video.thumbnail_url || video.picture, duration: video.length || 0 };
        }
        after = list.paging?.cursors?.after;
        if (!after || !list.paging?.next) break;
      }
    }
    throw new ApiError('Post not found in the most recent 100 media items of the first 25 authorized Pages/accounts. Check ownership and the original URL.', 404);
  }
  return { createSession, session, status, begin, complete, disconnect, resolve, clean };
}
