import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const base = process.env.SAVER_TEST_API || 'http://127.0.0.1:8787';
const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://x.com/Blaqclips07/status/2098569453155807630?s=20',
  'https://x.com/simpsons_DG/status/2095957790141383056',
  'https://x.com/BrooklynNets/status/1349794411333394432',
  'https://x.com/oshtru/status/1577855540407197696',
  'https://x.com/SouthamptonFC/status/1347577658079641604',
];
const directory = path.resolve('verification/downloads');
await mkdir(directory, { recursive: true });
const results = [];
async function api(route, body) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(125000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || String(response.status));
  return data;
}
for (const url of urls) {
  console.log(`Checking ${url}`);
  try {
    const preview = await api('/resolve', { url });
    let job = await api(`/media/${preview.id}/download`, {});
    const observedProgress = [];
    const deadline = Date.now() + 11 * 60 * 1000;
    while (job.status !== 'ready') {
      if (job.status === 'error') throw new Error(job.error);
      if (Date.now() > deadline) throw new Error('Preparation timed out');
      observedProgress.push(job.progress);
      await new Promise(resolve => setTimeout(resolve, 700));
      job = await api(`/media/${preview.id}`);
    }
    const response = await fetch(`${base}/media/${job.id}/file`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || response.headers.get('content-type') !== 'video/mp4') throw new Error('File endpoint did not return MP4');
    const file = path.join(directory, `${new URL(url).pathname.split('/')[3]}.mp4`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    const bytes = await readFile(file);
    if (bytes.length !== job.size || bytes.length !== Number(response.headers.get('content-length'))) throw new Error('Incomplete file transfer');
    // Verify ISO base media container boxes and audio/video handler declarations.
    const boxes = [];
    let moov;
    for (let offset = 0; offset + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      let size = bytes.readUInt32BE(offset);
      if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
      if (size === 0) size = bytes.length - offset;
      if (size < 8 || offset + size > bytes.length) throw new Error('Invalid MP4 box bounds');
      boxes.push(type);
      if (type === 'moov') moov = bytes.subarray(offset, offset + size);
      offset += size;
    }
    if (!['ftyp', 'moov', 'mdat'].every(box => boxes.includes(box)) || !moov.includes(Buffer.from('vide')) || !moov.includes(Buffer.from('soun'))) throw new Error('Expected a complete MP4 with both audio and video');
    const range = await fetch(`${base}/media/${job.id}/file`, { headers: { Range: 'bytes=0-31' } });
    if (range.status !== 206 || !Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(0, 32))) throw new Error('Playback range request failed');
    const result = { url, success: true, title: job.title, bytes: bytes.length, duration: job.duration, width: job.width, height: job.height, sha256: createHash('sha256').update(bytes).digest('hex'), file, preview: true, progressObserved: observedProgress, rangePlayback: true, audioAndVideo: true };
    results.push(result); console.log(`PASS ${url} (${bytes.length} bytes, ${job.width}x${job.height})`);
  } catch (error) { results.push({ url, success: false, error: error.message }); console.log(`FAIL ${url}: ${error.message}`); }
  await writeFile('verification/x-downloads.json', JSON.stringify({ verifiedAt: new Date().toISOString(), base, results }, null, 2));
}
console.log(`${results.filter(result => result.success).length}/${results.length} actual downloads passed.`);
if (results.some(result => !result.success)) process.exitCode = 1;
