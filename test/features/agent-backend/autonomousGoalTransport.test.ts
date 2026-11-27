// @vitest-environment node
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_INVOKE_CHANNEL,
  AGENT_BACKEND_OPERATIONS_ROUTE,
  hostTeamSelectionKey,
  readAutonomousGoalOptions,
  readAutonomousGoalStatus,
} from '../../../src/features/agent-backend/contracts';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { registerAgentBackendHttp } from '../../../src/features/agent-backend/main/adapters/input/registerAgentBackendHttp';
import { registerAgentBackendIpc } from '../../../src/features/agent-backend/main/adapters/input/registerAgentBackendIpc';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { controlAutonomousGoal } from '../../../src/features/agent-backend/renderer/controlAutonomousGoal';
import {
  buildPreparedSendRequest,
  isPreparedSendAllowed,
  restoredAutonomousGoalRequest,
} from '../../../src/renderer/components/team/messages/composerSendUtils';

import type {
  AgentBackendApi,
  AutonomousGoalStatus,
  BackendOperationRequest,
} from '../../../src/features/agent-backend/contracts';
import type { ResolvedTeamMember } from '../../../src/shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const goal: AutonomousGoalStatus = {
  goalId: 'TEST-goal',
  revision: 3,
  disposition: 'active',
  startedAt: '2026-11-27T08:00:00.000Z',
  deadlineAt: '2026-11-27T20:00:00.000Z',
  attemptLimit: 100,
  attemptsUsed: 4,
};
const handle = { handleId: 'TEST-handle' };
const teamName = hostTeamSelectionKey(handle.handleId);
const control = {
  handle,
  commandId: 'TEST-stop',
  operation: 'goal.control',
  payload: { goalId: goal.goalId, expectedRevision: goal.revision, action: 'stop' },
} satisfies BackendOperationRequest;

