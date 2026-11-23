import { completionStats, SCHEMA_VERSION } from '../contracts/game.ts';
import { sameGameBoard } from '../contracts/board-history.ts';
import type { ActiveGame, Completion, GameSnapshot } from '../contracts/game.ts';
import type { Intent, Mutation, MutationReceipt, SharedState } from '../contracts/sync.ts';
import type { PreviewData } from '../ui/preview-store.ts';

export type Queued = { operationId: string; historyId: string | null; intent: Intent };
export type RecoveryItem = Queued & { reason: string; canRetry: boolean };
export type Replica = {
  sequence: number;
  server: SharedState | null;
  retiredHistories: string[];
  active: ActiveGame | null;
  pending: Queued[];
  recovery: RecoveryItem[];
  invalidSave: boolean;
};

export function queue(intent: Intent, historyId: string | null): Queued {
  return { operationId: crypto.randomUUID(), historyId, intent };
}

export function seedReplica(preview: PreviewData, invalidSave: boolean): Replica {
  const pending = preview.completions.map((completion) => queue({ kind: 'import-completion', completion }, null));
  if (preview.activeGame) pending.push(queue({ kind: 'save-game', game: preview.activeGame }, null));
  return { sequence: 0, server: null, retiredHistories: [], active: preview.activeGame, pending, recovery: [], invalidSave };
}

export function asMutation(entry: Queued, historyId: string): Mutation {
  return { schemaVersion: SCHEMA_VERSION, historyId, operationId: entry.operationId, ...entry.intent };
}

function sameBoard(a: ActiveGame | null, b: ActiveGame | null): boolean {
  return a === b || (a !== null && b !== null && sameGameBoard(a, b));
}

function sameSnapshot(a: ActiveGame | null, b: ActiveGame): boolean {
  return sameBoard(a, b) && a?.elapsedMs === b.elapsedMs && a.selectedCell === b.selectedCell;
}

function withIntent(replica: Replica, entry: Queued): Replica {
  const { intent } = entry;
  const active = intent.kind === 'save-game' ? intent.game
    : intent.kind === 'complete-game' || replica.active?.gameId === intent.completion.gameId
      ? null : replica.active;
  return { ...replica, active, pending: [...replica.pending, entry], invalidSave: false };
}

export function record(replica: Replica, snapshot: GameSnapshot, previous?: ActiveGame): Replica {
  if (previous && snapshot.status === 'active') {
    return sameSnapshot(replica.active, previous) ? { ...replica, active: snapshot } : replica;
  }
  const intent: Intent = snapshot.status === 'active'
    ? { kind: 'save-game', game: snapshot }
    : { kind: 'complete-game', game: snapshot };
  return withIntent(replica, queue(intent, replica.server?.historyId ?? null));
}

type Resolution = { receipt: MutationReceipt } | { rejected: string; reason: string };

export function reconcile(replica: Replica, incoming: SharedState, resolution?: Resolution): Replica {
  const old = replica.server;
  const retiredHistories = replica.retiredHistories ?? [];
  if (retiredHistories.includes(incoming.historyId)) return replica;
  const historyChanged = old !== null && old.historyId !== incoming.historyId;
  const fresh = old && old.historyId === incoming.historyId && old.revision > incoming.revision ? old : incoming;
  const receipt = resolution && 'receipt' in resolution ? resolution.receipt : undefined;
  const rejected = resolution && 'rejected' in resolution ? resolution : undefined;
  const removedId = receipt?.operationId ?? rejected?.rejected;
  const pending: Queued[] = [];
  const held: RecoveryItem[] = [];
  let removed: Queued | undefined;
  let lastGameOp: Queued | undefined;
  for (const entry of replica.pending) {
    if (entry.historyId !== null && entry.historyId !== fresh.historyId) {
      held.push({ ...entry, reason: 'The server history changed.', canRetry: true });
    } else if (entry.operationId === removedId) {
      removed = entry;
      if (rejected) held.push({ ...entry, reason: rejected.reason, canRetry: false });
    } else {
      const retained = entry.historyId === null ? { ...entry, historyId: fresh.historyId } : entry;
      pending.push(retained);
      if (retained.intent.kind !== 'import-completion') lastGameOp = retained;
    }
  }

  const changed = old === null || historyChanged || fresh.revision !== old.revision;
  if (!changed && held.length === 0 && removed === undefined) return replica;

  // Keep the latest local checkpoint available after a restore, even after its board was acknowledged.
  if (historyChanged && replica.active && !sameSnapshot(fresh.activeGame, replica.active)
    && !held.some(({ intent }) => intent.kind === 'save-game' && sameSnapshot(intent.game, replica.active!))) {
    held.push({ ...queue({ kind: 'save-game', game: replica.active }, old.historyId),
      reason: 'The server history changed.', canRetry: true });
  }

  let active = changed || removed ? fresh.activeGame : replica.active;
  if (lastGameOp?.intent.kind === 'save-game') {
    active = sameBoard(replica.active, lastGameOp.intent.game) ? replica.active : lastGameOp.intent.game;
  } else if (lastGameOp?.intent.kind === 'complete-game') {
    active = null;
  } else if (receipt?.outcome === 'applied' && receipt.revision === fresh.revision
    && removed?.intent.kind === 'save-game' && sameBoard(replica.active, fresh.activeGame)) {
    active = replica.active;
  }
  if (active && pending.some(({ intent }) => intent.kind === 'import-completion'
    && intent.completion.gameId === active?.gameId)) active = null;
  return {
    ...replica,
    server: fresh,
    retiredHistories: historyChanged ? [...retiredHistories, old.historyId] : retiredHistories,
    active,
    pending,
    recovery: [...replica.recovery, ...held],
    invalidSave: replica.invalidSave && active === null,
  };
}

export function canReapply(item: RecoveryItem, server: SharedState | null): boolean {
  return item.canRetry && server !== null && (item.intent.kind !== 'save-game'
    || !server.completedGameIds.includes(item.intent.game.gameId));
}

export function recover(replica: Replica, id: string, reapply: boolean): Replica {
  const found = replica.recovery.find(({ operationId }) => operationId === id);
  if (!found || (reapply && !canReapply(found, replica.server))) return replica;
  const next = { ...replica, recovery: replica.recovery.filter(({ operationId }) => operationId !== id) };
  return reapply ? withIntent(next, queue(found.intent, replica.server!.historyId)) : next;
}

export function replicaStats(replica: Replica) {
  const known = new Set(replica.server?.completedGameIds ?? []);
  const completions: Completion[] = [];
  for (const { intent } of replica.pending) {
    if (intent.kind === 'save-game') continue;
    const completion = intent.kind === 'import-completion' ? intent.completion : intent.game;
    if (known.has(completion.gameId)) continue;
    known.add(completion.gameId);
    completions.push(completion);
  }
  return completionStats(completions, replica.server?.stats);
}
