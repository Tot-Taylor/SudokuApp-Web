import { randomUUID } from 'node:crypto';
import { closeSync, openSync, renameSync, rmSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, completionSchema, completionStats } from '../src/contracts/game.ts';
import type { Completion } from '../src/contracts/game.ts';
import { stateSchema } from '../src/contracts/sync.ts';
import type { Mutation, MutationReceipt, SharedState, SyncError } from '../src/contracts/sync.ts';
import { isValidPuzzle } from '../src/engine/generator.ts';

const migrations = [
  `
    CREATE TABLE profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      history_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      active_game TEXT
    ) STRICT;
    CREATE TABLE puzzles (id TEXT PRIMARY KEY, definition TEXT NOT NULL) STRICT;
    CREATE TABLE completions (
      game_id TEXT PRIMARY KEY,
      difficulty TEXT NOT NULL,
      elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
      revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE receipts (
      operation_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      revision INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'already-completed'))
    ) STRICT;
  `,
];

export class ApiError extends Error {
  readonly status: number;
  readonly code: SyncError['code'];

  constructor(status: number, code: SyncError['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function transaction<T>(db: DatabaseSync, write: boolean, run: () => T): T {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const value = run();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    transaction(db, true, () => {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > migrations.length) throw new Error('This database requires a newer Sudoku release.');
      for (let index = version; index < migrations.length; index++) {
        db.exec(migrations[index]!);
        db.exec(`PRAGMA user_version = ${index + 1}`);
      }
      db.prepare('INSERT OR IGNORE INTO profile (id, history_id) VALUES (1, ?)').run(randomUUID());
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readProfile(db: DatabaseSync) {
  const row = db.prepare('SELECT history_id, revision, active_game FROM profile WHERE id = 1').get();
  if (!row) throw new Error('The shared profile is missing.');
  return { historyId: String(row.history_id), revision: Number(row.revision), active: row.active_game };
}

export function readState(db: DatabaseSync): SharedState {
  return transaction(db, false, () => {
    const profile = readProfile(db);
    const completions = db.prepare(
      'SELECT game_id AS gameId, difficulty, elapsed_ms AS elapsedMs FROM completions ORDER BY revision',
    ).all().map((record) => completionSchema.parse(record));
    return stateSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      historyId: profile.historyId,
      revision: profile.revision,
      activeGame: profile.active === null ? null : JSON.parse(String(profile.active)),
      settings: {},
      stats: completionStats(completions),
      completedGameIds: completions.map(({ gameId }) => gameId),
    });
  });
}

function checkPuzzle(db: DatabaseSync, game: Extract<Mutation, { game: unknown }>['game']) {
  const definition = JSON.stringify({ difficulty: game.difficulty, givens: game.givens, solution: game.solution });
  const puzzle = db.prepare('SELECT definition FROM puzzles WHERE id = ?').get(game.gameId);
  if (puzzle) {
    if (puzzle.definition !== definition) {
      throw new ApiError(409, 'GAME_ID_REUSED', 'This game ID is already registered for another puzzle.');
    }
  } else {
    if (!isValidPuzzle(game)) {
      throw new ApiError(422, 'INVALID_GAME', 'The puzzle does not have the expected unique solution and difficulty.');
    }
    db.prepare('INSERT INTO puzzles VALUES (?, ?)').run(game.gameId, definition);
  }
}

function insertCompletion(db: DatabaseSync, { gameId, difficulty, elapsedMs }: Completion, revision: number) {
  const { total } = db.prepare('SELECT COALESCE(SUM(elapsed_ms), 0) AS total FROM completions WHERE difficulty = ?')
    .get(difficulty)!;
  if (!Number.isSafeInteger(Number(total) + elapsedMs)) {
    throw new ApiError(422, 'INVALID_GAME', 'The completion time exceeds the supported statistics range.');
  }
  db.prepare('INSERT INTO completions VALUES (?, ?, ?, ?)').run(gameId, difficulty, elapsedMs, revision);
}

export function applyMutation(db: DatabaseSync, operation: Mutation): MutationReceipt {
  return transaction(db, true, () => {
    const { historyId, revision, active } = readProfile(db);
    if (operation.historyId !== historyId) {
      throw new ApiError(409, 'HISTORY_CHANGED', 'The server has a different history.');
    }
    const payload = JSON.stringify(operation);
    const receipt = db.prepare('SELECT payload, revision, outcome FROM receipts WHERE operation_id = ?')
      .get(operation.operationId);
    if (receipt) {
      if (receipt.payload !== payload) {
        throw new ApiError(409, 'OPERATION_ID_REUSED', 'This operation ID already has a different request.');
      }
      return { schemaVersion: SCHEMA_VERSION, historyId, operationId: operation.operationId,
        revision: Number(receipt.revision), outcome: receipt.outcome as MutationReceipt['outcome'] };
    }

    const game = operation.kind === 'import-completion' ? operation.completion : operation.game;
    const prior = db.prepare('SELECT difficulty, revision FROM completions WHERE game_id = ?').get(game.gameId);
    let nextRevision = revision + 1;
    let outcome: MutationReceipt['outcome'] = 'applied';
    if (prior && prior.difficulty !== game.difficulty) {
      throw new ApiError(409, 'GAME_ID_REUSED', 'This completed game ID has a different difficulty.');
    }
    if (operation.kind !== 'import-completion') checkPuzzle(db, operation.game);

    if (prior) {
      if (operation.kind === 'save-game') {
        throw new ApiError(409, 'GAME_ALREADY_COMPLETED', 'This puzzle has already been completed.');
      }
      outcome = 'already-completed';
      nextRevision = Number(prior.revision);
    } else {
      let nextActive: string | null;
      if (operation.kind === 'save-game') {
        nextActive = JSON.stringify(operation.game);
      } else {
        if (operation.kind === 'import-completion') {
          const known = db.prepare('SELECT definition FROM puzzles WHERE id = ?').get(game.gameId);
          if (known && JSON.parse(String(known.definition)).difficulty !== game.difficulty) {
            throw new ApiError(409, 'GAME_ID_REUSED', 'The saved puzzle has a different difficulty.');
          }
        }
        insertCompletion(db, game, nextRevision);
        // The preview only saved completion summaries. Importing one preserves other active games.
        nextActive = operation.kind === 'import-completion' && typeof active === 'string'
          && JSON.parse(active).gameId !== game.gameId ? active : null;
      }
      db.prepare('UPDATE profile SET revision = ?, active_game = ? WHERE id = 1').run(nextRevision, nextActive);
    }
    db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?)').run(operation.operationId, payload, nextRevision, outcome);
    return { schemaVersion: SCHEMA_VERSION, historyId, operationId: operation.operationId, revision: nextRevision, outcome };
  });
}

