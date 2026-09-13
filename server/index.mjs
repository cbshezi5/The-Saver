import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePostLink } from '../shared/links.mjs';
import { runExtractor } from './runner.mjs';
import { progressiveMp4 as format } from './formats.mjs';
import { createOfficialAccess } from './official.mjs';
import { downloadOfficial } from './official-download.mjs';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

const cache = fileURLToPath(new URL('./cache/', import.meta.url));
const lifetime = 60 * 60 * 1000;
const maxBytes = 500 * 1024 * 1024;
export function createMediaServer({ run = runExtractor, cacheDir = cache, mode = process.env.MEDIA_ACCESS_MODE || 'official', official = createOfficialAccess(), officialDownload = downloadOfficial } = {}) {
  if (!['official', 'legacy'].includes(mode)) throw new Error('MEDIA_ACCESS_MODE must be official or legacy.');
  const jobs = new Map();
  let active = 0;
  function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  async function body(req) {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 8192) throw new Error('Request too large.'); }
    try { return JSON.parse(text); } catch { throw new Error('Invalid JSON request.'); }
  }
  const view = job => ({ id: job.id, title: job.title, author: job.author, platform: job.platform, thumbnail: job.thumbnail, duration: job.duration, width: job.width, height: job.height, size: job.size, status: job.status, progress: job.progress, error: job.error });
  const server = http.createServer(async (req, res) => {
    // Development companion server: bind only on a trusted LAN. No public deployment by default.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, mode });
      const callback = url.pathname.match(/^\/oauth\/(x|meta)\/callback$/);
      if (req.method === 'GET' && callback) {
        let message = 'Account connected. Return to The Saver and tap Refresh accounts.';
        let code = 200;
        try { await official.complete(callback[1], url.searchParams); } catch (error) { message = error.message; code = error.status || 400; }
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        return res.end(message);
      }
      if (req.method === 'POST' && url.pathname === '/auth/session') return json(res, 201, official.createSession());
      const owner = mode === 'official' || url.pathname.startsWith('/auth/') ? official.session(req) : null;
      if (req.method === 'GET' && url.pathname === '/auth/accounts') return json(res, 200, { mode, accounts: official.status(owner) });
      const authAction = url.pathname.match(/^\/auth\/(x|meta)\/(connect|disconnect)$/);
      if (req.method === 'POST' && authAction) {
        if (authAction[2] === 'connect') return json(res, 200, official.begin(owner, authAction[1]));
        await official.disconnect(owner, authAction[1]);
        // Invalidate server-side previews/downloads for this session on disconnect.
        for (const [id, job] of jobs) if (job.owner === owner.id && (authAction[1] === 'x' ? job.platform === 'X' : job.platform !== 'X')) {
          job.revoked = true; job.controller?.abort(); jobs.delete(id);
          if (job.status !== 'preparing') await rm(path.join(cacheDir, `${id}.mp4`), { force: true });
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/resolve') {
        if (active >= 2) return json(res, 429, { error: 'Server is busy. Please try again shortly.' });
        if (jobs.size >= 100) return json(res, 429, { error: 'Server storage is busy. Please try again later.' });
        const input = await body(req);
        const link = parsePostLink(input.url);
        if (!link) return json(res, 400, { error: 'Paste a valid X, Instagram, or Facebook post link.' });
        active++;
        try {
          const info = mode === 'official' ? await official.resolve(owner, link) : JSON.parse(await run(['--dump-single-json', '--skip-download', '-f', format, '--', link.url]));
          const entry = info.entries?.find(Boolean) ?? info;
          if (!entry.url || entry.vcodec === 'none') throw new Error('No downloadable video was found in this post.');
          if ((entry.filesize || entry.filesize_approx || 0) > maxBytes) throw new Error('This video exceeds the 500 MB download limit.');
          const job = { id: randomUUID(), source: link.url, platform: link.platform, title: entry.title || 'Untitled video', author: entry.uploader || entry.channel || link.platform, thumbnail: /^https:\/\//.test(entry.thumbnail || '') ? entry.thumbnail : null, duration: entry.duration || 0, width: entry.width, height: entry.height, size: entry.filesize || entry.filesize_approx || null, status: 'preview', progress: 0, createdAt: Date.now() };
          job.owner = owner?.id;
          jobs.set(job.id, job);
          return json(res, 200, view(job));
        } finally { active--; }
      }
      const match = url.pathname.match(/^\/media\/([a-f0-9-]{36})(\/download|\/file)?$/);
      if (!match) return json(res, 404, { error: 'Not found.' });
      const job = jobs.get(match[1]);
      if (!job) return json(res, 404, { error: 'Preview expired. Paste the link again to refresh it.' });
      if (mode === 'official' && job.owner !== owner.id) return json(res, 404, { error: 'Preview not found in this session.' });
      if (req.method === 'GET' && !match[2]) return json(res, 200, view(job));
      if (req.method === 'POST' && match[2] === '/download') {
        if (['preparing', 'ready'].includes(job.status)) return json(res, 200, view(job));
        if (active >= 2) return json(res, 429, { error: 'Server is busy. Please try again shortly.' });
        await mkdir(cacheDir, { recursive: true });
        active++; job.status = 'preparing'; job.progress = 0; job.error = undefined; job.controller = new AbortController();
        const file = path.join(cacheDir, `${job.id}.mp4`);
        void (async () => {
          try {
            if (mode === 'official') {
              // Recheck the grant/ownership and obtain a fresh signed URL before download.
              const fresh = await official.resolve(owner, { url: job.source, platform: job.platform });
              if (job.revoked) throw new Error('Account disconnected.');
              await officialDownload(fresh.url, job.platform, file, progress => { job.progress = progress; }, maxBytes, undefined, job.controller.signal);
            } else await run(['-f', format, '--max-filesize', String(maxBytes), '--newline', '--progress', '--progress-template', 'download:SAVER:%(progress._percent_str)s', '-o', file, '--', job.source], line => {
              const percent = line.match(/SAVER:\s*([\d.]+)%/);
              if (percent) job.progress = Math.min(1, Number(percent[1]) / 100);
            }, 10 * 60 * 1000);
            const details = await stat(file);
            if (!details.size || details.size > maxBytes) throw new Error('Video is empty or exceeds the 500 MB limit.');
            job.size = details.size; job.status = 'ready'; job.progress = 1; job.createdAt = Date.now();
          } catch (error) { job.status = 'error'; job.error = error.message; }
          finally { active--; if (job.revoked) await rm(file, { force: true }).catch(() => {}); }
        })();
        return json(res, 202, view(job));
      }
      if (req.method === 'GET' && match[2] === '/file') {
        if (job.status !== 'ready') return json(res, 409, { error: 'The video is not ready yet.' });
        const file = path.join(cacheDir, `${job.id}.mp4`);
        const { size } = await stat(file);
        let start = 0, end = size - 1;
        if (req.headers.range) {
          const range = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
          if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
          start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        }
        const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename="saver-${job.id}.mp4"` };
        if (req.headers.range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(req.headers.range ? 206 : 200, headers);
        const stream = createReadStream(file, { start, end });
        stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
      }
      return json(res, 405, { error: 'Method not allowed.' });
    } catch (error) {
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      if (!res.headersSent) json(res, error.status || 400, { error: error.message || 'Unable to process the post.', ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
    }
  });
  const cleanup = setInterval(async () => {
    for (const [id, job] of jobs) if (job.status !== 'preparing' && Date.now() - job.createdAt > lifetime) {
      jobs.delete(id);
      for (const suffix of ['.mp4', '.mp4.part', '.mp4.ytdl']) await rm(path.join(cacheDir, id + suffix), { force: true }).catch(() => {});
    }
  }, 60000);
  cleanup.unref(); server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPath = fileURLToPath(new URL('./.env', import.meta.url));
  if (existsSync(envPath)) loadEnvFile(envPath);
  const server = createMediaServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '0.0.0.0', () => console.log(`The Saver media server is listening on port ${port}. Use your computer's LAN IP in the app.`));
}
