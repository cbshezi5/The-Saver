/** Extract only supported social post URLs; never accept lookalike domains. */
export function parsePostLink(text) {
  const candidates = String(text).match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.!?;]+$/, ''));
      if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
      const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
      const path = url.pathname;
      let platform;
      if (['x.com', 'twitter.com'].includes(host) && /^\/(?:[^/]+\/status|i\/web\/status)\/\d+\/?/.test(path)) platform = 'X';
      if (host === 'instagram.com' && /^\/(p|reel|reels|tv|share)\/[\w-]+\/?/.test(path)) platform = 'Instagram';
      if ((host === 'fb.watch' && /^\/[\w-]+/.test(path)) || (host === 'facebook.com' && (/^\/(?:reel|share|watch|photo|photo.php|permalink.php|story.php)(?:\/|$)/.test(path) || /^\/[^/]+\/(?:videos|posts)\//.test(path)))) platform = 'Facebook';
      if (!platform) continue;
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|igsh|fbclid)/.test(key)) url.searchParams.delete(key);
      return { url: url.toString(), platform };
    } catch {}
  }
  return null;
}
