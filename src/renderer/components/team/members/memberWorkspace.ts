import { normalizePath } from '@renderer/utils/pathNormalize';

import type { MemberDraft } from './membersEditorTypes';
import type { TeamProviderBackendId, TeamProviderId } from '@shared/types';

export interface PreviousWorkspaceMember {
  name: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
}

export function resolveBranchDeviation(
  branch: string | null | undefined,
  commonBranch: string | null | undefined,
  isolated: boolean
): string | undefined {
  if (!branch || branch === commonBranch) return undefined;
  return commonBranch || isolated ? branch : undefined;
}

export function filterWorktreePathsForRuntime(
  members: MemberDraft[],
  paths: Record<string, string>,
  previousMembers: readonly PreviousWorkspaceMember[],
  inheritedProviderId?: TeamProviderId
): Record<string, string> {
  return Object.fromEntries(
    members.flatMap((member) => {
      const name = member.originalName?.trim().toLowerCase();
      const previous = previousMembers.find(
        (candidate) => candidate.name.trim().toLowerCase() === name
      );
      const provider = member.providerId ?? inheritedProviderId;
      const path = name && Object.hasOwn(paths, name) ? paths[name] : undefined;
      if (
        !name ||
        typeof path !== 'string' ||
        !path.trim() ||
        (previous?.providerId && provider && previous.providerId !== provider) ||
        (previous?.providerBackendId &&
          member.providerBackendId &&
          previous.providerBackendId !== member.providerBackendId)
      )
        return [];
      return [[name, path]];
    })
  );
}

/** Read recorded workspace details only for an unchanged, isolated member identity. */
export function getDraftWorktreePath(
  member: MemberDraft,
  worktreePaths: Record<string, string>
): string | undefined {
  const originalName = member.originalName?.trim().toLowerCase();
  if (
    member.removedAt ||
    member.isolation !== 'worktree' ||
    !originalName ||
    originalName !== member.name.trim().toLowerCase()
  )
    return undefined;
  const path = Object.hasOwn(worktreePaths, originalName) ? worktreePaths[originalName] : undefined;
  return typeof path === 'string' ? path.trim() || undefined : undefined;
}

export function resolveDraftWorkspace(
  member: MemberDraft,
  projectPath: string,
  worktreePaths: Record<string, string>,
  branches: Record<string, string | null>,
  hasLeadWorktree = false
): {
  kind: 'existing' | 'new' | 'shared' | 'sharedPending';
  path: string;
  branch: string | null;
} | null {
  if (member.removedAt) return null;
  if (member.isolation !== 'worktree' && hasLeadWorktree) {
    return { kind: 'sharedPending', path: '', branch: null };
  }
  const existingPath = getDraftWorktreePath(member, worktreePaths);
  const kind = member.isolation !== 'worktree' ? 'shared' : existingPath ? 'existing' : 'new';
  const path = kind === 'shared' ? projectPath.trim() : (existingPath ?? '');
  return { kind, path, branch: path ? (branches[normalizePath(path)] ?? null) : null };
}
