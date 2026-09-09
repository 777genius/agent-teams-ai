export const HOSTED_PRODUCER_PROVENANCE_ENV = 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2';
export const HOSTED_PRODUCER_PROVENANCE_CONTRACT =
  'claude-team/hosted-producer-provenance' as const;
export const HOSTED_PRODUCER_PROVENANCE_VERSION = 2 as const;
export const HOSTED_PRODUCER_PROVENANCE_CONTRACT_SHA256 =
  'ef6aa8ac1f139d2b5e9312da8ff1e6dac21da788d46eefbd6e3d43da27da23ba' as const;
export { default as HOSTED_PRODUCER_PROVENANCE_CONTRACT_ARTIFACT } from './hosted-producer-provenance-v2.schema.json?raw';

export type HostedProducerProvenanceRole = 'browser' | 'opencode' | 'owner' | 'product-producer';
export type HostedProducerProvenanceStream =
  | 'conditionalPostLedger'
  | 'negativeResults'
  | 'openCodeTimeline'
  | 'ownerWalTimeline'
  | 'productTimeline'
  | 'protectedEffectLedger';

export interface HostedProducerProvenanceDescriptorContract {
  readonly fd: number;
  readonly device: string;
  readonly inode: string;
}

export interface HostedProducerProvenanceEnvironmentContract {
  readonly activation: Readonly<{
    readonly controllerNonce: string;
    readonly runId: string;
    readonly stackManifestSha256: string;
  }>;
  readonly contract: typeof HOSTED_PRODUCER_PROVENANCE_CONTRACT;
  readonly version: typeof HOSTED_PRODUCER_PROVENANCE_VERSION;
  /** Validated against the digest derived from the exact checked-in schema bytes. */
  readonly contractSha256: string;
  readonly expectedProducer: Readonly<{
    readonly artifactManifestSha256: string;
    readonly executableSha256: string;
    readonly implementationId: string;
    readonly moduleSha256: string;
  }>;
  readonly producerRole: HostedProducerProvenanceRole;
  readonly streams: Readonly<
    Partial<Record<HostedProducerProvenanceStream, HostedProducerProvenanceDescriptorContract>>
  >;
}

export type HostedOwnerStateField =
  | 'actorMembers'
  | 'admissionDigest'
  | 'admissionGeneration'
  | 'bindings'
  | 'deliveries'
  | 'ingress'
  | 'retiredIngress'
  | 'revision'
  | 'routes'
  | 'schemaVersion'
  | 'writerFence';

export interface HostedOwnerCollectionSize {
  readonly previous: number;
  readonly next: number;
}

export interface HostedOwnerLeaseClaim {
  readonly claimedAtIso: string;
  readonly generation: number;
  readonly leaseExpiresAtIso: string;
  readonly leaseToken: string;
  readonly outboxId: string;
  readonly ownerId: string;
}

export type HostedOwnerMutation =
  | Readonly<{ kind: 'admission-reconciled'; outcome: 'published' }>
  | Readonly<{ kind: 'ingress-admitted'; outcome: 'admitted' }>
  | Readonly<{ kind: 'binding-quarantined'; outcome: 'quarantined' }>
  | Readonly<{
      kind: 'ingress-lease-claimed';
      outcome: 'claimed';
      claims: readonly HostedOwnerLeaseClaim[];
    }>
  | Readonly<{ kind: 'ingress-acknowledged'; outcome: 'acknowledged' }>
  | Readonly<{ kind: 'delivery-started'; outcome: 'started' }>
  | Readonly<{ kind: 'delivery-settled'; phase: 'completed'; outcome: 'delivered' }>
  | Readonly<{
      kind: 'delivery-settled';
      phase: 'rejected';
      outcome: 'stale_generation' | 'expired' | 'wrong_lane' | 'self_approval' | 'unavailable';
    }>;

export interface HostedOwnerWalNative {
  readonly fence: Readonly<{ dev: string; generation: string; ino: string }>;
  readonly mutation: HostedOwnerMutation;
  readonly revision: number;
  readonly stateDelta: Readonly<{
    changedFields: readonly HostedOwnerStateField[];
    collectionSizes: Readonly<
      Record<
        'actorMembers' | 'bindings' | 'deliveries' | 'ingress' | 'retiredIngress' | 'routes',
        HostedOwnerCollectionSize
      >
    >;
    nextRevision: number;
    nextStateSha256: string;
    previousRevision: number | null;
    previousStateSha256: string | null;
  }>;
  readonly wal: Readonly<{ byteSize: number; sha256: string }>;
}

export type HostedProducerNativeRecord =
  | Readonly<{
      recordType: 'owner-wal-published';
      operationNonce: string;
      native: HostedOwnerWalNative;
    }>
  | Readonly<{
      recordType: 'approval-http-unadmitted-response-finalized';
      operationNonce: string;
      native: Readonly<{
        bootId: string;
        deploymentId: string;
        method: 'POST';
        outcome: 'unadmitted';
        ownerAuthority: string;
        ownerGeneration: number;
        ownerSessionId: string;
        requestBodyBytes: number;
        requestBodySha256: string;
        responseBodyBytes: number;
        responseBodySha256: string;
        routeId: string;
        status: 503;
      }>;
    }>
  | Readonly<{
      recordType: 'decision-compare-and-claim-verified';
      operationNonce: string;
      native: Readonly<{
        actorId: string;
        approvalId: string;
        bootId: string;
        decision: 'allow' | 'deny';
        deploymentId: string;
        generationId: string;
        idempotencyKeySha256: string;
        ownerAuthority: string;
        ownerGeneration: number;
        ownerSessionId: string;
        outcome: 'committed' | 'idempotent_replay';
        requestId: string;
        sessionId: string;
        targetTeamId: string;
        targetTeamRunId: string;
      }>;
    }>
  | Readonly<{
      recordType: 'approval-http-response-finalized';
      operationNonce: string;
      native: Readonly<{
        actorId: string;
        bootId: string;
        deploymentId: string;
        method: 'POST';
        outcome:
          | 'success'
          | 'committed'
          | 'idempotent_replay'
          | 'already_resolved'
          | 'invalid_request'
          | 'stale_generation'
          | 'conflict'
          | 'expired'
          | 'not_found'
          | 'cancelled'
          | 'unavailable';
        ownerAuthority: string;
        ownerGeneration: number;
        ownerSessionId: string;
        requestBodyBytes: number;
        requestBodySha256: string;
        requestId: string;
        responseBodyBytes: number;
        responseBodySha256: string;
        routeId: string;
        sessionId: string;
        status: number;
      }>;
    }>
  | Readonly<{
      recordType: 'coordination-sse-write-succeeded';
      operationNonce: string;
      native: Readonly<{
        bootId: string;
        deploymentId: string;
        eventId: string | null;
        eventType: string | null;
        frameBytes: number;
        frameKind: 'coordination_event' | 'heartbeat' | 'resync_required';
        frameSha256: string;
        ownerAuthority: string;
        ownerGeneration: number;
        ownerSessionId: string;
      }>;
    }>
  | Readonly<{
      recordType: 'browser-negative-response-observed';
      operationNonce: string;
      native: Readonly<{
        actorTeamId: string;
        harnessRunId: string;
        httpStatus: number;
        processStartToken: string;
        observedOutcome:
          | 'cross_team_list_rejected'
          | 'cross_team_preview_rejected'
          | 'cross_team_decide_rejected';
        requestBodySha256: string;
        requestFamily: 'approval-page' | 'approval-preview' | 'approval-decision';
        responseBodySha256: string;
        targetTeamId: string;
        targetTeamRunId: string;
      }>;
    }>;
