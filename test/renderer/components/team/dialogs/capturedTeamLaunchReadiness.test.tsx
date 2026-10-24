import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { createLaunchGuard } from '@renderer/components/team/dialogs/providerLaunchAuthority';
import { runProviderPrepareDiagnostics } from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { updateProviderCheck } from '@renderer/components/team/dialogs/provisioningProviderChecks';
import { useCapturedTeamLaunchReadiness } from '@renderer/components/team/dialogs/useCapturedTeamLaunchReadiness';
import { capturedTeamSelectionSignature } from '@shared/utils/capturedTeamReadiness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProvisioningProviderCheck } from '@renderer/components/team/dialogs/provisioningProviderChecks';
import type { CapturedTeamReadiness, TeamProvisioningPrepareResult } from '@shared/types';

const { context } = vi.hoisted(() => ({ context: { activeContextId: 'local' } }));
vi.mock('@renderer/store', () => ({ useStore: (select: (value: unknown) => unknown) => select(context) }));

const proof: CapturedTeamReadiness = {
  handleId: 'TEST-handle', preparationId: 'TEST-preparation', launchId: 'TEST-launch',
  rosterRevision: 'TEST-source', selectionSignature: '["/TEST",true,[["anthropic","opus","medium",null]]]',
  expiresAt: Date.now() + 60_000,
};
const check = { providerId: 'anthropic' as const, model: 'opus', effort: 'medium' as const };
let dispose = () => {};
afterEach(() => { dispose(); context.activeContextId = 'local'; vi.useRealTimers(); });

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolve!: (value: { status: 'ready'; details: string[]; warnings: string[]; modelResultsById: Record<string, never>; capturedTeamReadiness: CapturedTeamReadiness }) => void;
  const pending = new Promise<Parameters<typeof resolve>[0]>(done => { resolve = done; });
  const run = vi.fn().mockResolvedValue({ status: 'ready', details: [], warnings: [], modelResultsById: {}, capturedTeamReadiness: proof });
  const input: Parameters<typeof useCapturedTeamLaunchReadiness>[0] = {
    open: true, teamName: 'host-team:TEST-handle', preparationId: proof.preparationId,
    sourceRevision: 'TEST-configuration', cwd: '/TEST', selectedModelChecks: [check],
    limitContext: true, draft: { prompt: 'ONE' }, checks: [],
    fence: { runPreflight: run } as unknown as Parameters<typeof useCapturedTeamLaunchReadiness>[0]['fence'],
  };
  let output!: ReturnType<typeof useCapturedTeamLaunchReadiness>;
  function View() { output = useCapturedTeamLaunchReadiness(input); return null; }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(<View />));
  render();
  dispose = () => { act(() => root.unmount()); host.remove(); };
  return { input, output: () => output, render, run, pending, resolve,
    async settle() {
      let result!: Awaited<ReturnType<typeof output.runPreflight>>;
      await act(async () => { result = await output.runPreflight({ cacheKey: 'TEST', requestSignature: 'TEST' }, {} as never); });
      input.checks = [{ providerId: 'anthropic', ...result }];
      render();
    },
  };
}

describe('captured Team readiness in the original launch guard', () => {
  it('permits only the current Team/draft/preparation and expires at click time without global auth', async () => {
    const f = mount();
    const guard = () => createLaunchGuard(['anthropic'], new Map(), undefined, f.output());
    expect(guard().blocked(true)).toBe(true);
    await f.settle();
    expect(guard().blocked(true)).toBe(false);
    expect(guard().blocked(true, proof.expiresAt)).toBe(true);
    f.input.draft = { prompt: 'TWO' }; f.render();
    expect(guard().blocked(true)).toBe(true);
    f.input.draft = { prompt: 'ONE' }; f.input.teamName = 'host-team:other'; f.render();
    expect(guard().blocked(true)).toBe(true);
    f.input.teamName = 'host-team:TEST-handle'; f.input.preparationId = 'other'; f.render();
    expect(guard().blocked(true)).toBe(true);
  });
  it('rejects a late successful response after draft/context edits and clears authority on progress/failure', async () => {
    const f = mount(); f.run.mockReturnValueOnce(f.pending);
    const result = f.output().runPreflight({ cacheKey: 'TEST', requestSignature: 'TEST' }, {} as never);
    context.activeContextId = 'other'; f.input.draft = { prompt: 'TWO' }; f.render();
    f.resolve({ status: 'ready', details: [], warnings: [], modelResultsById: {}, capturedTeamReadiness: proof });
    expect((await result).capturedTeamReadiness).toBeUndefined();
    const checks: ProvisioningProviderCheck[] = [{ providerId: 'anthropic', status: 'ready', details: [], capturedTeamReadiness: proof, capturedTeamDraftSignature: 'old' }];
    expect(updateProviderCheck(checks, 'anthropic', { status: 'checking' })[0]!.capturedTeamReadiness).toBeUndefined();
    expect(updateProviderCheck(checks, 'anthropic', { status: 'failed' })[0]!.capturedTeamReadiness).toBeUndefined();
  });
  it('drops readiness on close or source change and invalidates the rendered guard on expiry', async () => {
    vi.useFakeTimers(); const f = mount(); await f.settle();
    expect(f.output().permits('anthropic', Date.now())).toBe(true);
    f.input.sourceRevision = 'changed'; f.render();
    expect(f.output().permits('anthropic', Date.now())).toBe(false);
    f.input.sourceRevision = 'TEST-configuration'; f.input.open = false; f.render();
    expect(f.output().permits('anthropic', Date.now())).toBe(false);
    f.input.open = true; f.render();
    await act(async () => { vi.advanceTimersByTime(60_001); });
    expect(f.output().permits('anthropic', Date.now())).toBe(false);
  });
});

