import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareCapturedTeamModels } from '../../../src/features/agent-backend/main/application/prepareCapturedTeamModels';
import { FileTeamModelProbeIntents } from '../../../src/features/agent-backend/main/infrastructure/FileTeamModelProbeIntents';
import { createPrepareProvisioningHandler } from '../../../src/main/ipc/teams/createPrepareProvisioningHandler';
import { runProviderPrepareDiagnostics } from '../../../src/renderer/components/team/dialogs/providerPrepareDiagnostics';
import { capturedTeamSelectionSignature } from '../../../src/shared/utils/capturedTeamReadiness';
import { bindTeamProvisioningContext } from '../../../src/shared/utils/teamProvisioningContext';

import type {
  BackendLaunchConfigurationView,
  BackendLaunchModelProbe,
} from '../../../src/features/agent-backend/contracts/launch';
import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { TeamProvisioningModelCheckRequest } from '../../../src/shared/types/team';
import type { IpcMainInvokeEvent } from 'electron';

function fixture() {
  let current = true;
  const probes = new Map<string, BackendLaunchModelProbe>();
  const view: BackendLaunchConfigurationView = {
    launch: {
      launchId: 'TEST-launch',
      rosterRevision: 'TEST-roster',
      status: 'pending',
      ready: 0,
      expected: 1,
      retryCapability: 'same-binding-no-allocation-only',
      members: [],
    },
    members: [
      {
        memberId: 'TEST-member',
        label: 'Lead',
        role: 'lead',
        selected: {
          provider: 'claude',
          workspace: '/TEST/workspace',
          model: 'saved-model',
          effort: 'medium',
          capabilities: ['model', 'effort', 'context'],
        },
      },
    ],
  };
  const calls: BackendOperationRequest[] = [];
  const starts: BackendOperationRequest[] = [];
  const backend: AgentBackendApi = {
    getConnections: vi.fn(),
    invoke: vi.fn(async (request): Promise<BackendOperationResult> => {
      calls.push(structuredClone(request));
      if (request.operation === 'team.launch.model.configuration.read')
        return {
          ok: true,
          value: {
            source: {
              sourceId: view.launch.launchId,
              rosterRevision: view.launch.rosterRevision,
            },
            members: structuredClone(view.members),
          },
        };
      if (!request.operation.startsWith('team.launch.probe.') || !('model' in request.payload))
        throw new Error('Unexpected effect');
      if (request.operation === 'team.launch.probe.start') {
        starts.push(structuredClone(request));
        probes.set(request.commandId, {
          ...request.payload,
          commandId: request.commandId,
          phase: 'completed',
          ok: true,
          expiresAt: Date.now() + 60000,
        });
      }
      if (request.operation === 'team.launch.probe.cancel') {
        const probe = probes.get(request.commandId);
        if (probe && probe.phase === 'running')
          probes.set(request.commandId, {
            ...probe,
            phase: 'cancelled',
            ok: false,
          });
      }
      return { ok: true, value: probes.get(request.commandId) ?? null };
    }),
  };
  const options = {
    backend,
    handle: { handleId: 'TEST-original' },
    request: {
      cwd: '/TEST/workspace',
      providerId: 'anthropic' as const,
      providerIds: ['anthropic' as const],
      modelChecks: [
        {
          providerId: 'anthropic' as const,
          model: 'edited-model',
          effort: 'medium' as const,
        },
      ],
      limitContext: true,
    },
    isCurrent: () => current,
    wait: async () => {},
  };
  return {
    options,
    backend,
    view,
    calls,
    starts,
    probes,
    revoke: () => {
      current = false;
    },
  };
}

