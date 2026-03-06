import { z } from 'zod';
import { sep, isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Matches teamctl's `isSafePathSegment()`:
 * rejects empty, '.', '..', and strings containing '/', '\\', '\0', or '..'
 */
const safePathSegment = (label: string) =>
  z
    .string()
    .min(1)
    .max(128)
    .refine(
      (v) =>
        v.trim().length > 0 &&
        v !== '.' &&
        v !== '..' &&
        !v.includes('/') &&
        !v.includes('\\') &&
        !v.includes('\0') &&
        !v.includes('..'),
      { message: `Invalid ${label}: must be a safe path segment` },
    );

/** Team name — folder inside `~/.claude/teams/` */
export const teamNameSchema = safePathSegment('team name').describe(
  'Team name (folder in ~/.claude/teams/)',
);

/** Numeric task ID produced by teamctl's highwatermark counter */
export const taskIdSchema = z
  .string()
  .regex(/^\d{1,10}$/, 'Task ID must be a positive integer (e.g. "1", "42")')
  .describe('Numeric task ID');

/** Team member name — folder inside inboxes, safe path segment */
export const memberNameSchema = safePathSegment('member name').describe(
  'Team member name',
);

// ---------------------------------------------------------------------------
// Enums — match teamctl's normalizeStatus / normalizeColumn / etc.
// ---------------------------------------------------------------------------

export const taskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'deleted',
]);

export const kanbanColumnSchema = z
  .enum(['review', 'approved'])
  .describe('Kanban column to move task to');

export const clarificationSchema = z
  .enum(['lead', 'user', 'clear'])
  .describe('Who needs to clarify: lead, user, or clear the flag');

export const linkTypeSchema = z
  .enum(['blocked-by', 'blocks', 'related'])
  .describe('Relationship type between tasks');

export const linkOperationSchema = z.enum(['link', 'unlink']);

export const reviewDecisionSchema = z.enum(['approve', 'request-changes']);

export const reviewerOperationSchema = z.enum(['list', 'add', 'remove']);

// ---------------------------------------------------------------------------
// Composite schemas
// ---------------------------------------------------------------------------

/** Comma-separated task IDs sent as a single CLI argument */
export const taskIdsArraySchema = z
  .array(taskIdSchema)
  .describe('Array of task IDs (e.g. ["1", "3"])');

// ---------------------------------------------------------------------------
// File / attachment schemas — defence-in-depth for CLI arguments
// ---------------------------------------------------------------------------

/** Absolute file path without traversal sequences */
export const filePathSchema = z
  .string()
  .min(1)
  .refine((p) => isAbsolute(p), { message: 'Path must be absolute' })
  .refine((p) => !p.split(sep).includes('..'), {
    message: 'Path must not contain traversal sequences (..)',
  })
  .refine((p) => !p.includes('\0'), {
    message: 'Path must not contain null bytes',
  });

/** Safe filename — no path separators, no null bytes, reasonable length */
export const safeFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (f) => !f.includes('/') && !f.includes('\\') && !f.includes('\0'),
    { message: 'Filename must not contain path separators or null bytes' },
  );

/** MIME type — standard type/subtype format */
export const mimeTypeSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/,
    'Invalid MIME type format (expected type/subtype)',
  );
