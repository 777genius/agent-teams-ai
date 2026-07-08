import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeMemberMessageDeliveryService,
  createOpenCodeMemberMessageDeliveryServiceFromHost,
  createOpenCodeRuntimeBootstrapEvidencePorts,
  createTeamProvisioningOpenCodeMemberMessageDeliveryHostFromService,
  deliverOpenCodeMemberMessage,
  type OpenCodeMemberMessageDeliveryFactoryPorts,
  type TeamProvisioningOpenCodeMemberMessageDeliveryHost,
  type TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost,
} from '../TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';

describe('TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory', () => {
  it('creates bootstrap evidence ports from explicit factory input', () => {
    const warn = vi.fn();
    const teamsBasePath = path.join(tmpdir(), 'opencode-member-message-delivery');
    const ports = createOpenCodeRuntimeBootstrapEvidencePorts({
      teamsBasePath,
      warn,
    });

    expect(ports.teamsBasePath).toBe(teamsBasePath);
    expect(ports.warn).toBe(warn);
  });

  it('builds the delivery service and delegates delivery through the helper', async () => {
    const ports = {
      getOpenCodeRuntimeMessageAdapter: vi.fn(() => null),
      createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() =>
        createOpenCodeRuntimeBootstrapEvidencePorts({
          teamsBasePath: path.join(tmpdir(), 'opencode-member-message-delivery'),
          warn: vi.fn(),
        })
      ),
    } as unknown as OpenCodeMemberMessageDeliveryFactoryPorts;

    const service = createOpenCodeMemberMessageDeliveryService(ports);
    const delivery = await deliverOpenCodeMemberMessage(service, 'team-a', {
      memberName: 'Ada',
      text: 'hello',
    });

    expect(delivery).toEqual({
      delivered: false,
      reason: 'opencode_runtime_message_bridge_unavailable',
    });
    expect(ports.getOpenCodeRuntimeMessageAdapter).toHaveBeenCalledTimes(1);
    expect(ports.createOpenCodeRuntimeBootstrapEvidencePorts).not.toHaveBeenCalled();
  });

  it('creates the delivery service from a provisioning host boundary', async () => {
    const host = {
      getOpenCodeRuntimeMessageAdapter: vi.fn(() => null),
      createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(),
    } as unknown as TeamProvisioningOpenCodeMemberMessageDeliveryHost;

    const service = createOpenCodeMemberMessageDeliveryServiceFromHost(host);
    const delivery = await deliverOpenCodeMemberMessage(service, 'team-a', {
      memberName: 'Ada',
      text: 'hello',
    });

    expect(delivery).toEqual({
      delivered: false,
      reason: 'opencode_runtime_message_bridge_unavailable',
    });
    expect(host.getOpenCodeRuntimeMessageAdapter).toHaveBeenCalledTimes(1);
    expect(host.createOpenCodeRuntimeBootstrapEvidencePorts).not.toHaveBeenCalled();
  });

  it('builds the delivery host from service-shaped ports without freezing mutable seams', async () => {
    const firstAdapterGetter = vi.fn(() => null);
    const secondAdapterGetter = vi.fn(() => null);
    const service = {
      appShellBoundary: {
        getOpenCodeRuntimeMessageAdapter: firstAdapterGetter,
      },
      readOpenCodeMemberDirectory: vi.fn(async () => ({ members: [] })),
      resolveOpenCodeMemberIdentityFromDirectory: vi.fn(async () => null),
      stoppingSecondaryRuntimeTeams: new Set<string>(),
      readPersistedTeamProjectPath: vi.fn(async () => path.join('/tmp', 'team-a')),
      runTracking: {
        resolveDeliverableTrackedRuntimeRunId: vi.fn(() => 'run-1'),
      },
      runs: new Map(),
      getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'runtime-run-1'),
      openCodeRuntimeRecoveryIdentity: {
        resolveCurrentOpenCodeRuntimeRunId: vi.fn(() => 'runtime-run-2'),
        isOpenCodeRuntimeLaneIndexActive: vi.fn(() => true),
      },
      providerRuntime: {
        resolveControlApiBaseUrl: vi.fn(() => 'http://127.0.0.1:1234'),
      },
      createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(),
      sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(),
      rememberOpenCodeRuntimePidFromBridge: vi.fn(),
      maybeSyncOpenCodeRuntimePermissionsAfterDelivery: vi.fn(),
      isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: vi.fn(),
      createOpenCodePromptDeliveryLedger: vi.fn(),
      isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(),
      getOpenCodeDeliveryPendingReason: vi.fn(),
      markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: vi.fn(),
      scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
      logOpenCodePromptDeliveryEvent: vi.fn(),
      requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(),
      emitOpenCodePromptDeliveryTaskLogChange: vi.fn(),
      observeOpenCodeDirectUserDeliveryInlineIfNeeded: vi.fn(),
      tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(),
      tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: vi.fn(),
      deleteSecondaryRuntimeRun: vi.fn(),
      openCodeStoppedLaneCleanup: {
        cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
      },
    } as unknown as TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost;

    const host = createTeamProvisioningOpenCodeMemberMessageDeliveryHostFromService(service);

    expect(host.getOpenCodeRuntimeMessageAdapter()).toBeNull();
    service.appShellBoundary.getOpenCodeRuntimeMessageAdapter = secondAdapterGetter;

    expect(host.getOpenCodeRuntimeMessageAdapter()).toBeNull();
    expect(firstAdapterGetter).toHaveBeenCalledTimes(1);
    expect(secondAdapterGetter).toHaveBeenCalledTimes(1);
    const projectPath = await Promise.resolve(host.readPersistedTeamProjectPath('team-a'));
    expect(projectPath).toBe(path.join('/tmp', 'team-a'));
    expect(host.runTracking.resolveDeliverableTrackedRuntimeRunId('team-a')).toBe('run-1');
    expect(
      host.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive('team-a', 'lane-a')
    ).toBe(true);
    expect(host.providerRuntime.resolveControlApiBaseUrl()).toBe('http://127.0.0.1:1234');
  });
});
