import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
const sourceFilesUnder = (path: string): string[] =>
  readdirSync(join(process.cwd(), path), { withFileTypes: true }).flatMap((entry) => {
    const childPath = `${path}/${entry.name}`;
    if (entry.isDirectory()) return sourceFilesUnder(childPath);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [childPath] : [];
  });
const directTransportCall = /\bapi\.(?:teams|crossTeam)\b/;
const legacyCompositionPaths = [
  'src/renderer/store/slices/teamSlice.ts',
  'src/renderer/store/team/createTeamStoreFeatureSlices.ts',
  'src/renderer/store/team/createTeamCollaborationDataSlice.ts',
  'src/renderer/store/team/teamGlobalTaskNotifications.ts',
  'src/renderer/store/team/teamToolApprovalSettingsSync.ts',
] as const;
const concreteTransportPaths = [
  'src/renderer/composition/team/createTaskLogObservabilityRendererTransport.ts',
  'src/renderer/composition/team/createTeamLifecycleMutationTransport.ts',
  'src/renderer/composition/team/createTeamMessageDeliveryTransport.ts',
  'src/renderer/composition/team/createTeamNotificationTransport.ts',
  'src/renderer/composition/team/createTeamRosterMutationTransport.ts',
  'src/renderer/composition/team/createTeamRuntimeObservationTransport.ts',
  'src/renderer/composition/team/createTeamRuntimeOperationsTransport.ts',
  'src/renderer/composition/team/createTeamToolApprovalTransport.ts',
] as const;
const taskLogComponentPaths = [
  'src/renderer/components/team/taskLogs/ExactTaskLogsSection.tsx',
  'src/renderer/components/team/taskLogs/TaskActivitySection.tsx',
  'src/renderer/components/team/taskLogs/TaskLogStreamSection.tsx',
  'src/renderer/components/team/taskLogs/TaskLogsPanel.tsx',
] as const;
const legacyTransportFreeFeaturePaths = [
  'src/features/team-message-delivery/renderer/composition/createTeamMessageDeliveryRendererSlice.ts',
  'src/features/team-provisioning/renderer/adapters/createTeamRuntimeObservationSlice.ts',
  'src/features/team-message-delivery/renderer/ports/TeamMessageDeliveryRendererPorts.ts',
] as const;
const featureOwnedRendererBoundaryRoots = [
  'src/features/team-provisioning/renderer/composition',
  'src/features/team-provisioning/renderer/ports',
  'src/features/team-roster-mutations/renderer/composition',
  'src/features/team-roster-mutations/renderer/ports',
  'src/features/team-runtime-operations/renderer/composition',
  'src/features/team-runtime-operations/renderer/ports',
  'src/features/team-view-read-model/renderer/composition',
  'src/features/team-view-read-model/renderer/ports',
] as const;
const featureOwnedRendererBoundaryPaths =
  featureOwnedRendererBoundaryRoots.flatMap(sourceFilesUnder);
const explicitFeatureTransportAdapterPaths = [
  'src/features/team-provisioning/renderer/adapters/createTeamProvisioningControlTransport.ts',
  'src/features/team-provisioning/renderer/adapters/createTeamProvisioningLaunchTransport.ts',
  'src/features/team-view-read-model/renderer/adapters/createTeamDirectoryTransport.ts',
  'src/features/team-view-read-model/renderer/adapters/createTeamMessageFeedTransport.ts',
  'src/features/team-view-read-model/renderer/adapters/createTeamViewDataTransport.ts',
] as const;

