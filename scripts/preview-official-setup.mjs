// Temporary local UI verification server. No credentials or external access needed.
import { createMediaServer } from '../server/index.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const media = createMediaServer({ mode: 'official' });
media.listen(8787, '127.0.0.1');
const root = path.resolve('dist');
const web = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    const bytes = await readFile(file);
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.ttf': 'font/ttf', '.png': 'image/png', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
web.listen(8081, '127.0.0.1', () => console.log('Temporary official setup preview at http://localhost:8081'));
process.on('SIGINT', () => { web.close(); media.close(); });