describe('captured Team preparation from existing dialog requests', () => {
  it('accepts advancing Host observation time while retaining the same launch selection', async () => {
    const f = fixture();
    const original = f.backend.invoke;
    let reads = 0;
    f.backend.invoke = async (request) => {
      if (request.operation === 'team.launch.model.configuration.read')
        f.view.launch.observedAtMs = 1000 + ++reads;
      return original(request);
    };
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(true);
    expect(reads).toBe(2);
    expect(f.starts).toHaveLength(1);
  });
  it('reads the original ID before dispatch and reuses Host evidence after warm and cold caller recreation', async () => {
    const f = fixture();
    expect(await prepareCapturedTeamModels(f.options)).toMatchObject({
      ready: true,
    });
    const firstId = f.starts[0]!.commandId;
    expect(f.calls[1]).toMatchObject({
      commandId: firstId,
      operation: 'team.launch.probe.read',
    });
    expect(f.starts[0]).toMatchObject({
      payload: {
        model: 'edited-model',
        effort: 'medium',
        context: 'model-default',
        memberId: 'TEST-member',
      },
    });
    expect(
      await prepareCapturedTeamModels({
        ...f.options,
        handle: { ...f.options.handle },
        request: structuredClone(f.options.request),
      })
    ).toMatchObject({ ready: true });
    expect(f.starts).toHaveLength(1);
    expect(
      f.calls
        .filter((call) => call.operation === 'team.launch.probe.read')
        .map((call) => call.commandId)
    ).toEqual([firstId, firstId]);
  });

  it('retains full choices on a cached runtime-only diagnostics call', async () => {
    const f = fixture();
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(true);
    const { modelChecks, ...request } = f.options.request;
    expect(
      (
        await prepareCapturedTeamModels({
          ...f.options,
          request: { ...request, selectedModelChecks: modelChecks },
        })
      ).ready
    ).toBe(true);
    expect(f.starts).toHaveLength(1);
  });

  it('never turns an unavailable read or an expired completed proof into a new model request', async () => {
    const f = fixture();
    await prepareCapturedTeamModels(f.options);
    const saved = f.probes.get(f.starts[0]!.commandId)!;
    saved.expiresAt = Date.now() - 1;
    expect(await prepareCapturedTeamModels(f.options)).toMatchObject({
      ready: false,
      message: expect.stringContaining('expired'),
    });
    expect(f.starts).toHaveLength(1);
    vi.mocked(f.backend.invoke).mockResolvedValue({
      ok: false,
      code: 'unavailable',
      outcome: 'unknown',
    });
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(false);
    expect(f.starts).toHaveLength(1);
  });

  it('does not repeat a dispatch whose response was lost', async () => {
    const f = fixture();
    const original = f.backend.invoke;
    f.backend.invoke = async (request) => {
      const result = await original(request);
      if (request.operation === 'team.launch.probe.start') throw new Error('TEST response lost');
      return result;
    };
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(false);
    expect(f.starts).toHaveLength(1);
    f.backend.invoke = original;
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(true); // Recovered original outcome.
    expect(f.starts).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === 'team.launch.probe.cancel')).toMatchObject([
      {
        handle: { handleId: 'TEST-original' },
        commandId: f.starts[0]!.commandId,
      },
    ]);
  });

  it('cleans the exact running original on a roster-only read conflict while the foreground remains current', async () => {
    const f = fixture(),
      original = f.backend.invoke;
    let dispatched = false;
    f.backend.invoke = async (request) => {
      if (request.operation === 'team.launch.probe.read' && dispatched) {
        f.calls.push(structuredClone(request));
        return { ok: false, code: 'conflict', outcome: 'not-dispatched' };
      }
      const result = await original(request);
      if (
        request.operation === 'team.launch.probe.start' &&
        result.ok &&
        result.value &&
        'phase' in result.value
      ) {
        dispatched = true;
        const running = {
          ...result.value,
          phase: 'running' as const,
          ok: false,
        } as BackendLaunchModelProbe;
        f.probes.set(request.commandId, running);
        return { ok: true, value: running };
      }
      return result;
    };
    expect(f.options.isCurrent()).toBe(true);
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(false);
    expect(f.options.isCurrent()).toBe(true);
    expect(f.starts).toHaveLength(1);
    expect(f.calls.at(-1)).toMatchObject({
      operation: 'team.launch.probe.cancel',
      handle: { handleId: 'TEST-original' },
      commandId: f.starts[0]!.commandId,
      payload: f.starts[0]!.payload,
    });
    expect(f.probes.get(f.starts[0]!.commandId)?.phase).toBe('cancelled');
  });

  it('cancels only the captured check when the foreground changes while polling', async () => {
    const f = fixture();
    const original = f.backend.invoke;
    f.backend.invoke = async (request) => {
      const result = await original(request);
      if (
        request.operation === 'team.launch.probe.start' &&
        result.ok &&
        result.value &&
        'phase' in result.value
      )
        return {
          ok: true,
          value: {
            ...result.value,
            phase: 'running',
            ok: false,
          } as BackendLaunchModelProbe,
        };
      return result;
    };
    expect(
      await prepareCapturedTeamModels({
        ...f.options,
        wait: async () => {
          f.revoke();
          f.options.handle.handleId = 'TEST-replacement';
        },
      })
    ).toMatchObject({ ready: false, message: 'Team context changed.' });
    const cancel = f.calls.find((call) => call.operation === 'team.launch.probe.cancel');
    expect(cancel).toMatchObject({
      handle: { handleId: 'TEST-original' },
      commandId: f.starts[0]!.commandId,
    });
    expect(f.starts).toHaveLength(1);
  });

  it('captures desired options before an asynchronous settings read', async () => {
    const f = fixture();
    const original = f.backend.invoke;
    f.backend.invoke = async (request) => {
      if (request.operation === 'team.launch.model.configuration.read')
        f.options.request.modelChecks[0]!.model = 'TEST-late-choice';
      return original(request);
    };
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(true);
    expect(f.starts[0]!.payload).toMatchObject({ model: 'edited-model' });
  });

  it.each([
    'workspace',
    'provider',
    'ambiguous-models',
    'unrepresented-model',
    'capability',
    'scope',
  ] as const)('refuses %s before native dispatch', async (kind) => {
    const f = fixture();
    if (kind === 'workspace') f.options.request.cwd = '/TEST/other';
    if (kind === 'provider') f.view.members[0]!.selected!.provider = 'codex';
    if (kind === 'capability') f.view.members[0]!.selected!.capabilities = ['model'];
    if (kind === 'scope') f.revoke();
    if (kind === 'ambiguous-models' || kind === 'unrepresented-model') {
      f.options.request.modelChecks.push({
        providerId: 'anthropic',
        model: 'saved-model',
        effort: 'medium',
      });
      if (kind === 'ambiguous-models') f.view.members[0]!.selected!.model = 'TEST-unmatched';
    }
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(false);
    expect(f.starts).toHaveLength(0);
  });

  it('does not publish success if the launch changes after the native checks', async () => {
    const f = fixture();
    const original = f.backend.invoke;
    let reads = 0;
    f.backend.invoke = async (request) => {
      if (request.operation === 'team.launch.model.configuration.read' && ++reads === 2)
        f.view.launch.rosterRevision = 'TEST-replacement';
      return original(request);
    };
    expect((await prepareCapturedTeamModels(f.options)).ready).toBe(false);
    expect(f.starts).toHaveLength(1);
  });
});

