import type { Page } from '@playwright/test';
import type { Replica } from '../../src/sync/journal.ts';
import { DATABASE_NAME, REPLICA_STORE } from '../../src/sync/store.ts';

export function readReplica(page: Page): Promise<Replica> {
  return page.evaluate(({ database, store }) => new Promise<Replica>((resolve, reject) => {
    const opened = indexedDB.open(database, 1);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result;
      const request = db.transaction(store).objectStore(store).get('shared');
      request.onsuccess = () => { db.close(); resolve(request.result); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }), { database: DATABASE_NAME, store: REPLICA_STORE });
}
