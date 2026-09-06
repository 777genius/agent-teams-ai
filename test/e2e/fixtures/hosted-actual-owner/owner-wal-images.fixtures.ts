import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  HostedOwnerMutation,
  HostedOwnerStateField,
  HostedOwnerWalNative,
} from '../../../../src/features/hosted-producer-provenance/contracts';
import type {
  OwnerWalBinding,
  OwnerWalDelivery,
  OwnerWalIngress,
  OwnerWalRoute,
  OwnerWalState,
} from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-image-state';
import type {
  OwnerWalDeliveryRequest,
  OwnerWalImage,
  OwnerWalImageVerificationInput,
  OwnerWalMutationWitness,
} from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-images';

// Complete storage fixtures from r744 §3 and accepted 5b0c1bde WAL tests (93–251).
// They characterize storage; they are not captured W2 publications or custody evidence.
export const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
export const hex = (n: number): string => n.toString(16).padStart(64, '0');
export const AT = '2026-08-13T10:00:00.000Z';
export const CLAIM_AT = '2026-08-13T10:00:01.000Z';
export const ACK_AT = '2026-08-13T10:00:02.000Z';
export function route(): OwnerWalRoute {
  const teamId = `team_${'1'.repeat(32)}`,
    deliveryOwnerId = `member_${'4'.repeat(32)}`;
  return {
    routeId: 'route_1',
    memberName: 'worker',
    authority: {
      deploymentId: 'deployment_test',
      teamId,
      runId: `run_${'2'.repeat(32)}`,
      planGeneration: 2,
      laneId: 'secondary:opencode:worker',
      providerId: 'opencode',
      credentialGeneration: 3,
      credentialId: 'credential_1',
      sessionId: 'session_1',
      runtimeInstanceId: 'runtime_1',
      deliveryOwnerId,
    },
    scope: {
      principalId: 'actor_owner',
      workspaceId: `workspace_${'3'.repeat(32)}`,
      teamId,
      authorityGeneration: 'generation_1',
      restoreGeneration: 1,
    },
    openCodeBinding: {
      toolApprovalMode: 'manual',
      planGeneration: 2,
      credentialGeneration: 3,
      credentialId: 'credential_1',
      runtimeInstanceId: 'runtime_1',
      deliveryOwnerId,
      openCodeArtifactDigest: `sha256:${'c'.repeat(64)}`,
      sessionRecordFingerprint: 'a'.repeat(64),
      liveEffectFingerprint: 'b'.repeat(64),
    },
  };
}
export function ingress(n = 1, r = route()): OwnerWalIngress {
  const deliveryRef = `delivery_ref_opencode-${hex(n)}`;
  return {
    outboxVersion: 2,
    outboxId: `runtime_permission:effect:${hex(n)}`,
    commandId: `permission_${n}`,
    effectRef: `effect:${hex(n + 10000)}`,
    deliveryRef,
    authority: structuredClone(r.authority),
    payloadJson: JSON.stringify({
      schemaVersion: 1,
      deliveryRef,
      category: 'command',
      summary: 'Run tests',
      expiresAtMs: null,
      preview: null,
    }),
    observedAtIso: AT,
    acceptedAtIso: AT,
    lease: null,
    acknowledgedAtIso: null,
  };
}
export function binding(r: OwnerWalIngress, quarantined = false): OwnerWalBinding {
  return {
    teamId: r.authority.teamId,
    runId: r.authority.runId,
    requestId: r.commandId,
    effectRef: r.effectRef,
    bindingDigest: r.outboxId.slice('runtime_permission:effect:'.length),
    quarantined,
  };
}
export function emptyState(): OwnerWalState {
  return {
    schemaVersion: 3,
    revision: 1,
    admissionGeneration: 'approval-admission-generation_1',
    admissionDigest: 'a'.repeat(64),
    routes: [route()],
    actorMembers: {
      actor_owner: route().authority.deliveryOwnerId,
      actor_operator: `member_${'8'.repeat(32)}`,
    },
    ingress: [],
    retiredIngress: [],
    bindings: [],
    deliveries: [],
    writerFence: { generation: `approval-writer-fence_${'a'.repeat(32)}`, dev: '1', ino: '1' },
  };
}
export function state(count = 1): OwnerWalState {
  const result = emptyState();
  result.ingress = Array.from({ length: count }, (_, i) => ingress(i + 1));
  result.bindings = result.ingress.map((r) => binding(r));
  return result;
}
export function leased(record: OwnerWalIngress, acknowledged = false): OwnerWalIngress {
  return {
    ...record,
    lease: {
      generation: 1,
      ownerId: 'owner_1',
      leaseToken: 'lease_1',
      claimedAtIso: CLAIM_AT,
      leaseExpiresAtIso: '2026-08-13T10:01:01.000Z',
    },
    acknowledgedAtIso: acknowledged ? ACK_AT : null,
  };
}
export function request(
  r: OwnerWalIngress,
  decision: 'allow' | 'deny' | 'timeout' = 'allow'
): OwnerWalDeliveryRequest {
  return {
    providerDeliveryId: `delivery_${r.commandId}`,
    reconciliationRef: `approval-reconciliation_${digest(r.outboxId)}`,
    principal:
      decision === 'timeout'
        ? { kind: 'system_timeout' }
        : { kind: 'operator', actorId: 'actor_operator' },
    deliveryRef: r.deliveryRef,
    approvalId: `approval_${digest(
      JSON.stringify({
        schemaVersion: 1,
        teamId: r.authority.teamId,
        runId: r.authority.runId,
        requestId: r.commandId,
      })
    ).slice(0, 32)}`,
    approvalGeneration: `generation_runtime-permission-${r.effectRef.slice(7)}`,
    decision,
    partition: { teamId: r.authority.teamId, runId: r.authority.runId },
    requestId: r.commandId,
  };
}
export function delivery(r: OwnerWalIngress, req = request(r)): OwnerWalDelivery {
  return {
    providerDeliveryId: req.providerDeliveryId,
    reconciliationRef: req.reconciliationRef,
    deliveryRef: r.deliveryRef,
    payloadFingerprint: digest(JSON.stringify(req)),
    outboxId: r.outboxId,
    effectRef: r.effectRef,
    phase: 'started',
    result: null,
  };
}
export const nextState = (p: OwnerWalState, patch: Partial<OwnerWalState>): OwnerWalState => ({
  ...p,
  ...patch,
  revision: p.revision + 1,
});
export const image = (bytes: Uint8Array): OwnerWalImage => ({
  bytes,
  byteSize: bytes.byteLength,
  sha256: digest(bytes),
});
export const jsonImage = (s: unknown): OwnerWalImage =>
  image(Buffer.from(`${JSON.stringify(s)}\n`));
