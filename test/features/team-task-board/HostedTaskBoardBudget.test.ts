import {
  HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES,
  HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
  HOSTED_TASK_BOARD_MAX_PAGE_ITEMS,
  HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
  HostedTaskBoardBudget,
  measureHostedTaskBoardJsonBytes,
} from '@features/team-task-board/core/domain/models/HostedTaskBoardBudget';
import { describe, expect, it } from 'vitest';

describe('HostedTaskBoardBudget', () => {
  it('enforces the item budget deterministically', () => {
    const budget = new HostedTaskBoardBudget({
      itemLimit: 2,
      byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
      timeLimitMs: HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
      startedAtMs: 10,
    });

    expect(budget.admit({ taskId: 'one' }, 10)).toBe(true);
    expect(budget.admit({ taskId: 'two' }, 11)).toBe(true);
    expect(budget.admit({ taskId: 'three' }, 12)).toBe(false);
    expect(budget.truncationReasons()).toEqual(['item_budget']);
    expect(budget.metadata(13)).toMatchObject({
      itemLimit: 2,
      usedItems: 2,
      elapsedMs: 3,
    });
  });

  it('measures UTF-8 JSON bytes and reserves space for the page envelope', () => {
    expect(measureHostedTaskBoardJsonBytes('é')).toBe(4);
    const item = { subject: 'x'.repeat(32) };
    const itemBytes = measureHostedTaskBoardJsonBytes(item) + 1;
    const budget = new HostedTaskBoardBudget({
      itemLimit: 2,
      byteLimit: HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES + itemBytes,
      timeLimitMs: 10,
      startedAtMs: 0,
    });

    expect(budget.admit(item, 0)).toBe(true);
    expect(budget.admit(item, 1)).toBe(false);
    expect(budget.truncationReasons()).toEqual(['byte_budget']);
    expect(budget.metadata(1).usedBytes).toBe(HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES + itemBytes);
  });

  it('closes admission at the time boundary and keeps reason ordering stable', () => {
    const budget = new HostedTaskBoardBudget({
      itemLimit: 1,
      byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
      timeLimitMs: 10,
      startedAtMs: 100,
    });

    expect(budget.admit({ taskId: 'late' }, 110)).toBe(false);
    budget.mark('source_budget');
    budget.mark('byte_budget');
    expect(budget.truncationReasons()).toEqual(['byte_budget', 'time_budget', 'source_budget']);
  });

  it('rejects invalid or unbounded construction limits', () => {
    const base = {
      itemLimit: 1,
      byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
      timeLimitMs: HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
      startedAtMs: 0,
    };
    expect(
      () =>
        new HostedTaskBoardBudget({
          ...base,
          itemLimit: HOSTED_TASK_BOARD_MAX_PAGE_ITEMS + 1,
        })
    ).toThrow('hosted-task-board-budget-invalid');
    expect(
      () =>
        new HostedTaskBoardBudget({
          ...base,
          byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES + 1,
        })
    ).toThrow('hosted-task-board-budget-invalid');
    expect(
      () =>
        new HostedTaskBoardBudget({
          ...base,
          timeLimitMs: HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS + 1,
        })
    ).toThrow('hosted-task-board-budget-invalid');
  });
});
