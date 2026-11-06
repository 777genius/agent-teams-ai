import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TeamCreationRefusal } from '@features/agent-backend/contracts';
import { createLaunchGuard } from '@renderer/components/team/dialogs/providerLaunchAuthority';
import { runProviderPrepareDiagnostics } from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { updateProviderCheck } from '@renderer/components/team/dialogs/provisioningProviderChecks';
import { __resetRetainedCreateSubmissionForTests } from '@renderer/components/team/dialogs/retainedCreateSubmission';
import { useCreateConfigSubmission } from '@renderer/components/team/dialogs/useCreateConfigSubmission';
import { useCreatedTeamLaunchReadiness } from '@renderer/components/team/dialogs/useCreatedTeamLaunchReadiness';
import { useCreateTeamSubmission } from '@renderer/components/team/dialogs/useCreateTeamSubmission';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { IpcError } from '@renderer/utils/unwrapIpc';
import { createdTeamSelectionSignature } from '@shared/utils/createdTeamReadiness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreatedTeamReadiness, TeamCreateRequest, TeamProviderId } from '@shared/types/team';

const { context, createConfig } = vi.hoisted(() => ({
  context: { activeContextId: 'TEST-local' },
  createConfig: vi.fn(),
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign((select: (value: unknown) => unknown) => select(context), {
    getState: () => context,
  }),
}));
vi.mock('@renderer/api', () => ({ api: { teams: { createConfig } } }));
let dispose = () => {};
afterEach(() => {
  dispose();
  context.activeContextId = 'TEST-local';
  createConfig.mockReset();
  __resetRetainedCreateSubmissionForTests();
  resetContextScopedRequestEpochForTests();
  vi.useRealTimers();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const run = vi.fn();
  const input: Parameters<typeof useCreatedTeamLaunchReadiness>[0] = {
    open: true,
    request: { teamName: 'TEST-create', cwd: '/TEST-create', members: [], prompt: 'ONE' },
    checks: [],
    fence: { preparationId: 'TEST-fence', runPreflight: run } as unknown as Parameters<
      typeof useCreatedTeamLaunchReadiness
    >[0]['fence'],
  };
  let output!: ReturnType<typeof useCreatedTeamLaunchReadiness>;
  let submit!: ReturnType<typeof useCreateTeamSubmission>;
  let save!: ReturnType<typeof useCreateConfigSubmission>;
  function View() {
    output = useCreatedTeamLaunchReadiness(input);
    submit = useCreateTeamSubmission();
    save = useCreateConfigSubmission(input.open);
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(<View />));
  render();
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  return {
    input,
    output: () => output,
    submit: () => submit,
    save: () => save,
    unmount: () => act(() => root.render(null)),
    run,
    render,
    async settle(providerId: TeamProviderId = 'anthropic') {
      const proof: CreatedTeamReadiness = {
        preparationId: output.context.preparationId!,
        selectionSignature: createdTeamSelectionSignature(input.request),
        draftDigest: 'TEST-host-digest',
        expiresAt: Date.now() + 60_000,
      };
      run.mockResolvedValue({
        status: 'ready',
        details: [],
        warnings: [],
        modelResultsById: {},
        createdTeamReadiness: proof,
      });
      const result = await output.runPreflight(
        { cacheKey: 'TEST', requestSignature: 'TEST' },
        {} as never
      );
      input.checks = [{ providerId, ...result }];
      render();
      return proof;
    },
  };
}

describe('original Create launch flow scoped evidence', () => {
  it('requires the entire Create draft and exact owner/preparation, never global provider authority', async () => {
    const f = mount();
    const guard = () => createLaunchGuard(['anthropic'], new Map(), undefined, f.output());
    expect(guard().blocked(true)).toBe(true);
    const proof = await f.settle();
    expect(guard().blocked(true)).toBe(false);
    expect(guard().blocked(true, proof.expiresAt)).toBe(true);
    expect(f.output().permits('codex', Date.now())).toBe(false);
    f.input.request = { ...f.input.request, skipPermissions: false };
    f.render();
    expect(guard().blocked(true)).toBe(true);
    expect(f.output().context).toMatchObject({ kind: 'create', draft: { skipPermissions: false } });
    f.input.request = { ...f.input.request, skipPermissions: undefined };
    context.activeContextId = 'TEST-other';
    f.render();
    expect(guard().blocked(true)).toBe(true);
    expect(f.output().blocksSubmission).toBe(false);
    expect(
      updateProviderCheck(f.input.checks.slice(), 'anthropic', { status: 'checking' })[0]!
        .createdTeamReadiness
    ).toBeUndefined();
  });
  it.each(['codex', 'opencode'] as const)(
    'accepts only the exact current %s Create proof for its selected provider',
    async (providerId) => {
      const f = mount();
      f.input.request = { ...f.input.request, providerId };
      f.render();
      const guard = () => createLaunchGuard([providerId], new Map(), undefined, f.output());
      expect(guard().blocked(true)).toBe(true);
      const proof = await f.settle(providerId);
      expect(f.output().readiness).toEqual(proof);
      expect(f.output().blocksSubmission).toBe(false);
      expect(guard().blocked(true)).toBe(false);
      expect(f.output().permits('anthropic', Date.now())).toBe(false);
      expect(f.output().permits(providerId === 'codex' ? 'opencode' : 'codex', Date.now())).toBe(
        false
      );
      expect(guard().blocked(true, proof.expiresAt)).toBe(true);
      const [ready] = f.input.checks;
      f.input.checks = [{ ...ready!, status: 'checking' }];
      f.render();
      expect(guard().blocked(true)).toBe(true);
      expect(f.output().readiness).toBeUndefined();
      f.input.checks = [ready!];
      f.input.request = { ...f.input.request, prompt: 'changed after preparation' };
      f.render();
      expect(f.output().blocksSubmission).toBe(true);
      expect(guard().blocked(true)).toBe(true);
    }
  );
  it('finds a current provider proof after unrelated stale evidence without granting that provider', async () => {
    const f = mount();
    f.input.request = { ...f.input.request, providerId: 'codex' };
    f.render();
    const proof = await f.settle('codex');
    const [current] = f.input.checks;
    f.input.checks = [
      {
        ...current!,
        providerId: 'anthropic',
        createdTeamReadiness: { ...proof, preparationId: 'TEST-old-preparation' },
      },
      current!,
    ];
    f.render();
    expect(f.output().readiness).toEqual(proof);
    expect(f.output().permits('codex', Date.now())).toBe(true);
    expect(f.output().permits('anthropic', Date.now())).toBe(false);
  });
  it('invalidates expired observations without repeating probes and rejects late green after closing', async () => {
    vi.useFakeTimers();
    const f = mount();
    const proof = await f.settle();
    const previous = f.output().context.preparationId;
    vi.setSystemTime(proof.expiresAt);
    expect(f.output().readiness).toBeUndefined();
    expect(f.output().blocksSubmission).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(60_001);
    });
    expect(f.output().readiness).toBeUndefined();
    expect(f.output().context.preparationId).toBe(previous);
    expect(f.output().blocksSubmission).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1);
    let resolve!: (value: unknown) => void;
    f.run.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const pending = f
      .output()
      .runPreflight({ cacheKey: 'TEST', requestSignature: 'TEST' }, {} as never);
    f.input.open = false;
    f.render();
    resolve({ status: 'ready', createdTeamReadiness: { preparationId: previous } });
    expect((await pending).createdTeamReadiness).toBeUndefined();
  });
  it('retains original Create command after UNKNOWN through renew/reopen and rejects altered intent', async () => {
    const f = mount();
    const calls: TeamCreateRequest[] = [];
    const create = vi.fn(async (request: TeamCreateRequest) => {
      calls.push(request);
      throw new Error('UNKNOWN');
    });
    await expect(f.submit()(f.input.request, create)).rejects.toThrow('UNKNOWN');
    f.input.open = false;
    f.unmount();
    f.input.open = true;
    f.render();
    // Proof/selection renewal is not a new product intent, even after an epoch invalidation.
    invalidateContextScopedRequestEpoch();
    const proof = await f.settle();
    await expect(
      f.submit()({ ...f.input.request, createdTeamReadiness: proof }, create)
    ).rejects.toThrow('UNKNOWN');
    expect(calls[0]!.command).toEqual(calls[1]!.command);
    await expect(f.submit()({ ...f.input.request, prompt: 'TWO' }, create)).rejects.toThrow(
      'uncertain'
    );
    expect(create).toHaveBeenCalledTimes(2);
    const success = vi.fn(async () => {
      invalidateContextScopedRequestEpoch();
      return 'host-team:TEST';
    });
    await expect(f.submit()(f.input.request, success)).rejects.toThrow('context changed');
  });
  it.each(['not-dispatched', 'rejected'] as const)(
    'permits correction only after a typed original Create %s refusal',
    async (outcome) => {
      const f = mount();
      const original: TeamCreateRequest[] = [];
      const create = vi.fn(async (request: TeamCreateRequest) => {
        original.push(request);
        if (original.length === 1)
          throw new IpcError(
            'team:create',
            'safe refusal',
            new TeamCreationRefusal('conflict', outcome)
          );
        return 'host-team:TEST-new';
      });
      await expect(f.submit()(f.input.request, create)).rejects.toThrow('safe refusal');
      f.unmount();
      f.render();
      await expect(
        f.submit()({ ...f.input.request, teamName: 'TEST-corrected' }, create)
      ).resolves.toBe('host-team:TEST-new');
      expect(original[0]!.command!.commandId).not.toBe(original[1]!.command!.commandId);
    }
  );
  it('does not release the retained intent for an untyped error that merely resembles rejection', async () => {
    const f = mount();
    const create = vi.fn(async () => {
      throw Object.assign(new Error('not dispatched'), { code: 'conflict', outcome: 'rejected' });
    });
    await expect(f.submit()(f.input.request, create)).rejects.toThrow('not dispatched');
    await expect(f.submit()({ ...f.input.request, prompt: 'edited' }, create)).rejects.toThrow(
      'uncertain'
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each(['launch', 'config'] as const)(
    'keeps one owner-qualified %s intent across actual unmount and operation changes',
    async (kind) => {
      const f = mount();
      const calls: TeamCreateRequest[] = [];
      const unknown = vi.fn(async (request: TeamCreateRequest) => {
        calls.push(request);
        throw new Error('UNKNOWN');
      });
      createConfig.mockImplementation(unknown);
      const submit = (request: TeamCreateRequest) =>
        kind === 'launch' ? f.submit()(request, unknown) : f.save()(request);
      await expect(submit(f.input.request)).rejects.toThrow('UNKNOWN');
      f.input.open = false;
      f.render(); // Save-only previously cleared the intent merely because open became false.
      f.unmount();
      f.input.open = true;
      f.render();
      context.activeContextId = 'TEST-other-owner';
      await expect(submit(f.input.request)).rejects.toThrow('original owner');
      context.activeContextId = 'TEST-local';
      await expect(submit({ ...f.input.request, prompt: 'changed' })).rejects.toThrow('uncertain');
      await expect(
        kind === 'launch' ? f.save()(f.input.request) : f.submit()(f.input.request, unknown)
      ).rejects.toThrow('original owner and operation');
      expect(calls).toHaveLength(1);
      await expect(submit({ ...f.input.request })).rejects.toThrow('UNKNOWN');
      expect(calls).toHaveLength(2);
      expect(calls[1]!.command).toEqual(calls[0]!.command);
    }
  );
  it.each(['launch', 'config'] as const)(
    'holds the %s slot during an in-flight call even after actual remount, then releases on success',
    async (kind) => {
      const f = mount();
      const calls: TeamCreateRequest[] = [];
      const result =
        kind === 'launch' ? 'host-team:TEST-original' : { teamName: 'host-team:TEST-original' };
      let complete!: () => void;
      const create = vi.fn(async (request: TeamCreateRequest) => {
        calls.push(request);
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
        return result;
      });
      createConfig.mockImplementation(create);
      const submit = (request: TeamCreateRequest) =>
        kind === 'launch' ? f.submit()(request, create) : f.save()(request);
      const pending = submit(f.input.request);
      f.unmount();
      f.render();
      await expect(submit(f.input.request)).rejects.toThrow('still pending');
      expect(calls).toHaveLength(1);
      complete();
      await expect(pending).resolves.toEqual(result);
      const next = submit({ ...f.input.request, teamName: 'TEST-next' });
      complete();
      await expect(next).resolves.toEqual(result);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.command!.commandId).not.toBe(calls[0]!.command!.commandId);
    }
  );
  it('keeps an uncertain save-only command after ordinary untyped rejection and clears on its positive receipt', async () => {
    const f = mount();
    createConfig.mockRejectedValueOnce(new Error('invalid text is not definitive proof'));
    await expect(f.save()(f.input.request)).rejects.toThrow('not definitive proof');
    f.unmount();
    f.render();
    await expect(f.save()({ ...f.input.request, teamName: 'TEST-corrected' })).rejects.toThrow(
      'uncertain'
    );
    createConfig.mockResolvedValue({ teamName: 'host-team:TEST-saved' });
    await expect(f.save()(f.input.request)).resolves.toEqual({ teamName: 'host-team:TEST-saved' });
    expect(createConfig.mock.calls[1]![0].command).toEqual(createConfig.mock.calls[0]![0].command);
    await expect(f.save()({ ...f.input.request, teamName: 'TEST-new' })).resolves.toEqual({
      teamName: 'host-team:TEST-saved',
    });
    expect(createConfig.mock.calls[2]![0].command.commandId).not.toBe(
      createConfig.mock.calls[0]![0].command.commandId
    );
  });
  it.each(['not-dispatched', 'rejected'] as const)(
    'permits save-only correction after its proven original %s refusal',
    async (outcome) => {
      const f = mount();
      createConfig.mockRejectedValueOnce(
        new IpcError(
          'team:createConfig',
          'safe refusal',
          new TeamCreationRefusal('conflict', outcome)
        )
      );
      await expect(f.save()(f.input.request)).rejects.toThrow('safe refusal');
      f.unmount();
      f.render();
      createConfig.mockResolvedValueOnce(undefined);
      await expect(
        f.save()({ ...f.input.request, teamName: 'TEST-corrected' })
      ).resolves.toBeUndefined();
      expect(createConfig.mock.calls[1]![0].command.commandId).not.toBe(
        createConfig.mock.calls[0]![0].command.commandId
      );
    }
  );
  it.each(['launch', 'config'] as const)(
    'does not release a late %s branded refusal after the original owner changes',
    async (kind) => {
      const f = mount();
      const create = vi.fn(async () => {
        context.activeContextId = 'TEST-other-owner';
        throw new TeamCreationRefusal('unavailable', 'not-dispatched');
      });
      createConfig.mockImplementation(create);
      const submit = (request: TeamCreateRequest) =>
        kind === 'launch' ? f.submit()(request, create) : f.save()(request);
      await expect(submit(f.input.request)).rejects.toThrow('creation refused');
      f.unmount();
      f.render();
      context.activeContextId = 'TEST-local';
      await expect(submit({ ...f.input.request, teamName: 'TEST-other' })).rejects.toThrow(
        'uncertain'
      );
      expect(create).toHaveBeenCalledTimes(1);
    }
  );
  it('passes only the last actual successful Host proof through existing diagnostics', async () => {
    const proof = {
      preparationId: 'TEST-prepare',
      selectionSignature: '{}',
      draftDigest: 'TEST-digest',
      expiresAt: Date.now() + 60_000,
    };
    const input = {
      cwd: '/TEST-create',
      providerId: 'anthropic' as const,
      selectedModelIds: ['opus'],
    };
    const prepare = vi
      .fn()
      .mockResolvedValue({ ready: true, message: 'OK', createdTeamReadiness: proof });
    expect(
      (await runProviderPrepareDiagnostics({ ...input, prepareProvisioning: prepare }))
        .createdTeamReadiness
    ).toEqual(proof);
    prepare.mockResolvedValue({ ready: true, message: 'ready text only' });
    expect(
      (await runProviderPrepareDiagnostics({ ...input, prepareProvisioning: prepare }))
        .createdTeamReadiness
    ).toBeUndefined();
    prepare
      .mockResolvedValueOnce({ ready: true, message: 'OK', createdTeamReadiness: proof })
      .mockResolvedValueOnce({ ready: false, message: 'revoked' });
    expect(
      (await runProviderPrepareDiagnostics({ ...input, prepareProvisioning: prepare }))
        .createdTeamReadiness
    ).toBeUndefined();
  });
});
