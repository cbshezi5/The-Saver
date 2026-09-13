export function extractorMessage(details) {
  if (/No module named/.test(details)) return 'Media server needs setup. Run npm run setup:server.';
  if (/Requested format is not available/i.test(details)) return 'This post has no compatible single-file MP4. The platform may only offer separate audio and video streams.';
  if (/429|Too Many Requests/i.test(details)) return 'The platform is rate-limiting requests. Wait a little and try again.';
  if (/private|login|sign in|cookies|403|authenticate/i.test(details)) return 'This post requires sign-in, is private, or the platform is blocking access. Try another public video post.';
  if (/not found|does not exist|unavailable|deleted|404/i.test(details)) return 'The post or its media is unavailable. Check the link and try another public post.';
  if (/timed out|timeout|10013|network|resolve|connection|HTTP Error 5\d\d/i.test(details)) return 'The media server could not reach the platform. Check its internet connection and try again.';
  if (/No video|No media|does not contain.*video/i.test(details)) return 'This post does not contain a downloadable video. Photo-only posts are not supported yet.';
  return 'The platform could not provide this video. Try again or use another public video post; diagnostic details are in the media server log.';
}
