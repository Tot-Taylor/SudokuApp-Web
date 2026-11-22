import { generatePuzzle } from './generator.ts';
import type { GenerationRequest } from './generate-in-worker.ts';

globalThis.onmessage = ({ data }: MessageEvent<GenerationRequest>) => {
  globalThis.postMessage(generatePuzzle(data.difficulty, data.options));
};
