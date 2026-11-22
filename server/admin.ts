import { resolve } from 'node:path';
import { backupDatabase, restoreDatabase } from './database.ts';
import { backupDaily, openVerifiedDatabase } from './maintenance.ts';

const [command, source, target, ...extra] = process.argv.slice(2);
if ((command === 'backup' || command === 'backup-daily') && source && target && extra.length === 0) {
  const db = openVerifiedDatabase(resolve(source));
  try {
    if (command === 'backup-daily') {
      const result = await backupDaily(db, resolve(target));
      console.log(result.created
        ? `Created ${result.name}. Removed ${result.pruned} old daily snapshots.`
        : `Verified the existing daily backup ${result.name}.`);
    } else {
      await backupDatabase(db, resolve(target));
      console.log('SQLite backup completed.');
    }
  } finally {
    db.close();
  }
} else if (command === 'restore' && source && target && extra.length === 0) {
  openVerifiedDatabase(resolve(source)).close();
  await restoreDatabase(resolve(source), resolve(target));
  console.log('Restored a new database with a new sync history.');
} else if (command === 'verify' && source && target === undefined) {
  openVerifiedDatabase(resolve(source)).close();
  console.log('SQLite integrity and Sudoku state verified.');
} else {
  console.error('Use npm run admin -- backup DB NEW_BACKUP, backup-daily DB DIRECTORY, restore BACKUP NEW_DB, or verify DB.');
  process.exitCode = 1;
}
