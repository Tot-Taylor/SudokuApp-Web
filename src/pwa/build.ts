import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

const icons = [180, 192, 512].map((size) => `/icons/sudoku-v1-${size}.png`);

export function offlineBuild(): Plugin {
  return {
    name: 'sudoku-offline',
    apply: 'build',
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const index = bundle['index.html'];
        if (index?.type !== 'asset') this.error('Sudoku requires a built index.html.');

        const files = Object.keys(bundle).filter((name) => name.startsWith('assets/')).sort();
        if (!files.some((name) => /^assets\/generator\.worker-.*\.js$/.test(name))) {
          this.error('The puzzle generator worker must be available for offline play.');
        }
        const essentials = files.map((name) => `/${name}`);
        const shell = `/assets/sudoku-shell-${createHash('sha256').update(index.source).digest('hex')}.html`;
        const worker = await readFile(new URL('./service-worker.js', import.meta.url), 'utf8');
        const version = createHash('sha256').update(worker).update(JSON.stringify([shell, ...essentials, ...icons]));
        for (const file of files) {
          const asset = bundle[file]!;
          version.update(asset.type === 'asset' ? asset.source : asset.code);
        }
        const iconBytes = await Promise.all(icons.map((icon) =>
          readFile(new URL(`../../public${icon}`, import.meta.url)),
        ));
        for (const bytes of iconBytes) version.update(bytes);
        const release = { cacheName: `sudoku-shell-${version.digest('hex')}`, shell, essentials, icons };

        this.emitFile({ type: 'asset', fileName: shell.slice(1), source: index.source });
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: `const release = ${JSON.stringify(release)};\n${worker}`,
        });
      },
    },
  };
}
