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
  await expect(page.getByRole('button', { name: 'Eraser' })).toHaveAttribute('aria-pressed', 'false');

  await entry.click();
  await entry.press('Delete');
  await expect(matches).toHaveCount(0);
  await expect(five).toBeEnabled();
  await fitsViewport(page);
});

test('Eraser stays active across cells, blocks number entry, and saves cleared values', async ({ page }) => {
  const second = snapshot.givens.indexOf(null, firstEmpty + 1);
  const blank = snapshot.givens.indexOf(null, second + 1);
  const values = snapshot.values.slice();
  values[firstEmpty] = 6;
  values[second] = 7;
  await seedStorage(page, { ...snapshot, values });
  const resume = page.getByRole('button', { name: 'Continue Game' });
  await resume.click();
  const board = page.getByRole('grid');
  const cells = board.getByRole('gridcell');
  const firstEntry = cells.nth(firstEmpty);
  const secondEntry = cells.nth(second);
  const empty = cells.nth(blank);
  const given = board.getByRole('gridcell', { name: /given$/ }).first();
  const givenDigit = await given.textContent();
  const toggle = page.getByRole('button', { name: 'Eraser' });
  const keypad = page.getByRole('group', { name: 'Number pad' });
  const four = keypad.getByRole('button', { name: '4' });

  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const initialBackground = await toggle.evaluate((button) => getComputedStyle(button).backgroundColor);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).not.toHaveCSS('background-color', initialBackground);
  await expect(four).toBeDisabled();

  await given.click();
  await expect(given).toHaveText(givenDigit!);
  await empty.click();
  await expect(empty).toBeEmpty();
  await expect(board.locator('[aria-selected="true"]')).toHaveCount(0);
  await firstEntry.press('4');
  await expect(firstEntry).toHaveText('6');
  await firstEntry.press('ArrowRight');
  await expect(firstEntry).toHaveText('6');
  await expect(secondEntry).toHaveText('7');

  await firstEntry.click();
  await expect(firstEntry).toBeEmpty();
  await secondEntry.click();
  await expect(secondEntry).toBeEmpty();
  await expect(secondEntry).toHaveAttribute('data-highlight', 'selected');
  await expect(board.locator('[data-highlight="peer"]')).toHaveCount(20);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await readReplica(page)).active?.values).toEqual(snapshot.values);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await firstEntry.click();
  await four.click();
  await secondEntry.click();
  await firstEntry.click();
  await expect(firstEntry).toHaveText('4');
  await expect.poll(async () => (await readReplica(page)).active?.values[firstEmpty]).toBe(4);
  await page.reload();
  await resume.click();
  await expect(firstEntry).toHaveText('4');
  await expect(secondEntry).toBeEmpty();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await fitsViewport(page);
});