describe('bounded original goal transport', () => {
  it('retains an explicit Do or Delegate goal on the original message and rejects Ask/native options', () => {
    const message = {
      handle,
      commandId: 'TEST-message',
      operation: 'message.send',
      payload: {
        to: 'lead',
        text: 'Finish the report',
        actionMode: 'do',
        autonomousGoal: { durationHours: 12, maxAttempts: 100 },
      },
    };
    for (const actionMode of ['do', 'delegate']) {
      const request = { ...message, payload: { ...message.payload, actionMode } };
      expect(parseBackendOperation(request)).toEqual(request);
    }
    for (const patch of [
      { actionMode: 'ask' },
      { actionMode: undefined },
      { text: '/compact', nativeCommand: true },
      { autonomousGoal: { durationHours: 12, maxAttempts: 100, principalId: 'user' } },
    ])
      expect(() =>
        parseBackendOperation({ ...message, payload: { ...message.payload, ...patch } })
      ).toThrow();
    for (const options of [
      { durationHours: 0, maxAttempts: 100 },
      { durationHours: 25, maxAttempts: 100 },
      { durationHours: 12, maxAttempts: 0 },
      { durationHours: 12, maxAttempts: 1001 },
      { durationHours: 1.5, maxAttempts: 100 },
      { durationHours: 12, maxAttempts: Infinity },
    ])
      expect(() => readAutonomousGoalOptions(options)).toThrow();
  });

  it('keeps limits immutable in the captured direct-lead prepared request', () => {
    const options = { durationHours: 12, maxAttempts: 100 };
    const prepared = buildPreparedSendRequest({
      attemptId: 'TEST-original',
      teamName,
      selectedTeam: null,
      crossTeamRecipient: null,
      localRecipient: 'lead',
      text: 'Finish',
      summary: 'Finish',
      actionMode: 'delegate',
      autonomousGoal: options,
      attachments: [],
      taskRefs: [],
    });
    options.maxAttempts = 1;
    expect(prepared).toMatchObject({
      kind: 'local',
      request: {
        messageId: 'TEST-original',
        autonomousGoal: { durationHours: 12, maxAttempts: 100 },
      },
    });
    const members = [
      { name: 'lead', role: 'lead', agentType: 'team-lead' },
    ] as ResolvedTeamMember[];
    const content = {
      text: 'Finish',
      actionMode: 'delegate' as const,
      attachments: [],
      chips: [],
      autonomousGoal: { durationHours: 12, maxAttempts: 100 },
    };
    expect(isPreparedSendAllowed(content, prepared, members, teamName, true, undefined, true)).toBe(
      true
    );
    expect(isPreparedSendAllowed(content, prepared, members, teamName, true)).toBe(false);
    expect(
      isPreparedSendAllowed(
        { ...content, actionMode: 'ask' },
        prepared,
        members,
        teamName,
        true,
        undefined,
        true
      )
    ).toBe(false);
    expect(
      isPreparedSendAllowed(content, prepared, members, 'legacy-team', true, undefined, true)
    ).toBe(false);
    expect(
      isPreparedSendAllowed(content, prepared, members, teamName, false, undefined, true)
    ).toBe(false);
  });

  it('replays an unknown original unchanged after new goals become unavailable', () => {
    const original = buildPreparedSendRequest({
      attemptId: 'TEST-original',
      teamName,
      selectedTeam: null,
      crossTeamRecipient: null,
      localRecipient: 'lead',
      text: 'Finish',
      summary: 'Original summary',
      actionMode: 'do',
      attachments: [],
      autonomousGoal: { durationHours: 12, maxAttempts: 100 },
      taskRefs: [{ taskId: 'original-task', displayId: '1', teamName }],
    });
    if (original.kind !== 'local') throw new Error('Expected local original');
    const content = {
      text: 'Finish',
      chips: [],
      attachments: [],
      actionMode: 'do' as const,
      autonomousGoal: { durationHours: 12, maxAttempts: 100 },
      restoredOrigin: {
        kind: 'unconfirmed-send' as const,
        attemptId: 'retry-ui-id',
        messageId: 'TEST-original',
        autonomousGoalRequest: original,
      },
    };
    const replay = buildPreparedSendRequest({
      attemptId: 'new-ui-only-id',
      teamName,
      selectedTeam: null,
      crossTeamRecipient: null,
      localRecipient: 'lead',
      text: 'Finish',
      summary: 'A refreshed suggestion',
      actionMode: 'do',
      attachments: [],
      autonomousGoal: content.autonomousGoal,
      taskRefs: [],
      originalGoalRequest: original,
    });
    expect(replay).toEqual(original);
    const members = [
      { name: 'lead', role: 'lead', agentType: 'team-lead' },
    ] as ResolvedTeamMember[];
    expect(isPreparedSendAllowed(content, replay, members, teamName, true, undefined, false)).toBe(
      true
    );
    expect(
      restoredAutonomousGoalRequest({ ...content, text: 'Changed objective' }, teamName, 'lead')
    ).toBeUndefined();
    expect(
      isPreparedSendAllowed(
        { ...content, autonomousGoal: { durationHours: 24, maxAttempts: 100 } },
        replay,
        members,
        teamName,
        true,
        undefined,
        true
      )
    ).toBe(false);
    expect(restoredAutonomousGoalRequest(content, 'another-team', 'lead')).toBeUndefined();
  });

  it('routes controls through the existing facade and projects no private authority', async () => {
    const router = {
      request: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          ...goal,
          disposition: 'stopped',
          revision: 4,
          principalId: 'PRIVATE',
          nativeInputId: 'PRIVATE',
        },
      }),
      lookup: vi.fn(),
    };
    const facade = new BackendOperationsFacade(router);
    expect(await facade.invoke(control)).toEqual({
      ok: true,
      value: { ...goal, disposition: 'stopped', revision: 4 },
    });
    expect(router.request).toHaveBeenCalledWith(handle, {
      commandId: control.commandId,
      method: 'team.goal.control',
      payload: control.payload,
      control: true,
    });
    expect(() =>
      parseBackendOperation({ ...control, payload: { ...control.payload, attemptLimit: 200 } })
    ).toThrow();
    expect(() =>
      parseBackendOperation({ ...control, payload: { ...control.payload, action: 'extend' } })
    ).toThrow();
    expect(() =>
      parseBackendOperation({ ...control, payload: { ...control.payload, expectedRevision: 0 } })
    ).toThrow();
    expect(() => readAutonomousGoalStatus({ ...goal, attemptsUsed: 101 })).toThrow();
    router.request.mockResolvedValue({ ok: true, value: { ...goal, goalId: 'OTHER' } });
    expect(await facade.invoke(control)).toMatchObject({ ok: false, outcome: 'unknown' });
  });

  it('uses identical authenticated IPC and HTTP validation for goal controls', async () => {
    const router = {
      request: vi.fn().mockResolvedValue({ ok: true, value: { ...goal, disposition: 'stopped' } }),
      lookup: vi.fn(),
    };
    const facade = new BackendOperationsFacade(router);
    let invoke!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>;
    const ipc = {
      handle: vi.fn((channel: string, handler: typeof invoke) => {
        expect(channel).toBe(AGENT_BACKEND_INVOKE_CHANNEL);
        invoke = handler;
      }),
      removeHandler: vi.fn(),
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
    registerAgentBackendIpc(ipc, facade, () => true);
    const app = Fastify();
    registerAgentBackendHttp(app, facade, () => true);
    try {
      const viaIpc = await invoke({} as IpcMainInvokeEvent, control);
      const viaHttp = await app.inject({
        method: 'POST',
        url: AGENT_BACKEND_OPERATIONS_ROUTE,
        payload: control,
      });
      expect(viaHttp.json()).toEqual(viaIpc);
      const invalid = { ...control, payload: { ...control.payload, principalId: 'user' } };
      expect(await invoke({} as IpcMainInvokeEvent, invalid)).toMatchObject({
        ok: false,
        code: 'invalid',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: AGENT_BACKEND_OPERATIONS_ROUTE,
            payload: invalid,
          })
        ).json()
      ).toMatchObject({ ok: false, code: 'invalid' });
      expect(router.request).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('does not replay an unknown goal control or dispatch into a changed context', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('Transport lost'));
    const options = {
      backend: { invoke } as unknown as AgentBackendApi,
      teamName,
      commandId: 'TEST-once',
      request: control.payload,
      isCurrent: () => true,
    };
    await expect(controlAutonomousGoal(options)).rejects.toThrow('Transport lost');
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(controlAutonomousGoal({ ...options, isCurrent: () => false })).rejects.toThrow(
      'Team context changed'
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