describe('exact member model choices', () => {
  function team() {
    const f = fixture();
    f.view.members[0]!.label = 'Arbitrary lead name';
    f.view.members.push({
      memberId: 'TEST-bob',
      label: 'Bob',
      role: 'member',
      selected: {
        ...f.view.members[0]!.selected!,
        workspace: '/TEST/bob-private-workspace',
        model: 'saved-bob',
        effort: 'low',
      },
    });
    const choices: TeamProvisioningModelCheckRequest[] = [
      {
        providerId: 'anthropic',
        model: 'edited-lead',
        effort: 'medium',
        targets: [{ kind: 'lead' }],
      },
      {
        providerId: 'anthropic',
        model: 'edited-bob',
        effort: 'high',
        targets: [{ kind: 'member', name: 'Bob' }],
      },
    ];
    const run = () =>
      prepareCapturedTeamModels({
        ...f.options,
        request: {
          ...f.options.request,
          modelChecks: choices,
          selectedModelChecks: choices,
        },
      });
    return { ...f, choices, run };
  }
  it('maps edited choices by authoritative role/name while retaining distinct captured workspaces', async () => {
    const f = team();
    expect((await f.run()).ready).toBe(true);
    expect(f.starts.map((request) => request.payload)).toEqual([
      expect.objectContaining({
        memberId: 'TEST-member',
        model: 'edited-lead',
        effort: 'medium',
      }),
      expect.objectContaining({
        memberId: 'TEST-bob',
        model: 'edited-bob',
        effort: 'high',
      }),
    ]);
    expect(JSON.stringify(f.starts)).not.toContain('/TEST/bob-private-workspace');
  });
  it('preserves a renamed member reference and never selects a different account by the new display name', async () => {
    const f = team();
    f.choices[1]!.targets = [{ kind: 'member', name: 'Renamed', originalName: 'Bob' }];
    expect((await f.run()).ready).toBe(true);
    expect(f.starts[1]!.payload).toMatchObject({
      memberId: 'TEST-bob',
      model: 'edited-bob',
    });
  });
  it.each(['duplicate', 'wrong-role', 'unconfigured', 'mixed'] as const)(
    'rejects %s mapping before any model request',
    async (reason) => {
      const f = team();
      if (reason === 'duplicate')
        f.choices[0]!.targets!.push({
          kind: 'member',
          name: 'Twin',
          originalName: 'Bob',
        });
      if (reason === 'wrong-role')
        f.choices[1]!.targets = [{ kind: 'member', name: 'Arbitrary lead name' }];
      if (reason === 'unconfigured') f.view.members[1]!.selected = null;
      if (reason === 'mixed') delete f.choices[1]!.targets;
      expect((await f.run()).ready).toBe(false);
      expect(f.starts).toHaveLength(0);
    }
  );
});

