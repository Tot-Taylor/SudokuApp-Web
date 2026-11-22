import { z } from 'zod';
import { completionSchema } from '../contracts/game.ts';
import type { ActiveGame, Completion } from '../contracts/game.ts';
import { restoreGame } from '../engine/game.ts';

export const PREVIEW_KEY = 'sudoku.preview.v1';

export type PreviewData = { activeGame: ActiveGame | null; completions: Completion[] };
type PreviewStorage = () => Pick<Storage, 'getItem'>;
const browserStorage: PreviewStorage = () => window.localStorage;

const previewSchema = z.strictObject({
  version: z.literal(1),
  activeGame: z.unknown(),
  completions: z.array(completionSchema),
});

export function loadPreview(storage: PreviewStorage = browserStorage): {
  data: PreviewData;
  issue: 'invalid-save' | 'session-only' | null;
} {
  const empty = { activeGame: null, completions: [] };
  let value: string | null;
  try {
    value = storage().getItem(PREVIEW_KEY);
  } catch {
    return { data: empty, issue: 'session-only' };
  }
  if (value === null) return { data: empty, issue: null };

  try {
    const stored = previewSchema.parse(JSON.parse(value));
    const completions = new Map<string, Completion>();
    for (const completion of stored.completions) {
      if (!completions.has(completion.gameId)) completions.set(completion.gameId, completion);
    }
    const snapshot = stored.activeGame === null ? null : restoreGame(stored.activeGame)?.snapshot;
    const activeGame = snapshot?.status === 'active' && !completions.has(snapshot.gameId) ? snapshot : null;
    return {
      data: { activeGame, completions: [...completions.values()] },
      issue: stored.activeGame !== null && activeGame === null ? 'invalid-save' : null,
    };
  } catch {
    return { data: empty, issue: 'invalid-save' };
  }
}
