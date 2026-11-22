import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SCHEMA_VERSION } from '../src/contracts/game.ts';
import type { ActiveGame, SolvedGame } from '../src/contracts/game.ts';
import type { Intent, Mutation } from '../src/contracts/sync.ts';
import { startGame } from '../src/engine/game.ts';
import { generatePuzzle } from '../src/engine/generator.ts';
import { ApiError, applyMutation, backupDatabase, openDatabase, readState, restoreDatabase } from './database.ts';

function game(seed: number, id: string = randomUUID()): ActiveGame {
  const generated = generatePuzzle('easy', { seed });
  assert.equal(generated.status, 'generated');
  const { snapshot } = startGame(generated.puzzle, id);
  assert.equal(snapshot.status, 'active');
  return snapshot;
}

function operation(historyId: string, intent: Intent, operationId = randomUUID()): Mutation {
  return { schemaVersion: SCHEMA_VERSION, historyId, operationId, ...intent };
}

function solved(active: ActiveGame, elapsedMs = 42_000): SolvedGame {
  return { ...active, status: 'solved', values: active.solution, elapsedMs };
}

test('later commits win while retries return their original receipt without rewriting the active game', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { historyId } = readState(db);
  const first = game(1);
  const second = game(2);
  const oldSave = operation(historyId, { kind: 'save-game', game: first });
  const oldReceipt = applyMutation(db, oldSave);
  applyMutation(db, operation(historyId, { kind: 'save-game', game: second }));
  assert.deepEqual(applyMutation(db, oldSave), oldReceipt);
  assert.throws(() => applyMutation(db, { ...oldSave, game: second } as Mutation), {
    code: 'OPERATION_ID_REUSED',
  });
  assert.equal(readState(db).activeGame?.gameId, second.gameId);
  assert.equal(readState(db).revision, 2);

  const cell = first.givens.indexOf(null);
  const values = first.values.slice();
  values[cell] = 5;
  const delayed = { ...first, selectedCell: cell, values };
  applyMutation(db, operation(historyId, { kind: 'save-game', game: delayed }));
  assert.deepEqual(readState(db).activeGame, delayed);
  assert.equal(readState(db).revision, 3);
});

test('a first completion clears the active slot and counts once, even across competing devices', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { historyId } = readState(db);
  const active = game(3);
  const next = game(4);
  applyMutation(db, operation(historyId, { kind: 'save-game', game: next }));
  const one = operation(historyId, { kind: 'complete-game', game: solved(active) });
  assert.equal(applyMutation(db, one).revision, 2);
  assert.equal(readState(db).activeGame, null);
  applyMutation(db, operation(historyId, { kind: 'save-game', game: next }));
  const twice = operation(historyId, { kind: 'complete-game', game: solved(active, 2000) });
  assert.equal(applyMutation(db, twice).outcome, 'already-completed');
  assert.equal(applyMutation(db, twice).revision, 2);
  assert.throws(() => applyMutation(db, operation(historyId, { kind: 'save-game', game: active })), {
    code: 'GAME_ALREADY_COMPLETED',
  });
  const latest = readState(db);
  assert.deepEqual(latest.stats.easy, { completedCount: 1, totalTimeMs: 42_000, bestTimeMs: 42_000 });
  assert.deepEqual(latest.completedGameIds, [active.gameId]);
  assert.equal(latest.activeGame?.gameId, next.gameId);
  assert.equal(latest.revision, 3);
});

test('game IDs have immutable definitions and invalid puzzles roll back without consuming a revision', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { historyId } = readState(db);
  const active = game(5);
  applyMutation(db, operation(historyId, { kind: 'save-game', game: active }));
  assert.throws(() => applyMutation(db, operation(historyId, { kind: 'save-game', game: game(6, active.gameId) })), {
    code: 'GAME_ID_REUSED',
  });
  const invalid = { ...game(7), difficulty: 'expert' } as const;
  assert.throws(() => applyMutation(db, operation(historyId, { kind: 'save-game', game: invalid })), {
    code: 'INVALID_GAME',
  });
  assert.equal(readState(db).revision, 1);
  assert.equal(readState(db).activeGame?.gameId, active.gameId);
});

test('legacy completion imports deduplicate without clearing another active puzzle', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { historyId } = readState(db);
  const current = game(8);
  applyMutation(db, operation(historyId, { kind: 'save-game', game: current }));
  const completion = { gameId: randomUUID(), difficulty: 'medium', elapsedMs: 15_000 } as const;
  const intent = { kind: 'import-completion', completion } as const;
  assert.equal(applyMutation(db, operation(historyId, intent)).revision, 2);
  assert.equal(applyMutation(db, operation(historyId, intent)).outcome, 'already-completed');
  const latest = readState(db);
  assert.equal(latest.activeGame?.gameId, current.gameId);
  assert.equal(latest.stats.medium.completedCount, 1);
});

test('database restart preserves receipts and a restored backup rotates history before accepting writes', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'sudoku-db-test-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const dbPath = join(temporary, 'current.sqlite');
  const backupPath = join(temporary, 'backup.sqlite');
  const restoredPath = join(temporary, 'restored.sqlite');
  let intent: Mutation;
  let receipt;
  const db = openDatabase(dbPath);
  try {
    const { historyId } = readState(db);
    const finished = game(9);
    applyMutation(db, operation(historyId, { kind: 'complete-game', game: solved(finished) }));
    intent = operation(historyId, { kind: 'save-game', game: game(10) });
    receipt = applyMutation(db, intent);
    await backupDatabase(db, backupPath);
  } finally {
    db.close();
  }

  const reopened = openDatabase(dbPath);
  try {
    assert.deepEqual(applyMutation(reopened, intent), receipt);
    await assert.rejects(backupDatabase(reopened, backupPath), { code: 'EEXIST' });
  } finally {
    reopened.close();
  }
  await restoreDatabase(backupPath, restoredPath);
  const restored = openDatabase(restoredPath);
  try {
    const state = readState(restored);
    assert.notEqual(state.historyId, intent.historyId);
    assert.equal(state.revision, 2);
    assert.equal(state.stats.easy.completedCount, 1);
    assert.throws(() => applyMutation(restored, intent), (failure) =>
      failure instanceof ApiError && failure.code === 'HISTORY_CHANGED');
  } finally {
    restored.close();
  }
});
