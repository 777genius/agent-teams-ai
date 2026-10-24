export {
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  atomicReplaceFileIfUnchangedAsync,
  removePathWithIdentityFenceAsync,
} from '@agent-teams/legacy-agent-host/lifecycle';
export type {
  DurablePathIdentity,
  AtomicPathRemovalResult,
  DurablePathRemovalProofHooks,
} from '@agent-teams/legacy-agent-host/lifecycle';
