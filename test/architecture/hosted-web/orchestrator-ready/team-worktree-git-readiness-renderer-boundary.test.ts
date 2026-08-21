import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const bannerPath = 'src/renderer/components/team/dialogs/WorktreeGitReadinessBanner.tsx';
const hookPath = 'src/features/team-provisioning/renderer/hooks/useWorktreeGitReadiness.ts';
const portPath =
  'src/features/team-provisioning/renderer/ports/TeamWorktreeGitReadinessRendererPorts.ts';
const publicEntryPath = 'src/features/team-provisioning/renderer/index.ts';
const transportPath = 'src/renderer/composition/team/createTeamWorktreeGitReadinessTransport.ts';
const ownedProductionPaths = [
  bannerPath,
  hookPath,
  portPath,
  publicEntryPath,
  transportPath,
] as const;

const expectedTypeExports = [
  'TeamLaunchAnalyticsCoordinatorDependencies',
  'TeamLaunchAnalyticsContext',
  'TeamLaunchParams',
  'TeamListProvisioningLaunchPort',
  'TeamListProvisioningPorts',
  'TeamMemberSettingsDialogBridgeProps',
  'TeamProvisioningControlEffectsPort',
  'TeamProvisioningControlSlice',
  'TeamProvisioningControlSliceDependencies',
  'TeamProvisioningControlStatePort',
  'TeamProvisioningControlStoreState',
  'TeamProvisioningControlTransportPort',
  'TeamProvisioningDiagnosticsRendererPorts',
  'TeamProvisioningLaunchAnalyticsPort',
  'TeamProvisioningLaunchClockPort',
  'TeamProvisioningLaunchControlPort',
  'TeamProvisioningLaunchMessageEntry',
  'TeamProvisioningLaunchPersistencePort',
  'TeamProvisioningLaunchScopePort',
  'TeamProvisioningLaunchSlice',
  'TeamProvisioningLaunchSliceDependencies',
  'TeamProvisioningLaunchStatePort',
  'TeamProvisioningLaunchStoreState',
  'TeamProvisioningLaunchTransportPort',
  'TeamProvisioningPreparationRendererPort',
  'TeamProvisioningPreparationRendererPorts',
  'TeamProvisioningProgressAnalyticsPort',
  'TeamProvisioningProgressRefreshPort',
  'TeamProvisioningProgressRuntimePort',
  'TeamProvisioningProgressSlice',
  'TeamProvisioningProgressSliceDependencies',
  'TeamProvisioningProgressStatePort',
  'TeamProvisioningProgressStoreState',
  'TeamProvisioningRefreshFanoutNote',
  'TeamProvisioningSurfaceSnapshot',
  'TeamRuntimeObservationBackoffPort',
  'TeamRuntimeObservationMemberSpawnPolicyPort',
  'TeamRuntimeObservationRequestScopePort',
  'TeamRuntimeObservationSlice',
  'TeamRuntimeObservationSliceDependencies',
  'TeamRuntimeObservationSnapshotPolicyPort',
  'TeamRuntimeObservationStatePort',
  'TeamRuntimeObservationTransportPort',
  'TeamToolApprovalErrorLogPort',
  'TeamToolApprovalProjectionPort',
  'TeamToolApprovalRendererSlice',
  'TeamToolApprovalRendererSliceActions',
  'TeamToolApprovalRendererSliceDependencies',
  'TeamToolApprovalRendererSliceState',
  'TeamToolApprovalRendererState',
  'TeamToolApprovalRendererStatePort',
  'TeamToolApprovalRendererTransportPort',
  'TeamToolApprovalResponseTransportPort',
  'TeamToolApprovalSettingsLoadPort',
  'TeamToolApprovalSettingsSyncPort',
  'TeamWorktreeGitReadinessRendererPorts',
  'WorktreeGitReadinessState',
] as const;

const expectedValueExports = [
  'TeamMemberSettingsDialogBridge',
  'TeamRuntimeFreshnessCoordinator',
  'areTeamLaunchParamsEqual',
  'buildLaunchParamsFromRuntimeRequest',
  'createProductTeamLaunchAnalyticsCoordinator',
  'createTeamListProvisioningPorts',
  'createTeamMemberSettingsRendererApi',
  'createTeamProvisioningControlSlice',
  'createTeamProvisioningLaunchSlice',
  'createTeamProvisioningProgressSlice',
  'createTeamRuntimeObservationSlice',
  'createTeamToolApprovalRendererSlice',
  'extractBaseModel',
  'loadTeamToolApprovalSettingsIntoRenderer',
  'normalizePersistedTeamLaunchParams',
  'useWorktreeGitReadiness',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
  );
}

