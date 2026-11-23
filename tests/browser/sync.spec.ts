import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.ts';
import { applyMutation, openDatabase, readState } from '../../server/database.ts';
import { SCHEMA_VERSION } from '../../src/contracts/game.ts';
import type { ActiveGame } from '../../src/contracts/game.ts';
import type { Intent, Mutation } from '../../src/contracts/sync.ts';
import { startGame } from '../../src/engine/game.ts';
import { generatePuzzle } from '../../src/engine/generator.ts';
import { PREVIEW_KEY } from '../../src/ui/preview-store.ts';
import { readReplica } from './storage.ts';

const apiPaths = '**/api/v1/**';
const mutationPath = '**/api/v1/mutations';
const test = base.extend<{ app: { url: string; db: DatabaseSync } }>({
  app: async ({ request }, use) => {
    const db = openDatabase(':memory:');
    const server = createApp(db, { directory: resolve('dist') });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const socket = server.address();
      if (!socket || typeof socket === 'string') throw new Error('Missing local test address.');
      const url = `http://127.0.0.1:${socket.port}`;
      expect((await request.get(url + '/healthz')).ok()).toBe(true);
      await use({ url, db });
    } finally {
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      db.close();
    }
  },
});
test.use({ serviceWorkers: 'block' });

function puzzle(seed: number): ActiveGame {
  const generated = generatePuzzle('easy', { seed });
  if (generated.status !== 'generated') throw new Error('Missing test puzzle.');
  const { snapshot } = startGame(generated.puzzle);
  if (snapshot.status !== 'active') throw new Error('Expected active puzzle.');
  return snapshot;
}

function save(db: DatabaseSync, intent: Intent) {
  return applyMutation(db, {
    schemaVersion: SCHEMA_VERSION, operationId: randomUUID(), historyId: readState(db).historyId, ...intent,
  });
}

function openGame(page: Page) {
  return page.getByRole('button', { name: 'Continue Game' }).click();
}

async function place(page: Page, cell: number, digit: number) {
  const row = Math.floor(cell / 9) + 1;
  const column = cell % 9 + 1;
  const target = page.getByRole('gridcell', { name: new RegExp(`^Row ${row}, column ${column}, `) });
  await target.click();
  await page.getByRole('group', { name: 'Number pad' }).getByRole('button', { name: String(digit) }).click();
  await expect(target).toHaveAccessibleName(`Row ${row}, column ${column}, ${digit}`);
}

async function disconnect(context: BrowserContext, page: Page) {
  await context.route(apiPaths, (route) => route.abort());
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Offline');
}

async function reconnect(context: BrowserContext, page: Page) {
  await context.unroute(apiPaths);
  await page.getByRole('button', { name: 'Retry sync' }).click();
  await expect(page.getByRole('status')).toHaveText('Synced');
}

test('offline changes survive reload and a fresh commit wins across two devices', async ({
  app, page, context, browser,
}) => {
  const game = puzzle(21);
  const cell = game.givens.indexOf(null);
  save(app.db, { kind: 'save-game', game });
  await page.goto(app.url);
  await expect(page.getByRole('status')).toHaveText('Synced');
  await disconnect(context, page);
  await openGame(page);
  await place(page, cell, 4);
  await place(page, cell, 5);
  await expect(page.getByRole('status')).toContainText('2 pending');
  await page.reload();
  await expect(page.getByRole('status')).toContainText('2 pending');
  expect((await readReplica(page)).active?.values[cell]).toBe(5);

  const device = await browser.newContext();
  try {
    const other = await device.newPage();
    await other.goto(app.url);
    await openGame(other);
    await place(other, cell, 6);
    await expect.poll(() => readState(app.db).activeGame?.values[cell]).toBe(6);
    await expect(other.getByRole('status')).toHaveText('Synced');
    expect(readState(app.db).activeGame?.values[cell]).toBe(6);
    await reconnect(context, page);
    expect(readState(app.db).activeGame?.values[cell]).toBe(5);
    expect(readState(app.db).revision).toBe(4);
    await other.reload();
    await expect(other.getByRole('status')).toHaveText('Synced');
    expect((await readReplica(other)).active?.values[cell]).toBe(5);
  } finally {
    await device.close();
  }
});

