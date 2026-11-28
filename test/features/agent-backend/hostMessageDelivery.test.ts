import { describe, expect, it, vi } from 'vitest';

import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type {
  AgentBackendApi,
  BackendCommandReceipt,
  BackendRuntimeSnapshot,
} from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';

const team = hostTeamSelectionKey('owner');
const messageId = 'group-message:g:recipient';
function fixture() {
  let scope = 0;
  const receipt: BackendCommandReceipt = {
    commandId: messageId,
    operation: 'message.send',
    phase: 'completed',
    messageId,
    deliveryId: 'original-input',
    messageDelivery: {
      memberId: 'member',
      generation: 'original-generation',
      inputId: 'original-input',
    },
  };
  const runtime: BackendRuntimeSnapshot = {
    memberId: 'member',
    generation: 'original-generation',
    phase: 'allocated',
    sealed: false,
    attached: true,
    custody: 'owned',
    nativeReady: true,
    inputs: [{ inputId: 'original-input', phase: 'admitted' }],
    interactions: [],
  };
  const backend = {
    getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({
      state: 'ready',
      bindings: [
        {
          handle: { handleId: 'owner' },
          label: 'Team',
          members: [],
          ownerResourceRef: 'owner-resource',
          teamResourceRef: 'team-resource',
        },
      ],
    })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation === 'command.lookup')
        return { ok: true, value: structuredClone(receipt) };
      if (request.operation === 'runtime.read')
        return { ok: true, value: structuredClone(runtime) };
      throw new Error('Unexpected effect');
    }),
  } as unknown as AgentBackendApi;
  const legacy = { getOpenCodeRuntimeDeliveryStatus: vi.fn() } as unknown as TeamsAPI;
  const order = new TeamProductReadOrder();
  const teams = createHostTeamsApi(
    legacy,
    backend,
    () => {
      const original = scope;
      return () => scope === original;
    },
    order
  );
  return {
    receipt,
    runtime,
    backend,
    legacy,
    order,
    changeScope: () => {
      scope++;
    },
    read: (id = messageId) => teams.getHostMessageDeliveryStatus!(team, id),
  };
}

