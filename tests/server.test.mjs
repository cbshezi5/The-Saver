import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMediaServer } from '../server/index.mjs';

async function fixture(t, run) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'saver-test-'));
  const server = createMediaServer({ run, cacheDir, mode: 'legacy' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(cacheDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { base, post };
}
test('resolves preview, prepares media, reports progress, and serves local bytes/ranges', async t => {
  const { base, post } = await fixture(t, async (args, progress) => {
    if (args.includes('--dump-single-json')) return JSON.stringify({ title: 'Fixture video', uploader: 'Test creator', url: 'https://video.example/video.mp4', duration: 12, filesize: 16, vcodec: 'h264', height: 720 });
    progress('SAVER: 50.0%');
    await writeFile(args[args.indexOf('-o') + 1], '0123456789abcdef');
    return '';
  });
  const preview = await (await post('/resolve', { url: 'https://x.com/user/status/123' })).json();
  assert.equal(preview.status, 'preview'); assert.equal(preview.title, 'Fixture video');
  assert.equal((await fetch(`${base}/media/${preview.id}/file`)).status, 409);
  const starting = await post(`/media/${preview.id}/download`, {}); assert.equal(starting.status, 202);
  let job;
  for (let i = 0; i < 100; i++) { job = await (await fetch(`${base}/media/${preview.id}`)).json(); if (job.status === 'ready') break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(job.status, 'ready'); assert.equal(job.progress, 1); assert.equal(job.size, 16);
  assert.equal(await (await fetch(`${base}/media/${preview.id}/file`)).text(), '0123456789abcdef');
  const range = await fetch(`${base}/media/${preview.id}/file`, { headers: { Range: 'bytes=3-6' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), '3456');
  assert.equal((await fetch(`${base}/media/${preview.id}/file`, { headers: { Range: 'bytes=50-' } })).status, 416);
});
test('rejects invalid URLs before extraction and hides nonexistent jobs', async t => {
  let invoked = false;
  const { base, post } = await fixture(t, async () => { invoked = true; });
  assert.equal((await post('/resolve', { url: 'https://localhost/private' })).status, 400);
  assert.equal(invoked, false);
  assert.equal((await fetch(`${base}/media/11111111-1111-1111-1111-111111111111`)).status, 404);
});
test('surfaces platform failures and limits oversized media', async t => {
  let fail = true;
  const { post } = await fixture(t, async () => { if (fail) throw new Error('This post is private.'); return JSON.stringify({ url: 'https://example.com/file.mp4', filesize: 600 * 1024 * 1024 }); });
  const blocked = await post('/resolve', { url: 'https://instagram.com/reel/test/' });
  assert.equal(blocked.status, 400); assert.match((await blocked.json()).error, /private/);
  fail = false;
  assert.match((await (await post('/resolve', { url: 'https://instagram.com/reel/test/' })).json()).error, /500 MB/);
});
test('failed transfers become retryable error jobs', async t => {
  const { base, post } = await fixture(t, async args => { if (args.includes('--dump-single-json')) return JSON.stringify({ url: 'https://example.com/video.mp4' }); throw new Error('Platform blocked transfer.'); });
  const preview = await (await post('/resolve', { url: 'https://fb.watch/example/' })).json();
  await post(`/media/${preview.id}/download`, {});
  const job = await (await fetch(`${base}/media/${preview.id}`)).json();
  assert.equal(job.status, 'error'); assert.match(job.error, /blocked/);
});