test('a fresh device can undo synced entries and reveal their saved candidate notes', async ({ app, page, browser }) => {
  const game = puzzle(21);
  const cell = game.givens.indexOf(null);
  save(app.db, { kind: 'save-game', game });
  await page.goto(app.url);
  await openGame(page);
  await page.getByRole('button', { name: 'Candidate', exact: true }).click();
  await page.getByRole('gridcell').nth(cell).press('8');
  await page.getByRole('button', { name: 'Normal', exact: true }).click();
  await place(page, cell, 4);
  await place(page, cell, 5);
  await expect(page.getByRole('status')).toHaveText('Synced');
  expect(readState(app.db).activeGame?.undoHistory?.entries).toHaveLength(3);
  expect(readState(app.db).activeGame?.candidateNotes?.[cell]).toBe(0b010000000);

  const device = await browser.newContext();
  try {
    const other = await device.newPage();
    await other.goto(app.url);
    await openGame(other);
    const undo = other.getByRole('button', { name: 'Undo', exact: true });
    await undo.click();
    await expect.poll(() => readState(app.db).activeGame?.values[cell]).toBe(4);
    await undo.click();
    await expect(other.getByRole('gridcell').nth(cell)).toHaveAccessibleName(/empty, candidates 8$/);
    await expect.poll(() => readState(app.db).activeGame?.values[cell]).toBe(null);
    await undo.click();
    await expect(undo).toBeDisabled();
    await expect(other.getByRole('gridcell').nth(cell)).toBeEmpty();
    await expect.poll(() => readState(app.db).activeGame?.candidateNotes).toBeUndefined();
    expect(readState(app.db).activeGame?.undoHistory).toBeUndefined();
  } finally {
    await device.close();
  }
});

test('lost acknowledgement retries the same operation and preserves a later accepted puzzle', async ({
  app, page, context,
}) => {
  const game = puzzle(22);
  const replacement = puzzle(23);
  save(app.db, { kind: 'save-game', game });
  const submitted: Mutation[] = [];
  await context.route(mutationPath, async (route) => {
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      save(app.db, { kind: 'save-game', game: replacement });
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await page.goto(app.url);
  await openGame(page);
  await place(page, game.givens.indexOf(null), 4);
  await expect(page.getByRole('status')).toContainText('Offline · 1 pending');
  await page.getByRole('button', { name: 'Retry sync' }).click();
  await expect(page.getByRole('status')).toHaveText('Synced');
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  expect(readState(app.db).revision).toBe(3);
  expect(readState(app.db).activeGame?.gameId).toBe(replacement.gameId);
  expect((await readReplica(page)).active?.gameId).toBe(replacement.gameId);
});

test('changed server history holds pending gameplay until the user deliberately reapplies it', async ({
  app, page, context,
}) => {
  const game = puzzle(24);
  const cell = game.givens.indexOf(null);
  save(app.db, { kind: 'save-game', game });
  await page.goto(app.url);
  await expect(page.getByRole('status')).toHaveText('Synced');
  await disconnect(context, page);
  await openGame(page);
  await place(page, cell, 7);
  await expect(page.getByRole('status')).toContainText('1 pending');
  const queued = (await readReplica(page)).pending[0]!;
  const historyId = randomUUID();
  app.db.prepare('UPDATE profile SET history_id = ?, revision = 0, active_game = NULL WHERE id = 1').run(historyId);
  await reconnect(context, page);
  await expect(page.getByRole('button', { name: 'Continue Game' })).toBeDisabled();
  expect(readState(app.db).revision).toBe(0);
  await page.getByRole('button', { name: /Review saved changes/ }).click();
  await expect(page.getByRole('heading', { name: 'Saved changes' })).toBeVisible();
  await expect(page.getByText('The server history changed.').first()).toBeVisible();

  let sent: Mutation | undefined;
  await context.route(mutationPath, (route) => {
    sent = route.request().postDataJSON();
    return route.continue();
  });
  await page.getByRole('button', { name: 'Use this puzzle' }).first().click();
  await expect.poll(() => readState(app.db).activeGame?.values[cell]).toBe(7);
  expect(sent?.historyId).toBe(historyId);
  expect(sent?.operationId).not.toBe(queued.operationId);
});

test('imports the legacy active game and completion summary once across reload', async ({ app, page }) => {
  const game = puzzle(25);
  const completion = { gameId: randomUUID(), difficulty: 'expert', elapsedMs: 35_000 };
  await page.addInitScript(({ key, game, completion }) => {
    if (!sessionStorage.getItem('legacy-seeded')) {
      localStorage.setItem(key, JSON.stringify({ version: 1, activeGame: game, completions: [completion] }));
      sessionStorage.setItem('legacy-seeded', 'true');
    }
  }, { key: PREVIEW_KEY, game, completion });
  await page.goto(app.url);
  await expect(page.getByRole('status')).toHaveText('Synced');
  expect(readState(app.db).activeGame?.gameId).toBe(game.gameId);
  expect(readState(app.db).stats.expert.completedCount).toBe(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), PREVIEW_KEY)).toBeNull();
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Synced');
  expect(readState(app.db).revision).toBe(2);
});