describe('team renderer port boundaries', () => {
  it('removes direct team transports from legacy store composition', () => {
    for (const path of legacyCompositionPaths) {
      expect(source(path), path).not.toMatch(directTransportCall);
    }
  });

  it('isolates direct API access to outer renderer composition', () => {
    for (const path of concreteTransportPaths) {
      const contents = source(path);
      expect(contents, path).toContain("from '@renderer/api'");
      expect(contents, path).toMatch(directTransportCall);
      expect(contents, path).not.toMatch(/window\.electronAPI|ElectronAPI|renderer\/store/);
    }
    for (const path of legacyTransportFreeFeaturePaths) {
      expect(source(path), path).not.toMatch(
        /@renderer\/api|@renderer\/store|renderer\/store|window\.electronAPI|ElectronAPI|\bapi\.(?:teams|crossTeam)\b/
      );
    }
    for (const path of featureOwnedRendererBoundaryPaths) {
      expect(source(path), path).not.toMatch(
        /@renderer\/|renderer\/store|window\.electronAPI|ElectronAPI|\bapi\.(?:teams|crossTeam)\b/
      );
    }
    for (const path of explicitFeatureTransportAdapterPaths) {
      const contents = source(path);
      expect(contents, path).toContain("from '@renderer/api'");
      expect(contents, path).toMatch(directTransportCall);
      expect(contents, path).not.toMatch(/window\.electronAPI|ElectronAPI|renderer\/store/);
    }
  });

  it('keeps the concrete tool-approval transport only in outer renderer composition', () => {
    const outerTransportPath = 'src/renderer/composition/team/createTeamToolApprovalTransport.ts';
    const factoryDeclaration =
      /\b(?:function\s+createTeamToolApprovalTransport\s*\(|(?:const|let|var)\s+createTeamToolApprovalTransport\s*=)/;

    expect(source(outerTransportPath)).toMatch(factoryDeclaration);
    expect(sourceFilesUnder('src').filter((path) => factoryDeclaration.test(source(path)))).toEqual(
      [outerTransportPath]
    );
  });

  it('keeps the concrete runtime-observation transport only in outer renderer composition', () => {
    const outerTransportPath =
      'src/renderer/composition/team/createTeamRuntimeObservationTransport.ts';
    const storeCompositionOwnerPath = 'src/renderer/store/team/createTeamStoreFeatureSlices.ts';
    const lifecycleCoordinatorPath = 'src/renderer/store/team/TeamStateLifecycleCoordinator.ts';
    const runtimeObservationSliceContractPaths = [
      'src/features/team-provisioning/renderer/adapters/createTeamRuntimeObservationSlice.ts',
      'src/features/team-provisioning/renderer/index.ts',
    ] as const;
    const factoryDeclaration =
      /\b(?:function\s+createTeamRuntimeObservationTransport\s*\(|(?:const|let|var)\s+createTeamRuntimeObservationTransport\s*=)/;
    const factoryReference = /\bcreateTeamRuntimeObservationTransport\b/;
    const requiredTransportProperty = /\btransport:\s*TeamRuntimeObservationTransportPort\s*;/;
    const optionalTransportProperty = /\btransport\?\s*:\s*TeamRuntimeObservationTransportPort\s*;/;
    const storeCompositionOwner = source(storeCompositionOwnerPath);

    expect(source(outerTransportPath)).toMatch(factoryDeclaration);
    expect(sourceFilesUnder('src').filter((path) => factoryDeclaration.test(source(path)))).toEqual(
      [outerTransportPath]
    );
    expect(storeCompositionOwner, storeCompositionOwnerPath).toContain(
      "from '@renderer/composition/team/createTeamRuntimeObservationTransport'"
    );
    expect(storeCompositionOwner, storeCompositionOwnerPath).toContain(
      'const teamRuntimeObservationTransport = createTeamRuntimeObservationTransport();'
    );
    expect(storeCompositionOwner, storeCompositionOwnerPath).toMatch(
      /new stateLifecycle\.TeamStateLifecycleCoordinator\(\s*teamDirectoryRefreshCoordinator,\s*teamRuntimeObservationTransport\s*\)/
    );
    expect(
      sourceFilesUnder('src/renderer/store').filter((path) => factoryReference.test(source(path)))
    ).toEqual([storeCompositionOwnerPath]);
    expect(source(lifecycleCoordinatorPath), lifecycleCoordinatorPath).toContain(
      'private readonly runtimeObservationTransport: TeamRuntimeObservationTransportPort'
    );
    expect(source(lifecycleCoordinatorPath), lifecycleCoordinatorPath).not.toMatch(
      /runtimeObservationTransport\s*:\s*TeamRuntimeObservationTransportPort\s*=/
    );
    for (const path of runtimeObservationSliceContractPaths) {
      const contents = source(path);
      expect(contents, path).toMatch(requiredTransportProperty);
      expect(contents, path).not.toMatch(optionalTransportProperty);
    }
  });

  it('routes task-log components through outer renderer composition', () => {
    for (const path of taskLogComponentPaths) {
      const contents = source(path);
      expect(contents, path).toContain(
        "from '@renderer/composition/team/createTaskLogObservabilityRendererTransport'"
      );
      expect(contents, path).not.toMatch(
        /@renderer\/api|window\.electronAPI|ElectronAPI|\bapi\.teams\b/
      );
    }
  });

  it('keeps roster and runtime orchestration in focused feature slices', () => {
    const teamSlice = source(legacyCompositionPaths[0]);
    const featureSlices = source(legacyCompositionPaths[1]);
    expect(teamSlice).toContain('createTeamStoreFeatureSlices(set, get, store)');
    expect(teamSlice).not.toContain('createTeamRosterMutationRendererSlice({');
    expect(teamSlice).not.toContain('createTeamRuntimeOperationsRendererSlice({');
    expect(featureSlices).toContain('createTeamRosterMutationRendererSlice({');
    expect(featureSlices).toContain('createTeamRuntimeOperationsRendererSlice({');
    expect(teamSlice).not.toMatch(/addMember:\s*async|restartMember:\s*async/);
    expect(teamSlice.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(60);
  });

  it('keeps extracted renderer slices generic and free of unrelated ownership', () => {
    const extractedSlicePaths = [
      'src/features/team-provisioning/renderer/composition/createTeamToolApprovalRendererSlice.ts',
      'src/features/team-view-read-model/renderer/composition/createTeamViewPreferencesRendererSlice.ts',
    ] as const;

    for (const path of extractedSlicePaths) {
      const contents = source(path);
      const normalizedContents = contents.toLowerCase();
      expect(contents, path).toMatch(/StoreState extends/);
      expect(normalizedContents.split(/[^a-z0-9_]+/u), path).not.toContain('appstate');
      for (const forbiddenFragment of [
        'teamprovisioningservice',
        'provider',
        'runtime',
        'lifecycle',
        'electron',
      ]) {
        expect(normalizedContents, path).not.toContain(forbiddenFragment);
      }
      expect(
        contents.split('\n').some((line) => {
          const trimmedLine = line.trimStart().toLowerCase();
          const characterAfterLet = trimmedLine[3];
          return trimmedLine.startsWith('let') && characterAfterLet?.trim() === '';
        }),
        path
      ).toBe(false);
    }
  });

  it('does not widen lifecycle or runtime ownership', () => {
    const ownedSources = [
      ...legacyCompositionPaths,
      ...concreteTransportPaths,
      ...taskLogComponentPaths,
    ]
      .map(source)
      .join('\n');
    const runtimePorts = source(
      'src/features/team-runtime-operations/renderer/ports/TeamRuntimeOperationsRendererPorts.ts'
    );

    expect(ownedSources).not.toMatch(
      /createTeamLifecycleCommandFeature|team-runtime-control|TeamProvisioningService/
    );
    expect(runtimePorts).toContain('retryFailedSecondaryLanes(');
    expect(runtimePorts).toContain('retryFailedRuntimeLanes(');
    for (const path of [
      'src/features/team-message-delivery/renderer/ports/TeamMessageDeliveryRendererPorts.ts',
      'src/features/team-runtime-operations/renderer/ports/TeamRuntimeOperationsRendererPorts.ts',
      'src/features/team-runtime-operations/renderer/composition/createTeamRuntimeOperationsRendererSlice.ts',
    ]) {
      expect(source(path), path).not.toMatch(/OpenCode|opencode|Claude/);
    }
    expect(runtimePorts).not.toMatch(
      /TeamRuntimeOperationsRendererTransportPort[\s\S]*retryFailedOpenCodeSecondaryLanes\(/
    );
  });
});
