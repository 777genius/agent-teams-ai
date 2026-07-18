import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import {
  assertCanonicalRemoteRevision,
  materializePinnedRemoteCommit,
  resolveCanonicalRemoteWorktreeSource,
  resolveCanonicalRemoteHead,
  type CanonicalRemoteHead,
} from "./codex-goal-project-git";

export type ResolvedProjectSourceRevision = {
  readonly revision: string;
  readonly sourceRealPath: string;
  readonly pinned: boolean;
  readonly remoteHead?: CanonicalRemoteHead;
};

export type ResolvedProjectSourceReference = {
  readonly remoteTrackingRef: string;
  readonly worktreeSourceRef: string;
  readonly remoteVerified: boolean;
};

export function resolveProjectSourceReference(input: {
  readonly requestedRef: string;
  readonly scope: ProjectAccessScope;
  readonly remoteVerificationRequired: boolean;
}): ResolvedProjectSourceReference {
  if (!input.remoteVerificationRequired) {
    return {
      remoteTrackingRef: input.requestedRef,
      worktreeSourceRef: input.requestedRef,
      remoteVerified: false,
    };
  }
  const canonical = resolveCanonicalRemoteWorktreeSource({
    requestedRef: input.requestedRef,
    scope: input.scope,
  });
  return {
    ...canonical,
    remoteVerified: true,
  };
}

export async function resolveProjectSourceRevision(input: {
  readonly resolvedSource: {
    readonly revision: string;
    readonly sourceRealPath: string;
  };
  readonly remoteTrackingRef: string;
  readonly scope: ProjectAccessScope;
  readonly expectedSourceCommit?: string;
  readonly requireRemoteHead?: boolean;
}): Promise<ResolvedProjectSourceRevision> {
  const remoteTrackingRef =
    input.expectedSourceCommit || input.requireRemoteHead
      ? resolveCanonicalRemoteWorktreeSource({
          requestedRef: input.remoteTrackingRef,
          scope: input.scope,
        }).remoteTrackingRef
      : input.remoteTrackingRef;
  const pinnedRemote = input.expectedSourceCommit
    ? await materializePinnedRemoteCommit({
        workspacePath: input.resolvedSource.sourceRealPath,
        remoteTrackingRef,
        expectedCommit: input.expectedSourceCommit,
      })
    : undefined;
  const remoteHead = input.requireRemoteHead
    ? (pinnedRemote ??
      (await resolveCanonicalRemoteHead({
        workspacePath: input.resolvedSource.sourceRealPath,
        remoteTrackingRef,
      })))
    : undefined;
  if (remoteHead && !pinnedRemote) {
    assertCanonicalRemoteRevision({
      canonical: remoteHead,
      resolvedRevision: input.resolvedSource.revision,
    });
  }
  return {
    revision: pinnedRemote?.oid ?? input.resolvedSource.revision,
    sourceRealPath: input.resolvedSource.sourceRealPath,
    pinned: pinnedRemote !== undefined,
    ...(remoteHead ? { remoteHead } : {}),
  };
}
