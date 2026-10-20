import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GatewayRunMetadataStore } from './GatewayRunMetadataStore';

import type { TokenUsageRunDto } from '@features/token-usage/contracts';

let directory: string;
afterEach(async () => {
  vi.useRealTimers();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function nativeRun(
  session: string,
  startedAt: string,
  status: 'running' | 'completed' = 'running'
): TokenUsageRunDto {
  return {
    appRunId: `native:${session}`,
    teamName: 'sandbox',
    agentName: 'alice',
    providerId: 'anthropic',
    runtimeKind: 'anthropic',
    source: 'team_launch_state',
    startedAt,
    status,
    terminationConfirmed: status === 'completed' ? true : undefined,
    endedAt: status === 'completed' ? '2026-10-20T12:30:00Z' : undefined,
    sources: [
      {
        id: session,
        appRunId: `native:${session}`,
        sourceType: 'cli_log',
        nativeSessionId: session,
        discoveredAt: startedAt,
      },
    ],
  };
}

describe('GatewayRunMetadataStore', () => {
  it('persists before discovery, fixes source identity per native session across rebind and restart', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-run-metadata-'));
    const filePath = path.join(directory, 'runs.json');
    const store = new GatewayRunMetadataStore(filePath);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'anthropic',
      gatewayUsageRef: 'old-source',
    });
    expect(await store.hasUnfinishedRuns('old-source')).toBe(true);
    const old = nativeRun('session-old', '2026-10-20T12:00:01Z');
    expect((await store.reconcileRuns([old]))[0].gatewayUsageRef).toBe('old-source');
    vi.setSystemTime(new Date('2026-10-20T12:01:00Z'));
    await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'anthropic',
      gatewayUsageRef: 'new-source',
    });
    const reloaded = new GatewayRunMetadataStore(filePath);
    const runs = await reloaded.reconcileRuns([
      old,
      nativeRun('session-new', '2026-10-20T12:01:01Z'),
    ]);
    expect(runs.map((run) => run.gatewayUsageRef)).toEqual(['old-source', 'new-source']);
    expect((await reloaded.reconcileRuns([])).map((run) => run.gatewayUsageRef)).toEqual([
      'old-source',
      'new-source',
    ]);
    expect(await reloaded.hasUnfinishedRuns('old-source')).toBe(true);
    await reloaded.reconcileRuns([nativeRun('session-old', old.startedAt, 'completed')]);
    expect(await reloaded.hasUnfinishedRuns('old-source')).toBe(false);
    expect(await reloaded.hasUnfinishedRuns('new-source')).toBe(true);
  });

  it('does not apply a preceding gateway route to the next unbound launch', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-run-metadata-'));
    const store = new GatewayRunMetadataStore(path.join(directory, 'runs.json'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'anthropic',
      gatewayUsageRef: 'source',
    });
    vi.setSystemTime(new Date('2026-10-20T12:01:00Z'));
    await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'anthropic',
    });
    const run = nativeRun('unbound', '2026-10-20T12:01:01Z');
    expect((await store.reconcileRuns([run]))[0].gatewayUsageRef).toBeUndefined();
    expect(await store.hasUnfinishedRuns('source')).toBe(true);
  });
  it('retains confirmed native termination after discovery files disappear and reload', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-run-metadata-'));
    const filePath = path.join(directory, 'runs.json');
    const store = new GatewayRunMetadataStore(filePath);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'anthropic',
      gatewayUsageRef: 'source',
    });
    await store.reconcileRuns([nativeRun('stopped-session', '2026-10-20T12:00:01Z')]);
    vi.setSystemTime(new Date('2026-10-20T12:30:00Z'));
    await store.confirmNativeTeamStopped('sandbox');
    const reloaded = new GatewayRunMetadataStore(filePath);
    const retained = await reloaded.reconcileRuns([]);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      gatewayUsageRef: 'source',
      status: 'completed',
      endedAt: '2026-10-20T12:30:00.000Z',
      terminationConfirmed: true,
    });
    expect(await reloaded.hasUnfinishedRuns('source')).toBe(false);
    const stale = await reloaded.reconcileRuns([
      nativeRun('stopped-session', '2026-10-20T12:00:01Z'),
    ]);
    expect(stale[0].endedAt).toBe('2026-10-20T12:30:00.000Z');
  });

  it('releases a known never-spawned attempt while preserving another live attempt', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-run-metadata-'));
    const store = new GatewayRunMetadataStore(path.join(directory, 'runs.json'));
    const failed = await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'anthropic',
      gatewayUsageRef: 'failed-source',
    });
    await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'bob',
      providerId: 'anthropic',
      gatewayUsageRef: 'live-source',
    });
    await store.abortUnspawnedLaunch(failed);
    expect(await store.hasUnfinishedRuns('failed-source')).toBe(false);
    expect(await store.hasUnfinishedRuns('live-source')).toBe(true);
    expect(
      (await store.reconcileRuns([])).find((run) => run.gatewayUsageRef === 'failed-source')
    ).toMatchObject({ status: 'completed', terminationConfirmed: true });
  });
});
