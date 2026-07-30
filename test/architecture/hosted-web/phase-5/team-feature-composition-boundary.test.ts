import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('desktop team feature composition architecture', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const compositionSource = readFileSync(
    resolve(root, 'src/main/ipc/teamFeatureComposition.ts'),
    'utf8'
  );
  const legacyAdaptersSource = readFileSync(
    resolve(root, 'src/main/ipc/teamLegacyAdapters.ts'),
    'utf8'
  );
  const handlersSource = readFileSync(resolve(root, 'src/main/ipc/handlers.ts'), 'utf8');

  it('keeps composition on public registrar entrypoints and the focused outer ACL', () => {
    const featureImports = [...compositionSource.matchAll(/from '(@features\/[^']+)'/g)].map(
      ([, specifier]) => specifier
    );
    expect(featureImports).toEqual([
      '@features/task-log-observability/main',
      '@features/team-approvals/main',
      '@features/team-configuration/main',
      '@features/team-lifecycle/main',
      '@features/team-message-delivery/main',
      '@features/team-provisioning/main',
      '@features/team-roster-mutations/main',
      '@features/team-runtime-operations/main',
      '@features/team-task-board/main',
      '@features/team-view-read-model/main',
    ]);
    expect(compositionSource).toContain(
      'createDesktopTeamLegacyAdapters,\n  type DesktopTeamLegacyAdapterDependencies,'
    );
    expect(compositionSource.match(/createDesktopTeamLegacyAdapters\(/g)).toHaveLength(1);
    expect(compositionSource).not.toMatch(/\bcreateTeam[A-Z]\w*Feature\(/);
    expect(compositionSource).not.toMatch(
      /TeamDataWorkerClient|EventLoopLagMonitor|LaunchIoGovernor|createLogger/
    );
    expect(compositionSource).not.toMatch(
      /createTeamLifecycleCommandFeature|team-runtime-control|process-supervision|process-recovery|provider-execution|OpenCode/
    );
    expect(compositionSource).not.toMatch(/\b(?:spawn|kill)\s*\(|node:child_process/);
    expect(compositionSource).not.toMatch(/\bas\s+(?:any|never|unknown)\b|export\s+\*/);
  });

  it('contains feature-specific compatibility wiring only in the bounded outer ACL', () => {
    const featureImports = [...legacyAdaptersSource.matchAll(/from '(@features\/[^']+)'/g)].map(
      ([, specifier]) => specifier
    );
    expect(featureImports).toEqual([
      '@features/team-approvals/main',
      '@features/team-configuration/main',
      '@features/team-lifecycle/contracts',
      '@features/team-lifecycle/main',
      '@features/team-message-delivery/contracts',
      '@features/team-message-delivery/main',
      '@features/team-provisioning/main',
      '@features/team-roster-mutations/main',
      '@features/team-runtime-operations/main',
      '@features/team-task-board/main',
      '@features/team-view-read-model/main',
    ]);
    expect(
      featureImports.every((specifier) => /^@features\/[^/]+\/(?:contracts|main)$/.test(specifier))
    ).toBe(true);
    expect(compositionSource).not.toContain("from '../../features/");
    expect(legacyAdaptersSource).not.toContain("from '../../features/");
    for (const factory of [
      'createTeamLifecycleReadIpcFeature',
      'createTeamLifecycleIpcFeature',
      'createApprovalsFeature',
      'createTaskBoardFeature',
      'createViewReadModelFeature',
      'createConfigurationFeature',
      'createDesktopTeamMessageDeliveryFeature',
      'createRosterMutationFeature',
      'createProvisioningFeature',
      'createRuntimeOperationsFeature',
    ]) {
      expect(legacyAdaptersSource, factory).toContain(`${factory}(`);
    }
    expect(legacyAdaptersSource).not.toMatch(
      /createTeamLifecycleCommandFeature|team-runtime-control|process-supervision|process-recovery|provider-execution/
    );
    expect(legacyAdaptersSource).not.toMatch(
      /TeamIpcHandlerApis|TeamProvisioningApis|node:child_process|\bspawn\s*\(/
    );
    expect(legacyAdaptersSource.match(/ipcMain\.handle\(TEAM_PROCESS_/g)).toHaveLength(2);
    expect(legacyAdaptersSource.match(/ipcMain\.removeHandler\(TEAM_PROCESS_/g)).toHaveLength(2);
  });

  it('keeps handlers as the app shell with one create, initialize, register, and remove surface', () => {
    expect(handlersSource.match(/createDesktopTeamFeatureComposition\(/g)).toHaveLength(1);
    expect(
      handlersSource.match(/teamFeatureComposition\.initializeLegacyHandlers\(\)/g)
    ).toHaveLength(1);
    expect(handlersSource.match(/teamFeatureComposition\.register\(ipcMain\)/g)).toHaveLength(1);
    expect(handlersSource.match(/removeDesktopTeamFeatureComposition\(ipcMain\)/g)).toHaveLength(1);
    expect(handlersSource).not.toMatch(
      /(?:create|register|remove)Team(?:Approvals|Configuration|MessageDelivery|Provisioning|RosterMutation|RuntimeOperations|TaskBoard|ViewReadModel)(?:Feature|Ipc)/
    );
    expect(handlersSource).not.toMatch(
      /(?:initialize|register|remove)TeamHandlers|TaskLogObservabilityIpc/
    );
  });

  it('keeps the new production module within the source-size ratchet', () => {
    expect(compositionSource.split(/\r?\n/).length).toBeLessThanOrEqual(800);
    expect(legacyAdaptersSource.split(/\r?\n/).length).toBeLessThanOrEqual(800);
  });
});
