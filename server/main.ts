import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { openDatabase } from './database.ts';

const port = Number(process.env.SUDOKU_PORT ?? '4173');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid SUDOKU_PORT.');
const loopback = `http://127.0.0.1:${port}`;
const url = new URL(process.env.SUDOKU_ORIGIN ?? loopback);
if (url.href !== `${url.origin}/` || (url.protocol !== 'https:' && url.origin !== loopback)) {
  throw new Error('Set SUDOKU_ORIGIN to the HTTPS app origin or the local loopback URL.');
}
const db = openDatabase(resolve(process.env.SUDOKU_DB ?? 'sudoku.sqlite'));
const server = createApp(db, { origin: url.origin, directory: resolve('dist') });
server.listen(port, '127.0.0.1', () => { console.log(`Sudoku listening at ${loopback}`); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => db.close()));
}
