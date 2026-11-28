import { hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { createHostTeamResume } from '@renderer/components/team/dialogs/createHostTeamResume';
import { describe, expect, it, vi } from 'vitest';

import type {
  AgentBackendApi,
  BackendLaunchConfigurationView,
  BackendLaunchRestorations,
  BackendMemberCheckpoints,
  BackendOperationRequest,
  BackendOperationResult,
} from '@features/agent-backend/contracts';
import type { TeamCreateRequest } from '@shared/types';

function fixture() {
  const handle = { handleId: 'TEST-resume-handle' };
  const teamName = hostTeamSelectionKey(handle.handleId);
  const saved: TeamCreateRequest = {
    teamName,
    cwd: '/TEST-resume-project',
    prompt: 'TEST original request',
    members: [{ name: 'TEST-worker', role: 'worker' }],
    savedSettingsFingerprint: 'a'.repeat(64),
  };
  const configuration: BackendLaunchConfigurationView = {
    launch: {
      launchId: 'TEST-launch',
      rosterRevision: 'TEST-roster',
      status: 'failed',
      ready: 0,
      expected: 1,
      retryCapability: 'same-binding-no-allocation-only',
      members: [
        {
          memberId: 'TEST-member',
          generation: 'TEST-generation',
          attemptId: 'TEST-attempt',
          status: 'failed',
          nativeReady: false,
          usable: false,
          controlAvailable: false,
          noAllocation: false,
          reason: 'TEST-stopped',
        },
      ],
    },
    members: [{ memberId: 'TEST-member', label: 'TEST-worker', role: 'member', selected: null }],
  };
  const availability: BackendMemberCheckpoints = {
    memberId: 'TEST-member',
    sourceGeneration: 'TEST-generation',
    status: 'owner-eligible',
    reason: 'native-backing-unverified',
    nativeBacking: 'unverified',
    checkpoints: [
      {
        checkpointId: 'TEST-checkpoint',
        reference: `cp1-${'b'.repeat(64)}`,
        status: 'owner-eligible',
        reason: 'native-backing-unverified',
      },
    ],
  };
  let current = true;
  const ledger: BackendLaunchRestorations = {
    launchId: 'TEST-launch',
    rosterRevision: 'TEST-roster',
    preparations: [],
    restorations: [],
  };
  const fault = {
    prepareAck: false,
    restoreAck: false,
    advanceRevision: false,
    proofMismatch: '' as '' | 'resumeId' | 'commandId',
  };
  const getSavedRequest = vi.fn(async () => structuredClone(saved));
  const invoke = vi.fn(
    async (request: BackendOperationRequest): Promise<BackendOperationResult> => {
      if (request.operation === 'team.launch.configuration.read')
        return { ok: true, value: structuredClone(configuration) };
      if (request.operation === 'team.launch.read')
        return { ok: true, value: structuredClone(configuration.launch) };
      if (request.operation === 'runtime.checkpoints.read')
        return {
          ok: true,
          value: { ...structuredClone(availability), memberId: request.payload.memberId },
        };
      if (request.operation === 'team.launch.restorations.read')
        return {
          ok: true,
          value: structuredClone(ledger),
        };
      if (request.operation === 'team.launch.resume.prepare') {
        let prepared = ledger.preparations.find(
          (entry) => entry.resumeId === request.payload.resumeId
        );
        if (!prepared) {
          prepared = {
            resumeId: request.payload.resumeId,
            rosterRevision: request.payload.rosterRevision,
            members: request.payload.members.map((member) => ({ ...member, requested: false })),
          };
          ledger.preparations.push(prepared);
        }
        if (fault.prepareAck) {
          fault.prepareAck = false;
          throw new Error('TEST prepare ACK lost');
        }
        return { ok: true, value: structuredClone(prepared) };
      }
      if (request.operation === 'runtime.restore') {
        const prepared = ledger.preparations.find(
          (entry) => entry.resumeId === request.payload.resumeId
        )!;
        const member = prepared.members.find((entry) => entry.commandId === request.commandId)!;
        member.requested = true;
        if (fault.restoreAck) throw new Error('TEST restore ACK lost before selection');
        const generation = `TEST-restored-${member.memberId}`;
        ledger.restorations.push({
          ...member,
          selectedGeneration: generation,
          current: true,
          phase: 'allocated',
          custody: 'owned',
          attached: true,
        });
        const selected = configuration.launch.members.find(
          (entry) => entry.memberId === member.memberId
        )!;
        Object.assign(selected, { generation, nativeReady: true, usable: true, status: 'ready' });
        availability.sourceGeneration = generation;
        if (fault.advanceRevision) {
          ledger.rosterRevision = 'TEST-live-restored-roster';
          configuration.launch.rosterRevision = ledger.rosterRevision;
          if (fault.proofMismatch === 'resumeId')
            ledger.preparations[0].resumeId = 'TEST-foreign-preparation';
          if (fault.proofMismatch === 'commandId')
            ledger.preparations[0].members[0].commandId = 'TEST-foreign-command';
        }
        return {
          ok: true,
          value: {
            memberId: member.memberId,
            generation,
            phase: 'allocated',
            sealed: false,
            custody: 'owned',
            nativeReady: true,
            attached: true,
            inputs: [],
            interactions: [],
          },
        };
      }
      throw new Error(`Unexpected effect: ${request.operation}`);
    }
  );
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => ({
      state: 'ready' as const,
      bindings: [
        {
          handle,
          label: 'TEST-team',
          members: [{ memberId: 'TEST-member', label: 'TEST-worker' }],
        },
      ],
    })),
    invoke,
  };
  const controller = createHostTeamResume({
    backend,
    teamName,
    current: () => current,
    getSavedRequest,
  });
  return {
    controller,
    backend,
    invoke,
    getSavedRequest,
    saved,
    configuration,
    availability,
    ledger,
    fault,
    teamName,
    leave: () => {
      current = false;
    },
  };
}

