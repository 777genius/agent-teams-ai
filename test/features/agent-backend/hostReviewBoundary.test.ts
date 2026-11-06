// @vitest-environment node
import {
  assertBoundedReviewValue,
  BOUND_REVIEW_TEAM,
  REVIEW_TRANSPORT_LIMITS,
} from '@agent-teams/task-change-ledger/review-transport';
import { describe, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';

import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';

const handle = { handleId: 'TEST-retained-review-owner' };
function setup() {
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  return { router, facade: new BackendOperationsFacade(router) };
}
describe('finite Main review boundary', () => {
  it('uses original command lookup with payload/current guard rather than generic command lookup', async () => {
    const { router, facade } = setup();
    const payload = {
      scope: { taskId: 'TEST-task' },
      expected: {
        method: 'saveEditedFile',
        args: [
          { teamName: BOUND_REVIEW_TEAM, taskId: 'TEST-task' },
          '/TEST/file.ts',
          'after',
          'before',
        ],
      },
    };
    router.request.mockResolvedValue({
      ok: true,
      value: {
        kind: 'review-command',
        commandId: 'TEST-original',
        method: 'saveEditedFile',
        origin: payload.scope,
        phase: 'held',
        outcome: 'unknown',
        responseAvailable: false,
        principalId: 'private-principal',
        references: { actionId: 'TEST-action', privatePath: '/private/owner' },
      },
    });
    expect(
      await facade.invoke({
        handle,
        commandId: 'TEST-original',
        operation: 'review.lookup',
        payload,
      })
    ).toEqual({
      ok: true,
      value: {
        kind: 'review-command',
        commandId: 'TEST-original',
        method: 'saveEditedFile',
        origin: payload.scope,
        phase: 'held',
        outcome: 'unknown',
        responseAvailable: false,
        references: { actionId: 'TEST-action' },
      },
    });
    expect(router.request).toHaveBeenCalledExactlyOnceWith(handle, {
      commandId: 'TEST-original',
      method: 'team.review.lookup',
      payload,
      control: true,
    });
    expect(router.lookup).not.toHaveBeenCalled();
    router.request.mockResolvedValue({
      ok: true,
      value: {
        kind: 'review-command',
        commandId: 'WRONG-replacement',
        method: 'saveEditedFile',
        origin: payload.scope,
        phase: 'completed',
        outcome: 'completed',
        responseAvailable: false,
      },
    });
    expect(
      await facade.invoke({
        handle,
        commandId: 'TEST-original',
        operation: 'review.lookup',
        payload,
      })
    ).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
  });
  it('rejects foreign Team, extra selector, and unknown method before any Host request', async () => {
    const { router, facade } = setup();
    const request = {
      handle,
      commandId: 'TEST-save',
      operation: 'review.invoke',
      payload: {
        scope: { taskId: 'TEST-task' },
        request: {
          method: 'saveEditedFile',
          args: [
            { teamName: 'foreign-team', taskId: 'TEST-task' },
            '/TEST/file.ts',
            'after',
            'before',
          ],
        },
      },
    };
    expect(await facade.invoke(request)).toEqual({
      ok: false,
      code: 'invalid',
      outcome: 'not-dispatched',
    });
    expect(await facade.invoke({ ...request, operation: 'review.arbitrary' })).toEqual({
      ok: false,
      code: 'invalid',
      outcome: 'not-dispatched',
    });
    expect(
      await facade.invoke({
        ...request,
        payload: {
          scope: { taskId: 'TEST-task', owner: 'WRONG' },
          request: { method: 'previewReject', args: ['/TEST/file.ts', 'before', 'after', [], []] },
        },
      })
    ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(router.request).not.toHaveBeenCalled();
    expect(router.lookup).not.toHaveBeenCalled();
  });
  it('projects bounded original recovery metadata without private arguments and rejects cross-scope inventories', async () => {
    const { router, facade } = setup();
    const request = {
      handle,
      commandId: 'TEST-refresh',
      operation: 'review.recovery.read',
      payload: { scope: { taskId: 'TEST-task' } },
    };
    const command = {
      commandId: 'TEST-original-wal-command',
      method: 'executeReviewMutation',
      phase: 'completed',
      outcome: 'completed',
      responseAvailable: false,
      references: {
        walId: 'TEST-actual-wal',
        actionId: 'TEST-actual-action',
        decisionRevision: 2,
        privatePath: '/private/owner',
      },
      args: ['PRIVATE-file-bytes'],
    };
    router.request.mockResolvedValue({
      ok: true,
      value: {
        kind: 'review-recovery',
        origin: request.payload.scope,
        commands: [command],
        principalId: 'PRIVATE-principal',
      },
    });
    expect(await facade.invoke(request)).toEqual({
      ok: true,
      value: {
        kind: 'review-recovery',
        origin: request.payload.scope,
        commands: [
          {
            commandId: command.commandId,
            method: command.method,
            phase: 'completed',
            outcome: 'completed',
            responseAvailable: false,
            references: {
              walId: 'TEST-actual-wal',
              actionId: 'TEST-actual-action',
              decisionRevision: 2,
            },
          },
        ],
      },
    });
    expect(router.request).toHaveBeenCalledExactlyOnceWith(handle, {
      commandId: request.commandId,
      method: 'team.review.recovery.read',
      payload: request.payload,
      control: true,
    });
    for (const value of [
      { kind: 'review-recovery', origin: { taskId: 'FOREIGN-task' }, commands: [command] },
      { kind: 'review-recovery', origin: request.payload.scope, commands: [command, command] },
      {
        kind: 'review-recovery',
        origin: request.payload.scope,
        commands: Array.from({ length: 65 }, (_, index) => ({
          ...command,
          commandId: `TEST-${index}`,
        })),
      },
    ]) {
      router.request.mockResolvedValue({ ok: true, value });
      expect(await facade.invoke(request)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
    }
  });
  it('enforces the independent review payload cap using encoded JSON bytes', () => {
    const payload = { after: 'x'.repeat(REVIEW_TRANSPORT_LIMITS.bytes - 12) };
    expect(() => assertBoundedReviewValue(payload)).not.toThrow();
    payload.after += 'x';
    expect(() => assertBoundedReviewValue(payload)).toThrow();
  });
});
