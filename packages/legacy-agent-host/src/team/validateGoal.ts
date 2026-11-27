import { TeamOwnerError } from './contracts.js';
import { safeSegment } from './identity.js';
import type { AutonomousGoalOptions, GoalCommandOrigin, GoalControl, GoalInputSource, GoalRecord } from './goalContracts.js';

const hash = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function validateGoalOptions(value: unknown): asserts value is AutonomousGoalOptions {
  if (!object(value) || Object.keys(value).some(key => !['durationHours', 'maxAttempts'].includes(key)) ||
      !Number.isSafeInteger(value.durationHours) || Number(value.durationHours) < 1 || Number(value.durationHours) > 24 ||
      !Number.isSafeInteger(value.maxAttempts) || Number(value.maxAttempts) < 1 || Number(value.maxAttempts) > 1000)
    throw new TeamOwnerError('invalid');
}

export function validateGoalSource(value: GoalInputSource): void {
  if (!object(value) || !object(value.binding) || typeof value.operationRef !== 'string' ||
      !value.operationRef || value.operationRef.length > 256 || value.operationRef.includes('\0') ||
      !hash.test(value.inputFingerprint)) throw new TeamOwnerError('hold');
  safeSegment(value.inputId);
  for (const key of ['backendId', 'teamId', 'runId', 'memberId', 'generation'] as const)
    safeSegment(value.binding[key]);
}

export function validateGoalOrigin(value: GoalCommandOrigin | undefined): void {
  if (value === undefined) return;
  if (!object(value) || typeof value.goalId !== 'string' || !Number.isSafeInteger(value.revision) ||
      value.revision < 1 || !['intake', 'input', 'task', 'continuation', 'result'].includes(value.kind))
    throw new TeamOwnerError('hold');
  safeSegment(value.goalId);
  if (value.source) validateGoalSource(value.source);
  if ((value.kind === 'input' || value.kind === 'continuation') && !value.source)
    throw new TeamOwnerError('hold');
  if (value.kind === 'continuation') {
    const next = value.continuation;
    if (!next || !Number.isSafeInteger(next.sequence) || next.sequence < 1 ||
        !['productive', 'recovery', 'wait'].includes(next.reason) || !hash.test(next.evidenceFingerprint) ||
        typeof next.obligationKey !== 'string' || next.obligationKey.length > 256 || !next.obligationKey ||
        typeof next.text !== 'string' || !next.text.trim() || next.text.length > 8192)
      throw new TeamOwnerError('hold');
    validateGoalSource(next.source);
  } else if (value.continuation) throw new TeamOwnerError('hold');
}

export function validateGoalRecord(value: GoalRecord): void {
  if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !['active', 'finalizing', 'accepted', 'stopped'].includes(value.disposition) ||
      !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.deadlineAt)) ||
      Date.parse(value.deadlineAt) < Date.parse(value.startedAt) ||
      !Number.isSafeInteger(value.attemptLimit) || value.attemptLimit < 1 || value.attemptLimit > 1000 ||
      !object(value.debits) || Object.keys(value.debits).length > value.attemptLimit ||
      (value.controls && (!object(value.controls) || Object.keys(value.controls).length > 256)) ||
      (value.proposals && (!object(value.proposals) || Object.keys(value.proposals).length > 256))) throw new TeamOwnerError('hold');
  safeSegment(value.goalId);
  if (value.disposition === 'accepted' && !value.proposal) throw new TeamOwnerError('hold');
}

export function validateGoalControl(value: GoalControl): void {
  if (!object(value) || Object.keys(value).some(key => ![
    'commandId', 'goalId', 'expectedRevision', 'action', 'deadlineAt', 'attemptLimit',
  ].includes(key)) || typeof value.commandId !== 'string' || !value.commandId.trim() ||
      value.commandId.length > 256 || value.commandId.includes('\0') ||
      !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 ||
      !['stop', 'resume', 'extend'].includes(value.action)) throw new TeamOwnerError('invalid');
  safeSegment(value.goalId);
  if (value.action !== 'extend' && (value.deadlineAt !== undefined || value.attemptLimit !== undefined))
    throw new TeamOwnerError('invalid');
  if (value.attemptLimit !== undefined && (!Number.isSafeInteger(value.attemptLimit) || value.attemptLimit < 1 || value.attemptLimit > 1000))
    throw new TeamOwnerError('invalid');
  if (value.deadlineAt !== undefined && (!Number.isFinite(Date.parse(value.deadlineAt)) || new Date(value.deadlineAt).toISOString() !== value.deadlineAt))
    throw new TeamOwnerError('invalid');
}
