import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_UNDO_ENTRIES } from '../contracts/board-history.ts';
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
  assert.equal(cleared.completion, null);
  assert.deepEqual(cleared.session.snapshot.values, puzzle.givens);
  assert.equal(cleared.session.snapshot.gameId, session.snapshot.gameId);
  assert.equal(cleared.session.snapshot.selectedCell, session.snapshot.selectedCell);
  assert.equal(cleared.session.snapshot.elapsedMs, session.snapshot.elapsedMs);
  assert.equal(cleared.session.runningSince, session.runningSince);
  assert.equal(session.snapshot.values[firstEmpty], 3);
  assert.equal(session.snapshot.values[otherEmpty], 4);
  assert.equal(updateGame(cleared.session, action, 70).session, cleared.session);
  assert.equal(updateGame(cleared.session, { type: 'checkpoint' }, 80).session.snapshot.elapsedMs, 70);
  const undone = updateGame(cleared.session, { type: 'undo' }, 90);
  assert.deepEqual(undone, { session, completion: null });
});

test('Undo reverses placements, replacement and erase in order, skipping unrelated actions', () => {
  const fresh = startGame(puzzle, gameId);
  let session = fresh;
  const cells = puzzle.givens.flatMap((value, index) => value === null ? [index] : []).slice(0, 3);
  const boards = [fresh.snapshot.values];
  for (const [index, cell] of cells.entries()) {
    session = updateGame(session, { type: 'select', cell }, 0).session;
    session = updateGame(session, { type: 'place', digit: index + 1 }, 0).session;
    boards.push(session.snapshot.values);
  }
  assert.equal(updateGame(session, { type: 'place', digit: 3 }, 0).session, session);
  assert.equal(updateGame(session, { type: 'erase', cell: firstGiven }, 0).session, session);
  session = updateGame(session, { type: 'place', digit: 4 }, 0).session;
  boards.push(session.snapshot.values);
  session = updateGame(session, { type: 'erase' }, 0).session;
  session = updateGame(session, { type: 'select', cell: firstEmpty }, 0).session;
  for (const previous of boards.reverse()) {
    const undone = updateGame(session, { type: 'undo' }, 0);
    assert.equal(undone.completion, null);
    session = undone.session;
    assert.deepEqual(session.snapshot.values, previous);
    assert.deepEqual(session.snapshot.givens, fresh.snapshot.givens);
    assert.equal(session.snapshot.selectedCell, firstEmpty);
  }
  assert.equal(updateGame(session, { type: 'undo' }, 0).session, session);
});

test('candidate toggles, erase, placement and Clear All share the same persisted history', () => {
  const otherEmpty = puzzle.givens.indexOf(null, firstEmpty + 1);
  let session = startGame(puzzle, gameId);
  const original = session.snapshot;
  const apply = (action: Parameters<typeof updateGame>[1]) => {
    session = updateGame(session, action, 0).session;
    return session.snapshot;
  };
  apply({ type: 'select', cell: firstEmpty });
  const added = apply({ type: 'toggle-candidate', digit: 1 });
  const both = apply({ type: 'toggle-candidate', digit: 9 });
  const removed = apply({ type: 'toggle-candidate', digit: 1 });
  assert.ok(both.status === 'active' && removed.status === 'active');
  assert.equal(both.candidateNotes?.[firstEmpty], 0b100000001);
  assert.equal(removed.candidateNotes?.[firstEmpty], 0b100000000);
  const erased = apply({ type: 'erase' });
  assert.deepEqual(apply({ type: 'undo' }), removed);
  const placed = apply({ type: 'place', digit: 7 });
  assert.equal(placed.candidateNotes?.[firstEmpty], removed.candidateNotes?.[firstEmpty]);
  assert.equal(apply({ type: 'toggle-candidate', digit: 3 }), placed);
  const replaced = apply({ type: 'place', digit: 8 });
  assert.equal(replaced.values[firstEmpty], 8);
  assert.equal(replaced.candidateNotes?.[firstEmpty], removed.candidateNotes?.[firstEmpty]);
  const erasedValue = apply({ type: 'erase' });
  assert.equal(erasedValue.values[firstEmpty], null);
  assert.equal(erasedValue.candidateNotes?.[firstEmpty], removed.candidateNotes?.[firstEmpty]);
  assert.deepEqual(apply({ type: 'undo' }), replaced);
  assert.deepEqual(apply({ type: 'undo' }), placed);
  assert.deepEqual(apply({ type: 'undo' }), removed);
  apply({ type: 'place', digit: 7 });
  apply({ type: 'select', cell: otherEmpty });
  const mixed = apply({ type: 'toggle-candidate', digit: 5 });
  const cleared = apply({ type: 'clear-all' });
  assert.ok(cleared.status === 'active');
  assert.equal(cleared.candidateNotes, undefined);
  assert.deepEqual(cleared.values, original.values);

  const restored = restoreGame(JSON.parse(JSON.stringify(cleared)));
  assert.ok(restored);
  session = restored;
  assert.deepEqual(apply({ type: 'undo' }), mixed);
  const states = [placed, removed, both, added, original];
  for (const previous of states) {
    const actual = apply({ type: 'undo' });
    assert.ok(actual.status === 'active' && previous.status === 'active');
    assert.deepEqual(actual.values, previous.values);
    assert.deepEqual(actual.candidateNotes, previous.candidateNotes);
  }
  const emptyHistory = session;
  apply({ type: 'undo' });
  assert.equal(session, emptyHistory);
  assert.ok(erased.status === 'active');
  assert.equal(erased.candidateNotes, undefined);
});

