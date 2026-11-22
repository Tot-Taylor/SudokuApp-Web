import {
  availableDigits, bitDigit, BIT_COUNTS, boardMasks, CELLS, changeUsedDigits, digitBit, UNITS,
} from './board.ts';
import type { Board } from './board.ts';

export type SearchBudget = { remaining: number };

export type SearchResult =
  | { status: 'finished'; count: number; firstSolution: number[] | null }
  | { status: 'budget-exhausted' };

export const SEARCH_NODE_LIMIT = 500_000;

/** Counts up to limit. An exhausted search provides no uniqueness result. */
export function searchPuzzle(
  board: Board,
  limit = 2,
  budget: SearchBudget = { remaining: SEARCH_NODE_LIMIT },
): SearchResult {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Solution limit must be positive.');
  if (!Number.isSafeInteger(budget.remaining) || budget.remaining < 0) {
    throw new RangeError('Search budget must be a nonnegative integer.');
  }
  const initialUsed = boardMasks(board);
  if (initialUsed === null) return { status: 'finished', count: 0, firstSolution: null };
  const used = initialUsed;

  const values = board.map((value) => value ?? 0);
  const emptyCells = CELLS.filter(({ index }) => values[index] === 0);
  let count = 0;
  let firstSolution: number[] | null = null;

  function search(): boolean {
    if (budget.remaining <= 0) return false;
    budget.remaining -= 1;

    let nextCell;
    let nextMask = 0;
    let fewest = 10;
    for (const cell of emptyCells) {
      if (values[cell.index] !== 0) continue;
      const mask = availableDigits(used, cell);
      const choices = BIT_COUNTS[mask]!;
      if (choices === 0) return true;
      if (choices < fewest) {
        nextCell = cell;
        nextMask = mask;
        fewest = choices;
        if (choices === 1) break;
      }
    }

    if (nextCell === undefined) {
      count += 1;
      firstSolution ??= values.slice();
      return true;
    }

    while (nextMask !== 0 && count < limit) {
      const bit = nextMask & -nextMask;
      nextMask ^= bit;
      values[nextCell.index] = bitDigit(bit);
      changeUsedDigits(used, nextCell, bit);
      const finished = search();
      changeUsedDigits(used, nextCell, bit);
      values[nextCell.index] = 0;
      if (!finished) return false;
    }
    return true;
  }

  return search() ? { status: 'finished', count, firstSolution } : { status: 'budget-exhausted' };
}

/** Applies naked singles and hidden singles until the board is solved or progress stops. */
export function solvesWithSingles(board: Board): boolean {
  const used = boardMasks(board);
  if (used === null) return false;

  const values = board.slice();
  let remaining = values.filter((value) => value === null).length;
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const cell of CELLS) {
      if (values[cell.index] !== null) continue;
      const mask = availableDigits(used, cell);
      if (mask === 0) return false;
      if (BIT_COUNTS[mask] !== 1) continue;

      values[cell.index] = bitDigit(mask);
      changeUsedDigits(used, cell, mask);
      remaining -= 1;
      progress = true;
    }

    for (const unit of UNITS) {
      for (let bit = digitBit(1); bit <= digitBit(9); bit <<= 1) {
        let onlyCell;
        for (const cell of unit) {
          if (values[cell.index] !== null || (availableDigits(used, cell) & bit) === 0) continue;
          if (onlyCell !== undefined) {
            onlyCell = undefined;
            break;
          }
          onlyCell = cell;
        }
        if (onlyCell === undefined) continue;

        values[onlyCell.index] = bitDigit(bit);
        changeUsedDigits(used, onlyCell, bit);
        remaining -= 1;
        progress = true;
      }
    }
  }
  return remaining === 0;
}
