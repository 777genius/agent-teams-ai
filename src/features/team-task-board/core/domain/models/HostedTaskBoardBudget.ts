import type {
  HostedTaskBoardBudgetMetadata,
  HostedTaskBoardTruncationReason,
} from '../../../contracts/hosted';

export const HOSTED_TASK_BOARD_MAX_PAGE_ITEMS = 100;
export const HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS = HOSTED_TASK_BOARD_MAX_PAGE_ITEMS + 1;
export const HOSTED_TASK_BOARD_MAX_PAGE_BYTES = 256 * 1024;
export const HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS = 5_000;

// Reserves space for page metadata, cursors, JSON punctuation, and future additive safe metadata.
export const HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES = 2 * 1024;

const textEncoder = new TextEncoder();

export function measureHostedTaskBoardJsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') {
    throw new TypeError('hosted-task-board-json-value-invalid');
  }
  return textEncoder.encode(encoded).byteLength;
}

export class HostedTaskBoardBudget {
  private readonly reasons = new Set<HostedTaskBoardTruncationReason>();
  private usedItems = 0;
  private usedBytes = HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES;

  constructor(
    private readonly limits: {
      readonly itemLimit: number;
      readonly byteLimit: number;
      readonly timeLimitMs: number;
      readonly startedAtMs: number;
    }
  ) {
    if (
      !Number.isSafeInteger(limits.itemLimit) ||
      limits.itemLimit < 1 ||
      limits.itemLimit > HOSTED_TASK_BOARD_MAX_PAGE_ITEMS ||
      !Number.isSafeInteger(limits.byteLimit) ||
      limits.byteLimit <= HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES ||
      limits.byteLimit > HOSTED_TASK_BOARD_MAX_PAGE_BYTES ||
      !Number.isSafeInteger(limits.timeLimitMs) ||
      limits.timeLimitMs < 1 ||
      limits.timeLimitMs > HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS ||
      !Number.isSafeInteger(limits.startedAtMs) ||
      limits.startedAtMs < 0
    ) {
      throw new TypeError('hosted-task-board-budget-invalid');
    }
  }

  admit(value: unknown, nowMs: number): boolean {
    if (this.elapsed(nowMs) >= this.limits.timeLimitMs) {
      this.reasons.add('time_budget');
      return false;
    }
    if (this.usedItems >= this.limits.itemLimit) {
      this.reasons.add('item_budget');
      return false;
    }

    const itemBytes = measureHostedTaskBoardJsonBytes(value) + 1;
    if (this.usedBytes + itemBytes > this.limits.byteLimit) {
      this.reasons.add('byte_budget');
      return false;
    }

    this.usedItems += 1;
    this.usedBytes += itemBytes;
    return true;
  }

  mark(reason: HostedTaskBoardTruncationReason): void {
    this.reasons.add(reason);
  }

  truncationReasons(): readonly HostedTaskBoardTruncationReason[] {
    const rank = new Map([
      ['item_budget', 0],
      ['byte_budget', 1],
      ['time_budget', 2],
      ['source_budget', 3],
    ] satisfies readonly (readonly [HostedTaskBoardTruncationReason, number])[]);
    return Object.freeze(
      [...this.reasons].sort((left, right) => rank.get(left)! - rank.get(right)!)
    );
  }

  metadata(nowMs: number): HostedTaskBoardBudgetMetadata {
    return Object.freeze({
      itemLimit: this.limits.itemLimit,
      byteLimit: this.limits.byteLimit,
      timeLimitMs: this.limits.timeLimitMs,
      usedItems: this.usedItems,
      usedBytes: this.usedBytes,
      elapsedMs: this.elapsed(nowMs),
    });
  }

  private elapsed(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError('hosted-task-board-clock-invalid');
    }
    return Math.max(0, nowMs - this.limits.startedAtMs);
  }
}
