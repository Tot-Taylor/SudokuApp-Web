import assert from 'node:assert/strict';
import test from 'node:test';
import native from '../../tests/fixtures/native-parity.json' with { type: 'json' };
import { DIFFICULTIES, DIFFICULTY_RULES } from '../contracts/game.ts';
import { canPlace } from './board.ts';
import { classifyPuzzle, generatePuzzle, isValidPuzzle } from './generator.ts';
import { searchPuzzle, solvesWithSingles } from './solver.ts';

const blank = Array<number | null>(81).fill(null);
const classic = Array.from(
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079',
  (digit) => Number(digit) || null,
);
const classicSolution = Array.from(
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179',
  Number,
);

test('solver placement follows the native row fixture and checks columns and boxes', () => {
  for (const { givens, placement, expectedValid } of native.solverCases) {
    const board = blank.slice();
    for (const { row, column, value } of givens) board[row * 9 + column] = value;
    const { row, column, value } = placement;
    assert.equal(canPlace(board, row * 9 + column, value), expectedValid);
  }

  assert.equal(canPlace(classic, 2, 8), false);
  assert.equal(canPlace(classic, 54, 5), false);
  assert.equal(canPlace(classic, 2, 4), true);
  assert.equal(canPlace(classic, 0, 5), true);
  assert.equal(canPlace(classic.slice(0, 80), 80, 5), false);
  assert.equal(canPlace(classic, 80, 11), false);
});

test('solver finds the expected unique solution without changing the input', () => {
  const before = classic.slice();
  assert.deepEqual(searchPuzzle(classic), {
    status: 'finished', count: 1, firstSolution: classicSolution,
  });
  assert.equal(solvesWithSingles(classic), true);
  assert.deepEqual(classic, before);
});

test('solver separates impossible, malformed, multiple and unfinished searches', () => {
  const impossible = blank.slice();
  impossible.splice(0, 8, 1, 2, 3, 4, 5, 6, 7, 8);
  impossible[17] = 9;
  const duplicate = classicSolution.slice();
  duplicate[0] = duplicate[1]!;

  for (const board of [impossible, duplicate, classic.slice(1)]) {
    assert.deepEqual(searchPuzzle(board), { status: 'finished', count: 0, firstSolution: null });
    assert.equal(classifyPuzzle(board), null);
  }
  const multiple = searchPuzzle(blank);
  assert.equal(multiple.status, 'finished');
  assert.equal(multiple.count, 2);
  assert.equal(classifyPuzzle(blank), null);
  assert.deepEqual(searchPuzzle(classic, 2, { remaining: 1 }), { status: 'budget-exhausted' });
});

test('generated solutions, clue bands and complexity agree for 32 seeds per difficulty', () => {
  for (const difficulty of DIFFICULTIES) {
    const { minClues, maxClues, complexity } = DIFFICULTY_RULES[difficulty];
    for (let seed = 0; seed < 32; seed += 1) {
      const generated = generatePuzzle(difficulty, { seed });
      assert.equal(generated.status, 'generated', `${difficulty} seed ${seed}`);
      const { givens, solution } = generated.puzzle;
      const clues = givens.filter((value) => value !== null);
      assert.ok(clues.length >= minClues && clues.length <= maxClues);
      assert.ok(givens.every((value, index) => value === null || value === solution[index]));
      assert.deepEqual(searchPuzzle(givens), { status: 'finished', count: 1, firstSolution: solution });
      assert.equal(solvesWithSingles(givens), complexity === 'singles');
      assert.equal(classifyPuzzle(givens), difficulty);
    }
  }
});

test('generation passes the native easy uniqueness and medium seed-42 repeat fixtures', () => {
  const [unique, repeat] = native.generatorCases;
  assert.ok(unique && repeat);
  const easy = generatePuzzle('easy', { seed: 2026 });
  assert.equal(easy.status, 'generated');
  const solved = searchPuzzle(easy.puzzle.givens);
  assert.equal(solved.status, 'finished');
  assert.equal(solved.count, unique.expectedSolutionCount);

  const options = { seed: repeat.seed, maxAttempts: repeat.maxAttempts };
  const medium = generatePuzzle('medium', options);
  assert.equal(medium.status, 'generated');
  assert.equal(repeat.expectSameBoardOnRepeat, true);
  assert.deepEqual(generatePuzzle('medium', options), medium);
  assert.notDeepEqual(generatePuzzle('medium', { seed: 43 }), medium);
});

test('a bounded generation failure can be retried', () => {
  assert.deepEqual(generatePuzzle('hard', { seed: 0, maxAttempts: 1 }), { status: 'attempt-limit' });
  const retried = generatePuzzle('hard', { seed: 0 });
  assert.equal(retried.status, 'generated');
  assert.equal(isValidPuzzle(retried.puzzle), true);
  assert.throws(() => generatePuzzle('hard', { maxAttempts: Infinity }), RangeError);
});
