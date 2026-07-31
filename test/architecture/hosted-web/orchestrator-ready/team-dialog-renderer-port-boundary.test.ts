import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const createDialogPath = 'src/renderer/components/team/dialogs/CreateTeamDialog.tsx';
const editDialogPath = 'src/renderer/components/team/dialogs/EditTeamDialog.tsx';
const launchDialogPath = 'src/renderer/components/team/dialogs/LaunchTeamDialog.tsx';
const dialogPaths = [createDialogPath, editDialogPath, launchDialogPath] as const;
const configurationPortPath =
  'src/features/team-configuration/renderer/ports/TeamConfigurationRendererPorts.ts';
const preparationPortPath =
  'src/features/team-provisioning/renderer/ports/TeamProvisioningPreparationRendererPorts.ts';
const rosterPortPath =
  'src/features/team-roster-mutations/renderer/ports/TeamRosterMutationRendererPorts.ts';
const configurationTransportPath =
  'src/renderer/composition/team/createTeamConfigurationTransport.ts';
const preparationTransportPath =
  'src/renderer/composition/team/createTeamProvisioningPreparationTransport.ts';
const rosterTransportPath = 'src/renderer/composition/team/createTeamRosterMutationTransport.ts';
const runtimeTransportPath =
  'src/renderer/composition/team/createTeamRuntimeOperationsTransport.ts';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function interfaceMethods(path: string, interfaceName: string): string[] {
  const body = source(path).match(
    new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`)
  )?.[1];
  if (!body) return [];
  return Array.from(body.matchAll(/^\s{2}([a-z]\w*)(?:\?)?(?::\s*)?\(/gmu), (match) => match[1]);
}

describe('team dialog renderer port boundary', () => {
  it('ratchets all three dialogs to zero direct team API calls', () => {
    for (const path of dialogPaths) {
      expect(source(path), path).not.toMatch(/\bapi\.teams\b|window\.electronAPI\.teams/);
      expect(source(path), path).not.toMatch(
        /@features\/[^'"]+\/renderer\/(?:adapters|composition|ports)\//
      );
    }

    expect(source(createDialogPath)).toContain('teamConfigurationTransport.createConfig({');
    expect(source(editDialogPath)).toContain('teamConfigurationTransport.updateConfig(teamName, {');
    expect(source(launchDialogPath)).toContain(
      'teamConfigurationTransport.getSavedRequest(effectiveTeamName)'
    );
  });

  it('keeps configuration and preparation ports narrow and provider-specific-runtime free', () => {
    expect(interfaceMethods(configurationPortPath, 'TeamConfigurationRendererPorts')).toEqual([
      'createConfig',
      'getSavedRequest',
      'updateConfig',
    ]);
    expect(
      interfaceMethods(preparationPortPath, 'TeamProvisioningPreparationRendererPorts')
    ).toEqual(['prepareProvisioning']);
    expect(interfaceMethods(rosterPortPath, 'TeamRosterMutationRendererTransportPort')).toEqual([
      'add',
      'remove',
      'replace',
      'restore',
      'updateRole',
    ]);

    for (const path of [configurationPortPath, preparationPortPath, rosterPortPath]) {
      expect(source(path), path).not.toMatch(
        /@renderer\/|window\.|api\.|Electron|OpenCode|opencode|Anthropic|Claude|Codex|child_process|team-runtime-control|team-lifecycle|TeamDataService/
      );
    }
  });

  it('confines the migrated raw calls to delegating outer composition adapters', () => {
    const configurationTransport = source(configurationTransportPath);
    const preparationTransport = source(preparationTransportPath);
    const rosterTransport = source(rosterTransportPath);
    const runtimeTransport = source(runtimeTransportPath);

    for (const path of [
      configurationTransportPath,
      preparationTransportPath,
      rosterTransportPath,
      runtimeTransportPath,
    ]) {
      expect(source(path), path).toContain("from '@renderer/api'");
      expect(source(path), path).not.toMatch(
        /window\.electronAPI|@main\/|child_process|team-runtime-control/
      );
    }
    expect(configurationTransport.match(/\bapi\.teams\b/g) ?? []).toHaveLength(3);
    expect(configurationTransport).toContain('api.teams.createConfig(request)');
    expect(configurationTransport).toContain('api.teams.getSavedRequest(teamName)');
    expect(configurationTransport).toContain('api.teams.updateConfig(teamName, updates)');
    expect(preparationTransport.match(/\bapi\.teams\b/g) ?? []).toHaveLength(1);
    expect(preparationTransport).toContain('api.teams.prepareProvisioning');
    expect(rosterTransport).toContain('api.teams.replaceMembers(teamName, request)');
    expect(runtimeTransport).toContain('api.teams.restartMember(teamName, memberName)');
  });

  it('preserves optional preparation support and exact argument order in both dialogs', () => {
    const preparationTransport = source(preparationTransportPath).replace(/\s+/gu, ' ');
    expect(preparationTransport).toContain(
      'prepareProvisioning( cwd, providerId, providerIds, selectedModels, limitContext, modelVerificationMode, selectedModelChecks )'
    );
    expect(source(preparationTransportPath)).toMatch(
      /typeof prepareProvisioning !== 'function'[\s\S]*return \{\}/
    );

    for (const path of [createDialogPath, launchDialogPath]) {
      const dialog = source(path);
      expect(dialog, path).toContain(
        'const prepareProvisioning = teamProvisioningPreparationTransport.prepareProvisioning;'
      );
      expect(dialog, path).toContain("typeof prepareProvisioning !== 'function'");
      expect(dialog, path).toContain('prepareProvisioning,');
    }
  });

  it('preserves Edit save ordering and its per-member restart error collection', () => {
    const editDialog = source(editDialogPath);
    const updateIndex = editDialog.indexOf('await teamConfigurationTransport.updateConfig');
    const removeIndex = editDialog.indexOf('await teamRosterMutationTransport.remove');
    const replaceIndex = editDialog.indexOf('await teamRosterMutationTransport.replace');
    const restartIndex = editDialog.indexOf('await teamRuntimeOperationsTransport.restartMember');

    expect(updateIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(updateIndex);
    expect(replaceIndex).toBeGreaterThan(removeIndex);
    expect(restartIndex).toBeGreaterThan(replaceIndex);
    expect(editDialog).toMatch(
      /for \(const memberName of effectiveMembersToRestart\)[\s\S]*try \{[\s\S]*await teamRuntimeOperationsTransport\.restartMember\(teamName, memberName\);[\s\S]*catch \(restartError\)[\s\S]*restartFailures\.push/
    );
  });

  it('does not activate lifecycle-command or runtime-control ownership', () => {
    const ownedProductionBoundary = [
      ...dialogPaths,
      configurationPortPath,
      preparationPortPath,
      rosterPortPath,
      configurationTransportPath,
      preparationTransportPath,
      rosterTransportPath,
    ]
      .map(source)
      .join('\n');

    expect(ownedProductionBoundary).not.toMatch(
      /team-lifecycle\/(?:core|main|preload)|team-runtime-control|createTeamLifecycleCommandFeature|TeamProvisioningService|TeamDataService/
    );
    expect(source('src/features/team-configuration/renderer/index.ts').trim()).toBe(
      "export type { TeamConfigurationRendererPorts } from './ports/TeamConfigurationRendererPorts';"
    );
    expect(source('src/features/team-provisioning/renderer/index.ts')).toContain(
      "export type { TeamProvisioningPreparationRendererPorts } from './ports/TeamProvisioningPreparationRendererPorts';"
    );
  });
});
