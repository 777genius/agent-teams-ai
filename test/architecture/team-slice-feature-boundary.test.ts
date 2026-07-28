import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const teamSlicePath = 'src/renderer/store/slices/teamSlice.ts';
const navigationSlicePath = 'src/renderer/store/team/createTeamNavigationSlice.ts';
const provisioningRuntimeSlicePath =
  'src/renderer/store/team/createTeamProvisioningRuntimeSlice.ts';
const ownedProductionPaths = [
  teamSlicePath,
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

    expect(lineCount(teamSlice)).toBeLessThanOrEqual(565);
    expect(teamSlice).toContain('createTeamNavigationSlice({');
    expect(teamSlice).toContain('createTeamProvisioningRuntimeSlice({');
    expect(teamSlice).not.toMatch(
      /\b(?:globalTaskDetail|pendingMemberProfile|pendingTeamSectionFocus|pendingReviewRequest|teamsProjectNavigationIntent|kanbanFilterQuery|openGlobalTaskDetail|closeGlobalTaskDetail|openMemberProfile|closeMemberProfile|focusTeamSection|clearTeamSectionFocus|setPendingReviewRequest|clearKanbanFilter|openTeamsTab|openTeamTab):/
    );
    expect(teamSlice).not.toMatch(
      /\b(?:createTeamProvisioningControlSlice|createTeamProvisioningLaunchSlice|createTeamProvisioningProgressSlice)(?:<[^;]+?>)?\s*\(/
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
