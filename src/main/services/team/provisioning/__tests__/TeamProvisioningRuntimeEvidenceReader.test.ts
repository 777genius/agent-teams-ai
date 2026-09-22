import { describe, expect, it } from 'vitest';

import {
  hasTeamProvisioningRuntimePermissionBlock,
  readTeamProvisioningBootstrapEvidence,
} from '../TeamProvisioningRuntimeEvidenceReader';
import { resolveTeamProvisioningRuntimeLiveness } from '../TeamProvisioningRuntimeLiveness';

const NOW = '2026-04-24T12:00:00.000Z';

describe('TeamProvisioningRuntimeEvidenceReader', () => {
  it.each([
    {
      label: 'the observation instant',
      lastHeartbeatAt: NOW,
      expectedFreshness: 'fresh',
      expectedConfirmed: true,
    },
    {
      label: 'the exact freshness boundary',
      lastHeartbeatAt: '2026-04-24T11:58:00.000Z',
      expectedFreshness: 'fresh',
      expectedConfirmed: true,
    },
    {
      label: 'one millisecond beyond the freshness boundary',
      lastHeartbeatAt: '2026-04-24T11:57:59.999Z',
      expectedFreshness: 'stale',
      expectedConfirmed: false,
    },
    {
      label: 'one millisecond in the future',
      lastHeartbeatAt: '2026-04-24T12:00:00.001Z',
      expectedFreshness: 'future_timestamp',
      expectedConfirmed: false,
    },
    {
      label: 'an invalid timestamp',
      lastHeartbeatAt: 'invalid',
      expectedFreshness: 'invalid_timestamp',
      expectedConfirmed: false,
    },
    {
      label: 'missing timestamp evidence',
      lastHeartbeatAt: undefined,
      expectedFreshness: 'missing_timestamp',
      expectedConfirmed: false,
    },
  ] as const)(
    'classifies raw bootstrap confirmation at $label conservatively',
    ({ lastHeartbeatAt, expectedFreshness, expectedConfirmed }) => {
      const evidence = readTeamProvisioningBootstrapEvidence({
        status: {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          lastHeartbeatAt,
          updatedAt: lastHeartbeatAt ? NOW : '',
        },
        nowIso: NOW,
      });

      expect(evidence).toMatchObject({
        rawBootstrapConfirmed: true,
        bootstrapConfirmed: expectedConfirmed,
        heartbeatFreshness: expectedFreshness,
      });
    }
  );

  it('uses updatedAt when a confirmed status has no dedicated heartbeat timestamp', () => {
    expect(
      readTeamProvisioningBootstrapEvidence({
        status: {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          updatedAt: NOW,
        },
        nowIso: NOW,
      })
    ).toMatchObject({
      bootstrapConfirmed: true,
      heartbeatAt: NOW,
      heartbeatFreshness: 'fresh',
    });
  });

  it.each([
    { label: 'strict UTC', timestamp: '2026-04-24T12:00:00Z' },
    { label: 'strict offset', timestamp: '2026-04-24T14:00:00+02:00' },
    { label: 'zone-less UTC', timestamp: '2026-04-24T12:00:00' },
    { label: 'space-separated UTC', timestamp: '2026-04-24 12:00:00.000' },
    { label: 'compact positive offset', timestamp: '2026-04-24T17:30:00+0530' },
    { label: 'space and compact negative offset', timestamp: '2026-04-24 07:00:00-0500' },
    {
      label: 'nanosecond precision',
      timestamp: '2026-04-24T12:00:00.000000001Z',
    },
  ])('accepts $label producer timestamps', ({ timestamp }) => {
    expect(
      readTeamProvisioningBootstrapEvidence({
        status: {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          lastHeartbeatAt: timestamp,
          updatedAt: NOW,
        },
        nowIso: NOW,
      })
    ).toMatchObject({
      bootstrapConfirmed: true,
      heartbeatFreshness: 'fresh',
    });
  });

  it.each([
    { label: 'an impossible date', timestamp: '2026-02-30T12:00:00.000Z' },
    { label: 'a non-leap day', timestamp: '2025-02-29T12:00:00Z' },
    { label: 'month thirteen', timestamp: '2026-13-24T12:00:00Z' },
    { label: 'hour twenty-four', timestamp: '2026-04-24T24:00:00Z' },
    { label: 'minute sixty', timestamp: '2026-04-24T12:60:00Z' },
    { label: 'second sixty', timestamp: '2026-04-24T12:00:60Z' },
    { label: 'offset hour twenty-four', timestamp: '2026-04-24T12:00:00+2400' },
    { label: 'offset minute sixty', timestamp: '2026-04-24T12:00:00+12:60' },
    { label: 'a partial offset', timestamp: '2026-04-24T12:00:00+05' },
    { label: 'an empty fraction', timestamp: '2026-04-24T12:00:00.Z' },
    { label: 'an overlong fraction', timestamp: '2026-04-24T12:00:00.1234567890Z' },
    { label: 'lowercase UTC', timestamp: '2026-04-24T12:00:00z' },
    { label: 'trailing junk', timestamp: '2026-04-24T12:00:00Z later' },
  ])('rejects $label', ({ timestamp }) => {
    expect(
      readTeamProvisioningBootstrapEvidence({
        status: {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          lastHeartbeatAt: timestamp,
          updatedAt: NOW,
        },
        nowIso: NOW,
      })
    ).toMatchObject({
      bootstrapConfirmed: false,
      heartbeatFreshness: 'invalid_timestamp',
    });
  });

  it.each([
    { label: 'NaN', staleAfterMs: Number.NaN },
    { label: 'positive infinity', staleAfterMs: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', staleAfterMs: Number.NEGATIVE_INFINITY },
  ])('rejects a $label freshness window', ({ staleAfterMs }) => {
    expect(
      readTeamProvisioningBootstrapEvidence({
        status: {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          lastHeartbeatAt: NOW,
          updatedAt: NOW,
        },
        nowIso: NOW,
        heartbeatStaleAfterMs: staleAfterMs,
      })
    ).toMatchObject({
      bootstrapConfirmed: false,
      heartbeatFreshness: 'invalid_timestamp',
    });
  });

  it('does not mark a fresh producer-formatted heartbeat offline', () => {
    const lastHeartbeatAt = '2026-04-24 11:59:30+0000';
    expect(
      resolveTeamProvisioningRuntimeLiveness({
        teamName: 'demo',
        memberName: 'worker',
        backendType: 'process',
        trackedSpawnStatus: {
          status: 'online',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastHeartbeatAt,
          updatedAt: NOW,
        },
        processRows: [],
        processTableAvailable: true,
        nowIso: NOW,
      })
    ).toMatchObject({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      runtimeLastSeenAt: lastHeartbeatAt,
      runtimeDiagnostic: 'bootstrap confirmed',
    });
  });

  it('keeps permission evidence authoritative over a fresh raw confirmation', () => {
    const status = {
      status: 'waiting' as const,
      launchState: 'runtime_pending_permission' as const,
      bootstrapConfirmed: true,
      pendingPermissionRequestIds: ['permission-1'],
      lastHeartbeatAt: NOW,
      updatedAt: NOW,
    };

    expect(readTeamProvisioningBootstrapEvidence({ status, nowIso: NOW })).toMatchObject({
      rawBootstrapConfirmed: true,
      bootstrapConfirmed: false,
      permissionBlocked: true,
      heartbeatFreshness: 'fresh',
    });
    expect(hasTeamProvisioningRuntimePermissionBlock(status)).toBe(true);
  });
});
