import assert from 'node:assert/strict';
import test from 'node:test';
import { CELL_COUNT, conflictingCells } from './board.ts';

test('duplicates in a row, column, or box mark both cells', () => {
  for (const [first, second] of [[0, 6], [0, 27], [0, 10]] as const) {
    const values = Array<number | null>(CELL_COUNT).fill(null);
    values[first] = values[second] = 5;
    assert.deepEqual(conflictingCells(values), new Set([first, second]));
  }
});

test('all duplicates are marked across overlapping and separate units', () => {
  const values = Array<number | null>(CELL_COUNT).fill(null);
  values[0] = values[27] = values[54] = values[56] = 7;
  values[13] = values[23] = 1;
  values[80] = 7;
  assert.deepEqual(conflictingCells(values), new Set([0, 27, 54, 56, 13, 23]));

  values[54] = values[27] = null;
  values[13] = 2;
  assert.deepEqual(conflictingCells(values), new Set());
  assert.deepEqual(conflictingCells(Array(CELL_COUNT).fill(null)), new Set());
});
