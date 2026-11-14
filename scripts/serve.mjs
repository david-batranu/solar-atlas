#!/usr/bin/env node
/**
 * Minimal zero-dependency static server for Solar Atlas.
 *
 *   node scripts/serve.mjs
 *   PORT=5000 node scripts/serve.mjs
 *
 * Binds to 127.0.0.1 by default so the orrery is never accidentally exposed.
 */

import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}));

function resolveRequestPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const resolved = path.resolve(ROOT, `.${decoded}`);
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  const target = resolveRequestPath(request.url || '/');
  if (!target) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  let stats;
  try {
    stats = statSync(target);
    if (stats.isDirectory()) {
      const indexPath = path.join(target, 'index.html');
      statSync(indexPath);
      return serveFile(indexPath, stats.mtime, request, response);
    }
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  return serveFile(target, stats.mtime, request, response);
});

function serveFile(filePath, mtime, request, response) {
  const extension = path.extname(filePath).toLowerCase();
  const mime = MIME.get(extension) || 'application/octet-stream';
  const stats = statSync(filePath);
  response.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stats.size,
    'Cache-Control': 'no-store',
    'Last-Modified': new Date(mtime).toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

server.listen(PORT, HOST, () => {
  console.log(`Solar Atlas running at http://${HOST}:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=4174 node scripts/serve.mjs`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
