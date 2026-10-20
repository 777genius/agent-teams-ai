import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { toOpenCodeGatewayProviderId } from '@features/gateway-provider/main';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGatewayLaunchRuntime } from './createGatewayLaunchRuntime';
import { GatewayRunMetadataStore } from './GatewayRunMetadataStore';

import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function setup() {
  directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-launch-test-'));
  const source = {
    gatewayUsageRef: 'usage-worker',
    canonicalEndpoint: 'https://gateway.test',
    allowPrivateNetwork: false,
    teamName: 'sandbox',
    memberName: 'worker',
    firstUsageDay: '2026-10-20',
    lastBoundAt: '2026-10-20T00:00:00Z',
    hasActiveBinding: false,
    hasRuntimeArtifact: true,
  };
  const feature = {
    resolveMemberConnection: vi.fn(async () => null),
    markRuntimeArtifactActive: vi.fn(async () => undefined),
    markRuntimeArtifactRetired: vi.fn(async () => undefined),
    listGatewayUsageSources: vi.fn(async () => [source]),
  };
  const connector = {
    configureGatewayProvider: vi.fn(),
    retireGatewayProvider: vi.fn(async () => ({ retired: true })),
  };
  const runsPath = path.join(directory, 'runs.json');
  const runtime = createGatewayLaunchRuntime({ feature, connector, runsPath });
  const input = {
    teamName: 'sandbox',
    expectedMembers: [
      { name: 'worker', model: toOpenCodeGatewayProviderId(source) + '/gateway-model' },
    ],
  } as Parameters<TeamLaunchRuntimeAdapter['launch']>[0];
  const store = new GatewayRunMetadataStore(runsPath);
  return { source, feature, connector, runtime, input, store };
}

describe('OpenCode gateway launch attempts', () => {
  it('retires stopped artifacts without usage refresh while retaining unfinished launches', async () => {
    const { source, feature, connector, runtime, store } = await setup();
    const id = await store.snapshotLaunch({
      teamName: source.teamName,
      memberName: source.memberName,
      providerId: 'opencode',
      gatewayUsageRef: source.gatewayUsageRef,
    });
    await runtime.retireStoppedArtifacts();
    expect(connector.retireGatewayProvider).not.toHaveBeenCalled();
    await runtime.seams.confirmLaunchStopped?.(id);
    expect(connector.retireGatewayProvider).toHaveBeenCalledOnce();
    expect(feature.markRuntimeArtifactRetired).toHaveBeenCalledWith(source.gatewayUsageRef);
  });

  it('closes a rejected attempt so it does not block artifact retirement', async () => {
    const { source, feature, connector, runtime, input, store } = await setup();
    const failure = new Error('transient shared runtime unavailable');
    const adapter = runtime.wrapOpenCodeAdapter({
      launch: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as TeamLaunchRuntimeAdapter);
    await expect(adapter.launch(input)).rejects.toBe(failure);
    expect(await store.hasUnfinishedRuns(source.gatewayUsageRef)).toBe(false);
    await runtime.reconcileRuns([]);
    expect(connector.retireGatewayProvider).toHaveBeenCalledOnce();
    expect(feature.markRuntimeArtifactRetired).toHaveBeenCalledWith(source.gatewayUsageRef);
  });
  it('also closes already-created snapshots if the final source lookup rejects', async () => {
    const { source, feature, runtime, input, store } = await setup();
    const failure = new Error('source lookup failed');
    feature.listGatewayUsageSources.mockResolvedValueOnce([source]).mockRejectedValueOnce(failure);
    const launch = vi.fn();
    const adapter = runtime.wrapOpenCodeAdapter({ launch } as unknown as TeamLaunchRuntimeAdapter);
    await expect(adapter.launch(input)).rejects.toBe(failure);
    expect(launch).not.toHaveBeenCalled();
    expect(await store.hasUnfinishedRuns(source.gatewayUsageRef)).toBe(false);
  });
  it('retains the primary launch error if closing the metadata also fails', async () => {
    const { runtime, input } = await setup();
    const failure = new Error('launch unavailable');
    const abort = vi
      .spyOn(GatewayRunMetadataStore.prototype, 'abortUnspawnedLaunch')
      .mockRejectedValue(new Error('storage unavailable'));
    try {
      const adapter = runtime.wrapOpenCodeAdapter({
        launch: vi.fn(async () => {
          throw failure;
        }),
      } as unknown as TeamLaunchRuntimeAdapter);
      await expect(adapter.launch(input)).rejects.toBe(failure);
      expect(console.warn).toHaveBeenCalledWith(
        '[GatewayLaunchRuntime]',
        'Could not close all rejected gateway launch snapshots.'
      );
      vi.mocked(console.warn).mockClear();
    } finally {
      abort.mockRestore();
    }
  });
});
