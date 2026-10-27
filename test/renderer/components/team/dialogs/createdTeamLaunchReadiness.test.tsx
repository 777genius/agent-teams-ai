import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TeamCreationRefusal } from '@features/agent-backend/contracts';
import { createLaunchGuard } from '@renderer/components/team/dialogs/providerLaunchAuthority';
import { runProviderPrepareDiagnostics } from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { updateProviderCheck } from '@renderer/components/team/dialogs/provisioningProviderChecks';
import { useCreatedTeamLaunchReadiness } from '@renderer/components/team/dialogs/useCreatedTeamLaunchReadiness';
import { useCreateTeamSubmission } from '@renderer/components/team/dialogs/useCreateTeamSubmission';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import { IpcError } from '@renderer/utils/unwrapIpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreatedTeamReadiness, TeamCreateRequest } from '@shared/types/team';

const { context } = vi.hoisted(() => ({ context: { activeContextId: 'TEST-local' } }));
vi.mock('@renderer/store', () => ({
  useStore: (select: (value: unknown) => unknown) => select(context),
}));
let dispose = () => {};
afterEach(() => {
  dispose();
  context.activeContextId = 'TEST-local';
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
  function View() {
    output = useCreatedTeamLaunchReadiness(input);
    submit = useCreateTeamSubmission();
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
    run,
    render,
    async settle() {
      const proof: CreatedTeamReadiness = {
        preparationId: output.context.preparationId!,
        selectionSignature: JSON.stringify({
          cwd: '/TEST-create',
          members: [],
          prompt: 'ONE',
          teamName: 'TEST-create',
        }),
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
      input.checks = [{ providerId: 'anthropic', ...result }];
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
    f.render();
    f.input.open = true;
    f.render();
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
  it('permits correction with a new command only after a typed original Create refusal', async () => {
    const f = mount();
    const original: TeamCreateRequest[] = [];
    const create = vi.fn(async (request: TeamCreateRequest) => {
      original.push(request);
      if (original.length === 1)
        throw new IpcError(
          'team:create',
          'safe refusal',
          new TeamCreationRefusal('conflict', 'rejected')
        );
      return 'host-team:TEST-new';
    });
    await expect(f.submit()(f.input.request, create)).rejects.toThrow('safe refusal');
    await expect(
      f.submit()({ ...f.input.request, teamName: 'TEST-corrected' }, create)
    ).resolves.toBe('host-team:TEST-new');
    expect(original[0]!.command!.commandId).not.toBe(original[1]!.command!.commandId);
  });
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
