import { createHash } from 'node:crypto';

import { stableJson } from '@agent-teams/legacy-agent-host/team/command-proof';

import type { BackendCommandReceipt, BackendOperationRequest } from '../../../contracts/operations';
import type { TaskSubmissionProof } from '@agent-teams/legacy-agent-host/team/command-proof';

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid compact task receipt');
  return value as Record<string, unknown>;
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256)
    throw new Error('Invalid compact task identity');
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Invalid compact task proof');
  return value;
}

/** A digest from the authorized original Owner, never from the renderer request. */
export function projectCompactTaskSubmission(
  source: Record<string, unknown>,
  request: BackendOperationRequest
): Pick<BackendCommandReceipt, 'taskSubmissionProof' | 'taskSubmissionNoEffect'> {
  const command = row(source.command);
  const proof = row(source.taskSubmissionProof);
  if (
    Object.keys(command).some((key) => !['commandId', 'operation'].includes(key)) ||
    command.commandId !== request.commandId ||
    source.commandId !== command.commandId ||
    !['task.create', 'task.comment'].includes(String(command.operation)) ||
    proof.schemaVersion !== 1 ||
    Object.keys(proof).some(
      (key) =>
        ![
          'schemaVersion',
          'commandSha256',
          'taskId',
          'taskSubjectSha256',
          'commentTextSha256',
        ].includes(key)
    ) ||
    !['completed', 'rejected'].includes(String(source.phase))
  )
    throw new Error('Invalid compact task receipt');
  const projected: TaskSubmissionProof = {
    schemaVersion: 1,
    commandSha256: sha256(proof.commandSha256),
  };
  if (command.operation === 'task.comment') projected.taskId = identity(proof.taskId);
  else if (proof.taskId !== undefined) throw new Error('Unexpected compact task identity');

  if (request.operation !== 'command.lookup') {
    if (
      request.operation !== command.operation ||
      createHash('sha256')
        .update(
          stableJson({
            commandId: request.commandId,
            operation: request.operation,
            payload: request.payload,
          })
        )
        .digest('hex') !== projected.commandSha256 ||
      (request.operation === 'task.comment' && request.payload.taskId !== projected.taskId)
    )
      throw new Error('Wrong compact original task command');
  }
  const applied = row(source.result);
  if (source.phase === 'rejected') {
    if (
      Object.keys(applied).length !== 2 ||
      applied.rejected !== true ||
      applied.reason !== 'policy' ||
      proof.taskSubjectSha256 !== undefined ||
      proof.commentTextSha256 !== undefined
    )
      throw new Error('Invalid compact task refusal');
    return { taskSubmissionProof: projected, taskSubmissionNoEffect: true };
  }
  const effects = row(source.effects);
  if (command.operation === 'task.create') {
    if (identity(applied.id) !== identity(effects.taskId) || proof.commentTextSha256 !== undefined)
      throw new Error('Wrong compact task effect');
    if (proof.taskSubjectSha256 !== undefined) {
      if (applied.subject !== undefined) throw new Error('Ambiguous compact task subject');
      projected.taskSubjectSha256 = sha256(proof.taskSubjectSha256);
    }
  } else {
    const comment = row(applied.comment);
    if (
      identity(comment.id) !== identity(effects.commentId) ||
      (applied.task !== undefined && identity(row(applied.task).id) !== projected.taskId) ||
      proof.taskSubjectSha256 !== undefined
    )
      throw new Error('Wrong compact comment effect');
    if (proof.commentTextSha256 !== undefined) {
      if (comment.text !== undefined) throw new Error('Ambiguous compact comment text');
      projected.commentTextSha256 = sha256(proof.commentTextSha256);
    }
  }
  return { taskSubmissionProof: projected };
}