async function publishDatabase(destination: string, prepare: (stage: string) => Promise<void>) {
  const stage = `${destination}.${randomUUID()}.partial`;
  closeSync(openSync(stage, 'wx', 0o600));
  try {
    await prepare(stage);
    closeSync(openSync(destination, 'wx', 0o600));
    try {
      renameSync(stage, destination);
    } catch (error) {
      rmSync(destination, { force: true });
      throw error;
    }
  } finally {
    rmSync(stage, { force: true });
  }
}

export function backupDatabase(db: DatabaseSync, destination: string): Promise<void> {
  return publishDatabase(destination, async (stage) => { await backup(db, stage); });
}

export async function restoreDatabase(backupPath: string, destination: string): Promise<void> {
  const source = new DatabaseSync(backupPath, { readOnly: true });
  try {
    readState(source);
    await publishDatabase(destination, async (stage) => {
      await backup(source, stage);
      const db = openDatabase(stage);
      try {
        transaction(db, true, () => {
          db.prepare('UPDATE profile SET history_id = ? WHERE id = 1').run(randomUUID());
          db.exec('DELETE FROM receipts');
        });
        db.exec('PRAGMA journal_mode = DELETE');
      } finally {
        db.close();
      }
    });
  } finally {
    source.close();
  }
}
