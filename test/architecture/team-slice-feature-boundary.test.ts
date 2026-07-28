import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const teamSlicePath = 'src/renderer/store/slices/teamSlice.ts';
const teamSliceTypesPath = 'src/renderer/store/slices/teamSlice.types.ts';
const navigationSlicePath = 'src/renderer/store/team/createTeamNavigationSlice.ts';
const provisioningRuntimeSlicePath =
  'src/renderer/store/team/createTeamProvisioningRuntimeSlice.ts';
const ownedProductionPaths = [
  teamSlicePath,
  teamSliceTypesPath,
  navigationSlicePath,
  provisioningRuntimeSlicePath,
] as const;
const publicFeatureImport = /^@features\/[^/]+(?:\/(?:contracts|main|preload|renderer))?$/;
const directTeamTransport = /\bapi\.teams\b|\bwindow\.(?:api|electronAPI)\.teams\b/;

const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
const lineCount = (contents: string): number => contents.trimEnd().split(/\r?\n/).length;
const featureImports = (contents: string): string[] =>
  [...contents.matchAll(/from\s+['"](@features\/[^'"]+)['"]/g)].map((match) => match[1]);

describe('team slice feature boundary', () => {
  it('keeps direct team transports out of store-owned team slices', () => {
    for (const path of ownedProductionPaths) {
      expect(source(path), path).not.toMatch(directTeamTransport);
    }
  });

  it('allows store composition to consume only public feature entrypoints', () => {
    for (const path of ownedProductionPaths) {
      for (const featureImport of featureImports(source(path))) {
        expect(featureImport, `${path}: ${featureImport}`).toMatch(publicFeatureImport);
      }
    }
  });

  it('ratchets teamSlice size and delegates bounded state to composition slices', () => {
    const teamSlice = source(teamSlicePath);

    expect(lineCount(teamSlice)).toBeLessThan(245);
    expect(teamSlice).toContain('createTeamNavigationSlice({');
    expect(teamSlice).toContain('createTeamProvisioningRuntimeSlice({');
    expect(teamSlice).not.toMatch(
      /\b(?:globalTaskDetail|pendingMemberProfile|pendingTeamSectionFocus|pendingReviewRequest|teamsProjectNavigationIntent|kanbanFilterQuery|openGlobalTaskDetail|closeGlobalTaskDetail|openMemberProfile|closeMemberProfile|focusTeamSection|clearTeamSectionFocus|setPendingReviewRequest|clearKanbanFilter|openTeamsTab|openTeamTab):/
    );
    expect(teamSlice).not.toMatch(
      /\b(?:createTeamProvisioningControlSlice|createTeamProvisioningLaunchSlice|createTeamProvisioningProgressSlice)(?:<[^;]+?>)?\s*\(/
    );
    expect(teamSlice).toContain('createTeamToolApprovalRendererSlice(');
    expect(teamSlice).toContain('createTeamViewPreferencesRendererSlice<AppState>(');
    expect(teamSlice).not.toMatch(
      /\b(?:updateToolApprovalSettings|respondToToolApproval|setMessagesPanelMode|setMessagesPanelWidth|setSidebarLogsHeight)\s*:/
    );
  });

  it('composes the extracted public slice contracts without redeclaring their fields', () => {
    const types = source(teamSliceTypesPath);

    expect(lineCount(types)).toBeLessThan(63);
    expect(types).toContain('TeamToolApprovalRendererSlice,');
    expect(types).toContain('TeamViewPreferencesRendererSlice {}');
    expect(types).not.toMatch(
      /\b(?:pendingApprovals|resolvedApprovals|toolApprovalSettingsByTeam|toolApprovalSettings|messagesPanelMode|messagesPanelWidth|sidebarLogsHeight)\s*:/
    );
  });

  it('preserves feature-owned renderer ports in their bounded composition roots', () => {
    const teamSlice = source(teamSlicePath);
    const provisioningRuntimeSlice = source(provisioningRuntimeSlicePath);

    for (const factory of [
      'createTeamCollaborationDataSlice',
      'createTeamLifecycleMutationSlice',
      'createTeamProvisioningRuntimeSlice',
      'createTeamRosterMutationRendererSlice',
      'createTeamRuntimeOperationsRendererSlice',
      'createTeamToolApprovalRendererSlice',
      'createTeamViewPreferencesRendererSlice',
    ]) {
      expect(teamSlice, factory).toMatch(new RegExp(`\\b${factory}(?:<[^;]+?>)?\\s*\\(`));
    }

    for (const factory of [
      'createTeamProvisioningControlSlice',
      'createTeamProvisioningLaunchSlice',
      'createTeamProvisioningProgressSlice',
    ]) {
      expect(provisioningRuntimeSlice, factory).toMatch(
        new RegExp(`\\b${factory}(?:<[^;]+?>)?\\s*\\(`)
      );
    }
  });
});