test('Clear All confirms, preserves Eraser mode, and saves the same puzzle with only its clues', async ({ page }) => {
  const second = snapshot.givens.indexOf(null, firstEmpty + 1);
  const values = snapshot.values.slice();
  values[firstEmpty] = 6;
  values[second] = 7;
  await seedStorage(page, { ...snapshot, values });
  const resume = page.getByRole('button', { name: 'Continue Game' });
  await resume.click();
  const board = page.getByRole('grid');
  const entries = board.getByRole('gridcell');
  const eraser = page.getByRole('button', { name: 'Eraser' });
  const clear = page.getByRole('main').getByRole('button', { name: 'Clear All', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Clear All Entries?' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const confirm = dialog.getByRole('button', { name: 'Clear All' });

  await eraser.click();
  await clear.click();
  await expect(dialog).toHaveAccessibleDescription('This erases all numbers and candidate notes you entered. The original clues will stay.');
  await expect(cancel).toBeFocused();
  expect((await readReplica(page)).active?.values).toEqual(values);
  await page.keyboard.press('Escape');
  await expect(clear).toBeFocused();
  await expect(entries.nth(firstEmpty)).toHaveText('6');
  await expect(entries.nth(second)).toHaveText('7');

  await clear.press('Enter');
  await cancel.click();
  await expect(clear).toBeFocused();
  expect((await readReplica(page)).active?.values).toEqual(values);

  await clear.press('Enter');
  await confirm.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(clear).toBeFocused();
  await expect(eraser).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Easy puzzle' })).toBeVisible();
  const clues = snapshot.givens.map((value) => value === null ? '' : String(value));
  await expect(entries).toHaveText(clues);
  await expect.poll(async () => (await readReplica(page)).active).toMatchObject({
    gameId, difficulty: snapshot.difficulty, givens: snapshot.givens, values: snapshot.givens,
  });

  await clear.click();
  await confirm.click();
  await expect(clear).toBeFocused();
  await expect(entries).toHaveText(clues);
  await fitsViewport(page);
  await page.reload();
  await resume.click();
  await expect(entries).toHaveText(clues);
  expect((await readReplica(page)).active?.gameId).toBe(gameId);
});

test('Undo reverses edits and Clear All after reload and starts empty for a new puzzle', async ({ page }) => {
  await seedStorage(page, snapshot);
  const continueGame = page.getByRole('button', { name: 'Continue Game' });
  await continueGame.click();
  const grid = page.getByRole('grid', { name: 'Sudoku board' });
  const editable = grid.locator('[data-given="false"]');
  const [first, second, third] = [editable.nth(0), editable.nth(1), editable.nth(2)];
  const given = grid.locator('[data-given="true"]').first();
  const givenValue = await given.innerText();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const eraser = page.getByRole('button', { name: 'Eraser' });
  const clear = page.getByRole('main').getByRole('button', { name: 'Clear All', exact: true });
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Clear All' });

  await expect(undo).toBeDisabled();
  await undo.evaluate((button: HTMLButtonElement) => button.click());
  await expect(first).toBeEmpty();
  await given.click();
  await first.click();
  await eraser.click();
  await first.click();
  await eraser.click();
  await clear.click();
  await confirm.click();
  await expect(undo).toBeDisabled();

  for (const [index, cell] of [first, second, third].entries()) {
    await cell.click();
    await cell.press(String(index + 1));
  }
  await third.press('3');
  await third.press('4');
  await undo.click();
  await expect(third).toHaveText('3');
  await eraser.click();
  await third.click();
  await expect(third).toBeEmpty();
  await undo.click();
  await expect(third).toHaveText('3');
  await expect(eraser).toHaveAttribute('aria-pressed', 'true');

  await clear.click();
  await confirm.click();
  for (const cell of [first, second, third]) await expect(cell).toBeEmpty();
  await expect.poll(async () => (await readReplica(page)).active?.values).toEqual(snapshot.givens);
  await page.reload();
  await continueGame.click();
  await undo.click();
  await expect(first).toHaveText('1');
  await expect(second).toHaveText('2');
  await expect(third).toHaveText('3');
  await expect(given).toHaveText(givenValue);
  for (const cell of [third, second, first]) {
    await undo.click();
    await expect(cell).toBeEmpty();
  }
  await expect(undo).toBeDisabled();
  await expect.poll(async () => (await readReplica(page)).active?.values).toEqual(snapshot.givens);
  await fitsViewport(page);

  await first.click();
  await first.press('9');
  await expect(undo).toBeEnabled();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'New Game' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Easy' }).click();
  await page.getByRole('button', { name: 'Start New' }).click();
  await expect(grid).toBeVisible();
  await expect(undo).toBeDisabled();
  await expect.poll(async () => {
    const active = (await readReplica(page)).active;
    return active !== null && active.gameId !== gameId;
  }).toBe(true);
});

test('candidate mode positions and saves notes, hides them under values, and supports Undo', async ({ page }) => {
  await seedStorage(page, snapshot);
  const continueGame = page.getByRole('button', { name: 'Continue Game' });
  await continueGame.click();
  const board = page.getByRole('grid', { name: 'Sudoku board' });
  const cells = board.getByRole('gridcell');
  const cell = cells.nth(firstEmpty);
  const peerIndex = snapshot.givens.findIndex((value, index) => value === null && index !== firstEmpty
    && Math.floor(index / 9) === Math.floor(firstEmpty / 9));
  const peer = cells.nth(peerIndex);
  const given = board.locator('[data-given="true"]').first();
  const mode = page.getByRole('group', { name: 'Input mode' });
  const normal = mode.getByRole('button', { name: 'Normal' });
  const candidate = mode.getByRole('button', { name: 'Candidate' });
  const keypad = page.getByRole('group', { name: 'Number pad' });
  const key = (digit: number) => keypad.getByRole('button', { name: String(digit), exact: true });
  const undo = page.getByRole('button', { name: 'Undo' });
  const marks = cell.locator('.candidate-marks');
  const normalFontSize = await key(1).evaluate((button) => parseFloat(getComputedStyle(button).fontSize));
  const cellFontSize = await cell.evaluate((target) => parseFloat(getComputedStyle(target).fontSize));
  const cellSize = await cell.boundingBox();

  await expect(normal).toHaveAttribute('aria-pressed', 'true');
  await candidate.click();
  await expect(normal).toHaveAttribute('aria-pressed', 'false');
  await expect(candidate).toHaveAttribute('aria-pressed', 'true');
  const [modeBounds, keypadBounds] = await Promise.all([mode.boundingBox(), keypad.boundingBox()]);
  expect(modeBounds!.y + modeBounds!.height).toBeLessThan(keypadBounds!.y);
  expect(await key(1).evaluate((button) => parseFloat(getComputedStyle(button).fontSize))).toBeLessThan(normalFontSize);
  expect((await key(1).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await given.click();
  await expect(key(1)).toBeDisabled();
  await given.press('1');
  await expect(given.locator('.candidate-marks')).toHaveCount(0);
  await expect(undo).toBeDisabled();

  await cell.click();
  await key(1).click();
  await key(3).click();
  await cell.press('8');
  await expect(cell).toHaveAccessibleName(/empty, candidates 1, 3, 8$/);
  await expect(cell).toHaveAttribute('data-highlight', 'selected');
  await expect(peer).toHaveAttribute('data-highlight', 'peer');
  await expect(board.locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(marks).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(marks).toHaveCSS('border-top-width', '0px');
  expect(await marks.evaluate((target) => parseFloat(getComputedStyle(target).fontSize))).toBeLessThan(cellFontSize * 0.65);
  const slots = marks.locator('span');
  await expect(slots).toHaveText(['1', '', '3', '', '', '', '', '8', '']);
  const [topLeft, topRight, bottomMiddle] = await Promise.all([0, 2, 7].map((index) => slots.nth(index).boundingBox()));
  expect(topLeft!.x).toBeLessThan(bottomMiddle!.x);
  expect(bottomMiddle!.x).toBeLessThan(topRight!.x);
  expect(topLeft!.y).toBeCloseTo(topRight!.y, 0);
  expect(bottomMiddle!.y).toBeGreaterThan(topLeft!.y);
  expect(await cell.boundingBox()).toMatchObject({ width: cellSize!.width, height: cellSize!.height });
  expect((await readReplica(page)).active?.values[firstEmpty]).toBe(null);

  await expect(key(3)).toHaveAttribute('aria-pressed', 'true');
  await key(3).click();
  await expect(cell).toHaveAccessibleName(/empty, candidates 1, 8$/);
  await expect(key(3)).toHaveAttribute('aria-pressed', 'false');
  await undo.click();
  await expect(cell).toHaveAccessibleName(/empty, candidates 1, 3, 8$/);

  await normal.click();
  await expect(cell).toHaveAccessibleName(/empty, candidates 1, 3, 8$/);
  await peer.click();
  await key(1).click();
  await expect(peer).toHaveText('1');
  await expect(cell).toHaveAccessibleName(/empty, candidates 1, 3, 8$/);
  await expect(cell).not.toHaveAttribute('aria-invalid', 'true');
  await expect(cell).not.toHaveAttribute('data-highlight', 'match');
  await cell.click();
  await key(5).click();
  await expect(cell).toHaveText('5');
  await expect(marks).toHaveCount(0);
  await candidate.click();
  await expect(key(3)).toBeDisabled();
  await cell.press('3');
  await expect(cell).toHaveText('5');
  await expect.poll(async () => {
    const game = (await readReplica(page)).active;
    return [game?.values[firstEmpty], game?.candidateNotes?.[firstEmpty]];
  }).toEqual([5, 0b010000101]);

  await page.reload();
  await continueGame.click();
  await expect(candidate).toHaveAttribute('aria-pressed', 'true');
  await expect(cell).toHaveText('5');
  await expect(peer).toHaveText('1');
  await expect(key(3)).toBeDisabled();
  const eraser = page.getByRole('button', { name: 'Eraser' });
  await eraser.click();
  await cell.click();
  await expect(cell).toHaveAccessibleName(/empty, candidates 1, 3, 8$/);
  await eraser.click();
  await expect(candidate).toHaveAttribute('aria-pressed', 'true');
  await expect(key(3)).toHaveAttribute('aria-pressed', 'true');
  await cell.press('Delete');
  await expect(cell).toBeEmpty();
  await undo.click();
  await expect(cell).toHaveAccessibleName(/empty, candidates 1, 3, 8$/);
  await fitsViewport(page);
});

test('duplicate dots follow entry, replacement, restored progress, erasure, and Clear All', async ({ page }) => {
  await seedStorage(page, snapshot);
  const resume = page.getByRole('button', { name: 'Continue Game' });
  await resume.click();
  const board = page.getByRole('grid');
  const entry = board.getByRole('gridcell', { name: /^Row 1, column 2,/ });
  const conflicts = board.locator('[aria-invalid="true"]');
  const keypad = page.getByRole('group', { name: 'Number pad' });
  const five = keypad.getByRole('button', { name: '5' });

  await entry.click();
  await five.click();
  await expect(conflicts).toHaveCount(4);
  await expect(conflicts.and(board.locator('[data-given="true"]'))).toHaveCount(3);
  await expect(entry).toHaveAccessibleDescription('Duplicate number in its row, column, or box.');
  await expect(entry).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(entry).toHaveAttribute('data-highlight', 'selected');
  await expect(conflicts.and(board.locator('[data-highlight="match"]'))).toHaveCount(3);
  expect(await conflicts.evaluateAll((cells) => cells.every((cell) => {
    const dot = getComputedStyle(cell, '::after');
    return dot.backgroundColor === 'rgb(180, 35, 24)' && dot.width === '5px';
  }))).toBe(true);

  // This fixture's solution has a different digit here, but 3 does not duplicate a peer.
  expect(snapshot.solution[1]).not.toBe(3);
  await keypad.getByRole('button', { name: '3' }).click();
  await expect(entry).toHaveText('3');
  await expect(conflicts).toHaveCount(0);

  await five.click();
  await expect.poll(async () => (await readReplica(page)).active?.values[1]).toBe(5);
  await page.reload();
  await resume.click();
  await expect(conflicts).toHaveCount(4);
  await entry.press('Delete');
  await expect(entry).toBeEmpty();
  await expect(conflicts).toHaveCount(0);

  await five.click();
  await expect(conflicts).toHaveCount(4);
  await page.getByRole('button', { name: 'Clear All' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear All' }).click();
  await expect(conflicts).toHaveCount(0);
  await expect(entry).toBeEmpty();
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
