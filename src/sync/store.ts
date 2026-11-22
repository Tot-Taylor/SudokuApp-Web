import type { Replica } from './journal.ts';

export const DATABASE_NAME = 'sudoku-sync';
export const REPLICA_STORE = 'replica';

export class ReplicaStore {
  private opening: Promise<IDBDatabase> | undefined;

  private database(): Promise<IDBDatabase> {
    this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(REPLICA_STORE); };
      request.onblocked = () => reject(new Error('Another Sudoku tab is holding an older storage version.'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.opening = undefined; };
        db.onclose = () => { this.opening = undefined; };
        resolve(db);
      };
    }).catch((error) => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }

  async transact(update?: (previous: Replica | undefined) => Replica): Promise<Replica | undefined> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(REPLICA_STORE, update ? 'readwrite' : 'readonly',
        update ? { durability: 'strict' } : undefined);
      const store = transaction.objectStore(REPLICA_STORE);
      const read = store.get('shared');
      let value: Replica | undefined;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error ?? new Error('Local save was interrupted.'));
      read.onsuccess = () => {
        try {
          const old = read.result as Replica | undefined;
          value = update ? update(old) : old;
          if (update && value !== old && value) {
            value = { ...value, sequence: (old?.sequence ?? 0) + 1 };
            store.put(value, 'shared');
          }
        } catch (error) {
          reject(error);
          transaction.abort();
        }
      };
    });
  }
}
