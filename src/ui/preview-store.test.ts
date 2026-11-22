import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePuzzle } from '../engine/generator.ts';
import { startGame } from '../engine/game.ts';
import { loadPreview } from './preview-store.ts';
import type { PreviewData } from './preview-store.ts';

const gameId = 'd2d6b51c-d540-487c-ad42-350d70327b92';
const generated = generatePuzzle('easy', { seed: 42 });
assert.equal(generated.status, 'generated');
const { snapshot } = startGame(generated.puzzle, gameId);
assert.equal(snapshot.status, 'active');

function memoryStorage(initial: string | null = null) {
  return () => ({ getItem: () => initial });
}

test('preview storage round-trips the selected cell, digit, and elapsed time', () => {
  const cell = snapshot.givens.indexOf(null);
  const values = snapshot.values.slice();
  values[cell] = 4;
  const data: PreviewData = {
    activeGame: { ...snapshot, selectedCell: cell, values, elapsedMs: 3210 },
    completions: [],
  };
  const storage = memoryStorage(JSON.stringify({ version: 1, ...data }));
  assert.deepEqual(loadPreview(storage), { data, issue: null });
});

test('an invalid active game leaves valid statistics available', () => {
  const completion = { gameId, difficulty: 'easy', elapsedMs: 9000 };
  const storage = memoryStorage(JSON.stringify({
    version: 1, activeGame: { ...snapshot, difficulty: 'broken' }, completions: [completion],
  }));
  assert.deepEqual(loadPreview(storage), {
    data: { activeGame: null, completions: [completion] }, issue: 'invalid-save',
  });
});

test('legacy completion migration retains the first record per UUID', () => {
  const first = { gameId, difficulty: 'easy', elapsedMs: 12000 } as const;
  const storage = memoryStorage(JSON.stringify({
    version: 1, activeGame: null, completions: [first, { ...first, elapsedMs: 1000 }],
  }));
  assert.deepEqual(loadPreview(storage), { data: { activeGame: null, completions: [first] }, issue: null });
});
