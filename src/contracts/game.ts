import { z } from 'zod';

export const SCHEMA_VERSION = 1;
export const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_RULES = {
  easy: { label: 'Easy', minClues: 40, maxClues: 81, complexity: 'singles' },
  medium: { label: 'Medium', minClues: 33, maxClues: 39, complexity: 'singles' },
  hard: { label: 'Hard', minClues: 28, maxClues: 32, complexity: 'advanced-search' },
  expert: { label: 'Expert', minClues: 22, maxClues: 27, complexity: 'advanced-search' },
} as const satisfies Record<Difficulty, {
  label: string;
  minClues: number;
  maxClues: number;
  complexity: 'singles' | 'advanced-search';
}>;

const digitSchema = z.int().min(1).max(9);
const boardSchema = z.array(digitSchema.nullable()).length(81);
export const durationSchema = z.int().nonnegative();

const gameFields = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  gameId: z.uuid(),
  difficulty: z.enum(DIFFICULTIES),
  givens: boardSchema,
  solution: z.array(digitSchema).length(81),
  values: boardSchema,
  selectedCell: z.int().min(0).max(80).nullable(),
  elapsedMs: durationSchema,
};

const activeShape = z.strictObject({ ...gameFields, status: z.literal('active') });
const solvedShape = z.strictObject({ ...gameFields, status: z.literal('solved') });

type SnapshotShape = z.output<typeof activeShape> | z.output<typeof solvedShape>;

function validateSnapshot(game: SnapshotShape, ctx: z.RefinementCtx): void {
  let matchesSolution = true;
  let editableCells = 0;

  for (const [index, given] of game.givens.entries()) {
    const solution = game.solution[index];
    const value = game.values[index];

    if (given === null) {
      editableCells += 1;
    } else if (given !== solution || given !== value) {
      ctx.addIssue({
        code: 'custom',
        path: ['givens', index],
        message: 'A given must match both the solution and the current value.',
      });
    }

    matchesSolution &&= value === solution;
  }

  if (editableCells === 0) {
    ctx.addIssue({ code: 'custom', path: ['givens'], message: 'A game must have an editable cell.' });
  }

  if (game.selectedCell !== null && game.givens[game.selectedCell] !== null) {
    ctx.addIssue({ code: 'custom', path: ['selectedCell'], message: 'The selected cell must be editable.' });
  }

  if ((game.status === 'solved') !== matchesSolution) {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'A game is solved exactly when its values match the solution.',
    });
  }
}

export const activeGameSchema = activeShape.superRefine(validateSnapshot);
export const solvedGameSchema = solvedShape.superRefine(validateSnapshot);
export const gameSnapshotSchema = z.discriminatedUnion('status', [activeGameSchema, solvedGameSchema]);
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
export type ActiveGame = z.infer<typeof activeGameSchema>;
export type SolvedGame = z.infer<typeof solvedGameSchema>;

export const completionSchema = z.strictObject({
  gameId: z.uuid(),
  difficulty: z.enum(DIFFICULTIES),
  elapsedMs: durationSchema,
});

export type Completion = z.infer<typeof completionSchema>;

const difficultyStatsSchema = z.strictObject({
  completedCount: z.int().nonnegative(),
  totalTimeMs: durationSchema,
  bestTimeMs: durationSchema.nullable(),
}).refine(({ completedCount, totalTimeMs, bestTimeMs }) =>
  completedCount === 0
    ? totalTimeMs === 0 && bestTimeMs === null
    : bestTimeMs !== null && bestTimeMs <= totalTimeMs,
);

export const statsSchema = z.record(z.enum(DIFFICULTIES), difficultyStatsSchema);
export type Stats = z.infer<typeof statsSchema>;

export function completionStats(completions: readonly Completion[], base?: Stats): Stats {
  const stats: Stats = {
    easy: { ...base?.easy ?? { completedCount: 0, totalTimeMs: 0, bestTimeMs: null } },
    medium: { ...base?.medium ?? { completedCount: 0, totalTimeMs: 0, bestTimeMs: null } },
    hard: { ...base?.hard ?? { completedCount: 0, totalTimeMs: 0, bestTimeMs: null } },
    expert: { ...base?.expert ?? { completedCount: 0, totalTimeMs: 0, bestTimeMs: null } },
  };
  for (const { difficulty, elapsedMs } of completions) {
    const bucket = stats[difficulty];
    bucket.completedCount += 1;
    bucket.totalTimeMs += elapsedMs;
    bucket.bestTimeMs = Math.min(bucket.bestTimeMs ?? elapsedMs, elapsedMs);
  }
  return stats;
}

// Reserved until the product enables a preference that can be edited.
export const settingsSchema = z.strictObject({});
