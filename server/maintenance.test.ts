import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase, readState } from './database.ts';
import { backupDaily, openVerifiedDatabase } from './maintenance.ts';

test('daily backup retains 30 verified snapshots and preserves manual backups', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'sudoku-retention-'));
  const db = openDatabase(':memory:');
  t.after(async () => {
    db.close();
    await rm(folder, { recursive: true, force: true });
  });

  const preserved = ['sudoku-preupdate.sqlite', 'sudoku-daily-2025-08-01.sqlite.partial', 'notes.txt'];
  for (const name of preserved) await writeFile(join(folder, name), 'fixture');
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(Date.UTC(2025, 7, day));
    const result = await backupDaily(db, folder, date);
    assert.equal(result.created, true);
    assert.equal(result.pruned, day === 31 ? 1 : 0);
  }
  const sameDay = await backupDaily(db, folder, new Date('2025-08-31T22:00:00Z'));
  assert.deepEqual(sameDay, { created: false, name: 'sudoku-daily-2025-08-31.sqlite', pruned: 0 });
  const names = await readdir(folder);
  assert.equal(names.length, 30 + preserved.length);
  assert.ok(names.includes('sudoku-daily-2025-08-02.sqlite'));
  assert.ok(!names.includes('sudoku-daily-2025-08-01.sqlite'));
  assert.ok(preserved.every((name) => names.includes(name)));
  const newest = openVerifiedDatabase(join(folder, sameDay.name));
  try {
    assert.equal(readState(newest).historyId, readState(db).historyId);
  } finally {
    newest.close();
  }
});

test('an invalid same-day file fails verification and leaves earlier backups available', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'sudoku-backup-test-'));
  const db = openDatabase(':memory:');
  t.after(async () => {
    db.close();
    await rm(folder, { recursive: true, force: true });
  });
  await backupDaily(db, folder, new Date('2025-08-01T00:00:00Z'));
  await writeFile(join(folder, 'sudoku-daily-2025-08-02.sqlite'), 'invalid backup');
  await assert.rejects(backupDaily(db, folder, new Date('2025-08-02T00:00:00Z')));
  const prior = openVerifiedDatabase(join(folder, 'sudoku-daily-2025-08-01.sqlite'));
  prior.close();
  assert.deepEqual((await readdir(folder)).sort(), [
    'sudoku-daily-2025-08-01.sqlite', 'sudoku-daily-2025-08-02.sqlite',
  ]);
});
