import { describe, expect, it, vi } from 'vitest';

import { createPrMonitorFeature } from '../../../src/features/pr-monitor/main/composition/createPrMonitorFeature';

import type { DeviceLogin, MonitorResult } from '../../../src/features/pr-monitor/contracts';

const control = vi.hoisted(() => ({
  scope: {} as object,
  begin: vi.fn<() => Promise<MonitorResult<DeviceLogin>>>(),
  cancel: vi.fn(),
  poll: vi.fn(),
}));
vi.mock('../../../src/features/pr-monitor/main/adapters/output/projectRepositories', () => ({
  projectRepositories: () => ({
    currentScope: () => control.scope,
    resolve: async () => ({
      ok: true,
      value: {
        repository: { provider: 'github', owner: 'test', repo: 'fixture' },
        scope: control.scope,
      },
    }),
  }),
}));
vi.mock('../../../src/features/pr-monitor/main/composition/githubReaders', () => ({
  createGitHubReaders: () => ({ get: vi.fn(), dispose: vi.fn() }),
}));
vi.mock('../../../src/features/pr-monitor/main/composition/githubAccounts', () => ({
  createGitHubAccounts: () => ({
    flow: {
      configured: true,
      permissionNotice: 'TEST',
      cancel: control.cancel,
      poll: control.poll,
    },
    beginLogin: control.begin,
    connect: vi.fn(),
    signOut: vi.fn(),
    dispose: vi.fn(),
  }),
}));

describe('native login ownership across context replacement', () => {
  it('does not let an old begin completion reset the replacement scope login', async () => {
    const feature = createPrMonitorFeature(
      () => ({
        id: 'local',
        type: 'local',
        getDetailReadSource: () => control.scope,
        projectScanner: { scanWithWorktreeGrouping: async () => [] },
      }),
      {
        configuration: null,
        vault: {
          list: vi.fn(),
          readValueById: vi.fn(),
          save: vi.fn(),
          delete: vi.fn(),
          getStorageStatus: vi.fn(),
        },
      }
    );
    const view: DeviceLogin = {
      attemptId: 'TEST-current',
      userCode: 'TEST-CODE',
      verificationUri: 'https://github.com/login/device',
      expiresAt: '2026-11-28T23:59:59Z',
      intervalMs: 5000,
    };
    let finish!: (result: MonitorResult<DeviceLogin>) => void;
    control.begin
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValueOnce({ ok: true, value: view });
    const previous = feature.login({ contextId: 'old', projectId: 'TEST-old', operation: 'begin' });
    await vi.waitFor(() => expect(control.begin).toHaveBeenCalledOnce());
    control.scope = {};
    feature.reset();
    const request = { contextId: 'current', projectId: 'TEST-current' };
    expect(await feature.login({ ...request, operation: 'begin' })).toMatchObject({ ok: true });
    const cancellations = control.cancel.mock.calls.length;
    finish({ ok: true, value: { ...view, attemptId: 'TEST-retired' } });
    expect(await previous).toMatchObject({ error: { kind: 'aborted' } });
    expect(control.cancel).toHaveBeenCalledTimes(cancellations);
    control.poll.mockResolvedValue({
      ok: true,
      value: { status: 'pending', retryAt: view.expiresAt },
    });
    expect(
      await feature.login({ ...request, operation: 'poll', attemptId: view.attemptId })
    ).toMatchObject({ value: { status: 'pending' } });
    expect(control.poll).toHaveBeenCalledWith(view.attemptId);
    feature.dispose();
  });
});
