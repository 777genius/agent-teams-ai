import {
  canonicalHostedApprovalTransitionProjection,
  digestHostedApprovalTransitionValue,
  type HostedApprovalTransitionProductProjection,
  immutableHostedApprovalTransitionValue,
  validateHostedApprovalTransitionProductProjection,
} from './hostedApprovalTransitionWire';

import type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimeOuterAuthority,
  HostedApprovalRuntimeOwnerIdentity,
} from '@main/services/team/provisioning/HostedApprovalRuntimeAdmissionPublisher';

export interface HostedApprovalRuntimeProjectionAuthority {
  /** Authenticated launch/admission projection; never a team document or UI selection. */
  readStableAuthority(teamName: string): Promise<HostedApprovalRuntimeOuterAuthority | null>;
  /** Exact owner descriptor admitted by authenticated one-use bootstrap. */
  readExpectedOwner(teamName: string): Promise<HostedApprovalRuntimeOwnerIdentity | null>;
  /** Fresh installed-binary verifier read. */
  readInstalledArtifactDigest(teamName: string): Promise<`sha256:${string}` | null>;
  /** Fresh identity of the product process opening the transition connection. */
  readClientProcessIdentity(): Promise<Readonly<{ pid: number; startIdentity: string }> | null>;
}

export interface HostedApprovalRuntimeProjectionPin {
  readonly projection: HostedApprovalTransitionProductProjection;
  readonly projectionDigest: string;
  /** Fresh local artifact verifier; publisher fences retain this independent authority. */
  readonly resolveExpectedInstalledArtifactDigest: () => Promise<`sha256:${string}` | null>;
  /** Rechecks every locally owned authority input against the pinned projection. */
  assertCurrent(): Promise<boolean>;
}

/**
 * Builds the product half of the wire exclusively from authenticated product-owned sources.
 * Inputs are reread as a set before the projection can escape and are never reconstructed from
 * team JSON, renderer state, runtime snapshots, or orchestrator response fields.
 */
export class HostedApprovalRuntimeProjectionSource {
  constructor(private readonly authority: HostedApprovalRuntimeProjectionAuthority) {}

  async pin(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimeProjectionPin | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(teamName)) return null;
    const [stableAuthority, expectedOwner, expectedInstalledArtifactDigest, clientProcessIdentity] =
      await Promise.all([
        this.authority.readStableAuthority(teamName),
        this.authority.readExpectedOwner(teamName),
        this.authority.readInstalledArtifactDigest(teamName),
        this.authority.readClientProcessIdentity(),
      ]);
    if (
      !stableAuthority ||
      !expectedOwner ||
      !expectedInstalledArtifactDigest ||
      !clientProcessIdentity
    ) {
      return null;
    }
    const projection = structuredClone({
      teamName,
      lifecycle,
      expectedInstalledArtifactDigest,
      stableAuthority,
      expectedOwner,
      clientProcessIdentity,
    });
    try {
      validateHostedApprovalTransitionProductProjection(projection);
    } catch {
      return null;
    }
    const canonical = canonicalHostedApprovalTransitionProjection(projection);
    const pinned = immutableHostedApprovalTransitionValue(structuredClone(projection));
    const resolveExpectedInstalledArtifactDigest = async (): Promise<`sha256:${string}` | null> =>
      this.authority.readInstalledArtifactDigest(teamName);
    return Object.freeze({
      projection: pinned,
      projectionDigest: digestHostedApprovalTransitionValue(pinned),
      resolveExpectedInstalledArtifactDigest,
      assertCurrent: async () => {
        const [currentAuthority, currentOwner, currentArtifact, currentClient] = await Promise.all([
          this.authority.readStableAuthority(teamName),
          this.authority.readExpectedOwner(teamName),
          resolveExpectedInstalledArtifactDigest(),
          this.authority.readClientProcessIdentity(),
        ]);
        if (!currentAuthority || !currentOwner || !currentArtifact || !currentClient) return false;
        const current = {
          teamName,
          lifecycle,
          expectedInstalledArtifactDigest: currentArtifact,
          stableAuthority: currentAuthority,
          expectedOwner: currentOwner,
          clientProcessIdentity: currentClient,
        };
        try {
          validateHostedApprovalTransitionProductProjection(current);
          return canonicalHostedApprovalTransitionProjection(current) === canonical;
        } catch {
          return false;
        }
      },
    });
  }
}
