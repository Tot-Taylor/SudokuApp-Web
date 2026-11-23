import { z } from 'zod';

export const MAX_UNDO_ENTRIES = 100;
export const CELL_COUNT = 81;
export const EMPTY_CANDIDATES = 0;

export const digitSchema = z.int().min(1).max(9);
export const cellIndexSchema = z.int().min(0).max(CELL_COUNT - 1);
const candidateMaskSchema = z.int().min(0).max(0b111111111);
export const candidateNotesSchema = z.array(candidateMaskSchema).length(CELL_COUNT);

const cellStateSchema = z.tuple([digitSchema.nullable(), candidateMaskSchema]).refine(
  ([value, notes]) => value === null || notes === EMPTY_CANDIDATES,
);
const cellChangeSchema = z.strictObject({
  index: cellIndexSchema,
  before: cellStateSchema,
  after: cellStateSchema,
});
const entrySchema = z.array(cellChangeSchema).min(1).max(CELL_COUNT);
export const undoHistorySchema = z.strictObject({
  gameId: z.uuid(),
  boardKey: z.string().max(800),
  entries: z.array(entrySchema).min(1).max(MAX_UNDO_ENTRIES),
});

export type CellState = z.infer<typeof cellStateSchema>;
export type UndoEntry = z.infer<typeof entrySchema>;
type UndoHistory = z.infer<typeof undoHistorySchema>;

export type BoardState = { values: (number | null)[]; candidateNotes?: number[] | undefined };
type GameBoard = BoardState & { gameId: string; undoHistory?: UndoHistory | undefined };

export function cellState(board: BoardState, index: number): CellState {
  return [board.values[index] ?? null, board.candidateNotes?.[index] ?? EMPTY_CANDIDATES];
}

function sameCell(a: CellState, b: CellState): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function boardKey(board: BoardState): string {
  return JSON.stringify([board.values, board.candidateNotes?.some(Boolean) ? board.candidateNotes : []]);
}

export function sameGameBoard(a: GameBoard, b: GameBoard): boolean {
  return a.gameId === b.gameId && a.values.every((value, index) => value === b.values[index]
    && (a.candidateNotes?.[index] ?? EMPTY_CANDIDATES) === (b.candidateNotes?.[index] ?? EMPTY_CANDIDATES))
    && (a.undoHistory === b.undoHistory || JSON.stringify(a.undoHistory) === JSON.stringify(b.undoHistory));
}

export function validUndoHistory(game: GameBoard & { givens: (number | null)[]; solution: number[] }): boolean {
  const history = game.undoHistory;
  if (!history || history.gameId !== game.gameId || history.boardKey !== boardKey(game)) return false;

  const board = game.values.map((_, index) => cellState(game, index));
  for (let step = history.entries.length - 1; step >= 0; step -= 1) {
    const entry = history.entries[step]!;
    // A multi-cell change is Clear All and must start undoing from a board with only clues.
    if (entry.length > 1 && board.some((cell, index) => !sameCell(cell, [game.givens[index]!, EMPTY_CANDIDATES]))) {
      return false;
    }
    const seen = new Set<number>();
    for (const { index, before, after } of entry) {
      if (game.givens[index] !== null || seen.has(index) || sameCell(before, after)
        || !sameCell(board[index]!, after)) return false;
      seen.add(index);
      board[index] = before;
    }
    if (board.every(([value], index) => value === game.solution[index])) return false;
  }
  return true;
}

export function boardChanges(before: BoardState, after: BoardState): UndoEntry {
  const changes: UndoEntry = [];
  for (const [index] of before.values.entries()) {
    const previous = cellState(before, index);
    const current = cellState(after, index);
    if (!sameCell(previous, current)) changes.push({ index, before: previous, after: current });
  }
  return changes;
}

export function writeCells(board: BoardState, cells: Iterable<readonly [number, CellState]>): BoardState {
  const values = board.values.slice();
  const candidateNotes = board.candidateNotes?.slice() ?? Array<number>(CELL_COUNT).fill(EMPTY_CANDIDATES);
  for (const [index, [value, notes]] of cells) {
    values[index] = value;
    candidateNotes[index] = notes;
  }
  return { values, candidateNotes: candidateNotes.some(Boolean) ? candidateNotes : undefined };
}
