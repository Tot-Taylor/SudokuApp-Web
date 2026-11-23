import { receiptSchema, stateSchema, syncErrorSchema } from '../contracts/sync.ts';
import { activeGameSchema } from '../contracts/game.ts';
import type { Mutation, SharedState, SyncError } from '../contracts/sync.ts';
import type { ActiveGame, GameSnapshot } from '../contracts/game.ts';
import { loadPreview, PREVIEW_KEY } from '../ui/preview-store.ts';
import { asMutation, reconcile, record, recover, seedReplica } from './journal.ts';
import type { Replica } from './journal.ts';
import { ReplicaStore } from './store.ts';

export type SyncPhase = 'loading' | 'syncing' | 'synced' | 'offline' | 'error' | 'session-only';
export type SyncView = { phase: SyncPhase; replica: Replica | null };

const DEFAULT_INTERVAL = 4000;
const MAX_RETRY = 30_000;

class Rejected extends Error {
  readonly status: number;
  readonly code: SyncError['code'] | undefined;

  constructor(status: number, code: SyncError['code'] | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path: string, signal: AbortSignal, mutation?: Mutation): Promise<unknown> {
  const response = await fetch(`/api/v1/${path}`, {
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    ...(mutation ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mutation),
    } : {}),
  });
  const value: unknown = await response.json().catch(() => null);
  if (response.ok) return value;
  const error = syncErrorSchema.safeParse(value);
  throw new Rejected(response.status, error.data?.code, error.data?.message ?? 'The server is unavailable.');
}

export class SyncClient {
  private readonly store = new ReplicaStore();
  private snapshot: Replica | null = null;
  private phase: SyncPhase = 'loading';
  private publish: ((view: SyncView) => void) | undefined;
  private channel: BroadcastChannel | undefined;
  private next: number | undefined;
  private run: AbortController | undefined;
  private requested = false;
  private failures = 0;
  private memoryOnly = false;
  private ready = false;

  start(publish: (view: SyncView) => void): () => void {
    this.publish = publish;
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel('sudoku-replica');
      this.channel.onmessage = () => { void this.refresh(); };
    }
    const wake = () => {
      if (document.visibilityState === 'hidden' || !navigator.onLine) {
        this.run?.abort();
        if (!navigator.onLine && this.ready && !this.memoryOnly) this.setPhase('offline');
      } else {
        this.retry();
      }
    };
    const pause = () => this.run?.abort();
    window.addEventListener('online', wake);
    window.addEventListener('offline', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('pagehide', pause);
    document.addEventListener('visibilitychange', wake);
    void this.initialize();
    return () => {
      this.publish = undefined;
      this.run?.abort();
      window.clearTimeout(this.next);
      this.channel?.close();
      this.channel = undefined;
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('pagehide', pause);
      document.removeEventListener('visibilitychange', wake);
    };
  }

  private emit() {
    this.publish?.({ phase: this.phase, replica: this.snapshot });
  }

  private setPhase(phase: SyncPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit();
  }

  private async initialize() {
    const preview = loadPreview();
    const initial = seedReplica(preview.data, preview.issue === 'invalid-save');
    try {
      this.snapshot = (await this.store.transact((previous) => {
        if (!previous) return initial;
        if (previous.active?.undoHistory === undefined) return previous;
        const saved = activeGameSchema.safeParse(previous.active);
        return saved.success && !saved.data.undoHistory ? { ...previous, active: saved.data } : previous;
      }))!;
      // The legacy key is cleared only after the complete migration commits.
      if (preview.issue === null) {
        try { localStorage.removeItem(PREVIEW_KEY); } catch { /* The IndexedDB record marks the import. */ }
      }
    } catch {
      this.snapshot = initial;
      this.memoryOnly = true;
      this.phase = 'session-only';
    }
    this.ready = true;
    this.emit();
    this.retry();
  }

  private async refresh() {
    if (this.memoryOnly || this.snapshot === null) return;
    try {
      const replica = await this.store.transact();
      if (replica && replica.sequence > this.snapshot.sequence) {
        this.snapshot = replica;
        this.emit();
      }
    } catch {
      this.setPhase('error');
    }
  }

