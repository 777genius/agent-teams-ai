import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';
import type { CommandReceipt } from './contracts.js';
import type { TaskSubmissionProof } from './commandProof.js';

// Leave room for the Host JSON-RPC envelope under its immutable 1 MiB frame cap.
const MAX_PRODUCT_RECEIPT_BYTES = 768 * 1024;
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify({ ok: true, value }));

function row(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function hasOversizedTaskHistory(receipt: CommandReceipt): boolean {
  const result = row(receipt.result);
  const task = receipt.command.operation === 'task.comment' || receipt.command.operation === 'task.start'
    ? row(result?.task)
    : result;
  const history = task?.historyEvents;
  // Main's mutation projection has a tighter history budget than the wire
  // frame. Full retained history remains available through bounded read pages.
  return Array.isArray(history) &&
    (history.length > 4096 || JSON.stringify(history).length > 512 * 1024);
}

/** Omit previously retained task history only in the response, never in the
 * canonical command ledger. Current mutation identity and immediate fields
 * remain available to existing Desktop projection.
 */
function compactTask(value: JsonValue): JsonValue {
  const task = row(value);
  if (!task) return value;
  const {
    comments: _comments,
    historyEvents: _history,
    workIntervals: _work,
    reviewIntervals: _reviews,
    sourceMessage: _source,
    descriptionTaskRefs: _descriptionRefs,
    promptTaskRefs: _promptRefs,
    description: _description,
    prompt: _prompt,
    ...remaining
  } = task;
  return remaining;
}

/** The immutable ledger remains the source of the digest and of every effect.
 * Desktop compares this proof with its captured command before accepting an ACK
 * or a lookup, including when the original transport reply was lost.
 */
function compactCommand(receipt: CommandReceipt, result: JsonValue | undefined): JsonValue {
  const { hostCommand: _hostCommand, workSyncNudge: _workSyncNudge, command, ...publicReceipt } = receipt;
  const taskSubmissionProof: TaskSubmissionProof | undefined =
    command.operation === 'task.create' || command.operation === 'task.comment'
      ? {
          schemaVersion: 1,
          commandSha256: digest(command),
          ...(command.operation === 'task.comment' ? { taskId: command.payload.taskId } : {}),
        }
      : undefined;
  const header = {
    commandId: command.commandId,
    operation: command.operation,
    // Original message identity is still checked by the delivery projection.
    ...(command.operation === 'message.send'
      ? { payload: { ...(command.payload.messageId === undefined ? {} :
          { messageId: command.payload.messageId }) } }
      : {}),
  };
  const projection = () => json({
    ...publicReceipt,
    command: header,
    result,
    ...(taskSubmissionProof ? { taskSubmissionProof } : {}),
  });
  let projected = projection();
  if (bytes(projected) <= MAX_PRODUCT_RECEIPT_BYTES) return projected;
  const applied = row(result);
  if (receipt.phase !== 'completed' || !applied) throw new TeamOwnerError('hold');
  // A single accepted string can itself approach the frame limit. Retain its
  // exact digest, so the caller can restore only its own matching original text.
  if (command.operation === 'task.create' && taskSubmissionProof &&
      typeof applied.subject === 'string') {
    taskSubmissionProof.taskSubjectSha256 = digest(applied.subject);
    const { subject: _subject, ...remaining } = applied;
    result = remaining;
  } else if (command.operation === 'task.comment' && taskSubmissionProof) {
    const comment = row(applied.comment);
    if (!comment || typeof comment.text !== 'string') throw new TeamOwnerError('hold');
    taskSubmissionProof.commentTextSha256 = digest(comment.text);
    const { text: _text, ...remaining } = comment;
    const task = row(applied.task);
    result = {
      ...applied,
      comment: remaining,
      ...(task ? { task: { id: task.id!, status: task.status! } } : {}),
    };
  }
  projected = projection();
  if (bytes(projected) > MAX_PRODUCT_RECEIPT_BYTES) throw new TeamOwnerError('hold');
  return projected;
}

function compactResult(receipt: CommandReceipt): JsonValue | undefined {
  const result = row(receipt.result);
  if (!result) return receipt.result;
  const operation = receipt.command.operation;
  if (operation === 'task.comment') {
    return {
      ...result,
      ...(result.task === undefined ? {} : { task: compactTask(result.task) }),
    };
  }
  if (operation === 'task.start') {
    return {
      ...result,
      ...(result.task === undefined ? {} : { task: compactTask(result.task) }),
    };
  }
  if (operation === 'task.board.order' || operation === 'task.board.review-flow') return undefined;
  if (operation === 'message.send') {
    // The canonical message is available through the paged history. Delivery
    // projection needs only its original IDs, never another full text copy.
    const { message: _message, ...delivery } = result;
    return delivery;
  }
  return compactTask(receipt.result!);
}

/** Bounded Host response projection; original receipt is untouched and
 * can be read again under current authority via command lookup.
 * This never fabricates a success phase or a new product outcome.
 */
export function boundProductCommandReceipt(receipt: CommandReceipt): JsonValue {
  const { hostCommand: _hostCommand, workSyncNudge: _workSyncNudge, ...publicReceipt } = receipt;
  const full = json(publicReceipt);
  if (bytes(full) <= MAX_PRODUCT_RECEIPT_BYTES && !hasOversizedTaskHistory(receipt)) return full;
  if (receipt.phase !== 'completed' && receipt.phase !== 'rejected')
    throw new TeamOwnerError('hold');
  const result = compactResult(receipt);
  const projected = json({
    ...publicReceipt,
    ...(result === undefined ? { result: undefined } : { result }),
  });
  return bytes(projected) <= MAX_PRODUCT_RECEIPT_BYTES
    ? projected
    : compactCommand(receipt, result);
}
