import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'vite';
import { createApp } from '../../server/app.ts';
import { openDatabase, readState } from '../../server/database.ts';
import type { SharedState } from '../../src/contracts/sync.ts';
import { readReplica } from './storage.ts';

type LocalHost = {
  url: string;
  directory: string;
  apiAvailable: boolean;
  filesAvailable: boolean;
  state(): SharedState;
};

const test = base.extend<{ app: LocalHost }>({
  app: async ({ request }, use) => {
    const db = openDatabase(':memory:');
    const host: LocalHost = {
      url: '', directory: resolve('dist'), apiAvailable: true, filesAvailable: true, state: () => readState(db),
    };
    const handler = createApp(db, host);
    const server = createServer((req, res) => {
      const available = req.url?.startsWith('/api/') ? host.apiAvailable : host.filesAvailable;
      if (!available) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ code: 'UNAVAILABLE', message: 'Test outage.' }));
        return;
      }
      handler.emit('request', req, res);
    });
    try {
      await new Promise<void>((listening, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', listening);
      });
      const socket = server.address();
      if (!socket || typeof socket === 'string') throw new Error('Missing local PWA test address.');
      host.url = `http://127.0.0.1:${socket.port}`;
      expect((await request.get(host.url + '/healthz')).ok()).toBe(true);
      await use(host);
    } finally {
      await new Promise<void>((closed) => {
        server.close(() => closed());
        server.closeAllConnections();
      });
      db.close();
    }
  },
});

function syncStatus(page: Page) {
  return page.locator('.sync-status').getByRole('status');
}

async function waitForOfflineShell(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

function shellCaches(page: Page) {
  return page.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith('sudoku-shell-')));
}

function cachedPaths(page: Page) {
  return page.evaluate(async () => {
    const keys = await caches.keys();
    const paths = await Promise.all(keys.filter((key) => key.startsWith('sudoku-shell-')).map(async (key) => {
      const cache = await caches.open(key);
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    }));
    return paths.flat();
  });
}

