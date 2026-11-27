import { useId, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Label } from '@renderer/components/ui/label';
import { Switch } from '@renderer/components/ui/switch';

import { toReadableMessage } from '../state/createReviewFlowStore';
import {
  createInitialDraft,
  draftToPayload,
  type EditorDraft,
  isEditorDraftDirty,
  policyIdentity,
  type ReviewFlowScope,
  scopeToValue,
} from '../view-model/reviewFlowViewModel';

import { ReviewFlowProjectsNotice } from './ReviewFlowProjectsNotice';
import { ReviewFlowSettingsForm } from './ReviewFlowSettingsForm';
import { FLOW_TEXT_KEYS } from './reviewFlowText';
import { useSaveErrorText } from './useSaveErrorText';

import type { ReviewFlowPolicy, ReviewFlowSettings } from '../../contracts/types';
import type { ProjectTeamReviewFlowStatus } from '../view-model/projectTeamReviewFlow';

type Feedback = { kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string };

interface ReviewFlowPolicyEditorProps {
  scope: ReviewFlowScope;
  /** Effective settings of the scope as persisted right now. */
  policy: ReviewFlowPolicy;
  defaults: ReviewFlowSettings;
  /** Default scope only: how many teams follow the default. */
  followingTeamCount?: number;
  /**
   * What is saved for this scope cannot be read. The editor then says so instead of presenting the
   * shown values as persisted, and Save stays available even when nothing was changed.
   */
  repair?: boolean;
  /**
   * A team with separate history per project: one setting for all its projects. While some project
   * boards do not carry it, Save stays available to apply it to all of them.
   */
  projects?: ProjectTeamReviewFlowStatus | null;
  /** Saves the settings, or `null` when a team goes back to following the default. */
  onSave: (settings: ReviewFlowSettings | null) => Promise<void>;
  onSaved?: () => void;
  /** Provided by hosts that can be dismissed; otherwise Cancel just discards the draft. */
  onCancel?: () => void;
  testIdPrefix: string;
}

/**
 * The one editor of review-flow settings, used by the Settings tab and the Kanban popover:
 * a default for all teams, or a team that either follows it or has its own settings.
 */
