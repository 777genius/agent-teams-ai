import { z } from 'zod';
import { nativeProfilePathSchema } from './nativeProcessProfile.js';

const id = z.string().min(1).max(128).refine(value => !value.includes('\0'));
const tools = z.array(z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/u.test(value))).max(256);

/** App choices only. Native paths, environment, account and protocol come from the captured Host. */
export const scheduledRunInputSchema = z.object({
  runId: id,
  scheduleId: id,
  expectedRosterRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  config: z.object({
    cwd: nativeProfilePathSchema,
    prompt: z.string().min(1).max(64 * 1024).refine(value => Buffer.byteLength(value) <= 64 * 1024),
    providerId: z.enum(['anthropic', 'codex']).optional(),
    providerBackendId: z.enum(['auto', 'adapter', 'api', 'cli-sdk', 'codex-native']).optional(),
    model: z.string().min(1).max(256).optional(),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    fastMode: z.enum(['inherit', 'on', 'off']).optional(),
    resolvedFastMode: z.boolean().optional(),
    skipPermissions: z.boolean().optional(),
    allowedTools: tools.optional(),
    disallowedTools: tools.optional(),
  }).strict(),
  maxTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxBudgetUsd: z.number().finite().nonnegative().optional(),
}).strict();
export type ScheduledRunInput = z.infer<typeof scheduledRunInputSchema>;
export const scheduledRunKeySchema = z.object({ runId: id, scheduleId: id }).strict();

export const scheduledRunSnapshotSchema = z.object({
  runId: id,
  phase: z.enum(['running', 'completed', 'interrupted', 'held']),
  cleanup: z.enum(['confirmed', 'unresolved']),
  result: z.object({
    exitCode: z.number().int().nullable(),
    stdout: z.string().max(512 * 1024),
    stderr: z.string().max(16 * 1024),
    summary: z.string().max(500),
    durationMs: z.number().finite().nonnegative(),
  }).strict().optional(),
}).strict();
export type ScheduledRunSnapshot = z.infer<typeof scheduledRunSnapshotSchema>;
