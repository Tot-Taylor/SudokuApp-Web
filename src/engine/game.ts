import { gameSnapshotSchema, SCHEMA_VERSION } from '../contracts/game.ts';
import type { ActiveGame, Completion, GameSnapshot } from '../contracts/game.ts';
import { boardChanges, boardKey, cellState, EMPTY_CANDIDATES, MAX_UNDO_ENTRIES, writeCells } from '../contracts/board-history.ts';
import type { BoardState, UndoEntry } from '../contracts/board-history.ts';
import { isCellIndex, isDigit } from './board.ts';
import { isValidPuzzle } from './generator.ts';
import type { Puzzle } from './generator.ts';

export type GameSession = {
  snapshot: GameSnapshot;
  runningSince: number | null;
};

export type GameAction =
  | { type: 'foreground'; active: boolean }
  | { type: 'checkpoint' }
  | { type: 'select'; cell: number }
  | { type: 'place'; digit: number }
  | { type: 'toggle-candidate'; digit: number }
  | { type: 'erase'; cell?: number }
  | { type: 'clear-all' }
  | { type: 'undo' };

export type GameUpdate = { session: GameSession; completion: Completion | null };

/** Restores persisted foreground time. The caller starts the new clock on entering the visible board. */
export function restoreGame(snapshot: unknown): GameSession | null {
  const parsed = gameSnapshotSchema.safeParse(snapshot);
  if (!parsed.success || !isValidPuzzle(parsed.data)) return null;
  return { snapshot: parsed.data, runningSince: null };
}

export function startGame(puzzle: Puzzle, gameId: string = crypto.randomUUID()): GameSession {
  const session = restoreGame({
    schemaVersion: SCHEMA_VERSION,
    gameId,
    difficulty: puzzle.difficulty,
    givens: puzzle.givens,
    solution: puzzle.solution,
    values: puzzle.givens,
    selectedCell: null,
    status: 'active',
    elapsedMs: 0,
  });
  if (session === null) throw new RangeError('Invalid starting puzzle or game ID.');
  return session;
}

function checkpoint(session: GameSession, now: number): GameSession {
  const since = session.runningSince;
  if (since === null) return session;

  const elapsed = Math.floor(now - since);
  if (elapsed <= 0) return session;

  return {
    // Advance by the recorded whole milliseconds so repeated checkpoints retain fractions.
    runningSince: since + elapsed,
    snapshot: {
      ...session.snapshot,
      elapsedMs: Math.min(Number.MAX_SAFE_INTEGER, session.snapshot.elapsedMs + elapsed),
    },
  };
}

function withBoard(game: ActiveGame, board: BoardState, entries: UndoEntry[]): ActiveGame {
  const snapshot = { ...game, ...board, candidateNotes: board.candidateNotes };
  if (!snapshot.candidateNotes) delete snapshot.candidateNotes;
  if (entries.length === 0) delete snapshot.undoHistory;
  else snapshot.undoHistory = { gameId: game.gameId, boardKey: boardKey(board), entries };
  return snapshot;
}

function editBoard(game: ActiveGame, board: BoardState): ActiveGame {
  const changes = boardChanges(game, board);
  if (changes.length === 0) return game;
  const previous = game.undoHistory?.entries ?? [];
  return withBoard(game, board, [...previous.slice(-(MAX_UNDO_ENTRIES - 1)), changes]);
}

/** Applies an action with a monotonic timestamp from the caller's current page. */
export function updateGame(session: GameSession, action: GameAction, now: number): GameUpdate {
  if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Use a finite, nonnegative monotonic timestamp.');
  }
  if (session.snapshot.status === 'solved') return { session, completion: null };

  if (action.type === 'foreground') {
    if (action.active && session.runningSince === null) {
      return { session: { ...session, runningSince: now }, completion: null };
    }
    if (!action.active && session.runningSince !== null) {
      return { session: { ...checkpoint(session, now), runningSince: null }, completion: null };
    }
    return { session, completion: null };
  }
  if (action.type === 'checkpoint') {
    return { session: checkpoint(session, now), completion: null };
  }

  const game = session.snapshot;
  const { givens, selectedCell } = game;
  if (action.type === 'undo') {
    const entries = game.undoHistory?.entries;
    const last = entries?.at(-1);
    if (!entries || !last) return { session, completion: null };
    const board = writeCells(game, last.map(({ index, before }) => [index, before] as const));
    return {
      session: { ...session, snapshot: withBoard(game, board, entries.slice(0, -1)) },
      completion: null,
    };
  }
  if (action.type === 'clear-all') {
    const snapshot = editBoard(game, { values: givens.slice() });
    return { session: snapshot === game ? session : { ...session, snapshot }, completion: null };
  }
  if (action.type === 'select') {
    if (!isCellIndex(action.cell) || givens[action.cell] !== null || action.cell === selectedCell) {
      return { session, completion: null };
    }
    const timed = checkpoint(session, now);
    return {
      session: { ...timed, snapshot: { ...timed.snapshot, selectedCell: action.cell } },
      completion: null,
    };
  }

  const cell = action.type === 'erase' ? action.cell ?? selectedCell : selectedCell;
  if (cell === null || !isCellIndex(cell) || givens[cell] !== null
    || (action.type !== 'erase' && !isDigit(action.digit))) {
    return { session, completion: null };
  }

  const [value, notes] = cellState(game, cell);
  if (action.type === 'toggle-candidate' && value !== null) return { session, completion: null };
  const board = action.type === 'toggle-candidate'
    ? writeCells(game, [[cell, [null, notes ^ (1 << (action.digit - 1))]]])
    : writeCells(game, [[cell, [action.type === 'erase' ? null : action.digit, EMPTY_CANDIDATES]]]);
  const snapshot = editBoard(game, board);
  if (snapshot === game) return { session, completion: null };

  const timed = checkpoint({ ...session, snapshot }, now);
  const { values, solution, gameId, difficulty, elapsedMs } = timed.snapshot;
  if (values.every((digit, index) => digit === solution[index])) {
    const solved = { ...game, elapsedMs, values, status: 'solved' as const };
    delete solved.undoHistory;
    delete solved.candidateNotes;
    return {
      session: { snapshot: solved, runningSince: null },
      completion: { gameId, difficulty, elapsedMs },
    };
  }
  return { session: { ...timed, snapshot: { ...timed.snapshot, selectedCell: cell } }, completion: null };
}