function publicExportShape(path: string): {
  unsupported: string[];
  typeExports: string[];
  valueExports: string[];
} {
  const sourceFile = ts.createSourceFile(
    path,
    source(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const typeExports: string[] = [];
  const valueExports: string[] = [];
  const unsupported: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        unsupported.push(statement.getText(sourceFile));
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const target = statement.isTypeOnly || element.isTypeOnly ? typeExports : valueExports;
        target.push(element.name.text);
      }
      continue;
    }

    if (!hasExportModifier(statement)) {
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      typeExports.push(statement.name.text);
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      valueExports.push(statement.name.text);
    } else {
      unsupported.push(statement.getText(sourceFile));
    }
  }

  return {
    unsupported,
    typeExports: typeExports.sort(),
    valueExports: valueExports.sort(),
  };
}

describe('team worktree Git readiness renderer boundary', () => {
  it('ratchets the banner, hook, and port to zero direct team or Electron API access', () => {
    for (const path of [bannerPath, hookPath, portPath]) {
      const contents = source(path);
      expect(contents, path).not.toMatch(
        /@renderer\/api|\bapi\.teams\b|window\.electronAPI|ElectronAPI/
      );
    }

    const banner = source(bannerPath);
    expect(banner).toContain("from '@features/team-provisioning/renderer'");
    expect(banner).toContain(
      "from '@renderer/composition/team/createTeamWorktreeGitReadinessTransport'"
    );
    expect(banner).not.toMatch(/@features\/team-provisioning\/renderer\/(?:hooks|ports)\//);
  });

  it('keeps the feature port provider, process, lifecycle, transport, and store neutral', () => {
    const port = source(portPath);
    const forbiddenSurface =
      /@renderer\/|Electron|window\.|api\.|provider|OpenCode|opencode|Claude|child_process|renderer\/store|team-runtime-control|lifecycle/i;

    expect(port).not.toMatch(forbiddenSurface);
    expect(port).toContain('export interface TeamWorktreeGitReadinessRendererPorts');
    expect(port).toContain('getStatus(projectPath: string)');
    expect(port).toContain('initialize(projectPath: string)');
    expect(port).toContain('createInitialCommit(projectPath: string)');
  });

  it('confines all three legacy team API mappings to the outer renderer transport', () => {
    const transport = source(transportPath);
    const sourcesByPath = Object.fromEntries(
      ownedProductionPaths.map((path) => [path, source(path)])
    );
    const legacyMethods = [
      'getWorktreeGitStatus',
      'initializeGitRepository',
      'createInitialGitCommit',
    ] as const;

    expect(transport).toContain("from '@renderer/api'");
    expect(transport.match(/\bapi\.teams\b/g) ?? []).toHaveLength(3);
    expect(transport).not.toMatch(
      /window\.electronAPI|renderer\/store|child_process|team-runtime-control|lifecycle/i
    );
    for (const method of legacyMethods) {
      expect(transport.match(new RegExp(`\\bapi\\.teams\\.${method}\\b`, 'g')) ?? []).toHaveLength(
        1
      );
      expect(
        Object.entries(sourcesByPath)
          .filter(([, contents]) => contents.includes(method))
          .map(([path]) => path)
      ).toEqual([transportPath]);
    }
  });

  it('keeps request orchestration in the injected feature hook without a new owner', () => {
    const hook = source(hookPath);

    expect(hook).toContain('ports.getStatus(scope.projectPath)');
    expect(hook).toContain('ports.initialize(activePath)');
    expect(hook).toContain('ports.createInitialCommit(activePath)');
    expect(hook).toContain('requestSequenceRef.current === token.id');
    expect(hook).not.toMatch(
      /TeamProvisioningService|renderer\/store|child_process|team-runtime-control|createTeamLifecycle/i
    );
  });

  it('freezes the complete team-provisioning renderer public entrypoint', () => {
    expect(publicExportShape(publicEntryPath)).toEqual({
      unsupported: [],
      typeExports: [...expectedTypeExports].sort(),
      valueExports: [...expectedValueExports].sort(),
    });
  });
});