describe('Host team Resume source', () => {
  it('publishes all explicit member choices before effects and resumes each original command', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const f = fixture();
    f.configuration.launch.members.push({
      ...f.configuration.launch.members[0],
      memberId: 'TEST-second',
    });
    f.configuration.members.push({
      ...f.configuration.members[0],
      memberId: 'TEST-second',
      label: 'TEST-second',
    });
    const source = await f.controller.read();
    const selections = Object.fromEntries(
      source.members.map((member) => [
        member.memberId,
        member.availability.checkpoints[0].reference,
      ])
    );
    const result = await f.controller.submit(source, selections);
    expect(result.ready).toBe(true);
    const commands = f.invoke.mock.calls.map(([request]) => request);
    const prepareIndex = commands.findIndex(
      (request) => request.operation === 'team.launch.resume.prepare'
    );
    const restores = commands.filter((request) => request.operation === 'runtime.restore');
    expect(prepareIndex).toBeLessThan(
      commands.findIndex((request) => request.operation === 'runtime.restore')
    );
    expect(f.ledger.preparations[0].members).toHaveLength(2);
    expect(restores.map((request) => request.commandId)).toEqual(
      f.ledger.preparations[0].members.map((member) => member.commandId)
    );
    expect(
      restores.every((request) => request.payload.resumeId === f.ledger.preparations[0].resumeId)
    ).toBe(true);
  });

  it('finishes the exact prepared Resume after its technical generation advances the live roster revision', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const f = fixture();
    f.fault.advanceRevision = true;
    const source = await f.controller.read();
    const result = await f.controller.submit(source, {
      'TEST-member': source.members[0].availability.checkpoints[0].reference,
    });
    expect(result.ready).toBe(true);
    expect(result.restorations.rosterRevision).toBe('TEST-live-restored-roster');
    expect(result.restorations.preparations[0].rosterRevision).toBe('TEST-roster');
    expect(source.configuration.launch.rosterRevision).toBe('TEST-roster');
    expect(
      f.invoke.mock.calls.filter(([request]) => request.operation === 'runtime.restore')
    ).toHaveLength(1);
  });

  it.each(['resumeId', 'commandId'] as const)(
    'does not accept a different immutable %s across a live roster transition',
    async (field) => {
      vi.stubGlobal('crypto', webcrypto);
      const f = fixture();
      f.fault.advanceRevision = true;
      f.fault.proofMismatch = field;
      const source = await f.controller.read();
      await expect(
        f.controller.submit(source, {
          'TEST-member': source.members[0].availability.checkpoints[0].reference,
        })
      ).rejects.toThrow('Original Resume status unavailable');
      expect(
        f.invoke.mock.calls.filter(([request]) => request.operation === 'runtime.restore')
      ).toHaveLength(1);
    }
  );

  it('requires explicit checkpoint selection for every member before even prepare', async () => {
    const f = fixture();
    const source = await f.controller.read();
    await expect(f.controller.submit(source, {})).rejects.toThrow(
      'Select an available saved checkpoint'
    );
    expect(
      f.invoke.mock.calls.some(
        ([request]) =>
          request.operation === 'runtime.restore' ||
          request.operation === 'team.launch.resume.prepare'
      )
    ).toBe(false);
  });

  it('recovers a lost prepare ACK with the same immutable map before native effects', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const f = fixture();
    f.fault.prepareAck = true;
    const source = await f.controller.read();
    const selections = { 'TEST-member': source.members[0].availability.checkpoints[0].reference };
    expect((await f.controller.submit(source, selections)).ready).toBe(false);
    expect(f.ledger.preparations[0].members[0].requested).toBe(false);
    const original = structuredClone(f.ledger.preparations[0]);
    const reopened = createHostTeamResume({
      backend: f.backend,
      teamName: f.teamName,
      current: () => true,
      getSavedRequest: f.getSavedRequest,
    });
    const renewed = await reopened.read();
    expect((await reopened.submit(renewed, selections)).ready).toBe(true);
    const preparations = f.invoke.mock.calls.filter(
      ([request]) => request.operation === 'team.launch.resume.prepare'
    );
    expect(preparations).toHaveLength(2);
    expect(preparations[1][0]).toEqual(preparations[0][0]);
    expect(f.ledger.preparations[0].members[0].commandId).toBe(original.members[0].commandId);
  });

  it('queries only after UNKNOWN dispatch, including cold reopen and untouched members', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const f = fixture();
    f.fault.restoreAck = true;
    f.configuration.launch.members.push({
      ...f.configuration.launch.members[0],
      memberId: 'TEST-second',
    });
    f.configuration.members.push({
      ...f.configuration.members[0],
      memberId: 'TEST-second',
      label: 'TEST-second',
    });
    const source = await f.controller.read();
    const selections = Object.fromEntries(
      source.members.map((member) => [
        member.memberId,
        member.availability.checkpoints[0].reference,
      ])
    );
    expect((await f.controller.submit(source, selections)).ready).toBe(false);
    expect(f.ledger.preparations[0].members.map((member) => member.requested)).toEqual([
      true,
      false,
    ]);
    await f.controller.submit(source, selections);
    const reopened = createHostTeamResume({
      backend: f.backend,
      teamName: f.teamName,
      current: () => true,
      getSavedRequest: f.getSavedRequest,
    });
    await reopened.submit(await reopened.read(), {});
    expect(
      f.invoke.mock.calls.filter(([request]) => request.operation === 'runtime.restore')
    ).toHaveLength(1);
    expect(
      f.invoke.mock.calls.filter(([request]) => request.operation === 'team.launch.resume.prepare')
    ).toHaveLength(1);
  });
  it('reads exact published member generations without selecting a checkpoint or starting effects', async () => {
    const f = fixture();
    const source = await f.controller.read();
    expect(source.members[0].label).toBe('TEST-worker');
    expect(source.members[0].availability.nativeBacking).toBe('unverified');
    expect(f.invoke.mock.calls.map(([request]) => request.operation)).toEqual([
      'team.launch.configuration.read',
      'team.launch.restorations.read',
      'runtime.checkpoints.read',
      'team.launch.read',
    ]);
    expect(f.invoke.mock.calls[2][0].payload).toEqual({
      memberId: 'TEST-member',
      expectedGeneration: 'TEST-generation',
    });
    expect(f.getSavedRequest).toHaveBeenCalledTimes(2);
  });

  it('retains explicit unavailable owner reasons without promoting native backing', async () => {
    const f = fixture();
    f.availability.status = 'unavailable';
    f.availability.reason = 'custody-unreleased';
    f.availability.checkpoints[0].status = 'unavailable';
    f.availability.checkpoints[0].reason = 'history-changed';
    const source = await f.controller.read();
    expect(source.members[0].availability).toEqual(f.availability);
  });

  it.each(['fingerprint', 'prompt', 'roster'] as const)(
    'refuses changed full saved source (%s) before dispatch',
    async (field) => {
      const f = fixture();
      const source = await f.controller.read();
      if (field === 'fingerprint') f.saved.savedSettingsFingerprint = 'c'.repeat(64);
      if (field === 'prompt') f.saved.prompt = 'TEST changed prompt';
      if (field === 'roster') f.saved.members[0].effort = 'high';
      await expect(f.controller.assertSource(source)).rejects.toThrow('Saved settings changed');
      expect(f.invoke.mock.calls.every(([request]) => request.operation.endsWith('.read'))).toBe(
        true
      );
    }
  );

  it.each(['launch', 'roster', 'generation'] as const)(
    'refuses a changed captured %s',
    async (field) => {
      const f = fixture();
      const source = await f.controller.read();
      if (field === 'launch') f.configuration.launch.launchId = 'TEST-new-launch';
      if (field === 'roster') f.configuration.launch.rosterRevision = 'TEST-new-roster';
      if (field === 'generation')
        f.configuration.launch.members[0].generation = 'TEST-new-generation';
      await expect(f.controller.assertSource(source)).rejects.toThrow(
        'Original launch or member generation changed'
      );
    }
  );

  it('refuses a mismatched member checkpoint generation', async () => {
    const f = fixture();
    f.availability.sourceGeneration = 'TEST-other-generation';
    await expect(f.controller.read()).rejects.toThrow('Original checkpoint availability changed');
  });

  it('does not cross a context switch after an awaited owner read', async () => {
    const f = fixture();
    f.getSavedRequest.mockImplementationOnce(async () => {
      f.leave();
      return f.saved;
    });
    await expect(f.controller.read()).rejects.toThrow('Team context changed');
    expect(f.invoke.mock.calls.map(([request]) => request.operation)).toEqual([
      'team.launch.configuration.read',
    ]);
  });
});
import { webcrypto } from 'node:crypto';
