import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { startGame } from '../../src/engine/game.ts';
import { generatePuzzle } from '../../src/engine/generator.ts';
import { PREVIEW_KEY } from '../../src/ui/preview-store.ts';
import type { PreviewData } from '../../src/ui/preview-store.ts';
import { readReplica } from './storage.ts';

test.use({ serviceWorkers: 'block' });

const fixture = generatePuzzle('easy', { seed: 42 });
if (fixture.status !== 'generated') throw new Error('Failed to generate the preview fixture.');
const gameId = 'd2d6b51c-d540-487c-ad42-350d70327b92';
const snapshot = startGame(fixture.puzzle, gameId).snapshot;
if (snapshot.status !== 'active') throw new Error('Expected an active fixture.');
const firstEmpty = snapshot.givens.indexOf(null);

async function seedStorage(page: Page, activeGame: PreviewData['activeGame'] | 'corrupt') {
  await page.addInitScript(({ key, active }) => {
    if (sessionStorage.getItem('fixture-seeded')) return;
    localStorage.setItem(key, JSON.stringify({ version: 1, activeGame: active, completions: [] }));
    sessionStorage.setItem('fixture-seeded', 'true');
  }, { key: PREVIEW_KEY, active: activeGame });
  await page.goto('/');
}

async function fitsViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
}

async function expectNeutralCells(board: Locator) {
  const blanks = board.locator('[data-given="false"]');
  await expect(blanks.first()).toBeVisible();
  expect(await blanks.evaluateAll((cells) => cells.every((cell) =>
    cell.childNodes.length === 0
    && getComputedStyle(cell).backgroundColor === 'rgb(255, 255, 255)'))).toBe(true);

  const givens = board.locator('[data-given="true"]');
  await expect(givens.first()).toBeVisible();
  expect(await givens.evaluateAll((cells) => cells.every((cell) => {
    const { backgroundColor, color } = getComputedStyle(cell);
    return /^[1-9]$/.test(cell.textContent ?? '')
      && backgroundColor === 'rgb(232, 232, 232)' && color === 'rgb(0, 0, 0)';
  }))).toBe(true);
}

test('starts a puzzle, plays with touch controls and the keyboard, and resumes after reload', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sudoku' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue Game' })).toBeDisabled();
  await expectNeutralCells(page.locator('.preview-board'));
  await fitsViewport(page);

  await page.getByRole('button', { name: 'New Game' }).click();
  const choose = page.getByRole('dialog', { name: 'Choose Difficulty' });
  await expect(choose.getByRole('button', { name: 'Easy' })).toBeFocused();
  await expect(choose.getByRole('button')).toHaveCount(5);
  await choose.getByRole('button', { name: 'Easy' }).click();
  const board = page.getByRole('grid', { name: 'Sudoku board' });
  await expect(board).toBeVisible();
  const keypad = page.getByRole('group', { name: 'Number pad' });
  await expect(keypad.getByRole('button')).toHaveCount(9);
  await expect(keypad.getByRole('button', { name: '6' })).toBeDisabled();
  await expect(board.getByRole('gridcell')).toHaveCount(81);
  await expectNeutralCells(board);
  const rows = board.getByRole('row');
  await expect(rows.nth(0).getByRole('gridcell').nth(1)).toHaveCSS('border-right-width', '1px');
  await expect(rows.nth(0).getByRole('gridcell').nth(2)).toHaveCSS('border-right-width', '2px');
  await expect(rows.nth(2).getByRole('gridcell').first()).toHaveCSS('border-bottom-width', '2px');
  const given = board.getByRole('gridcell', { name: /given$/ }).first();
  await given.click();
  await given.press('6');
  await expect(given).toHaveAttribute('aria-readonly', 'true');
  await expect(keypad.getByRole('button', { name: '6' })).toBeDisabled();

  await context.setOffline(true);
  const empty = board.getByRole('gridcell', { name: /empty$/ }).first();
  const coordinates = (await empty.getAttribute('aria-label'))!.replace(', empty', '');
  const cell = board.getByRole('gridcell', { name: new RegExp(`^${coordinates},`) });
  await cell.click();
  await expect(cell).toHaveAttribute('aria-selected', 'true');
  await keypad.getByRole('button', { name: '6' }).click();
  await expect(cell).toHaveAccessibleName(`${coordinates}, 6`);
  await expect(cell).toHaveText('6');
  await expect(cell).toHaveCSS('color', 'rgb(0, 0, 0)');
  await cell.press('Delete');
  await expect(cell).toHaveAccessibleName(`${coordinates}, empty`);
  await expect(cell).toBeEmpty();
  await expect(cell).toHaveCSS('background-color', 'rgb(255, 232, 163)');
  await cell.press('4');
  await expect(cell).toHaveAccessibleName(`${coordinates}, 4`);

  await fitsViewport(page);
  const cellSize = await cell.boundingBox();
  const keySize = await keypad.getByRole('button', { name: '6' }).boundingBox();
  expect(cellSize!.width).toBeGreaterThanOrEqual(24);
  expect(keySize!.width).toBeGreaterThanOrEqual(24);
  expect(keySize!.height).toBeGreaterThanOrEqual(44);

  await page.getByRole('button', { name: 'Back to Home' }).click();
  await expect(page.getByRole('button', { name: 'Continue Game' })).toBeEnabled();
  await context.setOffline(false);
  await page.reload();
  await page.getByRole('button', { name: 'Continue Game' }).click();
  await expect(cell).toHaveAccessibleName(`${coordinates}, 4`);
  await expect(cell).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  await expect(cell).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(board.locator('[tabindex="0"]')).toBeFocused();
});