describe('explicit Team check renewal', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'TEST-team-check-renewal-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  function attempt(f: ReturnType<typeof fixture>, preparationId: string) {
    return {
      ...f.options,
      intents: new FileTeamModelProbeIntents(directory),
      request: { ...f.options.request, preparationId },
    };
  }
  it('renews an expired completed proof once for a new preparation, preserving every old caller after cold reconstruction', async () => {
    const f = fixture();
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-A'))).ready).toBe(true);
    const first = f.starts[0]!.commandId;
    f.probes.get(first)!.expiresAt = Date.now() - 1;
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-A'))).ready).toBe(false);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-B'))).ready).toBe(true);
    expect(f.starts).toHaveLength(2);
    expect(f.starts[1]!.commandId).not.toBe(first);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-B'))).ready).toBe(true);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-A'))).ready).toBe(false);
    expect(f.starts).toHaveLength(2);
  });
  it('holds a newly opened preparation on the original unknown ID even after that result becomes readable', async () => {
    const f = fixture();
    await prepareCapturedTeamModels(attempt(f, 'TEST-A'));
    f.probes.get(f.starts[0]!.commandId)!.expiresAt = Date.now() - 1;
    const original = f.backend.invoke;
    f.backend.invoke = async (request) =>
      request.operation === 'team.launch.probe.read'
        ? { ok: false, code: 'unavailable', outcome: 'unknown' }
        : original(request);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-B'))).ready).toBe(false);
    f.backend.invoke = original;
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-B'))).ready).toBe(false);
    expect(f.starts).toHaveLength(1);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-C'))).ready).toBe(true);
    expect(f.starts).toHaveLength(2);
  });
  it('never renews held custody and requires a new explicit preparation after clean cancellation', async () => {
    const f = fixture();
    await prepareCapturedTeamModels(attempt(f, 'TEST-A'));
    const saved = f.probes.get(f.starts[0]!.commandId)!;
    saved.phase = 'held';
    saved.ok = false;
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-B'))).ready).toBe(false);
    saved.phase = 'cancelled';
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-B'))).ready).toBe(false);
    expect(f.starts).toHaveLength(1);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-C'))).ready).toBe(true);
    expect(f.starts).toHaveLength(2);
  });
  it('does not dispatch when original-intent association cannot be published', async () => {
    const f = fixture();
    const options = attempt(f, 'TEST-A');
    const intents = {
      read: options.intents.read.bind(options.intents),
      admit: async () => {
        throw new Error('TEST disk failure');
      },
    };
    expect((await prepareCapturedTeamModels({ ...options, intents })).ready).toBe(false);
    expect(f.starts).toHaveLength(0);
  });
  it('renews a held observation only after its original owner confirms clean cancellation', async () => {
    const f = fixture();
    await prepareCapturedTeamModels(attempt(f, 'TEST-A'));
    const id = f.starts[0]!.commandId;
    const saved = f.probes.get(id)!;
    saved.phase = 'held';
    saved.ok = false;
    const original = f.backend.invoke;
    f.backend.invoke = async (request) => {
      const result = await original(request);
      if (request.operation === 'team.launch.probe.cancel' && request.commandId === id) {
        saved.phase = 'cancelled';
        return { ok: true, value: saved };
      }
      return result;
    };
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-B'))).ready).toBe(true);
    expect(f.starts).toHaveLength(2);
    expect(f.starts[1]!.commandId).not.toBe(id);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-A'))).ready).toBe(false);
    expect(f.starts).toHaveLength(2);
  });
  it('retires an invalidated proof only for a new preparation and obtains fresh admission rather than reusing cleanup success', async () => {
    const f = fixture();
    await prepareCapturedTeamModels(attempt(f, 'TEST-A'));
    const id = f.starts[0]!.commandId;
    const original = f.backend.invoke;
    f.backend.invoke = async (request) =>
      request.operation === 'team.launch.probe.read' && request.commandId === id
        ? { ok: false, code: 'conflict', outcome: 'rejected' }
        : original(request);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-A'))).ready).toBe(false);
    expect(f.calls.filter((call) => call.operation === 'team.launch.probe.cancel')).toMatchObject([
      { commandId: id, handle: { handleId: 'TEST-original' } },
    ]);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-B'))).ready).toBe(true);
    expect(f.starts).toHaveLength(2);
    expect(f.calls.find((call) => call.operation === 'team.launch.probe.cancel')?.commandId).toBe(
      id
    );
    expect(f.starts[1]!.commandId).not.toBe(id);
  });
  it('joins simultaneous new preparations to one successor using the Host original-ID replay contract', async () => {
    const f = fixture();
    await prepareCapturedTeamModels(attempt(f, 'TEST-A'));
    f.probes.get(f.starts[0]!.commandId)!.expiresAt = Date.now() - 1;
    const original = f.backend.invoke;
    f.backend.invoke = async (request) => {
      const prior = f.probes.get(request.commandId);
      return request.operation === 'team.launch.probe.start' && prior
        ? { ok: true, value: prior }
        : original(request);
    };
    const results = await Promise.all(
      ['TEST-B', 'TEST-C'].map((id) => prepareCapturedTeamModels(attempt(f, id)))
    );
    expect(results.every((result) => result.ready)).toBe(true);
    expect(f.starts).toHaveLength(2);
    expect((await prepareCapturedTeamModels(attempt(f, 'TEST-A'))).ready).toBe(false);
    expect(f.starts).toHaveLength(2);
  });
});

