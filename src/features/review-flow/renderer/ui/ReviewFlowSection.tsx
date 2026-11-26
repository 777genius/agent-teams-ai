import { useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import { useKnownTeams, useReviewFlowOverview } from '../state/useReviewFlow';
import {
  buildOverrideRows,
  buildScopeOptions,
  buildUnreadableRows,
  countFollowingDefault,
  DEFAULT_SCOPE_VALUE,
  isReviewFlowTeamUnavailable,
  resolveScopePolicy,
  scopeFromValue,
} from '../view-model/reviewFlowViewModel';

import { ReviewFlowDefaultsErrorBanner } from './ReviewFlowDefaultsErrorBanner';
import { ReviewFlowLoadGate } from './ReviewFlowLoadGate';
import { ReviewFlowPolicyEditor } from './ReviewFlowPolicyEditor';
import { ReviewFlowScopePicker } from './ReviewFlowScopePicker';
import { ReviewFlowTeamList } from './ReviewFlowTeamList';
import { FLOW_TEXT_KEYS } from './reviewFlowText';
import { useSaveErrorText } from './useSaveErrorText';

import type { ReviewFlowSettings } from '../../contracts/types';

const TEST_ID_PREFIX = 'review-flow-settings';

/**
 * The "Review flow" page of the app settings: the default for all teams and per-team overrides.
 * A team with separate history per project is one entry with one setting for all its projects.
 */
export const ReviewFlowSection = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const overview = useReviewFlowOverview({ revalidate: true });
  const teams = useKnownTeams();
  const [scopeValue, setScopeValue] = useState(DEFAULT_SCOPE_VALUE);

  const { defaults, defaultsError, overrides, unreadableTeams, unavailable = [] } = overview;
  const scope = scopeFromValue(scopeValue);
  const options = useMemo(
    () => buildScopeOptions(teams, overrides, unreadableTeams, t('reviewFlow.scope.defaultOption')),
    [teams, overrides, unreadableTeams, t]
  );
  const overrideRows = useMemo(
    () =>
      buildOverrideRows(teams, overrides).map((row) => ({
        teamName: row.teamName,
        displayName: row.displayName,
        detail: t(FLOW_TEXT_KEYS[row.settings.reviewFlow].label),
      })),
    [teams, overrides, t]
  );
  const unreadableRows = useMemo(
    () => buildUnreadableRows(teams, unreadableTeams),
    [teams, unreadableTeams]
  );
  const selectedUnavailable = scope.kind === 'team' &&
    isReviewFlowTeamUnavailable(teams.find((team) => team.teamName === scope.teamName) ?? { teamName: scope.teamName }, unavailable);
  const availableTeams = teams.filter((team) => !isReviewFlowTeamUnavailable(team, unavailable));
  const policy = resolveScopePolicy(scope, defaults, overrides);
  const repair =
    scope.kind === 'default' ? defaultsError !== null : unreadableTeams.includes(scope.teamName);

  const handleSave = (settings: ReviewFlowSettings | null): Promise<void> => {
    if (scope.kind === 'team') return overview.saveTeamOverride(scope.teamName, settings);
    // The default is always a value; only a team can go back to following it.
    return settings ? overview.saveDefaults(settings) : Promise.resolve();
  };
  const resetTeam = (teamName: string): Promise<void> => overview.saveTeamOverride(teamName, null);
  const errorText = useSaveErrorText();
  const resetLabel = t('reviewFlow.overrides.reset');
  const resetAriaLabel = (team: string): string => t('reviewFlow.overrides.resetLabel', { team });

  return (
    <div className="space-y-5" data-testid="review-flow-settings-page">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-[var(--color-text)]">{t('reviewFlow.title')}</h2>
        <p className="text-sm text-[var(--color-text-muted)]">{t('reviewFlow.intro')}</p>
      </header>
      <ReviewFlowLoadGate
        status={overview.status}
        error={overview.error}
        onRetry={() => void overview.load({ force: true })}
      >
        <div className="space-y-5">
          {defaultsError ? (
            <ReviewFlowDefaultsErrorBanner
              message={defaultsError}
              editing={scope.kind === 'default'}
              onFix={scope.kind === 'team' ? () => setScopeValue(DEFAULT_SCOPE_VALUE) : undefined}
            />
          ) : null}
          {unavailable.length > 0 ? (
            <div role="alert" className="space-y-2" data-testid="review-flow-unavailable">
              <p className="text-sm text-[var(--color-text-muted)]">{t('reviewFlow.unavailable', { count: unavailable.length })}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void overview.load({ force: true })}>
                {t('reviewFlow.retry')}
              </Button>
            </div>
          ) : null}
          <ReviewFlowScopePicker options={options} value={scopeValue} onChange={setScopeValue} />
          {!selectedUnavailable ? <ReviewFlowPolicyEditor
            scope={scope}
            policy={policy}
            defaults={defaults}
            followingTeamCount={countFollowingDefault(availableTeams, overrides)}
            repair={repair}
            projects={scope.kind === 'team' ? overview.projectTeams[scope.teamName] : null}
            onSave={handleSave}
            testIdPrefix={TEST_ID_PREFIX}
          /> : null}
          {scope.kind === 'default' ? (
            <>
              <ReviewFlowTeamList
                testIdPrefix="review-flow-unreadable"
                heading={t('reviewFlow.unreadable.heading', { count: unreadableRows.length })}
                rows={unreadableRows}
                resetLabel={resetLabel}
                resetAriaLabel={resetAriaLabel}
                errorText={errorText}
                onSelect={setScopeValue}
                onReset={resetTeam}
              />
              <ReviewFlowTeamList
                testIdPrefix="review-flow-overrides"
                heading={t('reviewFlow.overrides.heading', { count: overrideRows.length })}
                rows={overrideRows}
                emptyText={t('reviewFlow.overrides.empty')}
                resetLabel={resetLabel}
                resetAriaLabel={resetAriaLabel}
                errorText={errorText}
                onSelect={setScopeValue}
                onReset={resetTeam}
              />
            </>
          ) : null}
        </div>
      </ReviewFlowLoadGate>
    </div>
  );
};
