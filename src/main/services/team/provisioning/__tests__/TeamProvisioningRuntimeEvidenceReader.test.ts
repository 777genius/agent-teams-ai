import { describe, expect, it } from 'vitest';

import {
  hasTeamProvisioningRuntimePermissionBlock,
  readTeamProvisioningBootstrapEvidence,
} from '../TeamProvisioningRuntimeEvidenceReader';

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

  it('rejects an impossible calendar date instead of accepting its normalized instant', () => {
    expect(
      readTeamProvisioningBootstrapEvidence({
        status: {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          lastHeartbeatAt: '2026-02-30T12:00:00.000Z',
          updatedAt: '2026-03-02T12:00:00.000Z',
        },
        nowIso: '2026-03-02T12:00:00.000Z',
      })
    ).toMatchObject({
      bootstrapConfirmed: false,
      heartbeatFreshness: 'invalid_timestamp',
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
