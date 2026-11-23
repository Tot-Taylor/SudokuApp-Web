import assert from 'node:assert/strict';
import test from 'node:test';
import { completionSchema } from '../contracts/game.ts';
import { restoreGame, startGame, updateGame } from './game.ts';
import { generatePuzzle } from './generator.ts';

const gameId = 'd2d6b51c-d540-487c-ad42-350d70327b92';
const generated = generatePuzzle('easy', { seed: 42 });
assert.equal(generated.status, 'generated');
const { puzzle } = generated;
const firstEmpty = puzzle.givens.indexOf(null);
const firstGiven = puzzle.givens.findIndex((value) => value !== null);

test('new game, selection, placement and erase preserve givens and previous sessions', () => {
  const fresh = startGame(puzzle, gameId);
  assert.equal(fresh.snapshot.gameId, gameId);
  assert.equal(fresh.snapshot.elapsedMs, 0);
  assert.deepEqual(fresh.snapshot.givens, fresh.snapshot.values);
  assert.equal(updateGame(fresh, { type: 'place', digit: 3 }, 0).session, fresh);
  assert.equal(updateGame(fresh, { type: 'select', cell: firstGiven }, 0).session, fresh);
  assert.equal(updateGame(fresh, { type: 'select', cell: 81 }, 0).session, fresh);

  const selected = updateGame(fresh, { type: 'select', cell: firstEmpty }, 0).session;
  assert.equal(updateGame(selected, { type: 'place', digit: 0 }, 0).session, selected);
  assert.equal(updateGame(selected, { type: 'place', digit: 3.5 }, 0).session, selected);
  const played = updateGame(selected, { type: 'place', digit: 3 }, 0).session;
  assert.equal(played.snapshot.values[firstEmpty], 3);
  assert.equal(played.snapshot.givens[firstEmpty], null);
  assert.equal(selected.snapshot.values[firstEmpty], null);
  assert.equal(updateGame(played, { type: 'erase' }, 0).session.snapshot.values[firstEmpty], null);
  assert.equal(played.snapshot.values[firstEmpty], 3);
});

test('erasing a specific cell clears and selects it in one update, while invalid targets are no-ops', () => {
  const fresh = startGame(puzzle, gameId);
  const otherEmpty = puzzle.givens.indexOf(null, firstEmpty + 1);
  const selected = updateGame(fresh, { type: 'select', cell: firstEmpty }, 0).session;
  const played = updateGame(selected, { type: 'place', digit: 3 }, 0).session;
  const moved = updateGame(played, { type: 'select', cell: otherEmpty }, 0).session;
  const clockRunning = updateGame(moved, { type: 'foreground', active: true }, 0).session;
  for (const cell of [firstGiven, otherEmpty, 81]) {
    assert.equal(updateGame(clockRunning, { type: 'erase', cell }, 100).session, clockRunning);
  }

  const erased = updateGame(clockRunning, { type: 'erase', cell: firstEmpty }, 100).session;
  assert.equal(erased.snapshot.values[firstEmpty], null);
  assert.equal(erased.snapshot.selectedCell, firstEmpty);
  assert.equal(erased.snapshot.elapsedMs, 100);
  assert.equal(clockRunning.snapshot.values[firstEmpty], 3);
});

test('Clear All restores clues in one update and preserves the game and clock', () => {
  const fresh = startGame(puzzle, gameId);
  const otherEmpty = puzzle.givens.indexOf(null, firstEmpty + 1);
  let session = updateGame(fresh, { type: 'foreground', active: true }, 10).session;
  session = updateGame(session, { type: 'select', cell: firstEmpty }, 20).session;
  session = updateGame(session, { type: 'place', digit: 3 }, 30).session;
  session = updateGame(session, { type: 'select', cell: otherEmpty }, 40).session;
  session = updateGame(session, { type: 'place', digit: 4 }, 50).session;

  const action = { type: 'clear-all' } as const;
  const cleared = updateGame(session, action, 60);
  assert.deepEqual(cleared, {
    session: { ...session, snapshot: { ...session.snapshot, values: puzzle.givens } },
    completion: null,
  });
  assert.equal(session.snapshot.values[firstEmpty], 3);
  assert.equal(session.snapshot.values[otherEmpty], 4);
  assert.equal(updateGame(cleared.session, action, 70).session, cleared.session);
  assert.equal(updateGame(cleared.session, { type: 'checkpoint' }, 80).session.snapshot.elapsedMs, 70);
});