export const ReviewFlowPolicyEditor = ({
  scope,
  policy,
  defaults,
  followingTeamCount,
  repair = false,
  projects = null,
  onSave,
  onSaved,
  onCancel,
  testIdPrefix,
}: Readonly<ReviewFlowPolicyEditorProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const switchId = useId();
  const scopeKey = scopeToValue(scope);
  const identity = policyIdentity(scope, policy);
  const [baseScopeKey, setBaseScopeKey] = useState(scopeKey);
  const [baseIdentity, setBaseIdentity] = useState(identity);
  const [draft, setDraft] = useState<EditorDraft>(() => createInitialDraft(policy));
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle' });
  /** The person changed something or took over the settings of a project. */
  const [chosen, setChosen] = useState(false);
  const saveErrorText = useSaveErrorText();

  if (scopeKey !== baseScopeKey) {
    // Another scope: start clean, including the feedback of the previous one.
    setBaseScopeKey(scopeKey);
    setBaseIdentity(identity);
    setDraft(createInitialDraft(policy));
    setChosen(false);
    setFeedback({ kind: 'idle' });
  } else if (identity !== baseIdentity) {
    // A save landed (or the data changed underneath): restart from what is persisted.
    setBaseIdentity(identity);
    setDraft(createInitialDraft(policy));
    setChosen(false);
  }

  const isTeam = scope.kind === 'team';
  const saving = feedback.kind === 'saving';
  const dirty = isEditorDraftDirty(scope, draft, policy);
  const unsynced = isTeam && (projects?.unsynced.length ?? 0) > 0;
  // Saving puts one setting on every project of the team.
  const projectsNeedSave = unsynced || (isTeam && projects?.saveSuggested === true);
  // Projects that differ and a team that never saved: there is nothing to keep by default, so a
  // save waits for an explicit choice (an edit, or the settings of one project taken over).
  const mustChoose = unsynced && projects?.saved === false;
  const canSave = (): boolean => {
    // A team whose projects cannot be listed cannot be saved (main refuses it too).
    if (isTeam && projects?.projectsError !== undefined) return false;
    if (mustChoose) return chosen;
    return dirty || repair || projectsNeedSave;
  };
  const shown = isTeam && draft.inherit ? defaults : draft.settings;

  const useDefaultDescription = (): string => {
    if (repair) return t('reviewFlow.broken.teamHint');
    if (!draft.inherit) return t('reviewFlow.useDefault.custom');
    return t('reviewFlow.useDefault.following', {
      flow: t(FLOW_TEXT_KEYS[defaults.reviewFlow].label),
    });
  };

  const sourceBadgeText = (): string => {
    if (repair) return t('reviewFlow.badges.repair');
    // Before its first save, a team whose projects disagree has no single setting to name.
    if (unsynced && !projects?.saved) return t('reviewFlow.badges.differ');
    return policy.source === 'team'
      ? t('reviewFlow.badges.custom')
      : t('reviewFlow.badges.default');
  };

  const edit = (next: EditorDraft): void => {
    setDraft(next);
    setChosen(true);
    setFeedback({ kind: 'idle' });
  };

  const handleSave = (): void => {
    setFeedback({ kind: 'saving' });
    onSave(draftToPayload(scope, draft)).then(
      () => {
        setFeedback({ kind: 'saved' });
        onSaved?.();
      },
      (error: unknown) => setFeedback({ kind: 'error', message: toReadableMessage(error) })
    );
  };

  const handleCancel = (): void => {
    setDraft(createInitialDraft(policy));
    setChosen(false);
    setFeedback({ kind: 'idle' });
    onCancel?.();
  };

  return (
    <div className="space-y-3" data-testid={`${testIdPrefix}-editor`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">
          {isTeam ? t('reviewFlow.editor.teamHeading') : t('reviewFlow.editor.defaultHeading')}
        </h3>
        {isTeam ? (
          <Badge
            variant={repair ? 'destructive' : 'outline'}
            data-testid={`${testIdPrefix}-source`}
          >
            {sourceBadgeText()}
          </Badge>
        ) : null}
      </div>

      {isTeam && projects ? (
        <ReviewFlowProjectsNotice
          status={projects}
          disabled={saving}
          onUse={(setting) =>
            edit(setting ? { inherit: false, settings: setting } : { ...draft, inherit: true })
          }
          testIdPrefix={testIdPrefix}
        />
      ) : null}

      {!isTeam && followingTeamCount !== undefined ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('reviewFlow.editor.followingTeams', { count: followingTeamCount })}
        </p>
      ) : null}

      {isTeam ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-[var(--color-border)] p-2.5">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor={switchId}>{t('reviewFlow.useDefault.label')}</Label>
            <p className="text-xs text-[var(--color-text-muted)]">{useDefaultDescription()}</p>
          </div>
          <Switch
            id={switchId}
            checked={draft.inherit}
            disabled={saving}
            data-testid={`${testIdPrefix}-use-default`}
            onCheckedChange={(inherit) => edit({ ...draft, inherit })}
          />
        </div>
      ) : null}

      <ReviewFlowSettingsForm
        value={shown}
        onChange={(settings) => edit({ ...draft, settings })}
        disabled={saving}
        readOnly={isTeam && draft.inherit}
        testIdPrefix={testIdPrefix}
      />

      <div className="flex min-h-8 items-center justify-between gap-2">
        <p
          className={
            feedback.kind === 'error'
              ? 'text-xs text-red-400'
              : 'text-xs text-[var(--color-text-muted)]'
          }
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          data-testid={`${testIdPrefix}-feedback`}
        >
          {feedback.kind === 'saved' ? t('reviewFlow.feedback.saved') : null}
          {feedback.kind === 'saving' ? t('reviewFlow.feedback.saving') : null}
          {feedback.kind === 'error' ? saveErrorText(feedback.message) : null}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving || (!onCancel && !dirty)}
            onClick={handleCancel}
          >
            {onCancel ? t('reviewFlow.cancel') : t('reviewFlow.discard')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSave() || saving}
            data-testid={`${testIdPrefix}-save`}
            onClick={handleSave}
          >
            {t('reviewFlow.save')}
          </Button>
        </div>
      </div>
    </div>
  );
};