describe('existing dialog multi-provider preflight', () => {
  function mixed() {
    const f = fixture();
    for (const provider of ['codex', 'opencode'] as const)
      f.view.members.push({
        memberId: `TEST-${provider}`,
        label: provider,
        role: 'member',
        selected: {
          provider,
          workspace: `/TEST/${provider}`,
          model: `saved-${provider}`,
          capabilities: ['model'],
        },
      });
    const choices: TeamProvisioningModelCheckRequest[] = [
      {
        providerId: 'anthropic',
        model: 'edited-claude',
        effort: 'high',
        targets: [{ kind: 'lead' }],
      },
      {
        providerId: 'codex',
        model: 'edited-codex',
        targets: [{ kind: 'member', name: 'codex' }],
      },
      {
        providerId: 'opencode',
        model: 'TEST-local/edited-opencode',
        targets: [{ kind: 'member', name: 'opencode' }],
      },
    ];
    const options = {
      ...f.options,
      request: {
        ...f.options.request,
        providerIds: ['anthropic', 'codex', 'opencode'] as const,
        modelChecks: choices,
        selectedModelChecks: choices,
      },
    };
    // Keep the request's public mutable array shape.
    const run = () =>
      prepareCapturedTeamModels({
        ...options,
        request: {
          ...options.request,
          providerIds: [...options.request.providerIds],
        },
      });
    return { ...f, choices, run };
  }

  it('checks each exact member/account and applies the existing global context choice only to Claude', async () => {
    const f = mixed();
    expect((await f.run()).ready).toBe(true);
    expect(f.starts.map((call) => call.payload)).toEqual([
      expect.objectContaining({
        memberId: 'TEST-member',
        model: 'edited-claude',
        effort: 'high',
        context: 'model-default',
      }),
      {
        launchId: 'TEST-launch',
        rosterRevision: 'TEST-roster',
        memberId: 'TEST-codex',
        model: 'edited-codex',
      },
      {
        launchId: 'TEST-launch',
        rosterRevision: 'TEST-roster',
        memberId: 'TEST-opencode',
        model: 'TEST-local/edited-opencode',
      },
    ]);
    const originalIds = f.starts.map((call) => call.commandId);
    expect((await f.run()).ready).toBe(true);
    expect(f.starts.map((call) => call.commandId)).toEqual(originalIds);
  });

  it.each(['codex', 'opencode'] as const)(
    'supports a saved %s lead through the same dialog contract',
    async (provider) => {
      const f = fixture();
      f.view.members[0]!.selected = {
        provider,
        workspace: '/TEST/workspace',
        model: 'saved',
        capabilities: ['model'],
      };
      expect(
        (
          await prepareCapturedTeamModels({
            ...f.options,
            request: {
              cwd: '/TEST/workspace',
              providerId: provider,
              providerIds: [provider],
              limitContext: true,
              modelChecks: [
                {
                  providerId: provider,
                  model: 'edited',
                  targets: [{ kind: 'lead' }],
                },
              ],
            },
          })
        ).ready
      ).toBe(true);
      expect(f.starts[0]!.payload).toEqual({
        launchId: 'TEST-launch',
        rosterRevision: 'TEST-roster',
        memberId: 'TEST-member',
        model: 'edited',
      });
    }
  );

  it('retains an uncertain Codex check and stops before submitting OpenCode or a replacement', async () => {
    const f = mixed(),
      invoke = f.backend.invoke;
    f.backend.invoke = async (request) => {
      const result = await invoke(request);
      if (
        request.operation === 'team.launch.probe.start' &&
        'memberId' in request.payload &&
        request.payload.memberId === 'TEST-codex'
      )
        throw new Error('TEST-reply-lost');
      return result;
    };
    expect((await f.run()).ready).toBe(false);
    expect(f.starts).toHaveLength(2);
    const uncertain = f.starts[1]!;
    expect(
      f.calls.some(
        (call) =>
          call.operation === 'team.launch.probe.cancel' &&
          call.commandId === uncertain.commandId &&
          call.handle.handleId === 'TEST-original'
      )
    ).toBe(true);
    expect((await f.run()).ready).toBe(true);
    expect(f.starts.filter((call) => call.commandId === uncertain.commandId)).toHaveLength(1);
  });

  it('refuses a cross-provider member mapping before any native check', async () => {
    const f = mixed();
    f.choices[1]!.targets = [{ kind: 'member', name: 'opencode' }];
    expect((await f.run()).ready).toBe(false);
    expect(f.starts).toHaveLength(0);
  });
});