describe('diagnostics scope survives only actual current Host evidence', () => {
  const input = { cwd: '/TEST', providerId: 'anthropic' as const, selectedModelIds: ['opus'], selectedModelChecks: [check], limitContext: true };
  it('passes typed successful evidence, never synthesizes it from ready text or cached model results', async () => {
    const prepare = vi.fn().mockResolvedValue({ ready: true, message: 'OK', capturedTeamReadiness: proof } satisfies TeamProvisioningPrepareResult);
    expect((await runProviderPrepareDiagnostics({ ...input, prepareProvisioning: prepare })).capturedTeamReadiness).toEqual(proof);
    prepare.mockResolvedValue({ ready: true, message: 'ready text only' });
    const result = await runProviderPrepareDiagnostics({ ...input, prepareProvisioning: prepare, cachedModelResultsById: { opus: { status: 'ready', line: 'verified' } } });
    expect(result.status).toBe('ready'); expect(result.capturedTeamReadiness).toBeUndefined();
  });
  it('does not retain compatibility proof when a later deep read fails', async () => {
    const prepare = vi.fn().mockResolvedValueOnce({ ready: true, message: 'OK', capturedTeamReadiness: proof }).mockResolvedValueOnce({ ready: false, message: 'revoked' });
    expect((await runProviderPrepareDiagnostics({ ...input, prepareProvisioning: prepare })).capturedTeamReadiness).toBeUndefined();
  });
});

it('original mixed-provider launch guard requires each provider plan proof for its own selection and rejects cross-provider or edited evidence', async () => {
  const f = mount();
  f.input.selectedModelChecks = [
    check,
    { providerId: 'codex', model: 'TEST-codex', effort: 'minimal' },
    { providerId: 'opencode', model: 'TEST-local/TEST-open' },
  ];
  f.render();
  const providers = ['anthropic', 'codex', 'opencode'] as const;
  const guard = () => createLaunchGuard(providers, new Map(), undefined, f.output());
  expect(guard().blockers(true)).toHaveLength(3);
  for (const providerId of providers) {
    const selected = f.input.selectedModelChecks.filter((row) => row.providerId === providerId);
    const selectedProof = {
      ...proof,
      selectionSignature: capturedTeamSelectionSignature({
        cwd: f.input.cwd,
        limitContext: f.input.limitContext,
        selectedModelChecks: selected,
      }),
    };
    f.run.mockResolvedValueOnce({
      status: 'ready',
      details: [],
      warnings: [],
      modelResultsById: {},
      capturedTeamReadiness: selectedProof,
    });
    let result!: Awaited<
      ReturnType<ReturnType<typeof useCapturedTeamLaunchReadiness>['runPreflight']>
    >;
    await act(async () => {
      result = await f
        .output()
        .runPreflight({ cacheKey: providerId, requestSignature: providerId }, {} as never);
    });
    f.input.checks = [...f.input.checks, { providerId, ...result }];
    f.render();
    expect(f.output().permits(providerId, Date.now())).toBe(true);
  }
  expect(guard().blocked(true)).toBe(false);
  expect(f.output().permits('gemini', Date.now())).toBe(false);
  const codex = f.input.checks.find((row) => row.providerId === 'codex')!;
  codex.capturedTeamReadiness = { ...proof };
  f.render();
  expect(f.output().permits('codex', Date.now())).toBe(false);
  expect(f.output().permits('anthropic', Date.now())).toBe(true);
  f.input.selectedModelChecks = f.input.selectedModelChecks.map((row) =>
    row.providerId === 'opencode' ? { ...row, model: 'TEST-other' } : row
  );
  f.render();
  expect(guard().blockers(true)).toHaveLength(3);
});
