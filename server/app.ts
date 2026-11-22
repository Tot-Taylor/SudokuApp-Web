import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { mutationSchema } from '../src/contracts/sync.ts';
import { ApiError, applyMutation, readState } from './database.ts';

const MAX_BODY = 32 * 1024;
const staticTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function json(res: ServerResponse, status: number, value: object) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readMutation(req: IncomingMessage) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Send a JSON mutation.');
  }
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const buffer of req.iterator({ destroyOnReturn: false })) {
    size += buffer.length;
    if (size > MAX_BODY) throw new ApiError(413, 'INVALID_REQUEST', 'The mutation is too large.');
    buffers.push(buffer);
  }
  try {
    return mutationSchema.parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', 'The mutation does not match the Sudoku API.');
  }
}

async function serveStatic(res: ServerResponse, directory: string, path: string) {
  const file = path === '/' ? '/index.html' : path;
  const contentType = staticTypes[extname(file)];
  if (contentType && /^\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+$/i.test(file)) {
    try {
      const contents = await readFile(resolve(directory, '.' + file));
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': file.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(contents);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
}

export function createApp(db: DatabaseSync, options: { origin?: string; directory: string }) {
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const loopback = `127.0.0.1:${req.socket.localPort}`;
      const origin = options.origin ?? `http://${loopback}`;
      const authority = new URL(origin).host;
      if (req.headers.host !== authority && req.headers.host !== loopback) {
        throw new ApiError(403, 'ORIGIN_DENIED', 'This host is not configured for Sudoku.');
      }
      const path = (req.url ?? '').split('?')[0]!;
      if (path.startsWith('/api/')) {
        const source = req.headers.origin;
        const fetchSite = req.headers['sec-fetch-site'];
        if ((source && source !== origin) || fetchSite === 'cross-site'
          || (req.method === 'POST' && source !== origin)) {
          throw new ApiError(403, 'ORIGIN_DENIED', 'Open Sudoku from its configured origin.');
        }
        if (path === '/api/v1/state' && req.method === 'GET') {
          json(res, 200, readState(db));
        } else if (path === '/api/v1/mutations' && req.method === 'POST') {
          json(res, 200, applyMutation(db, await readMutation(req)));
        } else {
          json(res, 404, { code: 'INVALID_REQUEST', message: 'Unknown API route.' });
        }
      } else if ((req.method === 'GET' || req.method === 'HEAD') && path === '/healthz') {
        readState(db);
        json(res, 200, { status: 'ok' });
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(res, options.directory, path);
      } else {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 413) res.setHeader('Connection', 'close');
        json(res, error.status, { code: error.code, message: error.message });
      } else {
        json(res, 503, { code: 'UNAVAILABLE', message: 'Sudoku is temporarily unavailable.' });
      }
    }
  });
}
