import { TeamOwnerError } from './contracts.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';
import type { CommandReceipt } from './contracts.js';

// Leave room for the Host JSON-RPC envelope under its immutable 1 MiB frame cap.
const MAX_PRODUCT_RECEIPT_BYTES = 768 * 1024;
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify({ ok: true, value }));

function row(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
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
    ...remaining
  } = task;
  return remaining;
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
  if (operation === 'task.board.order') return undefined;
  if (operation === 'message.send') return receipt.result;
  return compactTask(receipt.result!);
}

/** Bounded Host response projection; original receipt is untouched and
 * can be read again under current authority via command lookup.
 * This never fabricates a success phase or a new product outcome.
 */
export function boundProductCommandReceipt(receipt: CommandReceipt): JsonValue {
  const full = json(receipt);
  if (bytes(full) <= MAX_PRODUCT_RECEIPT_BYTES) return full;
  if (receipt.phase !== 'completed') throw new TeamOwnerError('hold');
  const result = compactResult(receipt);
  const projected = json({
    ...receipt,
    ...(result === undefined ? { result: undefined } : { result }),
  });
  if (bytes(projected) > MAX_PRODUCT_RECEIPT_BYTES)
    throw new TeamOwnerError('hold');
  return projected;
}
