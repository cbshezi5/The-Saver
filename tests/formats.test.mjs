import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { progressiveMp4 } from '../server/formats.mjs';
import { extractorMessage } from '../server/errors.mjs';

const python = process.env.YTDLP_PYTHON || path.resolve('server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
test('real yt-dlp selector accepts X MP4s with unknown codecs and rejects isolated streams', { skip: !existsSync(python) }, () => {
  const script = `
import json, sys
from yt_dlp import YoutubeDL
formats = [
 {'format_id':'audio', 'url':'https://example.com/audio.mp4', 'ext':'mp4', 'protocol':'https', 'vcodec':'none', 'acodec':'aac'},
 {'format_id':'http-low', 'url':'https://example.com/low.mp4', 'ext':'mp4', 'protocol':'https', 'height':404},
 {'format_id':'http-high', 'url':'https://example.com/high.mp4', 'ext':'mp4', 'protocol':'https', 'height':906},
 {'format_id':'video-only', 'url':'https://example.com/silent.mp4', 'ext':'mp4', 'protocol':'https', 'height':1080, 'vcodec':'h264', 'acodec':'none'},
 {'format_id':'hls', 'url':'https://example.com/high.m3u8', 'ext':'mp4', 'protocol':'m3u8_native', 'height':2160, 'vcodec':'h264', 'acodec':'aac'}]
with YoutubeDL({'quiet': True}) as ydl:
 selector = ydl.build_format_selector(sys.argv[1])
 print(json.dumps([f['format_id'] for f in selector({'formats':formats, 'has_merged_format':False, 'incomplete_formats':False})]))
`;
  const result = spawnSync(python, ['-c', script, progressiveMp4], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['http-high']);
});
test('extractor errors distinguish format, network, rate limit and missing media', () => {
  assert.match(extractorMessage('Requested format is not available'), /compatible single-file MP4/);
  assert.match(extractorMessage('HTTP Error 500'), /could not reach/);
  assert.match(extractorMessage('HTTP Error 429'), /rate-limiting/);
  assert.match(extractorMessage('No video could be found in this tweet'), /does not contain/);
  assert.doesNotMatch(extractorMessage('Unknown extractor failure'), /Photo-only/);
});
