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
  it('preserves historical native stop times across later team stops and late discovery', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-run-metadata-'));
    const store = new GatewayRunMetadataStore(path.join(directory, 'runs.json'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const old = await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'anthropic',
      gatewayUsageRef: 'old-source',
    });
    await store.reconcileRuns([nativeRun('old-session', '2026-10-20T12:00:01Z')]);
    vi.setSystemTime(new Date('2026-10-20T12:30:00Z'));
    await store.confirmNativeTeamStopped('sandbox');
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'anthropic',
      gatewayUsageRef: 'new-source',
    });
    await store.reconcileRuns([nativeRun('new-session', '2026-10-21T12:00:01Z')]);
    vi.setSystemTime(new Date('2026-10-21T12:30:00Z'));
    await store.confirmNativeTeamStopped('sandbox');
    await store.confirmLaunchStopped(old);
    const retained = await store.reconcileRuns([
      nativeRun('late-old-session', '2026-10-20T12:00:02Z'),
    ]);
    expect(retained.filter((run) => run.gatewayUsageRef === 'old-source')).toHaveLength(2);
    expect(
      retained
        .filter((run) => run.gatewayUsageRef === 'old-source')
        .every((run) => run.endedAt === '2026-10-20T12:30:00.000Z' && run.terminationConfirmed)
    ).toBe(true);
    expect(retained.find((run) => run.gatewayUsageRef === 'new-source')?.endedAt).toBe(
      '2026-10-21T12:30:00.000Z'
    );
    expect(await store.hasUnfinishedRuns('old-source')).toBe(false);
  });

  it('does not move OpenCode termination or an aborted attempt to a later day', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-run-metadata-'));
    const store = new GatewayRunMetadataStore(path.join(directory, 'runs.json'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const old = await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'opencode',
      gatewayUsageRef: 'old-source',
    });
    const failed = await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'bob',
      providerId: 'anthropic',
      gatewayUsageRef: 'failed-source',
    });
    await store.recordOpenCodeSessions(
      'sandbox',
      [{ memberName: 'alice', sessionId: 'old-session', runtimeAlive: true }],
      [old]
    );
    await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'charlie',
      providerId: 'opencode',
      gatewayUsageRef: 'empty-opencode-source',
    });
    vi.setSystemTime(new Date('2026-10-20T12:30:00Z'));
    await store.confirmOpenCodeStopped('sandbox', [
      { memberName: 'alice', sessionId: 'old-session', stopped: true },
    ]);
    await store.abortUnspawnedLaunch(failed);
    await store.confirmOpenCodeStopped('sandbox', [{ memberName: 'charlie', stopped: true }]);
    vi.setSystemTime(new Date('2026-10-21T12:30:00Z'));
    await store.confirmOpenCodeStopped('sandbox', [{ memberName: 'alice', stopped: true }]);
    await store.abortUnspawnedLaunch(failed);
    await store.confirmOpenCodeStopped('sandbox', [{ memberName: 'charlie', stopped: true }]);
    const retained = await store.reconcileRuns([]);
    expect(retained).toHaveLength(3);
    expect(retained.every((run) => run.endedAt === '2026-10-20T12:30:00.000Z')).toBe(true);
  });

  it('requires the current launch receipt for OpenCode sessions and keeps a later unbound run ordinary', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-run-metadata-'));
    const filePath = path.join(directory, 'runs.json');
    const store = new GatewayRunMetadataStore(filePath);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const old = await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'opencode',
      gatewayUsageRef: 'old-source',
    });
    await store.recordOpenCodeSessions(
      'sandbox',
      [{ memberName: 'alice', sessionId: 'old-session', runtimeAlive: true }],
      [old]
    );
    vi.setSystemTime(new Date('2026-10-20T12:01:00Z'));
    await store.confirmOpenCodeStopped('sandbox', [
      { memberName: 'alice', sessionId: 'old-session', stopped: true },
    ]);
    await store.recordOpenCodeSessions(
      'sandbox',
      [{ memberName: 'alice', sessionId: 'ordinary-session', runtimeAlive: true }],
      []
    );
    const run = {
      ...nativeRun('ordinary-session', '2026-10-20T12:02:00Z'),
      providerId: 'opencode',
      runtimeKind: 'opencode',
    } as TokenUsageRunDto;
    const reconciled = await new GatewayRunMetadataStore(filePath).reconcileRuns([run]);
    expect(reconciled[0].gatewayUsageRef).toBeUndefined();
    expect(reconciled.filter((item) => item.gatewayUsageRef === 'old-source')).toHaveLength(1);
    expect(reconciled[1]).toMatchObject({
      gatewayUsageRef: 'old-source',
      status: 'completed',
      terminationConfirmed: true,
    });
    expect(await store.hasUnfinishedRuns('old-source')).toBe(false);
  });

  it('records OpenCode results only in this attempt, preserving older session ownership across a rebind', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-run-metadata-'));
    const store = new GatewayRunMetadataStore(path.join(directory, 'runs.json'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const old = await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'opencode',
      gatewayUsageRef: 'old-source',
    });
    const newer = await store.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'alice',
      providerId: 'opencode',
      gatewayUsageRef: 'new-source',
    });
    const foreign = await store.snapshotLaunch({
      teamName: 'other',
      memberName: 'alice',
      providerId: 'opencode',
      gatewayUsageRef: 'foreign-source',
    });
    await store.recordOpenCodeSessions(
      'sandbox',
      [
        { memberName: 'alice', sessionId: 'old-session', runtimeAlive: true },
        { memberName: 'bob', sessionId: 'foreign-member', runtimeAlive: true },
      ],
      [old, foreign]
    );
    await store.recordOpenCodeSessions(
      'sandbox',
      [{ memberName: 'alice', sessionId: 'new-session', runtimeAlive: true }],
      [newer]
    );
    const runs = await store.reconcileRuns([
      {
        ...nativeRun('old-session', '2026-10-20T12:00:01Z'),
        providerId: 'opencode',
        runtimeKind: 'opencode',
        agentId: 'native-alice',
      },
      {
        ...nativeRun('new-session', '2026-10-20T12:00:01Z'),
        providerId: 'opencode',
        runtimeKind: 'opencode',
      },
    ]);
    expect(runs[0]).toMatchObject({ gatewayUsageRef: 'old-source', agentId: 'native-alice' });
    expect(runs[1]).toMatchObject({ gatewayUsageRef: 'new-source', agentId: 'sandbox:alice' });
    expect(runs.some((run) => run.agentName === 'bob')).toBe(false);
    expect(runs.find((run) => run.gatewayUsageRef === 'foreign-source')?.sources).toEqual([]);
  });

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
