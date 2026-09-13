import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './official.mjs';

export function validateCdn(value, platform) {
  const url = new URL(value);
  const hosts = platform === 'X' ? ['twimg.com'] : ['fbcdn.net', 'cdninstagram.com'];
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new ApiError('The API returned an unsupported media host.');
  return url;
}
export async function downloadOfficial(source, platform, file, onProgress, maxBytes, fetcher = fetch, signal) {
  let url = validateCdn(source, platform), response;
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      // Provider bearer tokens never travel to media CDN hosts.
      response = await fetcher(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) : AbortSignal.timeout(10 * 60 * 1000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects === 4) throw new ApiError('Too many media redirects.');
      url = validateCdn(new URL(response.headers.get('location'), url).toString(), platform);
    }
    if (!response.ok || !response.body) throw new ApiError('Media URL expired or download was denied. Preview the post again.');
    const total = Number(response.headers.get('content-length'));
    if (total > maxBytes) { await response.body.cancel(); throw new ApiError('Video exceeds the 500 MB limit.'); }
    let written = 0, head = Buffer.alloc(0);
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) {
      written += chunk.length;
      if (written > maxBytes) return done(new ApiError('Video exceeds the 500 MB limit.'));
      if (head.length < 32) head = Buffer.concat([head, chunk]).subarray(0, 32);
      if (head.length >= 12 && head.toString('ascii', 4, 8) !== 'ftyp') return done(new ApiError('The official API did not return an MP4 file.'));
      onProgress(total > 0 ? Math.min(written / total, 1) : 0);
      done(null, chunk);
    } }), createWriteStream(file), { signal });
    if (head.length < 12 || (total > 0 && written !== total)) throw new ApiError('Incomplete media download.');
  } catch (error) { await rm(file, { force: true }); throw error; }
}
