import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
const directTransportCall = /\bapi\.(?:teams|crossTeam)\b/;
const legacyCompositionPaths = [
  'src/renderer/store/slices/teamSlice.ts',
  'src/renderer/store/team/createTeamCollaborationDataSlice.ts',
  'src/renderer/store/team/teamGlobalTaskNotifications.ts',
  'src/renderer/store/team/teamToolApprovalSettingsSync.ts',
] as const;
const concreteTransportPaths = [
  'src/features/team-lifecycle/renderer/composition/createTeamLifecycleMutationTransport.ts',
  'src/features/team-provisioning/renderer/composition/createTeamToolApprovalTransport.ts',
  'src/features/team-message-delivery/renderer/composition/createTeamMessageDeliveryTransport.ts',
  'src/features/team-task-board/renderer/composition/createTeamNotificationTransport.ts',
  'src/features/team-roster-mutations/renderer/composition/createTeamRosterMutationTransport.ts',
  'src/features/team-runtime-operations/renderer/composition/createTeamRuntimeOperationsTransport.ts',
] as const;
const transportFreeFeaturePaths = [
  'src/features/team-message-delivery/renderer/adapters/createTeamMessageDeliveryRendererSlice.ts',
  'src/features/team-message-delivery/renderer/ports/TeamMessageDeliveryRendererPorts.ts',
  'src/features/team-roster-mutations/renderer/composition/createTeamRosterMutationRendererSlice.ts',
  'src/features/team-roster-mutations/renderer/ports/TeamRosterMutationRendererPorts.ts',
  'src/features/team-runtime-operations/renderer/composition/createTeamRuntimeOperationsRendererSlice.ts',
  'src/features/team-runtime-operations/renderer/ports/TeamRuntimeOperationsRendererPorts.ts',
] as const;

describe('team renderer port boundaries', () => {
  it('removes direct team transports from legacy store composition', () => {
    for (const path of legacyCompositionPaths) {
      expect(source(path), path).not.toMatch(directTransportCall);
    }
  });

  it('isolates direct API access to feature-owned renderer composition', () => {
    for (const path of concreteTransportPaths) {
      const contents = source(path);
      expect(contents, path).toContain("from '@renderer/api'");
      expect(contents, path).toMatch(directTransportCall);
      expect(contents, path).not.toMatch(/window\.electronAPI|ElectronAPI|renderer\/store/);
    }
    for (const path of transportFreeFeaturePaths) {
      expect(source(path), path).not.toMatch(
        /@renderer\/api|window\.electronAPI|ElectronAPI|\bapi\.(?:teams|crossTeam)\b/
      );
    }
  });

  it('keeps roster and runtime orchestration in focused feature slices', () => {
    const teamSlice = source(legacyCompositionPaths[0]);
    expect(teamSlice).toContain('createTeamRosterMutationRendererSlice({');
    expect(teamSlice).toContain('createTeamRuntimeOperationsRendererSlice({');
    expect(teamSlice).not.toMatch(/addMember:\s*async|restartMember:\s*async/);
    expect(teamSlice.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(650);
  });

  it('does not widen lifecycle or runtime ownership', () => {
    const ownedSources = [...legacyCompositionPaths, ...concreteTransportPaths]
      .map(source)
      .join('\n');
    const runtimePorts = source(
      'src/features/team-runtime-operations/renderer/ports/TeamRuntimeOperationsRendererPorts.ts'
    );

    expect(ownedSources).not.toMatch(
      /createTeamLifecycleCommandFeature|team-runtime-control|TeamProvisioningService/
    );
    expect(runtimePorts).toContain('retryFailedSecondaryLanes(');
    expect(runtimePorts).not.toMatch(
      /TeamRuntimeOperationsRendererTransportPort[\s\S]*retryFailedOpenCodeSecondaryLanes\(/
    );
  });
});
