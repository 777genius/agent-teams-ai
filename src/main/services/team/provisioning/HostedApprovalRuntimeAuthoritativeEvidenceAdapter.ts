import { AsyncLocalStorage } from 'node:async_hooks';

import type { HostedApprovalRuntimeAuthoritativeEvidence } from './HostedApprovalRuntimeAdmissionComposition';
import type {
  AuthoritativeHostedApprovalRuntimeBindingLease,
  HostedApprovalRuntimeLifecycle,
} from './HostedApprovalRuntimeAdmissionPublisher';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface HostedApprovalRuntimeTransitionEvidence {
  readonly lifecycle: HostedApprovalRuntimeLifecycle;
  readonly lease: AuthoritativeHostedApprovalRuntimeBindingLease;
  /** Authoritative installed-binary verifier; reread on every publisher fence. */
  readonly resolveExpectedInstalledArtifactDigest: () => Promise<`sha256:${string}` | null>;
}

export interface HostedApprovalRuntimeTransitionAuthority {
  withEvidence<T>(
    teamName: string,
    evidence: HostedApprovalRuntimeTransitionEvidence,
    operation: () => Promise<T>
  ): Promise<T>;
}

export interface HostedApprovalRuntimeAuthoritativeEvidenceAdapter
  extends HostedApprovalRuntimeAuthoritativeEvidence, HostedApprovalRuntimeTransitionAuthority {}

interface EvidenceContext {
  readonly teamName: string;
  readonly evidence: HostedApprovalRuntimeTransitionEvidence;
}

/**
 * Request-scoped bridge from the trusted lifecycle caller to the publisher. Evidence is never
 * recovered from workspace files or retained after the awaited transition barrier completes.
 */
export function createHostedApprovalRuntimeAuthoritativeEvidenceAdapter(): HostedApprovalRuntimeAuthoritativeEvidenceAdapter {
  const context = new AsyncLocalStorage<EvidenceContext>();
  return Object.freeze({
    async withEvidence<T>(
      teamName: string,
      evidence: HostedApprovalRuntimeTransitionEvidence,
      operation: () => Promise<T>
    ): Promise<T> {
      const normalizedTeamName = teamName.trim();
      if (
        !normalizedTeamName ||
        !evidence ||
        !evidence.lease ||
        typeof evidence.lease.token !== 'string' ||
        !evidence.lease.token.trim() ||
        typeof evidence.resolveExpectedInstalledArtifactDigest !== 'function'
      ) {
        throw new TypeError('hosted-approval-runtime-transition-evidence-invalid');
      }
      if (context.getStore()) {
        throw new Error('hosted-approval-runtime-transition-evidence-nested');
      }
      const lifecycle = Object.freeze(structuredClone(evidence.lifecycle));
      return context.run(
        Object.freeze({
          teamName: normalizedTeamName,
          evidence: Object.freeze({
            lifecycle,
            lease: evidence.lease,
            resolveExpectedInstalledArtifactDigest: evidence.resolveExpectedInstalledArtifactDigest,
          }),
        }),
        operation
      );
    },
    async currentLifecycle(teamName: string) {
      const current = context.getStore();
      return current && current.teamName === teamName.trim() ? current.evidence.lifecycle : null;
    },
    async acquireRosterSessionBootstrapProcessLease(teamName: string) {
      const current = context.getStore();
      if (!current || current.teamName !== teamName.trim()) return null;
      let consumed = false;
      return Object.freeze({
        token: current.evidence.lease.token,
        binding: current.evidence.lease.binding,
        async consume() {
          if (consumed) return null;
          consumed = true;
          return current.evidence.lease.consume();
        },
      });
    },
    async expectedInstalledArtifactDigest(teamName: string) {
      const current = context.getStore();
      if (!current || current.teamName !== teamName.trim()) return null;
      const digest = await current.evidence.resolveExpectedInstalledArtifactDigest();
      return digest !== null && SHA256.test(digest) ? digest : null;
    },
  });
}
