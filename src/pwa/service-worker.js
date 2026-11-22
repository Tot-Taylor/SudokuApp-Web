/* global release */

const worker = globalThis;
const cachePrefix = 'sudoku-shell-';
const assets = new Set([release.shell, ...release.essentials, ...release.icons]);

async function cacheRelease(signal) {
  const cache = await worker.caches.open(release.cacheName);
  await cache.addAll([...assets].map((path) => new worker.Request(path, {
    cache: 'reload', redirect: 'error', credentials: 'omit', signal,
  })));
  return cache;
}

worker.addEventListener('install', (event) => {
  // Cache a complete release before the browser can activate it.
  event.waitUntil(cacheRelease());
});

worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await worker.caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(cachePrefix) && name !== release.cacheName)
      .map((name) => worker.caches.delete(name)));
    await worker.clients.claim();
  })());
});

function cached(path) {
  return worker.caches.match(path, { cacheName: release.cacheName }).catch(() => undefined);
}

async function appShell(request) {
  const [shell, ...essentials] = await Promise.all([release.shell, ...release.essentials].map(cached));
  if (shell && essentials.every(Boolean)) return shell;

  if (worker.navigator.onLine) {
    // Restore missing files only from this release's immutable URLs.
    try {
      const cache = await cacheRelease(worker.AbortSignal.timeout(4000));
      const repaired = await cache.match(release.shell);
      if (repaired) return repaired;
    } catch {
      // The host may already be serving a different release.
    }
    try {
      const response = await worker.fetch(request, { signal: worker.AbortSignal.timeout(4000) });
      if (response.ok) return response;
    } catch {
      // Keep the reconnect instructions available when the origin cannot be reached.
    }
  }
  return new worker.Response(
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sudoku is offline</title>' +
    '<h1>Sudoku is offline</h1><p>Reconnect to Tailscale and reopen Sudoku to download its app files.</p>' +
    '<p><a href="/">Try again</a></p></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

worker.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new worker.URL(request.url);
  if (request.method !== 'GET' || url.origin !== worker.location.origin) return;

  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(appShell(request));
  } else if (!url.search && assets.has(url.pathname)) {
    event.respondWith((async () => (await cached(url.pathname)) ?? worker.fetch(request))());
  }
});
