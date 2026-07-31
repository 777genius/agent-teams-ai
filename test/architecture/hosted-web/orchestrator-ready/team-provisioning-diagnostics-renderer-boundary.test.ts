import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const progressConsumerPath = 'src/renderer/components/team/ProvisioningProgressBlock.tsx';
const validationConsumerPath = 'src/renderer/components/team/dialogs/AdvancedCliSection.tsx';
const statsConsumerPath = 'src/renderer/hooks/useMemberStats.ts';
const portPath =
  'src/features/team-provisioning/renderer/ports/TeamProvisioningDiagnosticsRendererPorts.ts';
const publicEntryPath = 'src/features/team-provisioning/renderer/index.ts';
const diagnosticsTransportPath =
  'src/renderer/composition/team/createTeamProvisioningDiagnosticsTransport.ts';

const expectedTypeExports = [
  'TeamLaunchAnalyticsContext',
  'TeamLaunchParams',
  'TeamListProvisioningLaunchPort',
  'TeamListProvisioningPorts',
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
  'TeamRuntimeFreshnessCoordinator',
  'areTeamLaunchParamsEqual',
  'buildLaunchParamsFromRuntimeRequest',
  'createProductTeamLaunchAnalyticsCoordinator',
  'createTeamListProvisioningPorts',
  'createTeamProvisioningControlSlice',
  'createTeamProvisioningLaunchPersistence',
  'createTeamProvisioningLaunchSlice',
  'createTeamProvisioningLaunchTransport',
  'createTeamProvisioningProgressSlice',
  'createTeamRuntimeObservationSlice',
  'createTeamToolApprovalRendererSlice',
  'extractBaseModel',
  'loadAllTeamLaunchParams',
  'loadTeamToolApprovalSettingsIntoRenderer',
  'normalizePersistedTeamLaunchParams',
  'saveTeamLaunchParams',
  'saveTeamToolApprovalSettings',
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

describe('team provisioning diagnostics renderer boundary', () => {
  it('ratchets all three consumers to zero direct team or Electron API access', () => {
    for (const path of [progressConsumerPath, validationConsumerPath, statsConsumerPath]) {
      const contents = source(path);
      expect(contents, path).not.toMatch(
        /@renderer\/api|\bapi\.teams\b|window\.electronAPI|ElectronAPI/
      );
    }

    expect(source(progressConsumerPath)).toContain(
      'teamProvisioningDiagnosticsTransport.getLaunchFailureDiagnostics(teamName, runId)'
    );
    expect(source(validationConsumerPath)).toContain(
      'teamProvisioningDiagnosticsTransport.validateCliArgs(customArgs)'
    );
    expect(source(statsConsumerPath)).toContain(
      'teamOperationalReadTransport.readMemberStats(teamName, memberName)'
    );
  });

  it('keeps the diagnostics port focused and provider, process, and lifecycle neutral', () => {
    const port = source(portPath);

    expect(port).toContain('export interface TeamProvisioningDiagnosticsRendererPorts');
    expect(port).toContain('getLaunchFailureDiagnostics(');
    expect(port).toContain('validateCliArgs(rawArgs: string)');
    expect(port.match(/^\s{2}[a-z]\w*\(/gm) ?? []).toHaveLength(2);
    expect(port).not.toMatch(
      /@renderer\/|Electron|window\.|api\.|provider|OpenCode|opencode|Claude|Anthropic|child_process|renderer\/store|orchestrat|process|lifecycle|spawn|stop|restart|kill/i
    );
  });

  it('confines both legacy diagnostics calls to the delegating outer transport', () => {
    const transport = source(diagnosticsTransportPath);
    const nonTransportBoundary = [
      source(progressConsumerPath),
      source(validationConsumerPath),
      source(statsConsumerPath),
      source(portPath),
    ].join('\n');

    expect(transport).toContain("from '@renderer/api'");
    expect(transport).toContain("from '@features/team-provisioning/renderer'");
    expect(transport.match(/\bapi\.teams\b/g) ?? []).toHaveLength(2);
    expect(transport).toContain('api.teams.getLaunchFailureDiagnostics(teamName, runId)');
    expect(transport).toContain('api.teams.validateCliArgs(rawArgs)');
    expect(transport).not.toMatch(
      /window\.electronAPI|renderer\/store|child_process|try\s*{|catch\s*\(|await\s+|unwrapIpc|orchestrat|lifecycle/i
    );
    expect(nonTransportBoundary).not.toMatch(/\bapi\.teams\b|window\.electronAPI/);
    expect(source(statsConsumerPath)).not.toMatch(/\bgetMemberStats\b/);
  });

  it('keeps production consumers and composition on public feature entrypoints', () => {
    for (const path of [
      progressConsumerPath,
      validationConsumerPath,
      statsConsumerPath,
      diagnosticsTransportPath,
    ]) {
      expect(source(path), path).not.toMatch(
        /@features\/team-provisioning\/renderer\/(?:ports|adapters|composition|hooks|utils)\//
      );
    }

    expect(source(progressConsumerPath)).toContain(
      "from '@renderer/composition/team/createTeamProvisioningDiagnosticsTransport'"
    );
    expect(source(validationConsumerPath)).toContain(
      "from '@renderer/composition/team/createTeamProvisioningDiagnosticsTransport'"
    );
    expect(source(statsConsumerPath)).toContain(
      "from '@renderer/composition/team/createTeamOperationalReadTransport'"
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
