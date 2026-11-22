import { DIFFICULTIES, DIFFICULTY_RULES } from '../contracts/game.ts';
import type { Difficulty } from '../contracts/game.ts';
import { CELL_COUNT, SIDE, UNITS } from './board.ts';
import type { Board } from './board.ts';
import { SEARCH_NODE_LIMIT, searchPuzzle, solvesWithSingles } from './solver.ts';

export type Puzzle = {
  difficulty: Difficulty;
  givens: Board;
  solution: readonly number[];
};

export type GenerationOptions = { seed?: number; maxAttempts?: number };

export type GenerationResult =
  | { status: 'generated'; puzzle: Puzzle }
  | { status: 'attempt-limit' | 'search-limit' };

const MAX_ATTEMPTS = 64;
const DIAGONAL_BOXES = [0, 4, 8];

function clueCount(board: Board): number {
  return board.filter((value) => value !== null).length;
}

function classifyUniquePuzzle(board: Board): Difficulty | null {
  const clues = clueCount(board);
  const difficulty = DIFFICULTIES.find((tier) => {
    const { minClues, maxClues } = DIFFICULTY_RULES[tier];
    return clues >= minClues && clues <= maxClues;
  });
  if (difficulty === undefined || clues === CELL_COUNT) return null;

  const needsSinglesOnly = DIFFICULTY_RULES[difficulty].complexity === 'singles';
  return solvesWithSingles(board) === needsSinglesOnly ? difficulty : null;
}

export function classifyPuzzle(board: Board): Difficulty | null {
  const result = searchPuzzle(board);
  return result.status === 'finished' && result.count === 1 ? classifyUniquePuzzle(board) : null;
}

/** Validates a generated or restored puzzle's tier and exact unique solution. */
export function isValidPuzzle(puzzle: Puzzle): boolean {
  if (puzzle.solution.length !== CELL_COUNT) return false;
  const result = searchPuzzle(puzzle.givens);
  return result.status === 'finished'
    && result.count === 1
    && result.firstSolution?.every((digit, index) => digit === puzzle.solution[index]) === true
    && classifyUniquePuzzle(puzzle.givens) === puzzle.difficulty;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function shuffledRange(length: number, random: () => number): number[] {
  const values = Array.from({ length }, (_, index) => index);
  for (let last = length - 1; last > 0; last -= 1) {
    const swap = Math.floor(random() * (last + 1));
    [values[last], values[swap]] = [values[swap]!, values[last]!];
  }
  return values;
}

/** Generates locally. Use the worker entry from the browser UI to keep input responsive. */
export function generatePuzzle(difficulty: Difficulty, options: GenerationOptions = {}): GenerationResult {
  if (!DIFFICULTIES.includes(difficulty)) throw new RangeError('Unknown Sudoku difficulty.');
  const seed = options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError('Seed must be an unsigned 32-bit integer.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new RangeError(`Attempt limit must be between 1 and ${MAX_ATTEMPTS}.`);
  }

  const { minClues, maxClues, complexity } = DIFFICULTY_RULES[difficulty];
  const needsSinglesOnly = complexity === 'singles';
  const random = seededRandom(seed);
  const budget = { remaining: SEARCH_NODE_LIMIT };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Diagonal boxes share neither rows nor columns, so they can be shuffled independently.
    const seedBoard = Array<number | null>(CELL_COUNT).fill(null);
    for (const box of DIAGONAL_BOXES) {
      const digits = shuffledRange(SIDE, random);
      for (const [offset, cell] of UNITS[2 * SIDE + box]!.entries()) {
        seedBoard[cell.index] = digits[offset]! + 1;
      }
    }

    const solved = searchPuzzle(seedBoard, 1, budget);
    if (solved.status === 'budget-exhausted') return { status: 'search-limit' };
    const solution = solved.firstSolution;
    if (solution === null) continue;

    const givens: (number | null)[] = solution.slice();
    let remaining = CELL_COUNT;
    let best: Board | null = null;

    for (const index of shuffledRange(CELL_COUNT, random)) {
      const given = givens[index]!;
      givens[index] = null;
      const checked = searchPuzzle(givens, 2, budget);
      if (checked.status === 'budget-exhausted') {
        return best === null
          ? { status: 'search-limit' }
          : { status: 'generated', puzzle: { difficulty, givens: best, solution } };
      }
      if (checked.count !== 1) {
        givens[index] = given;
        continue;
      }
      remaining -= 1;

      if (remaining <= maxClues && solvesWithSingles(givens) === needsSinglesOnly) {
        best = givens.slice();
      }
      if (remaining === minClues) break;
    }

    if (best !== null) return { status: 'generated', puzzle: { difficulty, givens: best, solution } };
  }
  return { status: 'attempt-limit' };
}
