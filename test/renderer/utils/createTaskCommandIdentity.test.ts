import {
  canCloseCreateTaskDialog,
  resetCreateTaskSubmit,
  resolveCreateTaskCommand,
  tryBeginCreateTaskSubmit,
} from '@renderer/utils/createTaskCommandIdentity';
import { describe, expect, it, vi } from 'vitest';

describe('resolveCreateTaskCommand', () => {
  it('keeps one identity for an unchanged retry and rotates it when the intent changes', () => {
    const createCommandId = vi
      .fn<() => string>()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333');
    const request = { subject: 'Stable task', owner: 'alice' };

    const first = resolveCreateTaskCommand(null, 'team-a', request, createCommandId);
    const retry = resolveCreateTaskCommand(first, 'team-a', request, createCommandId);
    const changed = resolveCreateTaskCommand(
      retry,
      'team-a',
      { ...request, owner: 'bob' },
      createCommandId
    );
    const otherTeam = resolveCreateTaskCommand(changed, 'team-b', request, createCommandId);

    expect(retry).toBe(first);
    expect(changed.identity.commandId).toBe('22222222-2222-4222-8222-222222222222');
    expect(otherTeam.identity.commandId).toBe('33333333-3333-4333-8333-333333333333');
    expect(createCommandId).toHaveBeenCalledTimes(3);
  });

  it('treats relationship ids as sets when fingerprinting an intent', () => {
    const createCommandId = vi.fn<() => string>().mockReturnValue(
      '44444444-4444-4444-8444-444444444444'
    );
    const first = resolveCreateTaskCommand(
      null,
      'team-a',
      { subject: 'Stable relations', blockedBy: ['b', 'a'], related: ['d', 'c'] },
      createCommandId
    );
    const reordered = resolveCreateTaskCommand(
      first,
      'team-a',
      { subject: 'Stable relations', blockedBy: ['a', 'b'], related: ['c', 'd', 'c'] },
      createCommandId
    );

    expect(reordered).toBe(first);
    expect(createCommandId).toHaveBeenCalledTimes(1);
  });

  it('allows only one submit until the caller reports completion', () => {
    const gate = { inFlight: false };

    expect(tryBeginCreateTaskSubmit(gate)).toBe(true);
    expect(tryBeginCreateTaskSubmit(gate)).toBe(false);

    resetCreateTaskSubmit(gate);
    expect(tryBeginCreateTaskSubmit(gate)).toBe(true);
  });

  it('keeps the dialog open while a create request is in flight', () => {
    expect(canCloseCreateTaskDialog(true)).toBe(false);
    expect(canCloseCreateTaskDialog(false)).toBe(true);
  });
});
