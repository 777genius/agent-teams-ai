import { createHostedRouteAdmissionBinding } from '@main/composition/hosted/application';
import { createHostedOperatorProductionComposition } from '@main/composition/hosted/hostedOperatorProductionComposition';
import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '@features/team-approvals/main/hosted';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  parseBootId,
  parseDeploymentId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTeamApprovalAuthorityStorageGateway } from '@features/internal-storage/contracts';

const DEPLOYMENT_ID = parseDeploymentId('deployment_operator-production');
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const runtimeInstance = createRuntimeInstanceContext({
  deploymentId: DEPLOYMENT_ID,
  bootId: parseBootId('boot_operator-production'),
});
const routeAdmissionBinding = createHostedRouteAdmissionBinding({
  routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
  readiness: {
    readiness: async () => ({
      revision: 1,
      dimensions: Object.freeze({}) as never,
    }),
  },
});

function dependencies(
  audit: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalAuditTimeouts'],
  timers: {
    setTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  } = {}
) {
  return {
    authentication: { authenticatedPrincipalFor: vi.fn(() => null) },
    runtimeInstance,
    expectedDeploymentId: DEPLOYMENT_ID,
    workspaceId: WORKSPACE_ID,
    mountGeneration: 3,
    restoreGeneration: 1,
    teamIdentities: { getTeamIdentity: vi.fn(), listTeamIdentities: vi.fn() },
    approvalStorage: {
      hostedTeamApprovalAuditTimeouts: audit,
    } as HostedTeamApprovalAuthorityStorageGateway,
    routeAdmissionBinding,
    recoveryTimeoutMs: 50,
    nowMs: () => 1_000,
    ...timers,
  };
}

describe('hosted operator production composition', () => {
  it('does not become ready until the initial durable recovery completes', async () => {
    let resolveRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const composition = createHostedOperatorProductionComposition(
      dependencies(async () => {
        await recovery;
        return { resolvedCount: 0, nextAuditTimeMs: null };
      })
    );
    expect(composition.isReady()).toBe(false);
    resolveRecovery();
    await recovery;
    await Promise.resolve();
    expect(composition.isReady()).toBe(true);
    composition.close();
  });

  it('rolls a fresh composition closed on recovery timeout and ignores late completion', async () => {
    let resolveRecovery!: () => void;
    let timeout!: () => void;
    const recovery = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const composition = createHostedOperatorProductionComposition(
      dependencies(
        async () => {
          await recovery;
          return { resolvedCount: 0, nextAuditTimeMs: null };
        },
        {
          setTimer: ((callback: () => void) => {
            timeout = callback;
            return 1 as never;
          }) as never,
          clearTimer: vi.fn(),
        }
      )
    );
    timeout();
    expect(composition.isReady()).toBe(false);
    resolveRecovery();
    await recovery;
    await Promise.resolve();
    expect(composition.isReady()).toBe(false);
  });
});
