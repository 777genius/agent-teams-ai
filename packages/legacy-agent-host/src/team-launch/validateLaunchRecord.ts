import { validateNativeRetries } from './launchRetry.js';
import { TeamLaunchError } from './contracts.js';
import type { TeamLaunchRecord } from './contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { validateRestoreJournal } from './validateRestoreJournal.js';
import { validateResumePreparations } from './launchResume.js';
import { validateLaunchPreparation } from './launchPreparation.js';
/** Existing launch record validation, shared without another persistence authority. */
export function validateLaunchRecord(
  record: TeamLaunchRecord,
  fingerprint: string,
  memberCount: number
): void {
  if (
    new Set(record.members?.map((item) => item.memberId)).size !== record.members?.length ||
    record.schemaVersion !== 1 ||
    record.fingerprint !== fingerprint ||
    runtimeDigest(record.definition) !== fingerprint ||
    !Array.isArray(record.members) ||
    record.members.length !== memberCount ||
    !Array.isArray(record.retries)
  )
    throw new TeamLaunchError('hold', 'record-corrupt');
  if (
    record.startedAtMs !== undefined &&
    (!record.startCommandId ||
      !Number.isSafeInteger(record.startedAtMs) ||
      record.startedAtMs < 0 ||
      record.startedAtMs > 8_640_000_000_000_000)
  )
    throw new TeamLaunchError('hold', 'record-corrupt');
  validateNativeRetries(record);
  validateRestoreJournal(record);
  validateResumePreparations(record);
  if (
    record.sourceRosterRevision !== undefined &&
    (!record.startCommandId ||
      typeof record.sourceRosterRevision !== 'string' ||
      !record.sourceRosterRevision ||
      record.sourceRosterRevision.length > 256)
  )
    throw new TeamLaunchError('hold', 'record-corrupt');
  validateLaunchPreparation(record);
  for (const member of record.members) {
    if (
      !record.definition.members.some((item) => item.memberId === member.memberId) ||
      !Array.isArray(member.attempts) ||
      member.attempts.length < 1 ||
      member.attempts.length > 65
    )
      throw new TeamLaunchError('hold', 'record-corrupt');
    const attempt = member.attempts.find((a) => a.attemptId === member.currentAttemptId);
    if (!attempt) throw new TeamLaunchError('hold', 'attempt-corrupt');
    if (
      new Set(member.attempts.map((item) => item.attemptId)).size !== member.attempts.length ||
      member.attempts.at(-1)?.attemptId !== member.currentAttemptId ||
      ![
        'not-started',
        'pending-bootstrap',
        'pending-human',
        'ready',
        'failed',
        'unknown',
        'skipped',
      ].includes(attempt.status) ||
      typeof attempt.hostIncarnation !== 'string' ||
      typeof attempt.claimed !== 'boolean' ||
      [
        'nativeReady',
        'contextApplied',
        'everReady',
        'usable',
        'controlAvailable',
        'noAllocation',
      ].some((key) => typeof attempt[key as 'usable'] !== 'boolean') ||
      !Number.isSafeInteger(attempt.startedAtMs) ||
      !Number.isSafeInteger(attempt.deadlineMs) ||
      typeof attempt.reason !== 'string' ||
      attempt.reason.length > 128
    )
      throw new TeamLaunchError('hold', 'record-corrupt');
  }
}