test('legacy progress survives absent, malformed, cross-puzzle and stale undo data', () => {
  const fresh = startGame(puzzle, gameId);
  const selected = updateGame(fresh, { type: 'select', cell: firstEmpty }, 0).session;
  const { snapshot } = updateGame(selected, { type: 'place', digit: 1 }, 0).session;
  assert.ok(snapshot.status === 'active' && snapshot.undoHistory);
  const { undoHistory, ...legacy } = snapshot;
  const unrelated = puzzle.givens.indexOf(null, firstEmpty + 1);
  const staleValues = snapshot.values.map((value, index) => index === unrelated ? 3 : value);
  const cases = [
    [legacy, legacy],
    [{ ...legacy, undoHistory: { entries: 1 } }, legacy],
    [{ ...legacy, undoHistory: { ...undoHistory, gameId: crypto.randomUUID() } }, legacy],
    [{ ...snapshot, values: staleValues }, { ...legacy, values: staleValues }],
    [{ ...snapshot, undoHistory: { ...undoHistory, entries: [[{ index: firstGiven, before: [null, 0],
      after: [snapshot.values[firstGiven], 0] }]] } }, legacy],
  ];
  for (const [input, expected] of cases) {
    const restored = restoreGame(input);
    assert.ok(restored);
    assert.deepEqual(restored.snapshot, expected);
    assert.equal(updateGame(restored, { type: 'undo' }, 0).session, restored);
  }
});

test('Undo retains the latest 100 edits after saving and restoring', () => {
  let session = startGame(puzzle, gameId);
  session = updateGame(session, { type: 'select', cell: firstEmpty }, 0).session;
  for (let index = 0; index <= MAX_UNDO_ENTRIES; index += 1) {
    session = updateGame(session, { type: 'place', digit: index % 2 + 1 }, 0).session;
  }
  const restored = restoreGame(JSON.parse(JSON.stringify(session.snapshot)));
  assert.ok(restored);
  session = restored;
  for (let index = 0; index < MAX_UNDO_ENTRIES; index += 1) {
    session = updateGame(session, { type: 'undo' }, 0).session;
    assert.equal(session.snapshot.values[firstEmpty], index % 2 === 0 ? 2 : 1);
  }
  assert.equal(updateGame(session, { type: 'undo' }, 0).session, session);
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
  const note = updateGame(running, { type: 'toggle-candidate', digit: finalDigit }, 75);
  assert.equal(note.session.snapshot.status, 'active');
  assert.equal(note.session.snapshot.values[firstEmpty], null);
  assert.equal(note.completion, null);
  const wrong = updateGame(note.session, { type: 'place', digit: finalDigit % 9 + 1 }, 100);
  assert.equal(wrong.session.snapshot.status, 'active');
  assert.equal(wrong.completion, null);

  const solved = updateGame(wrong.session, { type: 'place', digit: finalDigit }, 350);
  assert.equal(solved.session.snapshot.status, 'solved');
  assert.equal(solved.session.snapshot.candidateNotes?.[firstEmpty], note.session.snapshot.candidateNotes?.[firstEmpty]);
  assert.equal(solved.session.runningSince, null);
  assert.deepEqual(completionSchema.parse(solved.completion), { gameId, difficulty: 'easy', elapsedMs: 2300 });
  assert.deepEqual(updateGame(solved.session, { type: 'erase' }, 500), { session: solved.session, completion: null });

  const restored = restoreGame(JSON.parse(JSON.stringify(solved.session.snapshot)));
  assert.ok(restored);
  assert.deepEqual(updateGame(restored, { type: 'checkpoint' }, 500), { session: restored, completion: null });
});