describe('existing Launch desired roster model preflight', () => {
  it('delegates provider changes, new members and explicit workspaces to the original Host without mutating its roster', async () => {
    const f = fixture();
    const choices: TeamProvisioningModelCheckRequest[] = [
      { providerId: 'codex', model: '__provider_default__', targets: [{ kind: 'lead' }] },
      {
        providerId: 'opencode',
        model: 'TEST-local/TEST-new',
        targets: [{ kind: 'member', name: 'new-worker' }],
      },
    ];
    const result = await prepareCapturedTeamModels({
      ...f.options,
      request: {
        cwd: '/TEST/edited-workspace',
        providerId: 'codex',
        providerIds: ['codex', 'opencode'],
        modelChecks: choices,
        selectedModelChecks: choices,
        limitContext: true,
      },
    });
    expect(result.ready).toBe(true);
    expect(f.starts.map((call) => call.payload)).toEqual([
      {
        launchId: 'TEST-launch',
        rosterRevision: 'TEST-roster',
        memberId: 'TEST-member',
        model: '__provider_default__',
        draft: {
          providerId: 'codex',
          target: { kind: 'lead' },
          workspace: '/TEST/edited-workspace',
        },
      },
      {
        launchId: 'TEST-launch',
        rosterRevision: 'TEST-roster',
        memberId: 'draft:new-worker',
        model: 'TEST-local/TEST-new',
        draft: {
          providerId: 'opencode',
          target: { kind: 'member', name: 'new-worker' },
          workspace: '/TEST/edited-workspace',
        },
      },
    ]);
    expect(
      f.calls.every(
        (call) =>
          call.operation.startsWith('team.launch.probe.') ||
          call.operation === 'team.launch.model.configuration.read'
      )
    ).toBe(true);
    expect(f.view.members).toHaveLength(1);
  });

  it('checks only retained desired members when the existing roster editor removes a member', async () => {
    const f = fixture();
    f.view.members.push({
      memberId: 'TEST-removed',
      label: 'removed',
      role: 'member',
      selected: { ...f.view.members[0]!.selected! },
    });
    expect(
      (
        await prepareCapturedTeamModels({
          ...f.options,
          request: {
            ...f.options.request,
            modelChecks: [
              { providerId: 'anthropic', model: 'edited-model', targets: [{ kind: 'lead' }] },
            ],
          },
        })
      ).ready
    ).toBe(true);
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.payload).toMatchObject({ memberId: 'TEST-member' });
  });
});

