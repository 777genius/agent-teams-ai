export type {
  AtomicPathRemovalResult,
  DurablePathIdentity,
  DurablePathRemovalProofHooks,
} from '@agent-teams/legacy-agent-host/lifecycle';
export {
  atomicReplaceFileIfUnchangedAsync,
  getDurablePathIdentity,
  hasUnexpectedMoveSource,
  isSameDurablePathIdentity,
  removePathWithIdentityFenceAsync,
} from '@agent-teams/legacy-agent-host/lifecycle';
