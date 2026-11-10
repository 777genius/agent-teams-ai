import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { useStore } from '@renderer/store';
import { normalizePath } from '@renderer/utils/pathNormalize';

import {
  filterWorktreePathsForRuntime,
  getDraftWorktreePath,
  resolveBranchDeviation,
  resolveDraftWorkspace,
} from '../members/memberWorkspace';

import type { MemberDraft } from '../members/membersEditorTypes';
import type { PreviousWorkspaceMember } from '../members/memberWorkspace';
import type { TeamProviderId } from '@shared/types';

const EMPTY_PREVIOUS_MEMBERS: readonly PreviousWorkspaceMember[] = [];
const EMPTY_WORKTREE_PATHS: Record<string, string> = {};

export function useMemberWorkspaceInfo({
  open,
  members,
  projectPath,
  worktreePaths: previousWorktreePaths = EMPTY_WORKTREE_PATHS,
  previousProjectPath,
  previousMembers = EMPTY_PREVIOUS_MEMBERS,
  inheritedProviderId,
  hasLeadWorktree = false,
}: {
  open: boolean;
  members: MemberDraft[];
  projectPath: string;
  previousProjectPath?: string;
  previousMembers?: readonly PreviousWorkspaceMember[];
  inheritedProviderId?: TeamProviderId;
  hasLeadWorktree?: boolean;
  worktreePaths?: Record<string, string>;
}): Record<string, string> {
  const { t } = useAppTranslation('team');
  const worktreePaths = useMemo(
    () =>
      previousProjectPath && normalizePath(previousProjectPath) !== normalizePath(projectPath)
        ? {}
        : filterWorktreePathsForRuntime(
            members,
            previousWorktreePaths,
            previousMembers,
            inheritedProviderId
          ),
    [
      previousProjectPath,
      projectPath,
      previousWorktreePaths,
      members,
      previousMembers,
      inheritedProviderId,
    ]
  );
  const paths = useMemo(
    () =>
      open
        ? [
            projectPath,
            ...members.flatMap((member) => getDraftWorktreePath(member, worktreePaths) ?? []),
          ].filter(Boolean)
        : [],
    [open, projectPath, members, worktreePaths]
  );
  useBranchSync(paths, { live: open });
  const branches = useStore((state) => state.branchByPath);
  return useMemo(() => {
    if (!open) return {};
    return Object.fromEntries(
      members.flatMap((member) => {
        const workspace = resolveDraftWorkspace(
          member,
          projectPath,
          worktreePaths,
          branches,
          hasLeadWorktree
        );
        if (!workspace) return [];
        if (workspace.kind === 'shared') return [];
        const commonBranch = projectPath ? (branches[normalizePath(projectPath)] ?? null) : null;
        if (
          workspace.kind === 'existing' &&
          !resolveBranchDeviation(workspace.branch, commonBranch, true)
        ) {
          return [];
        }
        const description = t(`memberDraft.worktree.${workspace.kind}`, { path: workspace.path });
        const branch =
          workspace.kind === 'new' || workspace.kind === 'sharedPending'
            ? ''
            : t('memberDraft.worktree.branch', {
                branch: workspace.branch ?? t('memberDraft.worktree.branchUnavailable'),
              });
        return [[member.id, [branch, description].filter(Boolean).join('\n')]];
      })
    );
  }, [open, members, projectPath, worktreePaths, branches, hasLeadWorktree, t]);
}
