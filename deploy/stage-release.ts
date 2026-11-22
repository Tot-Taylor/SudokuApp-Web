import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, lstatSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const [id, mode, ...extra] = process.argv.slice(2);
const localCheck = mode === '--local-check';
if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || (mode && !localCheck) || extra.length) {
  throw new Error('Use npm run release -- RELEASE-ID [--local-check] with a lowercase release ID.');
}

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourceCommit = git('rev-parse', '--verify', 'HEAD');

function checkSource() {
  if (localCheck) return;
  if (git('rev-parse', '--verify', 'HEAD') !== sourceCommit
    || git('status', '--porcelain=v1', '--untracked-files=all') !== '') {
    throw new Error('Deployable releases require a clean checkout of the reviewed commit. Use --local-check for rehearsal.');
  }
}
checkSource();

const releaseId = localCheck ? `local-check-${id}` : id;
const releases = join(root, 'releases');
const destination = join(releases, releaseId);
await mkdir(releases, { recursive: true });
if ((await realpath(releases)) !== releases) throw new Error('The release output directory must be inside the checkout.');
if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error('That release ID already exists.');

const runtimeFiles = [
  'package.json', 'package-lock.json', '.node-version',
  'server/admin.ts', 'server/app.ts', 'server/database.ts', 'server/main.ts', 'server/maintenance.ts',
  'src/contracts/game.ts', 'src/contracts/sync.ts',
  'src/engine/board.ts', 'src/engine/generator.ts', 'src/engine/solver.ts',
  'deploy/server.env.example', 'deploy/sudokuapp-web.service',
  'deploy/sudokuapp-web-backup.service', 'deploy/sudokuapp-web-backup.timer',
];
const publicFiles = [
  'manifest.webmanifest', 'icons/sudoku-v1-180.png', 'icons/sudoku-v1-192.png', 'icons/sudoku-v1-512.png',
];

async function copy(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

const staging = await mkdtemp(join(releases, '.staging-'));
if (dirname(staging) !== releases || !basename(staging).startsWith('.staging-')) {
  throw new Error('Release staging must be a dedicated directory inside the checkout.');
}
const contents = join(staging, 'contents');
try {
  // Keep ignored public files and local Vite environment files outside the artifact.
  await build({ root, mode: 'production', envDir: false, publicDir: false, build: { outDir: join(contents, 'dist') } });
  for (const file of runtimeFiles) await copy(join(root, file), join(contents, file));
  for (const file of publicFiles) await copy(join(root, 'public', file), join(contents, 'dist', file));
  checkSource();

  await writeFile(join(contents, 'release.json'), JSON.stringify({
    releaseId, sourceCommit, deployable: !localCheck,
  }, null, 2) + '\n');
  const archive = `sudokuapp-web-${releaseId}.tar.gz`;
  execFileSync('tar', ['-czf', join(staging, archive), '-C', contents, '.'], { stdio: 'inherit' });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(staging, archive))) hash.update(chunk);
  const digest = hash.digest('hex');
  await writeFile(join(staging, `${archive}.sha256`), `${digest}  ${archive}\n`);
  if ((await realpath(contents)) !== contents) throw new Error('Unexpected release contents directory.');
  await rm(contents, { recursive: true });
  await rename(staging, destination);
  console.log(`${localCheck ? 'Rehearsal' : 'Release'} archive: ${join(destination, archive)}`);
  console.log(`SHA-256: ${digest}`);
} finally {
  if (dirname(staging) === releases && basename(staging).startsWith('.staging-')) {
    await rm(staging, { recursive: true, force: true });
  }
}
