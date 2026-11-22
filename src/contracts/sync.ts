import { z } from 'zod';
import { SCHEMA_VERSION, activeGameSchema, completionSchema, solvedGameSchema, settingsSchema, statsSchema } from './game.ts';

const revisionSchema = z.int().nonnegative();

export const stateSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  historyId: z.uuid(),
  revision: revisionSchema,
  activeGame: activeGameSchema.nullable(),
  settings: settingsSchema,
  stats: statsSchema,
  completedGameIds: z.array(z.uuid()),
});

const mutationFields = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  historyId: z.uuid(),
  operationId: z.uuid(),
};

export const mutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...mutationFields,
    kind: z.literal('save-game'),
    game: activeGameSchema,
  }),
  z.strictObject({
    ...mutationFields,
    kind: z.literal('complete-game'),
    game: solvedGameSchema,
  }),
  z.strictObject({
    ...mutationFields,
    kind: z.literal('import-completion'),
    completion: completionSchema,
  }),
]);

export const receiptSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  historyId: z.uuid(),
  operationId: z.uuid(),
  revision: revisionSchema.min(1),
  outcome: z.enum(['applied', 'already-completed']),
});

export const syncErrorSchema = z.strictObject({
  code: z.enum([
    'INVALID_REQUEST',
    'ORIGIN_DENIED',
    'HISTORY_CHANGED',
    'OPERATION_ID_REUSED',
    'GAME_ID_REUSED',
    'GAME_ALREADY_COMPLETED',
    'INVALID_GAME',
    'UNAVAILABLE',
  ]),
  message: z.string().min(1),
});

export type SharedState = z.infer<typeof stateSchema>;
export type Mutation = z.infer<typeof mutationSchema>;
type WithoutEnvelope<T> = T extends Mutation ? Omit<T, 'schemaVersion' | 'historyId' | 'operationId'> : never;
export type Intent = WithoutEnvelope<Mutation>;
export type MutationReceipt = z.infer<typeof receiptSchema>;
export type SyncError = z.infer<typeof syncErrorSchema>;
