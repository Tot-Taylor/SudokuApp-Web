import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, readState } from './database.ts';

const retainedDailyBackups = 30;
const dailyFile = /^sudoku-daily-\d{4}-\d{2}-\d{2}\.sqlite$/;

export function openVerifiedDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const integrity = db.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') {
      throw new Error('SQLite integrity check failed.');
    }
    readState(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function backupDaily(db: DatabaseSync, directory: string, now = new Date()) {
  const name = `sudoku-daily-${now.toISOString().slice(0, 10)}.sqlite`;
  const target = join(directory, name);
  try {
    await backupDatabase(db, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Verify an existing same-day snapshot before treating this run as successful.
    openVerifiedDatabase(target).close();
    return { created: false, name, pruned: 0 };
  }
  openVerifiedDatabase(target).close();

  // Prune only completed files owned by this daily naming scheme, after publishing a new backup.
  const daily = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && dailyFile.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const stale = daily.slice(retainedDailyBackups);
  for (const old of stale) {
    await unlink(join(directory, old)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { created: true, name, pruned: stale.length };
}