it('uses canonical workspace inheritance when the existing Launch form changes the Team workspace', async () => {
  const f = fixture();
  f.view.members.push(
    {
      memberId: 'TEST-inherited',
      label: 'inherited',
      role: 'member',
      selected: { ...f.view.members[0]!.selected!, workspaceInherited: true },
    },
    {
      memberId: 'TEST-explicit',
      label: 'explicit',
      role: 'member',
      selected: {
        ...f.view.members[0]!.selected!,
        workspace: '/TEST/private-member-project',
        workspaceInherited: false,
      },
    }
  );
  const choices: TeamProvisioningModelCheckRequest[] = [
    {
      providerId: 'anthropic',
      model: 'edited-model',
      effort: 'medium',
      targets: [
        { kind: 'lead' },
        { kind: 'member', name: 'inherited' },
        { kind: 'member', name: 'explicit' },
      ],
    },
  ];
  const run = () =>
    prepareCapturedTeamModels({
      ...f.options,
      request: { ...f.options.request, cwd: '/TEST/new-team-project', modelChecks: choices },
    });
  expect((await run()).ready).toBe(true);
  expect(
    f.starts.map((call) => ('draft' in call.payload ? call.payload.draft?.workspace : undefined))
  ).toEqual(['/TEST/new-team-project', '/TEST/new-team-project', undefined]);
  delete f.view.members[1]!.selected!.workspaceInherited;
  expect((await run()).ready).toBe(false);
  expect(f.starts).toHaveLength(3);
});

it.each(['none', 'minimal', 'ultra'] as const)(
  'existing saved Codex dialog model check preserves its native %s effort',
  async (effort) => {
    const f = fixture();
    f.view.members[0]!.selected = {
      provider: 'codex',
      workspace: '/TEST/workspace',
      model: 'saved',
      capabilities: ['model', 'effort'],
    };
    expect(
      (
        await prepareCapturedTeamModels({
          ...f.options,
          request: {
            cwd: '/TEST/workspace',
            providerId: 'codex',
            providerIds: ['codex'],
            modelChecks: [
              { providerId: 'codex', model: 'edited', effort, targets: [{ kind: 'lead' }] },
            ],
          },
        })
      ).ready
    ).toBe(true);
    expect(f.starts[0]!.payload).toMatchObject({
      memberId: 'TEST-member',
      model: 'edited',
      effort,
    });
  }
);

it('no model choices retain captured effort while an existing dialog row with omitted effort requests private Default', async () => {
  const retained = fixture();
  expect(
    (
      await prepareCapturedTeamModels({
        ...retained.options,
        request: { cwd: '/TEST/workspace', providerId: 'anthropic', modelChecks: [] },
      })
    ).ready
  ).toBe(true);
  expect(retained.starts[0]!.payload).toMatchObject({ model: 'saved-model', effort: 'medium' });
  expect('draft' in retained.starts[0]!.payload).toBe(false);
  const cleared = fixture();
  expect(
    (
      await prepareCapturedTeamModels({
        ...cleared.options,
        request: {
          cwd: '/TEST/workspace',
          providerId: 'anthropic',
          modelChecks: [
            { providerId: 'anthropic', model: '__provider_default__', targets: [{ kind: 'lead' }] },
          ],
        },
      })
    ).ready
  ).toBe(true);
  expect(cleared.starts[0]!.payload).toEqual({
    launchId: 'TEST-launch',
    rosterRevision: 'TEST-roster',
    memberId: 'TEST-member',
    model: '__provider_default__',
    draft: { providerId: 'anthropic', target: { kind: 'lead' }, workspace: '/TEST/workspace' },
  });
});

