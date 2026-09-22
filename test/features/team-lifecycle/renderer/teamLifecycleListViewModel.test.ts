import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleState,
} from '@features/team-lifecycle/contracts';
import {
  toTeamLifecycleListItemViewModel,
  toTeamLifecycleListViewModel,
} from '@features/team-lifecycle/renderer';
import { parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const REVISION = parseRevision('revision_renderer-view-model');
const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);

function success(items: Extract<CanonicalListTeamLifecycleResult, { kind: 'success' }>['items']) {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'success',
    snapshotRevision: REVISION,
    items,
    nextCursor: null,
  } satisfies CanonicalListTeamLifecycleResult;
}

describe('team lifecycle list view model', () => {
  it.each([
    ['draft', 'list.status.offline', 'muted'],
    ['ready', 'list.status.offline', 'muted'],
    ['running', 'list.status.running', 'success'],
    ['degraded', 'list.status.partialFailure', 'warning'],
    ['stopped', 'list.status.offline', 'muted'],
    ['deleted', 'list.status.deleted', 'danger'],
  ] as const)('projects %s without rewriting opaque identity', (lifecycle, label, tone) => {
    const projected = toTeamLifecycleListItemViewModel({
      teamId: TEAM_ID,
      workspaceId: WORKSPACE_ID,
      displayName: 'Visible team',
      lifecycle: lifecycle as TeamLifecycleState,
      revision: REVISION,
    });

    expect(projected).toEqual({
      teamId: TEAM_ID,
      workspaceId: WORKSPACE_ID,
      displayName: 'Visible team',
      statusLabelKey: label,
      statusTone: tone,
    });
  });

  it('keeps empty success distinct from typed failure and inapplicable outcomes', () => {
    expect(toTeamLifecycleListViewModel(success([]))).toMatchObject({ state: 'empty' });
    expect(
      toTeamLifecycleListViewModel({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        kind: 'failure',
        error: { code: 'unavailable', reason: 'identity_unavailable' },
        retryable: true,
      })
    ).toEqual({ state: 'failure', failureKind: 'failure', retryable: true });
    expect(
      toTeamLifecycleListViewModel({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        kind: 'inapplicable',
        code: 'not_applicable',
        reason: 'list_not_found_inapplicable',
      })
    ).toEqual({ state: 'failure', failureKind: 'inapplicable', retryable: false });
  });
});