test('clock excludes hidden time and restores selection, board and elapsed time on a fresh clock', () => {
  let session = startGame(puzzle, gameId);
  session = updateGame(session, { type: 'foreground', active: true }, 100.5).session;
  session = updateGame(session, { type: 'select', cell: firstEmpty }, 400.8).session;
  session = updateGame(session, { type: 'place', digit: 7 }, 700.9).session;
  session = updateGame(session, { type: 'foreground', active: true }, 750).session;
  session = updateGame(session, { type: 'foreground', active: false }, 1100.5).session;
  assert.equal(session.snapshot.elapsedMs, 1000);
  assert.equal(updateGame(session, { type: 'checkpoint' }, 100_000).session, session);

  const restored = restoreGame(JSON.parse(JSON.stringify(session.snapshot)));
  assert.ok(restored);
  assert.deepEqual(restored.snapshot, session.snapshot);
  assert.equal(restored.runningSince, null);
  const reopened = updateGame(restored, { type: 'foreground', active: true }, 1).session;
  assert.equal(updateGame(reopened, { type: 'checkpoint' }, 501).session.snapshot.elapsedMs, 1500);
});

test('restore rejects corrupt snapshots and a puzzle claimed at the wrong difficulty', () => {
  const { snapshot } = startGame(puzzle, gameId);
  assert.equal(restoreGame({ ...snapshot, difficulty: 'expert' }), null);
  assert.equal(restoreGame({ ...snapshot, elapsedMs: NaN }), null);
  assert.equal(restoreGame({ ...snapshot, gameId: 'invalid' }), null);
  const invalidGrid = Array<number>(81).fill(1);
  assert.equal(restoreGame({
    ...snapshot,
    solution: invalidGrid,
    givens: snapshot.givens.map((given) => given === null ? null : 1),
    values: snapshot.givens.map((given) => given === null ? null : 1),
  }), null);
});

test('the last correct placement freezes the board and emits only one completion', () => {
  const { snapshot } = startGame(puzzle, gameId);
  const finalDigit = snapshot.solution[firstEmpty]!;
  const almost = restoreGame({
    ...snapshot,
    selectedCell: firstEmpty,
    values: snapshot.solution.map((digit, index) => index === firstEmpty ? null : digit),
    elapsedMs: 2000,
  });
  assert.ok(almost);
  const running = updateGame(almost, { type: 'foreground', active: true }, 50).session;
  const wrong = updateGame(running, { type: 'place', digit: finalDigit % 9 + 1 }, 100);
  assert.equal(wrong.session.snapshot.status, 'active');
  assert.equal(wrong.completion, null);

  const solved = updateGame(wrong.session, { type: 'place', digit: finalDigit }, 350);
  assert.equal(solved.session.snapshot.status, 'solved');
  assert.equal(solved.session.runningSince, null);
  assert.deepEqual(completionSchema.parse(solved.completion), { gameId, difficulty: 'easy', elapsedMs: 2300 });
  assert.deepEqual(updateGame(solved.session, { type: 'erase' }, 500), { session: solved.session, completion: null });

  const restored = restoreGame(JSON.parse(JSON.stringify(solved.session.snapshot)));
  assert.ok(restored);
  assert.deepEqual(updateGame(restored, { type: 'checkpoint' }, 500), { session: restored, completion: null });
});
