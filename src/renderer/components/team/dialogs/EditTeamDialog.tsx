import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { MemberDraftRow } from '@renderer/components/team/members/MemberDraftRow';
import {
  buildMembersFromDrafts,
  createMemberDraft,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
  MembersEditorSection,
  validateMemberNameInline,
} from '@renderer/components/team/members/MembersEditorSection';
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
import { isGeminiUiFrozen } from '@renderer/utils/geminiUiFreeze';
import { isImeComposing } from '@renderer/utils/imeComposition';
import {
  agentAvatarUrl,
  buildMemberColorMap,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import { parseNumericSuffixName } from '@shared/utils/teamMemberName';
import { Loader2 } from 'lucide-react';

import {
  buildEditTeamMemberRosterSnapshot,
  buildEditTeamSourceSnapshot,
  getLiveRosterIdentityChanges,
  getMemberRuntimeContractKey,
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

function deriveTeammateWorktreeDefault(members: readonly ResolvedTeamMember[]): boolean {
  const activeTeammates = filterEditableMemberInputs(members).filter((member) => !member.removedAt);
  return (
    activeTeammates.length > 0 && activeTeammates.every((member) => member.isolation === 'worktree')
  );
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
  }[],
  messages: {
    empty: string;
    invalid: string;
    reserved: (name: string) => string;
    numericSuffix: (name: string, base: string) => string;
  }
): string | null {
  for (const member of members) {
    if (member.removedAt) {
      continue;
    }
    const name = member.name.trim();
    if (!name) {
      return messages.empty;
    }
    if (validateMemberNameInline(name) !== null) {
      return messages.invalid;
    }
    const lower = name.toLowerCase();
    if (lower === 'user' || lower === 'team-lead') {
      return messages.reserved(name);
    }
    const suffixInfo = parseNumericSuffixName(name);
    if (suffixInfo && suffixInfo.suffix >= 2) {
      return messages.numericSuffix(name, suffixInfo.base);
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
  const { t } = useAppTranslation('team');
  const { isLight } = useTheme();
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription);
  const [color, setColor] = useState(currentColor);
  const [members, setMembers] = useState(() => membersToDrafts(currentMembers));
  const [teammateWorktreeDefault, setTeammateWorktreeDefault] = useState(() =>
    deriveTeammateWorktreeDefault(currentMembers)
  );
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
      customRole: t('editTeam.teamLead.role'),
      workflow: leadMember.workflow,
      providerId: leadMember.providerId,
      model: leadMember.model ?? '',
      effort: leadMember.effort,
    });
  }, [leadMember, t]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    if (open) {
      const shouldInitialize = !wasOpen || initializedTeamNameRef.current !== teamName;
      if (shouldInitialize) {
        setName(currentName);
        setDescription(currentDescription);
        setColor(currentColor);
        setMembers(membersToDrafts(currentMembers));
        setTeammateWorktreeDefault(deriveTeammateWorktreeDefault(currentMembers));
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
  const invalidMemberNamesError = useMemo(
    () =>
      getInvalidMemberNamesError(members, {
        empty: t('editTeam.errors.memberNameEmpty'),
        invalid: t('editTeam.errors.memberNameInvalid'),
        reserved: (memberName) => t('editTeam.errors.memberNameReserved', { name: memberName }),
        numericSuffix: (memberName, base) =>
          t('editTeam.errors.memberNameNumericSuffix', { name: memberName, base }),
      }),
    [members, t]
  );
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
  const currentMemberRosterSnapshot = useMemo(
    () => buildEditTeamMemberRosterSnapshot(currentMembers),
    [currentMembers]
  );
  const nextMemberRosterSnapshot = useMemo(
    () => buildEditTeamMemberRosterSnapshot(builtMembers),
    [builtMembers]
  );
  const hasMemberRosterChanges = currentMemberRosterSnapshot !== nextMemberRosterSnapshot;
  const currentMembersByName = useMemo(
    () =>
      new Map(currentMembers.map((member) => [member.name.trim().toLowerCase(), member] as const)),
    [currentMembers]
  );
  const isLiveMixedOpenCodeSideLaneTeam = useMemo(
    () =>
      isTeamAlive &&
      leadMember?.providerId !== 'opencode' &&
      currentMembers.some((member) => !member.removedAt && member.providerId === 'opencode'),
    [currentMembers, isTeamAlive, leadMember?.providerId]
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
          .filter((memberName) => {
            const nextMember = builtMembersByName.get(memberName.toLowerCase());
            return nextMember?.providerId !== 'opencode';
          })
          .filter(Boolean)
      )
    );
  }, [builtMembersByName, membersPendingRestartRetry, membersToRestart]);
  const openCodeMembersHandledByLiveRoster = useMemo(() => {
    if (!isTeamAlive) {
      return [];
    }
    return Array.from(
      new Set(
        membersToRestart
          .map((memberName) => memberName.trim())
          .filter((memberName) => {
            const nextMember = builtMembersByName.get(memberName.toLowerCase());
            return nextMember?.providerId === 'opencode';
          })
          .filter(Boolean)
      )
    );
  }, [builtMembersByName, isTeamAlive, membersToRestart]);
  const liveRuntimeRefreshMemberNames = useMemo(
    () =>
      Array.from(new Set([...effectiveMembersToRestart, ...openCodeMembersHandledByLiveRoster])),
    [effectiveMembersToRestart, openCodeMembersHandledByLiveRoster]
  );
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
  const unsupportedLiveMixedPrimaryRuntimeChangeNames = useMemo(() => {
    if (!isLiveMixedOpenCodeSideLaneTeam) {
      return [];
    }
    return membersToRestart.filter((memberName) => {
      const nextMember = builtMembersByName.get(memberName.trim().toLowerCase());
      return nextMember?.providerId !== 'opencode';
    });
  }, [builtMembersByName, isLiveMixedOpenCodeSideLaneTeam, membersToRestart]);
  const unsupportedLiveMixedPrimaryRemovalNames = useMemo(() => {
    if (!isLiveMixedOpenCodeSideLaneTeam) {
      return [];
    }
    return liveRemovedExistingMembers.filter((memberName) => {
      const currentMember = currentMembersByName.get(memberName.trim().toLowerCase());
      return currentMember?.providerId !== 'opencode';
    });
  }, [currentMembersByName, isLiveMixedOpenCodeSideLaneTeam, liveRemovedExistingMembers]);
  const unsupportedLiveMixedPrimaryMutationNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...unsupportedLiveMixedPrimaryRuntimeChangeNames,
          ...unsupportedLiveMixedPrimaryRemovalNames,
        ])
      ),
    [unsupportedLiveMixedPrimaryRemovalNames, unsupportedLiveMixedPrimaryRuntimeChangeNames]
  );
  const hasNewLiveTeammates = useMemo(
    () =>
      isTeamAlive && members.some((member) => !member.removedAt && !member.originalName?.trim()),
    [isTeamAlive, members]
  );
  const memberWarningById = useMemo(() => {
    const restartNames = new Set(
      liveRuntimeRefreshMemberNames.map((memberName) => memberName.trim().toLowerCase())
    );
    if (restartNames.size === 0) {
      return undefined;
    }
    return Object.fromEntries(
      members.map((member) => [
        member.id,
        restartNames.has(member.name.trim().toLowerCase())
          ? t('editTeam.memberRestartWarning')
          : null,
      ])
    );
  }, [liveRuntimeRefreshMemberNames, members, t]);

  const handleSave = (): void => {
    if (!name.trim()) {
      setError(t('editTeam.errors.teamNameEmpty'));
      return;
    }
    if (invalidMemberNamesError) {
      setError(invalidMemberNamesError);
      return;
    }
    if (hasDuplicateMembers) {
      setError(t('editTeam.errors.memberNamesUnique'));
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
      setError(t('editTeam.errors.settingsChanged'));
      return;
    }
    if (hasBlockedLiveIdentityChanges) {
      setError(
        t('editTeam.errors.liveRenameBlocked', {
          names: liveIdentityChanges.renamed.join(', '),
        })
      );
      return;
    }
    if (isTeamProvisioning) {
      setError(t('editTeam.errors.provisioning'));
      return;
    }
    if (hasNewLiveTeammates) {
      setError(t('editTeam.errors.newLiveTeammates'));
      return;
    }
    if (unsupportedLiveMixedPrimaryMutationNames.length > 0) {
      setError(
        t('editTeam.errors.unsupportedMixedPrimaryMutation', {
          names: unsupportedLiveMixedPrimaryMutationNames.join(', '),
        })
      );
      return;
    }
    setSaving(true);
    setError(null);
    setSaveOutcomeError(null);
    void (async () => {
      let configSaved = false;
      let membersSaved = false;
      let refreshAfterSaveAttempted = false;
      let committedMembersForSnapshot: ResolvedTeamMember[] = currentMembers;
      try {
        await api.teams.updateConfig(teamName, {
          name: name.trim(),
          description: description.trim(),
          color,
        });
        configSaved = true;
        if (hasMemberRosterChanges) {
          for (const removedMemberName of liveRemovedExistingMembers) {
            await api.teams.removeMember(teamName, removedMemberName);
            committedMembersForSnapshot = applyRemovedMembersToSnapshot(
              committedMembersForSnapshot,
              [removedMemberName]
            );
          }
          await api.teams.replaceMembers(teamName, { members: builtMembers });
          membersSaved = true;
        }
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
            isolation: member.isolation,
            mcpPolicy: member.mcpPolicy,
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

        refreshAfterSaveAttempted = true;
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
          restartFailures.length === 1
            ? t('editTeam.errors.restartFailedOne', { failures: restartFailures.join(', ') })
            : t('editTeam.errors.restartFailedMany', { failures: restartFailures.join(', ') })
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : t('editTeam.errors.saveFailed');
        if (membersSaved) {
          setSaveOutcomeError(t('editTeam.errors.changesSavedRefreshFailed', { message }));
        } else if (configSaved) {
          pendingCommittedSourceSnapshotRef.current = buildEditTeamSourceSnapshot({
            name: name.trim(),
            description: description.trim(),
            color: color.trim(),
            members: committedMembersForSnapshot,
          });
          if (refreshAfterSaveAttempted) {
            setSaveOutcomeError(t('editTeam.errors.settingsSavedRefreshFailed', { message }));
            return;
          }
          let refreshErrorDetail: string | null = null;
          try {
            await Promise.resolve(onSaved());
          } catch (refreshError) {
            refreshErrorDetail =
              refreshError instanceof Error ? refreshError.message : String(refreshError);
          }
          setSaveOutcomeError(
            refreshErrorDetail
              ? t('editTeam.errors.settingsSavedMembersAndRefreshFailed', {
                  message,
                  refreshError: refreshErrorDetail,
                })
              : t('editTeam.errors.settingsSavedMembersFailed', { message })
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
          <DialogTitle>{t('editTeam.title')}</DialogTitle>
          <DialogDescription>{t('editTeam.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="edit-team-name"
              className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]"
            >
              {t('editTeam.fields.name')}
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
                if (!isImeComposing(e) && e.key === 'Enter' && !saving && name.trim()) handleSave();
              }}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]"
              placeholder={t('editTeam.placeholders.teamName')}
            />
          </div>
          <div>
            <label
              htmlFor="edit-team-description"
              className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]"
            >
              {t('editTeam.fields.description')}
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
              placeholder={t('editTeam.placeholders.description')}
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
                      lockedRoleLabel={t('editTeam.teamLead.role')}
                      lockIdentity
                      hideActionButton
                      modelLockReason={t('editTeam.teamLead.modelLockReason')}
                      lockedModelAction={{
                        label: t('editTeam.teamLead.changeRuntime'),
                        description: t('editTeam.teamLead.changeRuntimeDescription'),
                        onClick: onChangeLeadRuntime,
                        disabled: isTeamProvisioning,
                      }}
                    />
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      {t('editTeam.teamLead.readOnlyHint')}
                    </p>
                  </div>
                ) : null
              }
              existingMembers={currentMembers}
              existingMemberColorMap={effectiveResolvedMemberColorMap}
              showWorktreeIsolationControls
              teammateWorktreeDefault={teammateWorktreeDefault}
              onTeammateWorktreeDefaultChange={setTeammateWorktreeDefault}
              lockProviderModel={false}
              lockExistingMemberIdentity={isTeamAlive}
              identityLockReason={undefined}
              disableAddMember={isTeamAlive}
              addMemberLockReason={t('editTeam.addMemberLockReason')}
              memberWarningById={memberWarningById}
              disableGeminiOption={isGeminiUiFrozen()}
            />
          </div>
          {isTeamProvisioning ? (
            <p className="text-xs text-amber-300">{t('editTeam.notices.provisioning')}</p>
          ) : null}
          {isTeamAlive && hasNewLiveTeammates ? (
            <p className="text-xs text-red-300">{t('editTeam.notices.newLiveTeammates')}</p>
          ) : null}
          {isTeamAlive && hasBlockedLiveIdentityChanges ? (
            <p className="text-xs text-red-300">{t('editTeam.notices.liveRenameBlocked')}</p>
          ) : null}
          {unsupportedLiveMixedPrimaryMutationNames.length > 0 ? (
            <p className="text-xs text-red-300">
              {t('editTeam.notices.unsupportedMixedPrimaryMutation', {
                names: unsupportedLiveMixedPrimaryMutationNames.join(', '),
              })}
            </p>
          ) : null}
          {isTeamAlive && liveRuntimeRefreshMemberNames.length > 0 ? (
            <p className="text-xs text-amber-300">
              {liveRuntimeRefreshMemberNames.length === 1
                ? t('editTeam.notices.restartOne', {
                    names: liveRuntimeRefreshMemberNames.join(', '),
                  })
                : t('editTeam.notices.restartMany', {
                    names: liveRuntimeRefreshMemberNames.join(', '),
                  })}
            </p>
          ) : null}
          <div>
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Color picker is a group of buttons, not a single input */}
            <label className="label-optional mb-1 block text-xs font-medium">
              {t('editTeam.fields.colorOptional')}
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
            {t('editTeam.actions.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={
              saving ||
              isTeamProvisioning ||
              !name.trim() ||
              hasDuplicateMembers ||
              Boolean(invalidMemberNamesError) ||
              unsupportedLiveMixedPrimaryMutationNames.length > 0
            }
          >
            {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {t('editTeam.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