test('highlights Sudoku peers and matching givens and entries without making givens editable', async ({ page }) => {
  await seedStorage(page, snapshot);
  await page.getByRole('button', { name: 'Continue Game' }).click();
  const board = page.getByRole('grid', { name: 'Sudoku board' });
  const entry = board.getByRole('gridcell').nth(firstEmpty);
  const given = board.getByRole('gridcell', { name: /, 5, given$/ }).first();
  const five = page.getByRole('group', { name: 'Number pad' }).getByRole('button', { name: '5' });
  const peers = board.locator('[data-highlight="peer"]');
  const matches = board.locator('[data-highlight="match"]');

  await entry.click();
  await expect(peers).toHaveCount(20);
  await expect(peers.first()).toHaveCSS('background-color', 'rgb(255, 244, 204)');
  await expect(matches).toHaveCount(0);
  await expect(entry).toHaveCSS('box-shadow', /rgb\(217, 149, 0\)/);
  await expect(board.locator('[data-given="false"]:not([data-highlight])').first())
    .toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(board.locator('[data-given="true"]:not([data-highlight])').first())
    .toHaveCSS('background-color', 'rgb(232, 232, 232)');
  await five.click();
  await expect(given).toHaveCSS('background-color', 'rgb(255, 217, 128)');
  await expect(given).toHaveCSS('color', 'rgb(0, 0, 0)');

  await given.click();
  await given.click();
  await expect(given).toHaveAttribute('aria-selected', 'true');
  await expect(given).toHaveAttribute('aria-readonly', 'true');
  await expect(given).toHaveCSS('background-color', 'rgb(255, 232, 163)');
  await expect(entry).toHaveCSS('background-color', 'rgb(255, 217, 128)');
  await expect(entry).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(five).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Eraser' })).toBeDisabled();

  await entry.click();
  await entry.press('Delete');
  await expect(matches).toHaveCount(0);
  await expect(five).toBeEnabled();
  await fitsViewport(page);
});

