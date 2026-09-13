import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePostLink } from '../shared/links.mjs';

test('extracts and normalizes links from shared text', () => {
  assert.deepEqual(parsePostLink('Watch this https://www.instagram.com/reel/AbC_12/?igsh=tracking'), { platform: 'Instagram', url: 'https://www.instagram.com/reel/AbC_12/' });
  assert.equal(parsePostLink('https://x.com/person/status/12345')?.platform, 'X');
  assert.equal(parsePostLink('https://mobile.twitter.com/person/status/12345')?.platform, 'X');
  assert.equal(parsePostLink('https://m.facebook.com/watch/?v=123')?.platform, 'Facebook');
  assert.equal(parsePostLink('https://fb.watch/abc123/')?.platform, 'Facebook');
  assert.equal(parsePostLink('https://www.facebook.com/share/r/123456/')?.platform, 'Facebook');
});
test('rejects lookalike domains, credentials, non-HTTPS, profiles, and arbitrary targets', () => {
  for (const link of ['https://x.com.evil.com/u/status/123', 'https://evilinstagram.com/reel/abc/', 'https://user:pass@x.com/u/status/123', 'https://x.com:8443/u/status/123', 'http://x.com/u/status/123', 'https://instagram.com/person', 'https://127.0.0.1/reel/abc', 'https://facebook.com.evil.com/watch/?v=1', 'javascript:alert(1)', 'unrelated clipboard text']) assert.equal(parsePostLink(link), null, link);
});
