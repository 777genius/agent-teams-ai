import { api } from '@renderer/api';
import { installCodexStartupStatusRevalidation } from '@renderer/store/codexStartupStatusRevalidation';
import {
  createCliInstallerSlice,
  createLoadingMultimodelCliStatus,
} from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { CliProviderStatus } from '@shared/types';
import type { StateCreator } from 'zustand';

vi.mock('@renderer/api', () => ({
  api: { cliInstaller: { getProviderStatus: vi.fn() } },
}));

const healthyAccount: CodexAccountSnapshotDto = {
  preferredAuthMode: 'auto',
  effectiveAuthMode: 'chatgpt',
  launchAllowed: true,
  launchIssueMessage: null,
  launchReadinessState: 'ready_chatgpt',
  appServerState: 'healthy',
  appServerStatusMessage: null,
  managedAccount: { type: 'chatgpt', email: null, planType: 'plus' },
  apiKey: { available: false, source: null, sourceLabel: null },
  requiresOpenaiAuth: true,
  login: { status: 'idle', error: null, startedAt: null },
  rateLimits: null,
  updatedAt: '2026-11-10T12:00:00.000Z',
};

function fixture() {
  const store = createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
  const status = createLoadingMultimodelCliStatus();
  const unknown: CliProviderStatus = {
    ...status.providers.find((provider) => provider.providerId === 'codex')!,
    supported: true,
    statusCheckOutcome: 'authoritative',
    statusMessage: null,
  };
  store.setState({ cliStatus: status });
  let onSnapshot: ((_event: unknown, snapshot: CodexAccountSnapshotDto) => void) | undefined;
  const unsubscribe = vi.fn();
  const accountApi = {
    getCodexAccountSnapshot: vi.fn(async () => healthyAccount),
    onCodexAccountSnapshotChanged: vi.fn((callback: typeof onSnapshot) => {
      onSnapshot = callback;
      return unsubscribe;
    }),
  };
  const cleanup = installCodexStartupStatusRevalidation(store, accountApi);
  return {
    store,
    unknown,
    accountApi,
    cleanup,
    unsubscribe,
    push: (snapshot = healthyAccount) => onSnapshot?.({}, snapshot),
  };
}

afterEach(() => vi.clearAllMocks());

describe('Codex startup status revalidation', () => {
  it('rechecks after account warming races the initial probe, without joining the old request', async () => {
    const test = fixture();
    let resolveInitial!: (provider: CliProviderStatus) => void;
    let resolveFresh!: (provider: CliProviderStatus) => void;
    vi.mocked(api.cliInstaller.getProviderStatus)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve;
          })
      );
    try {
      const initial = test.store.getState().fetchCliProviderStatus('codex');
      test.push();
      await Promise.resolve();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
      resolveInitial(test.unknown);
      await initial;
      await vi.waitFor(() => expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(2));
      expect(
        test.store.getState().cliStatus?.providers.find((p) => p.providerId === 'codex')
      ).toMatchObject({ authenticated: false, capabilities: { teamLaunch: false } });
      resolveFresh({ ...test.unknown, authenticated: true, verificationState: 'verified' });
      await vi.waitFor(() =>
        expect(test.store.getState().cliProviderStatusLoading.codex).toBe(false)
      );
      test.push();
      test.push({ ...healthyAccount, updatedAt: '2026-11-10T12:01:00.000Z' });
      await Promise.resolve();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(2);
      expect(test.accountApi.getCodexAccountSnapshot).not.toHaveBeenCalled();
    } finally {
      test.cleanup();
    }
  });

  it('discovers an already warm account once and does not retry every account update after failure', async () => {
    const test = fixture();
    vi.mocked(api.cliInstaller.getProviderStatus).mockResolvedValue(test.unknown);
    try {
      test.store.setState({
        cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [test.unknown] },
      });
      await vi.waitFor(() => expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1));
      expect(test.accountApi.getCodexAccountSnapshot).toHaveBeenCalledTimes(1);
      test.push();
      test.push();
      await Promise.resolve();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
    } finally {
      test.cleanup();
    }
  });

  it('ignores signed-out snapshots and unsubscribes with pending work on disposal', async () => {
    const test = fixture();
    test.push({ ...healthyAccount, effectiveAuthMode: null, launchAllowed: false });
    test.store.setState({
      cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [test.unknown] },
    });
    test.cleanup();
    await Promise.resolve();
    expect(test.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.cliInstaller.getProviderStatus).not.toHaveBeenCalled();
    expect(test.accountApi.getCodexAccountSnapshot).not.toHaveBeenCalled();
  });
});