test('cancellation and a failed replacement preserve the saved puzzle, and retry can replace it', async ({
  page, context,
}) => {
  await seedStorage(page, snapshot);
  const newGame = page.getByRole('button', { name: 'New Game' });
  await newGame.click();
  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  const replace = page.getByRole('dialog', { name: 'Start New Puzzle?' });
  await expect(replace.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(newGame).toBeFocused();
  expect((await readReplica(page)).active?.gameId).toBe(gameId);

  const worker = '**/assets/generator.worker-*.js';
  await context.route(worker, (route) => route.abort());
  await newGame.click();
  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  await replace.getByRole('button', { name: 'Start New' }).click();
  const failed = page.getByRole('dialog', { name: 'Couldn’t Generate a Puzzle' });
  await expect(failed).toBeVisible();
  expect((await readReplica(page)).active?.gameId).toBe(gameId);
  await context.unroute(worker);
  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Medium puzzle' })).toBeVisible();
  await expect.poll(async () => (await readReplica(page)).active?.gameId).not.toBe(gameId);
});

test('completes a puzzle once, shows its time, and persists statistics', async ({ page }) => {
  const almostSolved = {
    ...snapshot,
    selectedCell: firstEmpty,
    values: snapshot.solution.map((digit, index) => index === firstEmpty ? null : digit),
    elapsedMs: 5000,
  };
  await seedStorage(page, almostSolved);
  await page.getByRole('button', { name: 'Continue Game' }).click();
  const keypad = page.getByRole('group', { name: 'Number pad' });
  await keypad.getByRole('button', { name: String(snapshot.solution[firstEmpty]) }).click();
  const complete = page.getByRole('dialog', { name: 'Congratulations!' });
  await expect(complete.getByText(/Puzzle solved in 00:0[5-9]/)).toBeVisible();
  await complete.getByRole('button', { name: 'View Puzzle' }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-readonly', 'true');
  await expect(keypad.getByRole('button', { name: '1' })).toBeDisabled();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await expect(page.getByRole('button', { name: 'Continue Game' })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Statistics' }).click();
  await expect(page.getByRole('row', { name: /^Easy / }).getByRole('cell').first()).toHaveText('1');
  expect((await readReplica(page)).pending.filter(({ intent }) => intent.kind === 'complete-game')).toHaveLength(1);
  await fitsViewport(page);
});

test('recovers from an invalid save and provides empty statistics, Settings and Shop', async ({ page }) => {
  await seedStorage(page, 'corrupt');
  await expect(page.getByRole('alert')).toContainText('saved puzzle couldn’t be restored');
  await expect(page.getByRole('button', { name: 'Continue Game' })).toBeDisabled();
  await page.getByRole('button', { name: 'Statistics' }).click();
  await expect(page.getByText('Complete a puzzle to see your times here.')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeFocused();
  await page.getByRole('button', { name: 'Shop' }).click();
  await expect(page.getByText('Coming later')).toBeVisible();
  await page.getByRole('button', { name: 'Sudoku home' }).click();
  await expect(page.getByRole('heading', { name: 'Sudoku' })).toBeVisible();
});

test('shows a session-only save status when browser storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new DOMException('Browser storage blocked', 'SecurityError'); };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New Game' }).click();
  await page.getByRole('button', { name: 'Easy', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Progress stays in this tab');
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await expect(page.getByRole('button', { name: 'Continue Game' })).toBeEnabled();
});

test('checkpoints elapsed time only while the game is open and focused', async ({ page }) => {
  await page.clock.install();
  await seedStorage(page, snapshot);
  await page.getByRole('button', { name: 'Continue Game' }).click();
  await page.clock.runFor(1250);
  await expect.poll(async () => (await readReplica(page)).active!.elapsedMs).toBeGreaterThan(0);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const paused = (await readReplica(page)).active!.elapsedMs;
  await page.clock.runFor(7000);
  expect((await readReplica(page)).active!.elapsedMs).toBe(paused);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(1250);
  await expect.poll(async () => (await readReplica(page)).active!.elapsedMs).toBeGreaterThan(paused);
  await page.getByRole('button', { name: 'Back to Home' }).click();
  const closed = (await readReplica(page)).active!.elapsedMs;
  await page.clock.runFor(7000);
  expect((await readReplica(page)).active!.elapsedMs).toBe(closed);
});
