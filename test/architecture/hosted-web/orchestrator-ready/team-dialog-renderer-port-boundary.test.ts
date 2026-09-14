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

  it('preserves independently optional preparation capabilities and exact argument order', () => {
    const preparationTransportSource = source(preparationTransportPath);
    const preparationTransport = preparationTransportSource.replace(/\s+/gu, ' ');
    const exactPrepareProvisioningDelegation = [
      'port.prepareProvisioning = (',
      'cwd, providerId, providerIds, selectedModels, limitContext, modelVerificationMode, selectedModelChecks',
      ') => prepareProvisioning(',
      'cwd, providerId, providerIds, selectedModels, limitContext, modelVerificationMode, selectedModelChecks',
      ')',
    ].join(' ');
    expect(preparationTransport).toContain(exactPrepareProvisioningDelegation);
    expect(preparationTransportSource).toContain(
      "if (typeof prepareProvisioning === 'function') {"
    );
    expect(preparationTransportSource).toContain(
      "if (typeof workspaceTrust?.getProjectStatus === 'function') {"
    );
    expect(preparationTransportSource).toContain(
      'port.getWorkspaceTrustProjectStatus = (request) => workspaceTrust.getProjectStatus(request);'
    );
    expect(preparationTransportSource).not.toContain('return {};');
    expect(preparationTransportSource).toContain('return port;');
  });

  it('preserves optional preparation support in both dialogs', () => {
    for (const path of [createDialogPath, launchDialogPath]) {
      const dialog = source(path);
      expect(dialog, path).toContain(
        'const prepareProvisioning = teamProvisioningPreparationTransport.prepareProvisioning;'
      );
      expect(dialog, path).toContain("typeof prepareProvisioning !== 'function'");
      expect(dialog, path).toContain('prepareProvisioning,');
    }
  });

  it('preserves Edit save ordering while member runtime changes use their dedicated flow', () => {
    const editDialog = source(editDialogPath);
    const updateIndex = editDialog.indexOf('await teamConfigurationTransport.updateConfig');
    const removeIndex = editDialog.indexOf('await teamRosterMutationTransport.remove');
    const replaceIndex = editDialog.indexOf('await teamRosterMutationTransport.replace');

    expect(updateIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(updateIndex);
    expect(replaceIndex).toBeGreaterThan(removeIndex);
    expect(editDialog).not.toContain('teamRuntimeOperationsTransport.restartMember');
    expect(editDialog).not.toContain('effectiveMembersToRestart');
    expect(editDialog).toContain('liveRuntimeRefreshMemberNames');
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
    const requiredRendererExports = [
      [
        'src/features/team-configuration/renderer/index.ts',
        "export type { TeamConfigurationRendererPorts } from './ports/TeamConfigurationRendererPorts';",
      ],
      [
        'src/features/team-provisioning/renderer/index.ts',
        "export type { TeamProvisioningPreparationRendererPorts } from './ports/TeamProvisioningPreparationRendererPorts';",
      ],
    ] as const;
    for (const [path, requiredExport] of requiredRendererExports) {
      const rendererEntrypoint = source(path);
      expect(rendererEntrypoint, path).toContain(requiredExport);
      expect(rendererEntrypoint, path).not.toMatch(
        /team-lifecycle\/(?:core|main|preload)|team-runtime-control|TeamProvisioningService|TeamDataService|child_process|@main\//
      );
    }
  });
});