it.each(['codex', 'opencode'] as const)(
  'existing per-provider %s plan proves its member-only model destination without requiring the lead in that plan',
  async (provider) => {
    const f = fixture();
    f.view.members.push({
      memberId: 'TEST-provider-worker',
      label: 'worker',
      role: 'member',
      selected: {
        provider,
        workspace: '/TEST/workspace',
        workspaceInherited: true,
        model: 'saved',
        capabilities: ['model', 'effort'],
      },
    });
    const choices: TeamProvisioningModelCheckRequest[] = [
      {
        providerId: provider,
        model: 'edited',
        effort: 'high',
        targets: [{ kind: 'member', name: 'worker' }],
      },
    ];
    expect(
      (
        await prepareCapturedTeamModels({
          ...f.options,
          request: {
            cwd: '/TEST/workspace',
            providerId: provider,
            providerIds: [provider],
            modelChecks: choices,
            selectedModelChecks: choices,
          },
        })
      ).ready
    ).toBe(true);
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.payload).toMatchObject({
      memberId: 'TEST-provider-worker',
      model: 'edited',
      effort: 'high',
    });
  }
);

it('actual existing provider diagnostics/context/IPC normalization reaches each original member-only model intent and returns its scoped proof', async () => {
  const f = fixture();
  for (const provider of ['codex', 'opencode'] as const)
    f.view.members.push({
      memberId: `TEST-${provider}`,
      label: provider,
      role: 'member',
      selected: {
        provider,
        workspace: '/TEST/workspace',
        workspaceInherited: true,
        model: 'saved',
        capabilities: ['model', 'effort'],
      },
    });
  const directory = await mkdtemp(join(tmpdir(), 'TEST-existing-provider-dialog-'));
  try {
    const legacy = vi.fn();
    const handler = createPrepareProvisioningHandler(
      legacy,
      () => true,
      (_event, context, cwd, options) =>
        prepareCapturedTeamModels({
          ...f.options,
          intents: new FileTeamModelProbeIntents(directory),
          request: {
            ...options,
            cwd,
            selectedModelChecks: context.selectedModelChecks,
            preparationId: context.preparationId,
          },
        })
    );
    const prepare: TeamsAPI['prepareProvisioning'] = async (...args) => {
      const result = await handler({} as IpcMainInvokeEvent, ...args);
      if (!result.success || !result.data) throw new Error(result.error);
      return result.data;
    };
    for (const providerId of ['anthropic', 'codex', 'opencode'] as const) {
      const choices: TeamProvisioningModelCheckRequest[] = [
        {
          providerId,
          model: `TEST-${providerId}-edited`,
          effort: 'high',
          targets: [
            providerId === 'anthropic' ? { kind: 'lead' } : { kind: 'member', name: providerId },
          ],
        },
      ];
      const bound = bindTeamProvisioningContext(prepare, {
        kind: 'team',
        teamName: 'host-team:TEST-original',
        selectedModelChecks: choices,
        preparationId: 'TEST-ui-preparation',
      });
      const result = await runProviderPrepareDiagnostics({
        cwd: '/TEST/workspace',
        providerId,
        selectedModelIds: choices.map((row) => row.model),
        selectedModelChecks: choices,
        limitContext: true,
        prepareProvisioning: bound,
      });
      expect(result.status).toBe('ready');
      expect(result.capturedTeamReadiness).toMatchObject({
        handleId: 'TEST-original',
        preparationId: 'TEST-ui-preparation',
        selectionSignature: capturedTeamSelectionSignature({
          cwd: '/TEST/workspace',
          limitContext: true,
          selectedModelChecks: choices,
        }),
      });
    }
    expect(f.starts).toHaveLength(3);
    expect(f.starts.map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memberId: 'TEST-member' }),
        expect.objectContaining({ memberId: 'TEST-codex' }),
        expect.objectContaining({ memberId: 'TEST-opencode' }),
      ])
    );
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
