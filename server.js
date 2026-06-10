// Chords — local server. API logic lives in core.js (shared with worker.js).
// Zero dependencies. Node 18+.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRoute } from './core.js';

const PORT = process.env.PORT || 3456;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  const api = await apiRoute(url.pathname, url.searchParams);
  if (api) return send(api.status, api.body);

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(403, { error: 'Forbidden' });
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    return send(200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  }
  return send(404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Chords running at http://localhost:${PORT}`));
