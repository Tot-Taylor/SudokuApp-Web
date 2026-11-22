import { gameSnapshotSchema, SCHEMA_VERSION } from '../contracts/game.ts';
import type { Completion, GameSnapshot } from '../contracts/game.ts';
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
  | { type: 'erase' };

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

  const { givens, selectedCell } = session.snapshot;
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

  const value = action.type === 'erase' ? null : action.digit;
  if (selectedCell === null || givens[selectedCell] !== null
    || (value !== null && !isDigit(value)) || session.snapshot.values[selectedCell] === value) {
    return { session, completion: null };
  }

  const timed = checkpoint(session, now);
  const values = timed.snapshot.values.slice();
  values[selectedCell] = value;
  if (values.every((digit, index) => digit === timed.snapshot.solution[index])) {
    const { gameId, difficulty, elapsedMs } = timed.snapshot;
    return {
      session: { snapshot: { ...timed.snapshot, status: 'solved', values }, runningSince: null },
      completion: { gameId, difficulty, elapsedMs },
    };
  }
  return { session: { ...timed, snapshot: { ...timed.snapshot, values } }, completion: null };
}