async function newGame(page: Page, difficulty: 'Easy' | 'Medium', replace = false) {
  await page.getByRole('button', { name: 'New Game' }).click();
  await page.getByRole('button', { name: difficulty, exact: true }).click();
  if (replace) await page.getByRole('button', { name: 'Start New', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${difficulty} puzzle` })).toBeVisible();
}

async function playDigit(page: Page, digit: number) {
  const cell = page.getByRole('gridcell', { name: /empty$/ }).first();
  await cell.click();
  await page.getByRole('group', { name: 'Number pad' }).getByRole('button', { name: String(digit) }).click();
  await expect(page.locator('[aria-selected="true"]')).toHaveText(String(digit));
}

async function fitsViewport(page: Page) {
  const dimensions = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
}

test('serves the standalone manifest and icons and precaches only release files', async ({ app, page, request }) => {
  await page.goto(app.url);
  await waitForOfflineShell(page);
  await expect(syncStatus(page)).toHaveText('Synced');

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const manifest = await request.get(app.url + '/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  expect(await manifest.json()).toMatchObject({
    name: 'Sudoku', short_name: 'Sudoku', id: '/', scope: '/', start_url: '/', display: 'standalone',
    icons: [192, 512].map((size) => ({ src: `/icons/sudoku-v1-${size}.png`, sizes: `${size}x${size}`, type: 'image/png' })),
  });
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/sudoku-v1-180.png');
  for (const size of [180, 192, 512]) {
    const icon = await request.get(app.url + `/icons/sudoku-v1-${size}.png`);
    expect(icon.headers()['content-type']).toContain('image/png');
    const png = await icon.body();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
  }
  const worker = await request.get(app.url + '/sw.js');
  expect(worker.headers()['cache-control']).toBe('no-cache');
  const state = await request.get(app.url + '/api/v1/state');
  expect(state.headers()['cache-control']).toBe('no-store');

  const paths = await cachedPaths(page);
  expect(paths).toEqual(expect.arrayContaining([
    expect.stringMatching(/^\/assets\/sudoku-shell-.*\.html$/),
    expect.stringMatching(/^\/assets\/.*\.css$/),
    expect.stringMatching(/^\/assets\/generator\.worker-.*\.js$/),
    '/icons/sudoku-v1-180.png',
  ]));
  expect(paths.every((path) => path.startsWith('/assets/') || path.startsWith('/icons/sudoku-v1-'))).toBe(true);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Offline play is ready on this device.')).toBeVisible();
});

test('cold launches offline, resumes a puzzle, generates a replacement, and syncs on reconnect', async ({
  app, page, context,
}) => {
  await page.goto(app.url);
  await waitForOfflineShell(page);
  await newGame(page, 'Easy');
  await expect(syncStatus(page)).toHaveText('Synced');
  const original = app.state().activeGame?.gameId;
  expect(original).toBeTruthy();

  await context.setOffline(true);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(app.url);
  await expect(syncStatus(reopened)).toHaveText('Offline');
  await reopened.getByRole('button', { name: 'Continue Game' }).click();
  await expect(reopened.getByRole('heading', { name: 'Easy puzzle' })).toBeVisible();
  await playDigit(reopened, 4);
  await expect(syncStatus(reopened)).toContainText('1 pending');
  await reopened.getByRole('button', { name: 'Back to Home' }).click();
  await newGame(reopened, 'Medium', true);
  await playDigit(reopened, 7);
  await expect(syncStatus(reopened)).toContainText('3 pending');
  const latest = (await readReplica(reopened)).active!;
  expect(latest.gameId).not.toBe(original);
  await fitsViewport(reopened);
  const portrait = reopened.viewportSize()!;
  await reopened.setViewportSize({ width: portrait.height, height: portrait.width });
  await fitsViewport(reopened);
  await expect(reopened.getByRole('gridcell')).toHaveCount(81);
  await expect(reopened.getByRole('group', { name: 'Number pad' }).getByRole('button')).toHaveCount(9);
  await reopened.setViewportSize(portrait);

  await reopened.reload();
  await expect(syncStatus(reopened)).toContainText('3 pending');
  await reopened.getByRole('button', { name: 'Continue Game' }).click();
  await expect(reopened.locator('[aria-selected="true"]')).toHaveText('7');
  await context.setOffline(false);
  await expect(syncStatus(reopened)).toHaveText('Synced');
  expect(app.state().activeGame?.gameId).toBe(latest.gameId);
  expect(app.state().activeGame?.values).toEqual(latest.values);
  expect(app.state().revision).toBe(4);
});

test('a prepared app can play offline before it has fetched shared game data', async ({ app, page, context }) => {
  app.apiAvailable = false;
  await page.goto(app.url);
  await waitForOfflineShell(page);
  await expect(syncStatus(page)).toHaveText('Sync unavailable');
  await context.setOffline(true);
  await page.close();

  const offline = await context.newPage();
  await offline.goto(app.url);
  await expect(offline.getByText(/Reconnect to Tailscale to look for a shared puzzle/)).toBeVisible();
  await expect(offline.getByRole('button', { name: 'Continue Game' })).toBeDisabled();
  await newGame(offline, 'Easy');
  await expect(syncStatus(offline)).toContainText('1 pending');
  expect((await readReplica(offline)).pending[0]?.historyId).toBeNull();

  app.apiAvailable = true;
  await context.setOffline(false);
  await expect(syncStatus(offline)).toHaveText('Synced');
  expect(app.state().activeGame?.difficulty).toBe('easy');
});

test('waits for the old app to close and preserves its pending edits through a new release', async ({
  app, page, context,
}, testInfo) => {
  const upgrade = testInfo.outputPath('upgrade');
  await build({
    logLevel: 'silent',
    build: { outDir: upgrade },
    plugins: [{
      name: 'sudoku-test-release',
      transform(code, id) {
        return id.replaceAll('\\', '/').endsWith('/src/main.tsx')
          ? code + "\ndocument.documentElement.dataset.testRelease = 'upgraded';" : undefined;
      },
    }],
  });

  await page.goto(app.url);
  await waitForOfflineShell(page);
  await newGame(page, 'Easy');
  await expect(syncStatus(page)).toHaveText('Synced');
  const originalCaches = await shellCaches(page);
  expect(originalCaches).toHaveLength(1);
  await page.evaluate(() => caches.open('test-unrelated-cache'));

  app.apiAvailable = false;
  await playDigit(page, 5);
  await expect(syncStatus(page)).toContainText('1 pending');
  app.directory = upgrade;
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  await expect.poll(() => page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe('installed');
  await expect(page.getByText(/An update is ready/)).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-test-release');
  await playDigit(page, 6);
  await expect(syncStatus(page)).toContainText('2 pending');
  expect(app.state().revision).toBe(1);
  const pending = (await readReplica(page)).pending.map(({ operationId }) => operationId);

  await context.setOffline(true);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(app.url);
  await expect(reopened.locator('html')).toHaveAttribute('data-test-release', 'upgraded');
  await expect(syncStatus(reopened)).toContainText('2 pending');
  expect((await readReplica(reopened)).pending.map(({ operationId }) => operationId)).toEqual(pending);
  await reopened.getByRole('button', { name: 'Continue Game' }).click();
  await expect(reopened.locator('[aria-selected="true"]')).toHaveText('6');
  const updated = await shellCaches(reopened);
  expect(updated).toHaveLength(1);
  expect(updated).not.toEqual(originalCaches);
  expect(await reopened.evaluate(() => caches.keys())).toContain('test-unrelated-cache');

  app.apiAvailable = true;
  await context.setOffline(false);
  await expect(syncStatus(reopened)).toHaveText('Synced');
  expect((await readReplica(reopened)).pending).toHaveLength(0);
  const latest = app.state().activeGame!;
  expect(latest.values[latest.selectedCell!]).toBe(6);
  expect(app.state().revision).toBe(3);
});

test('offers a reconnect page when app files are lost and repairs the cache when online', async ({
  app, page, context,
}) => {
  await page.goto(app.url);
  await waitForOfflineShell(page);
  const name = (await shellCaches(page))[0]!;
  await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const generator = (await cache.keys()).find((request) => request.url.includes('generator.worker-'));
    if (!generator) throw new Error('Missing cached generator.');
    await cache.delete(generator);
  }, name);

  app.filesAvailable = false;
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sudoku is offline' })).toBeVisible();
  app.filesAvailable = true;
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Sudoku', exact: true })).toBeVisible();
  expect(await cachedPaths(page)).toEqual(expect.arrayContaining([
    expect.stringMatching(/^\/assets\/generator\.worker-.*\.js$/),
  ]));
});
