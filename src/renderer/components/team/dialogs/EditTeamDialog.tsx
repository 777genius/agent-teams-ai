import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import {
  buildMembersFromDrafts,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
  createMemberDraft,
  MembersEditorSection,
  validateMemberNameInline,
} from '@renderer/components/team/members/MembersEditorSection';
import { MemberDraftRow } from '@renderer/components/team/members/MemberDraftRow';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import {
  agentAvatarUrl,
  buildMemberColorMap,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import { parseNumericSuffixName } from '@shared/utils/teamMemberName';
import { Loader2 } from 'lucide-react';

import {
  buildEditTeamSourceSnapshot,
  getMemberRuntimeContractKey,
  getLiveRosterIdentityChanges,
  getMembersRequiringRuntimeRestart,
} from './editTeamRuntimeChanges';

import type { ResolvedTeamMember } from '@shared/types';

const TEAM_COLOR_NAMES = [
  'blue',
  'green',
  'red',
  'yellow',
  'purple',
  'cyan',
  'orange',
  'pink',
] as const;

interface EditTeamDialogProps {
  open: boolean;
  teamName: string;
  currentName: string;
  currentDescription: string;
  currentColor: string;
  currentMembers: ResolvedTeamMember[];
  leadMember?: ResolvedTeamMember | null;
  resolvedMemberColorMap?: ReadonlyMap<string, string>;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  projectPath?: string | null;
  onClose: () => void;
  onChangeLeadRuntime: () => void;
  onSaved: () => Promise<void> | void;
}

function membersToDrafts(members: ResolvedTeamMember[]) {
  return createMemberDraftsFromInputs(filterEditableMemberInputs(members));
}

function useEditTeamErrorReset(
  setError: (value: string | null) => void,
  setSaveOutcomeError: (value: string | null) => void
): () => void {
  return () => {
    setError(null);
    setSaveOutcomeError(null);
  };
}

function getInvalidMemberNamesError(
  members: readonly {
    name: string;
    removedAt?: number | string | null;
  }[]
): string | null {
  for (const member of members) {
    if (member.removedAt) {
      continue;
    }
    const name = member.name.trim();
    if (!name) {
      return 'Member name cannot be empty';
    }
    if (validateMemberNameInline(name) !== null) {
      return 'Member name must start with alphanumeric, use only [a-zA-Z0-9._-], max 128 chars';
    }
    const lower = name.toLowerCase();
    if (lower === 'user' || lower === 'team-lead') {
      return `Member name "${name}" is reserved`;
    }
    const suffixInfo = parseNumericSuffixName(name);
    if (suffixInfo && suffixInfo.suffix >= 2) {
      return `Member name "${name}" is not allowed (reserved for Claude CLI auto-suffix). Use "${suffixInfo.base}" instead.`;
    }
  }
  return null;
}

function applyRemovedMembersToSnapshot(
  members: readonly ResolvedTeamMember[],
  removedMemberNames: readonly string[]
): ResolvedTeamMember[] {
  if (removedMemberNames.length === 0) {
    return [...members];
  }
  const removedKeys = new Set(removedMemberNames.map((name) => name.trim().toLowerCase()));
  const removedAt = Date.now();
  return members.map((member) =>
    removedKeys.has(member.name.trim().toLowerCase()) ? { ...member, removedAt } : member
  );
}

export const EditTeamDialog = ({
  open,
  teamName,
  currentName,
  currentDescription,
  currentColor,
  currentMembers,
  leadMember = null,
  resolvedMemberColorMap,
  isTeamAlive = false,
  isTeamProvisioning = false,
  projectPath,
  onClose,
  onChangeLeadRuntime,
  onSaved,
}: EditTeamDialogProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription);
  const [color, setColor] = useState(currentColor);
  const [members, setMembers] = useState(() => membersToDrafts(currentMembers));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOutcomeError, setSaveOutcomeError] = useState<string | null>(null);
  const [membersPendingRestartRetry, setMembersPendingRestartRetry] = useState<
    Record<string, string>
  >({});
  const wasOpenRef = useRef(false);
  const initializedTeamNameRef = useRef<string | null>(null);
  const baselineSourceSnapshotRef = useRef<string | null>(null);
  const pendingCommittedSourceSnapshotRef = useRef<string | null>(null);

  useFileListCacheWarmer(projectPath ?? null);
  const clearTransientErrors = useEditTeamErrorReset(setError, setSaveOutcomeError);
  const effectiveResolvedMemberColorMap = useMemo(
    () => resolvedMemberColorMap ?? buildMemberColorMap(currentMembers),
    [currentMembers, resolvedMemberColorMap]
  );
  const leadDraft = useMemo(() => {
    if (!leadMember) return null;
    return createMemberDraft({
      id: `lead:${leadMember.name}`,
      name: displayMemberName(leadMember.name),
      originalName: leadMember.name,
      roleSelection: '',
      customRole: 'Team Lead',
      workflow: leadMember.workflow,
      providerId: leadMember.providerId,
      model: leadMember.model ?? '',
      effort: leadMember.effort,
    });
  }, [leadMember]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    if (open) {
      const shouldInitialize = !wasOpen || initializedTeamNameRef.current !== teamName;
      if (shouldInitialize) {
        setName(currentName);
        setDescription(currentDescription);
        setColor(currentColor);
        setMembers(membersToDrafts(currentMembers));
        setError(null);
        setSaveOutcomeError(null);
        setMembersPendingRestartRetry({});
        initializedTeamNameRef.current = teamName;
        baselineSourceSnapshotRef.current = buildEditTeamSourceSnapshot({
          name: currentName,
          description: currentDescription,
          color: currentColor,
          members: currentMembers,
        });
        pendingCommittedSourceSnapshotRef.current = null;
      } else if (pendingCommittedSourceSnapshotRef.current !== null) {
        const latestSourceSnapshot = buildEditTeamSourceSnapshot({
          name: currentName,
          description: currentDescription,
          color: currentColor,
          members: currentMembers,
        });
        if (latestSourceSnapshot === pendingCommittedSourceSnapshotRef.current) {
          baselineSourceSnapshotRef.current = latestSourceSnapshot;
          pendingCommittedSourceSnapshotRef.current = null;
        }
      }
    } else if (wasOpen) {
      initializedTeamNameRef.current = null;
      baselineSourceSnapshotRef.current = null;
      pendingCommittedSourceSnapshotRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open, teamName, currentName, currentDescription, currentColor, currentMembers]);

  const builtMembers = useMemo(() => buildMembersFromDrafts(members), [members]);
  const invalidMemberNamesError = useMemo(() => getInvalidMemberNamesError(members), [members]);
  const hasDuplicateMembers = useMemo(() => {
    const names = members
      .filter((member) => !member.removedAt)
      .map((member) => member.name.trim().toLowerCase())
      .filter(Boolean);
    return new Set(names).size !== names.length;
  }, [members]);
  const membersToRestart = useMemo(
    () =>
      isTeamAlive
        ? getMembersRequiringRuntimeRestart({
            previousMembers: currentMembers,
            nextMembers: builtMembers,
          })
        : [],
    [builtMembers, currentMembers, isTeamAlive]
  );
  const builtMembersByName = useMemo(
    () =>
      new Map(builtMembers.map((member) => [member.name.trim().toLowerCase(), member] as const)),
    [builtMembers]
  );
  const effectiveMembersToRestart = useMemo(() => {
    const retryMembers = Object.entries(membersPendingRestartRetry).flatMap(
      ([normalizedName, expectedRuntimeContractKey]) => {
        const nextMember = builtMembersByName.get(normalizedName);
        if (!nextMember) {
          return [];
        }
        return getMemberRuntimeContractKey(nextMember) === expectedRuntimeContractKey
          ? [nextMember.name.trim()]
          : [];
      }
    );
    return Array.from(
      new Set(
        [...membersToRestart, ...retryMembers]
          .map((memberName) => memberName.trim())
          .filter(Boolean)
      )
    );
  }, [builtMembersByName, membersPendingRestartRetry, membersToRestart]);
  const liveIdentityChanges = useMemo(
    () =>
      isTeamAlive
        ? getLiveRosterIdentityChanges({
            previousMembers: currentMembers,
            nextDrafts: members,
          })
        : { renamed: [], removed: [] },
    [currentMembers, isTeamAlive, members]
  );
  const hasBlockedLiveIdentityChanges = liveIdentityChanges.renamed.length > 0;
  const liveRemovedExistingMembers = useMemo(
    () => (isTeamAlive ? liveIdentityChanges.removed : []),
    [isTeamAlive, liveIdentityChanges.removed]
  );
  const hasNewLiveTeammates = useMemo(
    () =>
      isTeamAlive && members.some((member) => !member.removedAt && !member.originalName?.trim()),
    [isTeamAlive, members]
  );
  const memberWarningById = useMemo(() => {
    const restartNames = new Set(
      effectiveMembersToRestart.map((memberName) => memberName.trim().toLowerCase())
    );
    if (restartNames.size === 0) {
      return undefined;
    }
    return Object.fromEntries(
      members.map((member) => [
        member.id,
        restartNames.has(member.name.trim().toLowerCase())
          ? 'Saving will restart this teammate to apply role, workflow, provider, model, or effort changes.'
          : null,
      ])
    );
  }, [effectiveMembersToRestart, members]);

  const handleSave = (): void => {
    if (!name.trim()) {
      setError('Team name cannot be empty');
      return;
    }
    if (invalidMemberNamesError) {
      setError(invalidMemberNamesError);
      return;
    }
    if (hasDuplicateMembers) {
      setError('Member names must be unique before saving');
      return;
    }
    const latestSourceSnapshot = buildEditTeamSourceSnapshot({
      name: currentName,
      description: currentDescription,
      color: currentColor,
      members: currentMembers,
    });
    const allowedSourceSnapshots = new Set(
      [baselineSourceSnapshotRef.current, pendingCommittedSourceSnapshotRef.current].filter(
        (value): value is string => value !== null
      )
    );
    if (allowedSourceSnapshots.size > 0 && !allowedSourceSnapshots.has(latestSourceSnapshot)) {
      setError(
        'Team settings changed while this dialog was open. Reopen it and review the latest state before saving.'
      );
      return;
    }
    if (hasBlockedLiveIdentityChanges) {
      setError(
        `Existing teammates cannot be renamed while the team is live. renamed: ${liveIdentityChanges.renamed.join(', ')}`
      );
      return;
    }
    if (isTeamProvisioning) {
      setError(
        'Team settings cannot be edited while provisioning is still in progress. Wait for launch to finish, then try again.'
      );
      return;
    }
    if (hasNewLiveTeammates) {
      setError(
        'Add new teammates from the dedicated Add member dialog while the team is live. Edit Team only supports updating existing teammates.'
      );
      return;
    }
    setSaving(true);
    setError(null);
    setSaveOutcomeError(null);
    void (async () => {
      let configSaved = false;
      let membersSaved = false;
      let committedMembersForSnapshot: ResolvedTeamMember[] = currentMembers;
      try {
        await api.teams.updateConfig(teamName, {
          name: name.trim(),
          description: description.trim(),
          color,
        });
        configSaved = true;
        for (const removedMemberName of liveRemovedExistingMembers) {
          await api.teams.removeMember(teamName, removedMemberName);
          committedMembersForSnapshot = applyRemovedMembersToSnapshot(committedMembersForSnapshot, [
            removedMemberName,
          ]);
        }
        await api.teams.replaceMembers(teamName, { members: builtMembers });
        membersSaved = true;
        pendingCommittedSourceSnapshotRef.current = buildEditTeamSourceSnapshot({
          name: name.trim(),
          description: description.trim(),
          color: color.trim(),
          members: builtMembers.map((member) => ({
            name: member.name,
            role: member.role,
            workflow: member.workflow,
            providerId: member.providerId,
            model: member.model,
            effort: member.effort,
          })) as ResolvedTeamMember[],
        });

        const restartFailures: string[] = [];
        const failedRestartMembers: string[] = [];
        for (const memberName of effectiveMembersToRestart) {
          try {
            await api.teams.restartMember(teamName, memberName);
          } catch (restartError) {
            const detail =
              restartError instanceof Error ? restartError.message : String(restartError);
            failedRestartMembers.push(memberName);
            restartFailures.push(`${memberName} (${detail})`);
          }
        }

        await Promise.resolve(onSaved());
        if (restartFailures.length === 0) {
          setMembersPendingRestartRetry({});
          onClose();
          return;
        }

        setMembersPendingRestartRetry(
          Object.fromEntries(
            failedRestartMembers.flatMap((memberName) => {
              const nextMember = builtMembersByName.get(memberName.trim().toLowerCase());
              if (!nextMember) {
                return [];
              }
              return [
                [memberName.trim().toLowerCase(), getMemberRuntimeContractKey(nextMember)] as const,
              ];
            })
          )
        );
        setSaveOutcomeError(
          `Team saved, but failed to restart ${restartFailures.length === 1 ? 'this teammate' : 'these teammates'}: ${restartFailures.join(', ')}`
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to save';
        if (membersSaved) {
          setSaveOutcomeError(
            `Team changes were saved, but failed to refresh the latest view: ${message}`
          );
        } else if (configSaved) {
          pendingCommittedSourceSnapshotRef.current = buildEditTeamSourceSnapshot({
            name: name.trim(),
            description: description.trim(),
            color: color.trim(),
            members: committedMembersForSnapshot,
          });
          let refreshErrorDetail: string | null = null;
          try {
            await Promise.resolve(onSaved());
          } catch (refreshError) {
            refreshErrorDetail =
              refreshError instanceof Error ? refreshError.message : String(refreshError);
          }
          setSaveOutcomeError(
            refreshErrorDetail
              ? `Team settings were saved, but member changes failed: ${message}. Refresh also failed: ${refreshErrorDetail}`
              : `Team settings were saved, but member changes failed: ${message}`
          );
        } else {
          setError(message);
        }
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit Team</DialogTitle>
          <DialogDescription>Change team name, description and color</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="edit-team-name"
              className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Name
            </label>
            <input
              id="edit-team-name"
              type="text"
              value={name}
              onChange={(e) => {
                clearTransientErrors();
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving && name.trim()) handleSave();
              }}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]"
              placeholder="Team name"
            />
          </div>
          <div>
            <label
              htmlFor="edit-team-description"
              className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Description
            </label>
            <textarea
              id="edit-team-description"
              value={description}
              onChange={(e) => {
                clearTransientErrors();
                setDescription(e.target.value);
              }}
              rows={3}
              className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]"
              placeholder="Team description (optional)"
            />
          </div>
          <div>
            <MembersEditorSection
              members={members}
              onChange={(nextMembers) => {
                clearTransientErrors();
                setMembers(nextMembers);
              }}
              fieldError={invalidMemberNamesError ?? undefined}
              validateMemberName={validateMemberNameInline}
              showWorkflow
              showJsonEditor={!isTeamAlive}
              draftKeyPrefix={`editTeam:${teamName}`}
              projectPath={projectPath ?? null}
              headerExtra={
                leadDraft ? (
                  <div className="space-y-2">
                    <MemberDraftRow
                      member={leadDraft}
                      index={0}
                      avatarSrc={agentAvatarUrl('team-lead', 32)}
                      resolvedColor={effectiveResolvedMemberColorMap.get(
                        leadDraft.originalName ?? leadDraft.name
                      )}
                      nameError={null}
                      onNameChange={() => undefined}
                      onRoleChange={() => undefined}
                      onCustomRoleChange={() => undefined}
                      onRemove={() => undefined}
                      onProviderChange={() => undefined}
                      onModelChange={() => undefined}
                      onEffortChange={() => undefined}
                      projectPath={projectPath ?? null}
                      lockProviderModel
                      lockRole
                      lockedRoleLabel="Team Lead"
                      lockIdentity
                      hideActionButton
                      modelLockReason="Team lead runtime is managed from Relaunch Team."
                      lockedModelAction={{
                        label: 'Change lead runtime',
                        description:
                          'Open Relaunch Team to change the lead provider, model, or effort.',
                        onClick: onChangeLeadRuntime,
                        disabled: isTeamProvisioning,
                      }}
                    />
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      Team lead name and role stay read-only here. Open the runtime panel on the
                      lead row to change provider, model, or effort.
                    </p>
                  </div>
                ) : null
              }
              existingMembers={currentMembers}
              existingMemberColorMap={effectiveResolvedMemberColorMap}
              lockProviderModel={false}
              lockExistingMemberIdentity={isTeamAlive}
              identityLockReason={undefined}
              disableAddMember={isTeamAlive}
              addMemberLockReason="Use the dedicated Add member dialog to add new teammates while the team is live."
              memberWarningById={memberWarningById}
            />
          </div>
          {isTeamProvisioning ? (
            <p className="text-xs text-amber-300">
              Team provisioning is still in progress. Editing is temporarily locked until launch
              finishes.
            </p>
          ) : null}
          {isTeamAlive && hasNewLiveTeammates ? (
            <p className="text-xs text-red-300">
              New teammates cannot be added from Edit Team while the team is live. Use the Add
              member dialog instead.
            </p>
          ) : null}
          {isTeamAlive && hasBlockedLiveIdentityChanges ? (
            <p className="text-xs text-red-300">
              Live save is blocked because existing teammates were renamed. Revert those identity
              changes or stop the team first.
            </p>
          ) : null}
          {isTeamAlive && effectiveMembersToRestart.length > 0 ? (
            <p className="text-xs text-amber-300">
              Saving will restart{' '}
              {effectiveMembersToRestart.length === 1 ? 'this teammate' : 'these teammates'} to
              apply role, workflow, provider, model, or effort changes:{' '}
              {effectiveMembersToRestart.join(', ')}.
            </p>
          ) : null}
          <div>
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Color picker is a group of buttons, not a single input */}
            <label className="label-optional mb-1 block text-xs font-medium">
              Color (optional)
            </label>
            <div className="flex flex-wrap gap-2">
              {TEAM_COLOR_NAMES.map((colorName) => {
                const colorSet = getTeamColorSet(colorName);
                const isSelected = color === colorName;
                return (
                  <button
                    key={colorName}
                    type="button"
                    className={cn(
                      'flex size-7 items-center justify-center rounded-full border-2 transition-all',
                      isSelected ? 'scale-110' : 'opacity-70 hover:opacity-100'
                    )}
                    style={{
                      backgroundColor: getThemedBadge(colorSet, isLight),
                      borderColor: isSelected ? colorSet.border : 'transparent',
                    }}
                    title={colorName}
                    onClick={() => {
                      clearTransientErrors();
                      setColor(isSelected ? '' : colorName);
                    }}
                  >
                    <span
                      className="size-3.5 rounded-full"
                      style={{ backgroundColor: colorSet.border }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
          {(error || saveOutcomeError) && (
            <p className="text-xs text-red-400">{error ?? saveOutcomeError}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={
              saving ||
              isTeamProvisioning ||
              !name.trim() ||
              hasDuplicateMembers ||
              Boolean(invalidMemberNamesError)
            }
          >
            {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
