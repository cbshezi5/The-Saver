import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOfficialAccess } from '../server/official.mjs';
import { createMediaServer } from '../server/index.mjs';
import { downloadOfficial, validateCdn } from '../server/official-download.mjs';

const env = { OAUTH_PUBLIC_BASE_URL: 'https://saver.example', X_CLIENT_ID: 'test-client', META_APP_ID: 'test-meta', META_APP_SECRET: 'test-secret', META_GRAPH_VERSION: 'v26.0' };
const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function fixture() {
  let clock = 1000, author = 'owner', limited = false, refreshes = 0;
  const calls = [];
  const access = createOfficialAccess({ env, now: () => clock, fetcher: async (url, options) => {
    url = new URL(url); calls.push({ url, options });
    if (url.pathname === '/2/oauth2/token') {
      const body = new URLSearchParams(options.body);
      if (body.get('grant_type') === 'refresh_token') refreshes++;
      return reply({ access_token: 'provider-secret', refresh_token: 'refresh-secret', scope: 'tweet.read users.read offline.access', expires_in: 120 });
    }
    if (url.pathname === '/2/users/me') return reply({ data: { id: 'owner', username: 'my-account' } });
    if (url.pathname.startsWith('/2/tweets/')) {
      if (limited) return reply({}, 429, { 'retry-after': '42' });
      return reply({ data: { author_id: author, text: 'My clip', attachments: { media_keys: ['key'] } }, includes: { media: [{ media_key: 'key', type: 'video', duration_ms: 1000, variants: [{ content_type: 'video/mp4', bit_rate: 1, url: 'https://video.twimg.com/low.mp4' }, { content_type: 'video/mp4', bit_rate: 2, url: 'https://video.twimg.com/high.mp4' }] }] } });
    }
    if (url.pathname.endsWith('/oauth/access_token')) return reply({ access_token: 'meta-secret', expires_in: 5000 });
    if (url.pathname.endsWith('/me')) return reply({ id: 'meta-owner', name: 'My Meta' });
    if (url.pathname.endsWith('/me/accounts')) return reply({ data: [{ id: '123', name: 'My Page', access_token: 'page-secret', instagram_business_account: { id: '456', username: 'my-ig' } }] });
    if (url.pathname.endsWith('/456/media')) return reply({ data: [{ id: '789', media_type: 'VIDEO', media_url: 'https://scontent.cdninstagram.com/clip.mp4', permalink: 'https://www.instagram.com/reel/MyClip/', caption: 'My IG clip' }] });
    if (url.pathname.endsWith('/123/videos')) return reply({ data: [{ id: '999', source: 'https://video.fbcdn.net/clip.mp4', description: 'My Page clip' }] });
    throw new Error(`Unexpected mock request ${url.pathname}`);
  } });
  const newSession = () => { const { token } = access.createSession(); return { token, session: access.session({ headers: { authorization: `Bearer ${token}` } }) }; };
  const connect = async (s, provider = 'x') => { const start = new URL(access.begin(s, provider).url); await access.complete(provider, new URLSearchParams({ state: start.searchParams.get('state'), code: 'test-code' })); return start; };
  return { access, calls, newSession, connect, setAuthor: value => { author = value; }, setClock: value => { clock = value; }, limit: () => { limited = true; }, refreshes: () => refreshes };
}
test('X OAuth uses S256 PKCE, state is single-use, and provider tokens stay server-side', async () => {
  const f = fixture(), { session } = f.newSession();
  const start = await f.connect(session);
  assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
  const verifier = new URLSearchParams(f.calls[0].options.body).get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), start.searchParams.get('code_challenge'));
  assert.doesNotMatch(JSON.stringify(f.access.status(session)), /provider-secret|refresh-secret/);
  await assert.rejects(f.access.complete('x', new URLSearchParams({ state: start.searchParams.get('state'), code: 'replay' })), /Invalid/);
});
test('state validation rejects wrong provider, expired state, and consent denial', async () => {
  const f = fixture(), { session } = f.newSession();
  const state = new URL(f.access.begin(session, 'x').url).searchParams.get('state');
  await assert.rejects(f.access.complete('meta', new URLSearchParams({ state, code: 'test' })), /Invalid/);
  await assert.rejects(f.access.complete('x', new URLSearchParams({ state, error: 'access_denied' })), /declined/);
  assert.equal(f.access.status(session)[0].connected, false);
  const next = new URL(f.access.begin(session, 'x').url).searchParams.get('state');
  f.setClock(700000);
  await assert.rejects(f.access.complete('x', new URLSearchParams({ state: next, code: 'test' })), /expired/);
});
test('X resolution restricts authorship, selects MP4 and returns rate-limit guidance', async () => {
  const f = fixture(), { session } = f.newSession(); await f.connect(session);
  const link = { platform: 'X', url: 'https://x.com/me/status/123' };
  assert.equal((await f.access.resolve(session, link)).url, 'https://video.twimg.com/high.mp4');
  f.setAuthor('someone-else'); await assert.rejects(f.access.resolve(session, link), /authored by/);
  f.limit(); await assert.rejects(f.access.resolve(session, link), e => e.status === 429 && e.retryAfter === 42);
});
test('expired X tokens refresh once and disconnect removes local grants', async () => {
  const f = fixture(), { session } = f.newSession(); await f.connect(session); f.setClock(100000);
  await Promise.all([1, 2].map(() => f.access.resolve(session, { platform: 'X', url: 'https://x.com/me/status/123' })));
  assert.equal(f.refreshes(), 1); await f.access.disconnect(session, 'x');
  await assert.rejects(f.access.resolve(session, { platform: 'X', url: 'https://x.com/me/status/123' }), /Connect X/);
});
test('Meta resolves only videos in granted Page/Instagram media lists', async () => {
  const f = fixture(), { session } = f.newSession(); await f.connect(session, 'meta');
  assert.match((await f.access.resolve(session, { platform: 'Instagram', url: 'https://instagram.com/reel/MyClip/' })).url, /cdninstagram/);
  assert.match((await f.access.resolve(session, { platform: 'Facebook', url: 'https://facebook.com/reel/999/' })).url, /fbcdn/);
  await assert.rejects(f.access.resolve(session, { platform: 'Instagram', url: 'https://instagram.com/reel/NotMine/' }), /not found/);
  assert.doesNotMatch(JSON.stringify(f.access.status(session)), /meta-secret|page-secret/);
});
test('official API isolates jobs across sessions and never calls the legacy extractor', async t => {
  const f = fixture(), owner = f.newSession(), other = f.newSession(); await f.connect(owner.session);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'saver-official-'));
  const server = createMediaServer({ mode: 'official', official: f.access, cacheDir, run: () => { throw new Error('Legacy must never run'); }, officialDownload: async (url, platform, file, progress) => { progress(.5); await writeFile(file, 'fake-mp4'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(cacheDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (route, token, body) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const landing = await fetch(base + '/');
  assert.equal(landing.status, 200);
  assert.equal((await landing.json()).service, 'The Saver media API');
  assert.equal((await req('/resolve', '', { url: 'https://x.com/me/status/123' })).status, 401);
  const job = await (await req('/resolve', owner.token, { url: 'https://x.com/me/status/123' })).json();
  assert.ok(job.id);
  for (const suffix of ['', '/file', '/download']) assert.equal((await req(`/media/${job.id}${suffix}`, other.token, suffix === '/download' ? {} : undefined)).status, 404);
  await req(`/media/${job.id}/download`, owner.token, {});
  for (let i = 0; i < 50; i++) { const value = await (await req(`/media/${job.id}`, owner.token)).json(); if (value.status === 'ready') break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal((await req(`/media/${job.id}/file`, owner.token)).status, 200);
  await req('/auth/x/disconnect', owner.token, {});
  assert.equal((await req(`/media/${job.id}/file`, owner.token)).status, 404);
});
test('CDN transfer blocks untrusted hosts, checks redirects and enforces byte limits', async t => {
  for (const url of ['http://video.twimg.com/a.mp4', 'https://video.twimg.com.evil.test/a', 'https://127.0.0.1/a', 'https://user@video.twimg.com/a']) assert.throws(() => validateCdn(url, 'X'));
  const dir = await mkdtemp(path.join(tmpdir(), 'saver-cdn-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'video.mp4'), bytes = Buffer.from('0000ftyp0000video');
  const progress = [];
  await downloadOfficial('https://video.twimg.com/a.mp4', 'X', file, value => progress.push(value), 100, async (url, options) => { assert.equal(options.headers, undefined); return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); });
  assert.deepEqual(await readFile(file), bytes); assert.equal(progress.at(-1), 1);
  await assert.rejects(downloadOfficial('https://video.twimg.com/a.mp4', 'X', file, () => {}, 4, async () => new Response(bytes)), /500 MB/);
  await assert.rejects(downloadOfficial('https://video.twimg.com/a.mp4', 'X', file, () => {}, 100, async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })), /unsupported/);
});