describe('Host group delivery observations through the ordinary Teams API', () => {
  it.each(['', ' leading', 'trailing ', 'x\tx', 'x\u007f', 'x'.repeat(257)])(
    'rejects an invalid original message identity before any owner read',
    async (id) => {
      const f = fixture();
      await expect(f.read(id)).rejects.toThrow('invalid');
      expect(f.backend.getConnections).not.toHaveBeenCalled();
      expect(f.backend.invoke).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['admitted', 'pending', true],
    ['claimed', 'pending', true],
    ['consumed', 'confirmed', false],
    ['terminal', 'confirmed', false],
    ['unknown', 'unconfirmed', true],
    ['not-sent', 'unconfirmed', false],
    ['cancelled', 'unconfirmed', false],
    ['rejected', 'unconfirmed', false],
  ] as const)(
    'reads the original input phase %s without legacy ledger or another delivery',
    async (phase, confirmation, responsePending) => {
      const f = fixture();
      f.runtime.inputs[0].phase = phase;
      // A different input with a successful turn must never confirm this group recipient.
      f.runtime.inputs.unshift({
        inputId: 'unrelated-input',
        phase: 'terminal',
        terminal: 'succeeded',
      });
      expect(await f.read()).toEqual({
        source: 'captured-host',
        messageId,
        confirmation,
        responsePending,
        phase,
      });
      expect(
        vi.mocked(f.backend.invoke).mock.calls.map(([request]) => ({
          operation: request.operation,
          commandId: request.commandId,
          handle: request.handle,
          payload: request.payload,
        }))
      ).toEqual([
        {
          operation: 'command.lookup',
          commandId: messageId,
          handle: { handleId: 'owner' },
          payload: {},
        },
        {
          operation: 'runtime.read',
          commandId: expect.any(String),
          handle: { handleId: 'owner' },
          payload: { memberId: 'member', expectedGeneration: 'original-generation' },
        },
        {
          operation: 'command.lookup',
          commandId: messageId,
          handle: { handleId: 'owner' },
          payload: {},
        },
      ]);
      expect(f.legacy.getOpenCodeRuntimeDeliveryStatus).not.toHaveBeenCalled();
    }
  );

  it('keeps absent Runtime admission pending and does not promote an unrelated completed input', async () => {
    const f = fixture();
    f.runtime.inputs = [{ inputId: 'unrelated-input', phase: 'terminal', terminal: 'succeeded' }];
    expect(await f.read()).toMatchObject({
      confirmation: 'pending',
      responsePending: true,
      phase: 'pending-admission',
    });
  });

  it('retains a receipt without native delivery as unconfirmed and performs no Runtime read', async () => {
    const f = fixture();
    delete f.receipt.messageDelivery;
    delete f.receipt.deliveryId;
    expect(await f.read()).toMatchObject({
      confirmation: 'unconfirmed',
      responsePending: false,
      phase: 'unavailable',
    });
    expect(
      vi.mocked(f.backend.invoke).mock.calls.every(([r]) => r.operation === 'command.lookup')
    ).toBe(true);
  });

  it.each(['send', 'message.send'])(
    'rejects a group product receipt with operation %s before reading Runtime delivery',
    async (operation) => {
      const f = fixture();
      vi.mocked(f.backend.invoke).mockResolvedValue({
        ok: true,
        value: { kind: 'group-chat-command', commandId: messageId, operation, phase: 'completed' },
      });
      await expect(f.read()).rejects.toThrow('invalid-result');
      expect(f.backend.invoke).toHaveBeenCalledTimes(1);
      expect(f.legacy.getOpenCodeRuntimeDeliveryStatus).not.toHaveBeenCalled();
    }
  );

  it.each(['message', 'member', 'generation', 'duplicate-input', 'delivery-id'] as const)(
    'rejects a mismatched %s instead of reading or reporting another delivery',
    async (change) => {
      const f = fixture();
      if (change === 'message') f.receipt.messageId = 'other-message';
      if (change === 'member') f.runtime.memberId = 'other-member';
      if (change === 'generation') f.runtime.generation = 'replacement';
      if (change === 'duplicate-input') f.runtime.inputs.push({ ...f.runtime.inputs[0] });
      if (change === 'delivery-id') f.receipt.deliveryId = 'other-input';
      await expect(f.read()).rejects.toThrow('invalid-result');
      expect(f.legacy.getOpenCodeRuntimeDeliveryStatus).not.toHaveBeenCalled();
    }
  );

  it.each(['scope', 'mutation', 'owner', 'receipt'] as const)(
    'refuses an observation crossing a changed %s',
    async (change) => {
      const f = fixture();
      const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
      vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
        const result = await invoke(request);
        if (request.operation === 'runtime.read') {
          if (change === 'scope') f.changeScope();
          if (change === 'mutation') f.order.invalidateReads('owner');
          if (change === 'owner')
            vi.mocked(f.backend.getConnections).mockResolvedValue({ state: 'ready', bindings: [] });
          if (change === 'receipt') f.receipt.messageDelivery!.generation = 'replacement';
        }
        return result;
      });
      await expect(f.read()).rejects.toThrow();
      expect(f.legacy.getOpenCodeRuntimeDeliveryStatus).not.toHaveBeenCalled();
    }
  );

  it('keeps original-principal authorization failures explicit without a legacy lookup', async () => {
    const f = fixture();
    vi.mocked(f.backend.invoke).mockResolvedValue({
      ok: false,
      code: 'forbidden',
      outcome: 'not-dispatched',
    });
    await expect(f.read()).rejects.toThrow('forbidden');
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
    expect(f.legacy.getOpenCodeRuntimeDeliveryStatus).not.toHaveBeenCalled();
  });
});
