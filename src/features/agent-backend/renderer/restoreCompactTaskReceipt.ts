import { stableJson } from '@agent-teams/legacy-agent-host/team/command-proof';

import { HostTeamOperationError } from '../contracts/taskSubmission';

import type { BackendCommandReceipt, BackendOperationRequest } from '../contracts/operations';

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Rehydrate only text independently bound by the original Owner's result digest.
 * The original command, scope and remaining effect checks are still mandatory.
 */
export async function restoreCompactTaskReceipt(
  receipt: BackendCommandReceipt,
  command: Omit<BackendOperationRequest, 'handle'>
): Promise<void> {
  const proof = receipt.taskSubmissionProof;
  const invalid = (): never => {
    throw new HostTeamOperationError('invalid-correlation', 'unknown', command.commandId);
  };
  if (
    !proof ||
    proof.schemaVersion !== 1 ||
    receipt.taskSubmission !== undefined ||
    !/^[a-f0-9]{64}$/.test(proof.commandSha256) ||
    !['completed', 'rejected'].includes(receipt.phase)
  )
    return invalid();
  if ((await digest(command)) !== proof.commandSha256) return invalid();
  if (command.operation === 'task.create') {
    if (proof.taskId !== undefined || proof.commentTextSha256 !== undefined) return invalid();
    if (proof.taskSubjectSha256 !== undefined) {
      const subject = 'subject' in command.payload ? command.payload.subject : undefined;
      if (
        receipt.phase !== 'completed' ||
        !receipt.task ||
        receipt.task.subject !== undefined ||
        typeof subject !== 'string' ||
        (await digest(subject.trim())) !== proof.taskSubjectSha256
      )
        return invalid();
      receipt.task.subject = subject.trim();
    }
  } else if (command.operation === 'task.comment') {
    if (
      !('taskId' in command.payload) ||
      proof.taskId !== command.payload.taskId ||
      proof.taskSubjectSha256 !== undefined
    )
      return invalid();
    if (proof.commentTextSha256 !== undefined) {
      const text = 'text' in command.payload ? command.payload.text : undefined;
      if (
        receipt.phase !== 'completed' ||
        !receipt.comment ||
        receipt.comment.text !== undefined ||
        typeof text !== 'string' ||
        (await digest(text)) !== proof.commentTextSha256
      )
        return invalid();
      receipt.comment.text = text;
    }
  } else return invalid();
}
