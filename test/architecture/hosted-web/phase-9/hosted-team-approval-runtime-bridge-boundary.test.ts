import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const OWNED_PATHS = Object.freeze([
  'src/features/team-runtime-control/contracts/runtimePermissionApproval.ts',
  'src/features/team-runtime-control/contracts/index.ts',
  'src/features/team-runtime-control/core/application/runtime-ingress/RuntimeIngressPermissionOutbox.ts',
  'src/features/team-runtime-control/core/application/runtime-ingress/index.ts',
  'src/features/team-runtime-control/core/application/runtime-ingress/ports.ts',
  'src/features/team-runtime-control/main/adapters/output/runtime-ingress/RuntimeIngressPermissionOutboxStore.ts',
  'src/features/team-runtime-control/main/adapters/output/runtime-ingress/runtimeIngressDurableState.ts',
  'src/features/team-runtime-control/main/adapters/output/runtime-ingress/FileRuntimeIngressDurableStore.ts',
  'src/features/team-approvals/main/ports/HostedTeamApprovalRuntimeBridgePorts.ts',
  'src/features/team-approvals/main/adapters/input/runtime-ingress/HostedRuntimePermissionRequestProjector.ts',
  'src/features/team-approvals/main/adapters/output/runtime-ingress/HostedApprovalDecisionDeliveryCoordinator.ts',
  'src/features/team-approvals/main/composition/createHostedTeamApprovalRuntimeBridge.ts',
  'src/features/team-approvals/main/hosted.ts',
  'src/main/composition/hosted/hostedTeamApprovalRuntimeCompatibility.ts',
  'test/features/team-runtime-control/core/runtime-ingress/RuntimeIngressPermissionOutbox.test.ts',
  'test/features/team-runtime-control/main/runtime-ingress/RuntimeIngressPermissionOutboxStore.test.ts',
  'test/features/team-approvals/hosted/HostedRuntimePermissionRequestProjector.test.ts',
  'test/features/team-approvals/hosted/HostedApprovalDecisionDeliveryCoordinator.test.ts',
  'test/features/team-approvals/hosted/HostedTeamApprovalRuntimeBridge.test.ts',
  'test/architecture/hosted-web/phase-9/hosted-team-approval-runtime-bridge-boundary.test.ts',
]);
const PRODUCTION_PATHS = OWNED_PATHS.filter((path) => path.startsWith('src/'));

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed owned paths above
  return readFileSync(path, 'utf8');
}

describe('Phase 9 hosted team approval runtime bridge boundary', () => {
  it('keeps the bounded runtime bridge to exactly the twenty admitted paths', () => {
    expect(OWNED_PATHS).toHaveLength(20);
    expect(new Set(OWNED_PATHS).size).toBe(20);
    expect(OWNED_PATHS.every(existsSync)).toBe(true);
  });

  it('derives approval scope only from persisted ingress authority and fails closed for stale or self authority', () => {
    const contracts = source(
      'src/features/team-runtime-control/contracts/runtimePermissionApproval.ts'
    );
    const projector = source(
      'src/features/team-approvals/main/adapters/input/runtime-ingress/HostedRuntimePermissionRequestProjector.ts'
    );
    const payloadInterface =
      contracts.match(/export interface RuntimePermissionApprovalPayload \{([\s\S]*?)\n\}/)?.[1] ??
      '';

    expect(payloadInterface).not.toMatch(
      /\b(?:teamId|runId|laneId|providerId|principalId|authorityGeneration|decision)\b/
    );
    expect(projector).toContain('resolvePersistedIngressAuthority(record.authority)');
    expect(projector).toMatch(/pendingRecordFor\(\s*record,\s*resolved\.scope/);
    expect(projector).toContain('resolved.scope.principalId === record.authority.deliveryOwnerId');
    expect(projector).toContain("resolved.status !== 'resolved'");
    expect(projector).not.toMatch(
      /payload\.(?:teamId|runId|laneId|providerId|principalId|authorityGeneration|decision)/
    );
  });

  it('uses stable effect and delivery identity with outboxes around both external boundaries', () => {
    const ingressOutbox = source(
      'src/features/team-runtime-control/core/application/runtime-ingress/RuntimeIngressPermissionOutbox.ts'
    );
    const projector = source(
      'src/features/team-approvals/main/adapters/input/runtime-ingress/HostedRuntimePermissionRequestProjector.ts'
    );
    const coordinator = source(
      'src/features/team-approvals/main/adapters/output/runtime-ingress/HostedApprovalDecisionDeliveryCoordinator.ts'
    );
    const ports = source(
      'src/features/team-approvals/main/ports/HostedTeamApprovalRuntimeBridgePorts.ts'
    );

    expect(ingressOutbox).toContain('outboxId: string');
    expect(ingressOutbox).toContain('runtime_permission:effect');
    expect(projector).toContain('deriveRuntimePermissionApprovalIdentity(record.effectRef)');
    expect(projector).toContain('after the idempotent pending record has been persisted');
    expect(coordinator).toContain('providerDeliveryId: record.deliveryId');
    expect(coordinator).toContain(
      "delivery.status !== 'delivered' && delivery.status !== 'idempotent_replay'"
    );
    expect(ports).toContain('idempotency key');
  });

  it('uses narrow ports without mounting HTTP, renderer, standalone, or a second process lifecycle owner', () => {
    const bridge = source(
      'src/features/team-approvals/main/composition/createHostedTeamApprovalRuntimeBridge.ts'
    );
    const compatibility = source(
      'src/main/composition/hosted/hostedTeamApprovalRuntimeCompatibility.ts'
    );
    const implementation = [
      source('src/features/team-approvals/main/ports/HostedTeamApprovalRuntimeBridgePorts.ts'),
      source(
        'src/features/team-approvals/main/adapters/input/runtime-ingress/HostedRuntimePermissionRequestProjector.ts'
      ),
      source(
        'src/features/team-approvals/main/adapters/output/runtime-ingress/HostedApprovalDecisionDeliveryCoordinator.ts'
      ),
      bridge,
      compatibility,
    ].join('\n');

    expect(implementation).not.toMatch(
      /\b(?:Fastify|ipcMain|BrowserWindow|electron|child_process|spawn|fork)\b/i
    );
    expect(implementation).not.toMatch(/\b(?:start|stop|setInterval|setTimeout)\s*\(/);
    expect(bridge).toContain('without mounting an HTTP route');
    expect(compatibility).toContain('intentionally creates no runtime or scheduler');
    expect(compatibility).toContain('createHostedTeamApprovalRuntimeBridge(dependencies)');
  });

  it('keeps every admitted production file under the source-size ceiling', () => {
    for (const path of PRODUCTION_PATHS) {
      expect(source(path).split(/\r?\n/).length, path).toBeLessThanOrEqual(800);
    }
  });
});