  private async change(update: (replica: Replica) => Replica): Promise<Replica> {
    const current = this.snapshot!;
    if (this.memoryOnly) {
      this.snapshot = update(current);
      this.emit();
      return this.snapshot;
    }
    const next = (await this.store.transact((previous) => update(previous ?? current)))!;
    if (next.sequence > this.snapshot!.sequence) {
      this.snapshot = next;
      this.emit();
      this.channel?.postMessage(next.sequence);
    }
    return next;
  }

  async save(game: GameSnapshot, previous?: ActiveGame) {
    try {
      await this.change((replica) => record(replica, game, previous));
    } catch {
      // Keep the live game usable, and report that these changes cannot survive reload.
      this.memoryOnly = true;
      this.run?.abort();
      this.phase = 'session-only';
      await this.change((replica) => record(replica, game, previous));
    }
    if (!previous) this.wake();
  }

  async resolveRecovery(id: string, reapply: boolean) {
    try {
      await this.change((replica) => recover(replica, id, reapply));
      if (reapply) this.retry();
    } catch {
      this.setPhase('error');
    }
  }

  retry() {
    this.failures = 0;
    this.wake();
  }

  private wake() {
    if (!this.publish || !this.ready || this.memoryOnly || document.visibilityState === 'hidden') return;
    if (!navigator.onLine) {
      this.setPhase('offline');
      return;
    }
    if (this.run) {
      this.requested = true;
      return;
    }
    window.clearTimeout(this.next);
    const controller = new AbortController();
    this.run = controller;
    this.requested = false;
    void this.synchronize(controller.signal);
  }

  private async synchronize(signal: AbortSignal) {
    try {
      if (navigator.locks) {
        await navigator.locks.request('sudoku-sync', { ifAvailable: true }, async (lock) => {
          if (lock) await this.drain(signal);
          else await this.refresh();
        });
      } else {
        await this.drain(signal);
      }
      this.failures = 0;
    } catch (error) {
      if (!signal.aborted) {
        this.failures++;
        const networkFailure = error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
        this.setPhase(networkFailure ? 'offline' : 'error');
      }
    } finally {
      this.run = undefined;
      if (this.publish && !this.memoryOnly) {
        const delay = this.failures
          ? Math.min(MAX_RETRY, 1000 * 2 ** this.failures)
          : this.requested ? 0 : DEFAULT_INTERVAL;
        this.next = window.setTimeout(() => this.wake(), delay);
      }
    }
  }

  private async pull(signal: AbortSignal): Promise<SharedState> {
    return stateSchema.parse(await request('state', signal));
  }

  private async merge(incoming: SharedState, resolution?: Parameters<typeof reconcile>[2]) {
    const replica = await this.change((previous) => reconcile(previous, incoming, resolution));
    if (replica.server?.historyId !== incoming.historyId) throw new Error('The response comes from an older history.');
    return replica;
  }

  private async drain(signal: AbortSignal) {
    const cached = this.snapshot!;
    if (!cached.server || cached.pending.length > 0) this.setPhase('syncing');
    // Every run rechecks the current history before it sends a pending operation.
    const fresh = await this.pull(signal);
    let current = await this.merge(fresh);
    let head = current.pending[0];
    while (head) {
      signal.throwIfAborted();
      this.setPhase('syncing');
      const sent = head;
      const historyId = current.server!.historyId;
      let receipt;
      try {
        receipt = receiptSchema.parse(await request('mutations', signal, asMutation(sent, historyId)));
      } catch (error) {
        if (!(error instanceof Rejected)) throw error;
        if (error.code === 'HISTORY_CHANGED') {
          const restored = await this.pull(signal);
          if (restored.historyId === historyId) throw error;
          current = await this.merge(restored);
        } else if (error.code && [400, 409, 413, 422].includes(error.status)) {
          const latest = await this.pull(signal);
          current = await this.merge(latest, { rejected: sent.operationId, reason: error.message });
        } else {
          throw error;
        }
        head = current.pending[0];
        continue;
      }
      if (receipt.operationId !== sent.operationId || receipt.historyId !== historyId) {
        throw new Error('The server returned a receipt for another operation.');
      }
      const latest = await this.pull(signal);
      if (latest.historyId === historyId && latest.revision < receipt.revision) {
        throw new Error('The server state predates its own receipt.');
      }
      current = await this.merge(latest, { receipt });
      head = current.pending[0];
    }
    this.setPhase('synced');
  }
}
