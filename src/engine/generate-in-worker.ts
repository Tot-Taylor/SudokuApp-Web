import type { Difficulty } from '../contracts/game.ts';
import type { GenerationOptions, GenerationResult } from './generator.ts';

export type GenerationRequest = { difficulty: Difficulty; options: GenerationOptions };

/** Runs one generation request off the UI thread. Abort when the user leaves or starts over. */
export async function generateInWorker(
  difficulty: Difficulty,
  options: GenerationOptions = {},
  signal?: AbortSignal,
): Promise<GenerationResult> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./generator.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    }

    function fail(error: unknown): void {
      cleanup();
      reject(error);
    }

    const abort = () => fail(signal?.reason);
    worker.onmessage = ({ data }: MessageEvent<GenerationResult>) => {
      cleanup();
      resolve(data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error('Puzzle generation failed.'));
    };
    worker.onmessageerror = () => fail(new Error('The puzzle generation response could not be read.'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      worker.postMessage({ difficulty, options } satisfies GenerationRequest);
    } catch (error) {
      fail(error);
    }
  });
}
