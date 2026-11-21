import {
  findProjectCopyOwner,
  formatProjectCopyLabel,
  type ProjectCopyCatalogTeam,
} from '@features/team-project-context/core';

import {
  areReviewFlowSettingsEqual,
  resolveReviewFlowPolicy,
} from '../../core/domain/reviewFlowPolicy';

import type {
  ReviewFlowPolicy,
  ReviewFlowSettings,
  TeamReviewFlowOverrides,
} from '../../contracts/types';

/** Pure view logic of the review-flow settings UI. No React, no store, no IPC. */

export type ReviewFlowScope = { kind: 'default' } | { kind: 'team'; teamName: string };

export const DEFAULT_SCOPE_VALUE = '*';

export interface TeamIdentity {
  teamName: string;
  displayName?: string;
}

/** Marker next to a team in the scope picker: its own settings, or saved settings that need repair. */
export type ScopeBadge = 'custom' | 'repair' | null;

export interface ScopeOption {
  value: string;
  label: string;
  description?: string;
  badge: ScopeBadge;
}

export interface OverrideRow {
  teamName: string;
  displayName: string;
  settings: ReviewFlowSettings;
}

/** A team in a list that offers a reset, such as the unreadable ones. */
export interface TeamRow {
  teamName: string;
  displayName: string;
}

/** The editable state of one editor: the "use default" switch plus the form fields. */
export interface EditorDraft {
  inherit: boolean;
  settings: ReviewFlowSettings;
}

export function scopeToValue(scope: ReviewFlowScope): string {
  return scope.kind === 'default' ? DEFAULT_SCOPE_VALUE : scope.teamName;
}

export function scopeFromValue(value: string): ReviewFlowScope {
  return value === DEFAULT_SCOPE_VALUE ? { kind: 'default' } : { kind: 'team', teamName: value };
}

/**
 * The teams a review flow can be set for. A team with separate history per
 * project has one setting for the team (see `foldProjectTeamBoards`), so it is
 * listed once and its project copies are not (`projectCopies`, from the main
 * process, also covers a copy whose first launch never finished, which the team
 * list still shows as a row of its own). An ordinary team is its own board;
 * copies it retained from an earlier period keep boards of their own and are
 * named after the team and the project.
 */
export function reviewFlowBoardsOf(
  teams: readonly ProjectCopyCatalogTeam[],
  projectCopies: ReadonlySet<string>
): TeamIdentity[] {
  return teams.flatMap((team): TeamIdentity[] => {
    if (projectCopies.has(team.teamName)) return [];
    const own = { teamName: team.teamName, displayName: team.displayName };
    if (team.projectContextMode === 'per_project') return [own];
    const copies = (team.projectHistoryContexts ?? []).map((context) => {
      const owner = findProjectCopyOwner(teams, context.executionTeamName);
      return {
        teamName: context.executionTeamName,
        displayName: owner ? formatProjectCopyLabel(owner) : context.executionTeamName,
      };
    });
    return [own, ...copies];
  });
}

function teamLabel(team: TeamIdentity): string {
  return team.displayName?.trim() || team.teamName;
}

function compareByLabel(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/** Teams followed by teams the list does not know yet (with saved settings), so none is unreachable. */
function mergeKnownTeams(
  teams: readonly TeamIdentity[],
  overrides: TeamReviewFlowOverrides,
  unreadableTeams: readonly string[] = []
): TeamIdentity[] {
  const known = new Set(teams.map((team) => team.teamName));
  const orphans = [...new Set([...Object.keys(overrides), ...unreadableTeams])]
    .filter((teamName) => !known.has(teamName))
    .map((teamName) => ({ teamName }));
  return [...teams, ...orphans];
}

function scopeBadge(
  teamName: string,
  overrides: TeamReviewFlowOverrides,
  broken: ReadonlySet<string>
): ScopeBadge {
  if (broken.has(teamName)) return 'repair';
  return teamName in overrides ? 'custom' : null;
}

export function buildScopeOptions(
  teams: readonly TeamIdentity[],
  overrides: TeamReviewFlowOverrides,
  unreadableTeams: readonly string[],
  defaultLabel: string
): ScopeOption[] {
  const broken = new Set(unreadableTeams);
  const teamOptions = mergeKnownTeams(teams, overrides, unreadableTeams)
    .map<ScopeOption>((team) => {
      const label = teamLabel(team);
      return {
        value: team.teamName,
        label,
        ...(label !== team.teamName ? { description: team.teamName } : {}),
        badge: scopeBadge(team.teamName, overrides, broken),
      };
    })
    .sort((a, b) => compareByLabel(a.label, b.label));
  return [{ value: DEFAULT_SCOPE_VALUE, label: defaultLabel, badge: null }, ...teamOptions];
}

export function buildUnreadableRows(
  teams: readonly TeamIdentity[],
  unreadableTeams: readonly string[]
): TeamRow[] {
  const byName = new Map(teams.map((team) => [team.teamName, team]));
  return unreadableTeams
    .map((teamName) => ({
      teamName,
      displayName: teamLabel(byName.get(teamName) ?? { teamName }),
    }))
    .sort((a, b) => compareByLabel(a.displayName, b.displayName));
}

export function buildOverrideRows(
  teams: readonly TeamIdentity[],
  overrides: TeamReviewFlowOverrides
): OverrideRow[] {
  return mergeKnownTeams(teams, overrides)
    .filter((team) => team.teamName in overrides)
    .map((team) => ({
      teamName: team.teamName,
      displayName: teamLabel(team),
      settings: overrides[team.teamName],
    }))
    .sort((a, b) => compareByLabel(a.displayName, b.displayName));
}

/** How many known teams currently follow the default. */
export function countFollowingDefault(
  teams: readonly TeamIdentity[],
  overrides: TeamReviewFlowOverrides
): number {
  return teams.filter((team) => !(team.teamName in overrides)).length;
}

export function resolveScopePolicy(
  scope: ReviewFlowScope,
  defaults: ReviewFlowSettings,
  overrides: TeamReviewFlowOverrides
): ReviewFlowPolicy {
  return scope.kind === 'default'
    ? resolveReviewFlowPolicy(defaults, null)
    : resolveReviewFlowPolicy(defaults, overrides[scope.teamName]);
}

/** A team that follows the default starts from the default values, so switching to custom loses nothing. */
export function createInitialDraft(policy: ReviewFlowPolicy): EditorDraft {
  return {
    inherit: policy.source === 'default',
    settings: { reviewFlow: policy.reviewFlow, reviewFlowPrompt: policy.reviewFlowPrompt },
  };
}

export function isEditorDraftDirty(
  scope: ReviewFlowScope,
  draft: EditorDraft,
  policy: ReviewFlowPolicy
): boolean {
  if (scope.kind === 'team') {
    const persistedInherit = policy.source === 'default';
    if (draft.inherit !== persistedInherit) return true;
    if (draft.inherit) return false;
  }
  return !areReviewFlowSettingsEqual(draft.settings, policy);
}

/** What to save: the settings, or `null` meaning "this team follows the default again". */
export function draftToPayload(
  scope: ReviewFlowScope,
  draft: EditorDraft
): ReviewFlowSettings | null {
  return scope.kind === 'team' && draft.inherit ? null : draft.settings;
}

/** Stable identity of what the editor currently persists; a change means the draft must restart. */
export function policyIdentity(scope: ReviewFlowScope, policy: ReviewFlowPolicy): string {
  return JSON.stringify([
    scopeToValue(scope),
    policy.source,
    policy.reviewFlow,
    policy.reviewFlowPrompt,
  ]);
}
