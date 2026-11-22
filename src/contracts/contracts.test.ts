import assert from 'node:assert/strict';
import test from 'node:test';
import native from '../../tests/fixtures/native-parity.json' with { type: 'json' };
import { DIFFICULTIES, DIFFICULTY_RULES, gameSnapshotSchema } from './game.ts';
import type { ActiveGame, SolvedGame } from './game.ts';
import { mutationSchema, receiptSchema, stateSchema, syncErrorSchema } from './sync.ts';
import type { SharedState } from './sync.ts';

const solution = Array.from(
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179',
  Number,
);
const givens = solution.map((value, index) => index < 40 ? value : null);
const game: ActiveGame = {
  schemaVersion: 1,
  gameId: '1b519412-9cd2-4bff-a299-02a6920414a2',
  difficulty: 'easy',
  givens,
  solution,
  values: givens.map((value, index) => index === 40 ? 5 : value),
  selectedCell: 40,
  status: 'active',
  elapsedMs: 2456,
};
const solved: SolvedGame = { ...game, status: 'solved', values: solution };
const change = {
  schemaVersion: 1,
  historyId: '04933182-ca65-424e-a060-f474bac59f73',
  operationId: '32dd1046-89ef-48f0-9ef7-841d367e7e94',
} as const;
const emptyStats = { completedCount: 0, bestTimeMs: null, totalTimeMs: 0 };
const state: SharedState = {
  schemaVersion: 1,
  historyId: change.historyId,
  revision: 0,
  completedGameIds: [],
  activeGame: null,
  settings: {},
  stats: { easy: emptyStats, medium: emptyStats, hard: emptyStats, expert: emptyStats },
};

test('difficulty names, clue bands, and complexity match the native fixture', () => {
  assert.deepEqual(
    DIFFICULTIES.map((id) => ({ id, ...DIFFICULTY_RULES[id] })),
    native.difficulties.map(({ id, label, minClues, maxClues, complexity }) =>
      ({ id, label, minClues, maxClues, complexity })),
  );
});

test('a game round-trips givens, player values, selected cell, and foreground elapsed time', () => {
  assert.deepEqual(gameSnapshotSchema.parse(JSON.parse(JSON.stringify(game))), game);
});

test('snapshots reject malformed boards and modified or selected givens', () => {
  assert.equal(gameSnapshotSchema.safeParse({ ...game, values: [1] }).success, false);
  assert.equal(gameSnapshotSchema.safeParse({ ...game, values: [9, ...game.values.slice(1)] }).success, false);
  assert.equal(gameSnapshotSchema.safeParse({ ...game, selectedCell: 0 }).success, false);
  assert.equal(gameSnapshotSchema.safeParse({ ...game, elapsedMs: -1 }).success, false);
});

test('a solved snapshot must match the solution and an active snapshot must remain unfinished', () => {
  assert.equal(gameSnapshotSchema.safeParse({ ...game, status: 'solved' }).success, false);
  assert.equal(gameSnapshotSchema.safeParse({ ...solved, status: 'active' }).success, false);
  assert.deepEqual(gameSnapshotSchema.parse(solved), solved);
});

test('mutations distinguish saves and completions and require stable IDs and a known version', () => {
  const save = { ...change, kind: 'save-game', game };
  const complete = { ...change, kind: 'complete-game', game: solved };
  assert.deepEqual(mutationSchema.parse(save), save);
  assert.deepEqual(mutationSchema.parse(complete), complete);
  assert.equal(mutationSchema.safeParse({ ...save, game: solved }).success, false);
  assert.equal(mutationSchema.safeParse({ ...complete, game }).success, false);
  assert.equal(mutationSchema.safeParse({ ...save, schemaVersion: 2 }).success, false);
  assert.equal(mutationSchema.safeParse({ ...save, operationId: 'device timestamp' }).success, false);
});

test('canonical state exposes only an unfinished game and completion stats for all difficulties', () => {
  assert.deepEqual(stateSchema.parse(state), state);
  assert.equal(stateSchema.safeParse({ ...state, activeGame: solved }).success, false);
  assert.equal(stateSchema.safeParse({ ...state, stats: { easy: emptyStats } }).success, false);
  assert.equal(stateSchema.safeParse({ ...state, points: 1 }).success, false);
  const stats = { ...state.stats, easy: { completedCount: 1, totalTimeMs: 2456, bestTimeMs: 2456 } };
  assert.equal(stateSchema.safeParse({ ...state, revision: 1, activeGame: game, stats }).success, true);
});

test('receipts distinguish applied writes from a repeat completion and expose an ordered revision', () => {
  assert.equal(receiptSchema.safeParse({ ...change, revision: 3, outcome: 'applied' }).success, true);
  assert.equal(receiptSchema.safeParse({ ...change, revision: 2, outcome: 'already-completed' }).success, true);
  assert.equal(receiptSchema.safeParse({ ...change, revision: 0, outcome: 'applied' }).success, false);
  assert.equal(syncErrorSchema.safeParse({ code: 'HISTORY_CHANGED', message: 'Refresh the snapshot.' }).success, true);
});