test('tabs share the durable queue and converge when one tab reconnects', async ({ app, page, context }) => {
  const game = puzzle(26);
  const [first, second] = game.givens.flatMap((digit, index) => digit === null ? [index] : []);
  save(app.db, { kind: 'save-game', game });
  await page.goto(app.url);
  await expect(page.getByRole('status')).toHaveText('Synced');
  await disconnect(context, page);
  await openGame(page);
  await place(page, first!, 3);
  await expect(page.getByRole('status')).toContainText('1 pending');

  const secondTab = await context.newPage();
  await secondTab.goto(app.url);
  await expect(secondTab.getByRole('status')).toContainText('1 pending');
  await openGame(secondTab);
  await place(secondTab, second!, 8);
  await expect(secondTab.getByRole('status')).toContainText('2 pending');

  await reconnect(context, secondTab);
  await expect.poll(async () => (await readReplica(page)).pending.length).toBe(0);
  expect(readState(app.db).revision).toBe(3);
  expect(readState(app.db).activeGame?.values[first!]).toBe(3);
  expect(readState(app.db).activeGame?.values[second!]).toBe(8);
});

test('the same-origin API protects mutations and avoids caching private state', async ({ app, request }) => {
  const url = app.url + '/api/v1/';
  const state = await request.get(url + 'state');
  expect(state.status()).toBe(200);
  expect(state.headers()['cache-control']).toBe('no-store');
  expect(state.headers()['access-control-allow-origin']).toBeUndefined();
  const cross = await request.post(url + 'mutations', { headers: { Origin: 'https://outside.example' }, data: {} });
  expect(cross.status()).toBe(403);
  expect(await cross.json()).toMatchObject({ code: 'ORIGIN_DENIED' });
  expect((await request.get(url + 'state', { headers: { Host: 'outside.example' } })).status()).toBe(403);
  const malformed = await request.post(url + 'mutations', { headers: { Origin: app.url }, data: {} });
  expect(malformed.status()).toBe(400);
  expect(readState(app.db).revision).toBe(0);
});

test('readiness reports a missing shared profile without returning database details', async ({ app, request }) => {
  app.db.exec('DELETE FROM profile');
  const health = await request.get(app.url + '/healthz');
  expect(health.status()).toBe(503);
  expect(health.headers()['cache-control']).toBe('no-store');
  expect(await health.json()).toEqual({ code: 'UNAVAILABLE', message: 'Sudoku is temporarily unavailable.' });
});
