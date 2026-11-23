import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL_COUNT } from '../engine/board.ts';
import { cellHighlight } from './cell-highlight.ts';

const empty = Array<number | null>(CELL_COUNT).fill(null);

test('an empty selection highlights exactly its row, column, and box', () => {
  const cases = [
    { selected: 0, boxOnly: [10, 11, 19, 20] },
    { selected: 40, boxOnly: [30, 32, 48, 50] },
    { selected: 4, boxOnly: [12, 14, 21, 23] },
    { selected: 10, boxOnly: [0, 2, 18, 20] },
  ];

  for (const { selected, boxOnly } of cases) {
    const rowStart = selected - selected % 9;
    const expectedPeers = empty.flatMap((_, index) =>
      index !== selected && (index >= rowStart && index < rowStart + 9
        || index % 9 === selected % 9 || boxOnly.includes(index)) ? [index] : [],
    );
    const highlights = empty.map((_, index) => cellHighlight(empty, selected, index));
    assert.equal(highlights[selected], 'selected');
    assert.deepEqual(highlights.flatMap((highlight, index) => highlight === 'peer' ? [index] : []), expectedPeers);
    assert.equal(expectedPeers.length, 20);
    assert.ok(!highlights.includes('match'));
  }
});

test('matching digits take precedence over peers and can appear anywhere on the board', () => {
  const values = empty.slice();
  values[0] = 5;
  values[1] = 6;
  assert.equal(cellHighlight(values, null, 0), undefined);
  assert.ok(!values.some((_, index) => cellHighlight(values, 0, index) === 'match'));

  values[10] = 5;
  values[80] = 5;
  assert.equal(cellHighlight(values, 0, 0), 'selected');
  assert.equal(cellHighlight(values, 0, 1), 'peer');
  assert.equal(cellHighlight(values, 0, 10), 'match');
  assert.equal(cellHighlight(values, 0, 80), 'match');
  assert.equal(cellHighlight(values, 0, 79), undefined);
});
