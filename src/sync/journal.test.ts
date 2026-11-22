import assert from 'node:assert/strict';
import test from 'node:test';
import { completionStats, SCHEMA_VERSION } from '../contracts/game.ts';
import type { ActiveGame } from '../contracts/game.ts';
import type { SharedState } from '../contracts/sync.ts';
import { startGame } from '../engine/game.ts';
import { generatePuzzle } from '../engine/generator.ts';
import { reconcile, record, recover, replicaStats, seedReplica } from './journal.ts';

const generated = generatePuzzle('easy', { seed: 42 });
assert.equal(generated.status, 'generated');
const { snapshot } = startGame(generated.puzzle);
assert.equal(snapshot.status, 'active');
const original: SharedState = {
  schemaVersion: SCHEMA_VERSION, historyId: crypto.randomUUID(), revision: 0, activeGame: null,
  stats: completionStats([]), completedGameIds: [], settings: {},
};
const empty = () => seedReplica({ activeGame: null, completions: [] }, false);

test('first connection binds unbound operations and acknowledgement cannot replace newer server state', () => {
  const queued = record(empty(), snapshot);
  assert.equal(queued.pending[0]?.historyId, null);
  const connected = reconcile(queued, original);
  const head = connected.pending[0]!;
  assert.equal(head.historyId, original.historyId);
  assert.equal(head.operationId, queued.pending[0]?.operationId);
  const remote: ActiveGame = { ...snapshot, gameId: crypto.randomUUID() };
  const later = { ...original, activeGame: remote, revision: 2 };
  const acknowledged = reconcile(connected, later, { receipt: {
    schemaVersion: SCHEMA_VERSION, historyId: original.historyId, operationId: head.operationId, revision: 1,
    outcome: 'applied',
  } });
  assert.deepEqual(acknowledged.active, remote);
  assert.equal(acknowledged.pending.length, 0);
  assert.equal(reconcile(acknowledged, { ...original, revision: 1 }), acknowledged);
});

test('checkpoint writes do not resurrect a replaced puzzle or queue a synchronization mutation', () => {
  const replica = reconcile(empty(), { ...original, activeGame: snapshot, revision: 1 });
  const checkpoint = { ...snapshot, elapsedMs: 600 };
  const local = record(replica, checkpoint, snapshot);
  assert.equal(local.pending.length, 0);
  assert.equal(local.active?.elapsedMs, 600);
  assert.equal(reconcile(local, replica.server!), local);
  const replaced = reconcile(local, { ...original, revision: 2 });
  assert.equal(record(replaced, checkpoint, snapshot), replaced);
});

test('restore holds original history writes and explicit recovery allocates a new operation ID', () => {
  const local = record(reconcile(empty(), original), snapshot);
  const historyId = crypto.randomUUID();
  const held = reconcile(local, { ...original, historyId });
  assert.equal(held.active, null);
  assert.equal(held.pending.length, 0);
  assert.equal(held.recovery.length, 1);
  const oldId = held.recovery[0]!.operationId;
  const restored = recover(held, oldId, true);
  assert.equal(restored.pending[0]?.historyId, historyId);
  assert.notEqual(restored.pending[0]?.operationId, oldId);
  assert.equal(restored.active?.gameId, snapshot.gameId);
  assert.equal(restored.recovery.length, 0);
  assert.equal(reconcile(restored, original), restored);
});

test('pending completion statistics count once after the server has accepted the same game', () => {
  const saved = record(empty(), { ...snapshot, status: 'solved', values: snapshot.solution, elapsedMs: 15_000 });
  assert.equal(replicaStats(saved).easy.completedCount, 1);
  const canonical = { ...original, completedGameIds: [snapshot.gameId], revision: 1,
    stats: completionStats([{ gameId: snapshot.gameId, difficulty: 'easy', elapsedMs: 14_000 }]) };
  const pulled = reconcile(saved, canonical);
  assert.equal(pulled.pending.length, 1);
  assert.deepEqual(replicaStats(pulled).easy, { completedCount: 1, bestTimeMs: 14_000, totalTimeMs: 14_000 });
});

test('terminally rejected changes are held without blocking later queued work', () => {
  const first = record(reconcile(empty(), original), snapshot);
  const next: ActiveGame = { ...snapshot, gameId: crypto.randomUUID() };
  const queued = record(first, next);
  const rejected = first.pending[0]!.operationId;
  const held = reconcile(queued, original, { rejected, reason: 'This puzzle has already been completed.' });
  assert.equal(held.recovery[0]?.operationId, rejected);
  assert.equal(held.pending.length, 1);
  assert.equal(held.active?.gameId, next.gameId);
  assert.equal(recover(held, rejected, true), held);
});