export const admission = (s: OwnerWalState): OwnerWalMutationWitness => ({
  kind: 'admission-reconciled',
  admission: {
    admissionGeneration: s.admissionGeneration,
    digest: s.admissionDigest,
    routes: s.routes,
    actorMembers: s.actorMembers,
  },
});
export const claimWitness = (): Extract<
  OwnerWalMutationWitness,
  { kind: 'ingress-lease-claimed' }
> => ({
  kind: 'ingress-lease-claimed',
  request: { ownerId: 'owner_1', leaseToken: 'lease_1', leaseDurationMs: 60000, limit: 100 },
  claimedAtIso: CLAIM_AT,
  maximumAggregateBytes: 8 * 1024 * 1024 - 8192,
});
export const ackWitness = (
  r: OwnerWalIngress
): Extract<OwnerWalMutationWitness, { kind: 'ingress-acknowledged' }> => ({
  kind: 'ingress-acknowledged',
  request: {
    outboxId: r.outboxId,
    generation: r.lease!.generation,
    ownerId: r.lease!.ownerId,
    leaseToken: r.lease!.leaseToken,
  },
  acknowledgedAtIso: ACK_AT,
});

// Only fixture metadata, calculated independently of the verifier so adversarial tests
// can rehash a changed image and reach semantic checks rather than an earlier hash failure.
export function pair(
  p: OwnerWalImage | null,
  n: OwnerWalState,
  mutation: HostedOwnerMutation,
  witness: OwnerWalMutationWitness
) {
  const next = jsonImage(n);
  const previous: Record<string, unknown> | null = p
    ? JSON.parse(Buffer.from(p.bytes).toString('utf8'))
    : null;
  const stored: Record<string, unknown> = JSON.parse(Buffer.from(next.bytes).toString('utf8'));
  const counts = (key: string, value: Record<string, unknown> | null): number => {
    if (!value || !Object.hasOwn(value, key)) return 0;
    const item = value[key];
    return Array.isArray(item) ? item.length : Object.keys(item as object).length;
  };
  const sizes = (key: string) => ({ previous: counts(key, previous), next: counts(key, stored) });
  const native: HostedOwnerWalNative = {
    fence: n.writerFence,
    mutation,
    revision: n.revision,
    stateDelta: {
      changedFields: Object.keys(stored)
        .filter(
          (k) =>
            !previous || !Object.hasOwn(previous, k) || !isDeepStrictEqual(previous[k], stored[k])
        )
        .sort() as HostedOwnerStateField[],
      collectionSizes: {
        actorMembers: sizes('actorMembers'),
        bindings: sizes('bindings'),
        deliveries: sizes('deliveries'),
        ingress: sizes('ingress'),
        retiredIngress: sizes('retiredIngress'),
        routes: sizes('routes'),
      },
      nextRevision: n.revision,
      nextStateSha256: next.sha256,
      previousRevision: previous ? (previous.revision as number) : null,
      previousStateSha256: p?.sha256 ?? null,
    },
    wal: { byteSize: next.byteSize, sha256: next.sha256 },
  };
  return {
    previous: p ? { kind: 'retained' as const, image: p } : { kind: 'absent' as const },
    next,
    native,
    witness,
  } satisfies OwnerWalImageVerificationInput;
}
export type LegacyState = Omit<OwnerWalState, 'schemaVersion' | 'bindings'> & {
  schemaVersion: 1 | 2;
};
export function legacy(version: 1 | 2): { stored: LegacyState; reconciled: OwnerWalState } {
  const base = state(3),
    records = base.ingress.map((r) => {
      const deliveryRef = `delivery_ref_legacy_${r.commandId}`;
      return {
        ...r,
        outboxVersion: 1 as const,
        outboxId: `runtime_permission:${r.effectRef}`,
        deliveryRef,
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          deliveryRef,
          category: 'command',
          summary: 'Run tests',
          expiresAtMs: null,
          preview: null,
        }),
      };
    });
  const retired = records[2];
  if (version === 2) {
    // Own-authority decoding after credential rotation, r740 regression.
    retired.authority.credentialGeneration = 2;
    retired.authority.credentialId = 'credential_old';
  }
  const { bindings: _bindings, ...rest } = base;
  const legacyDelivery = (r: OwnerWalIngress): OwnerWalDelivery => ({
    providerDeliveryId: `delivery_legacy_${r.commandId}`,
    reconciliationRef: `approval-reconciliation_legacy_${r.commandId}`,
    deliveryRef: r.deliveryRef,
    payloadFingerprint: 'f'.repeat(64),
    outboxId: r.outboxId,
    effectRef: r.effectRef,
    phase: 'started',
    result: null,
  });
  const stored: LegacyState = {
    ...rest,
    schemaVersion: version,
    revision: 7,
    ingress: records.slice(0, 2),
    retiredIngress: [retired],
    deliveries: [
      legacyDelivery(records[0]),
      { ...legacyDelivery(retired), phase: 'completed', result: 'delivered' },
    ],
  };
  if (version === 1) delete stored.routes[0].openCodeBinding.openCodeArtifactDigest;
  // Every legacy tuple receives a tombstone, including the unreferenced second ingress.
  const reconciled = nextState(
    { ...base, revision: 7 },
    {
      routes: [route()],
      ingress: [],
      retiredIngress: [records[0], retired],
      deliveries: stored.deliveries,
      bindings: records.map((r) => ({ ...binding(r, true), effectRef: null, bindingDigest: null })),
    }
  );
  return { stored, reconciled };
}
