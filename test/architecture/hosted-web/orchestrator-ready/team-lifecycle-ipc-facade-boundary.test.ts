import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const HANDLERS_PATH = 'src/main/ipc/handlers.ts';
const TEAMS_PATH = 'src/main/ipc/teams.ts';
const COMPOSITION_PATH = 'src/main/ipc/teamFeatureComposition.ts';
const LEGACY_ADAPTERS_PATH = 'src/main/ipc/teamLegacyAdapters.ts';
const FACADE_PATH = 'src/features/team-lifecycle/main/adapters/input/ipc/TeamLifecycleIpcFacade.ts';
const FACTORY_PATH =
  'src/features/team-lifecycle/main/adapters/input/ipc/createTeamLifecycleIpcFacade.ts';
const PORTS_PATH = 'src/features/team-lifecycle/core/application/ports/TeamLifecycleIpcPorts.ts';
const FEATURE_COMPOSITION_PATH =
  'src/features/team-lifecycle/main/composition/createTeamLifecycleIpcFeature.ts';
const ENTRYPOINT_PATH = 'src/features/team-lifecycle/main/index.ts';

const readSource = (path: string): string =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled repository-relative architecture-test paths
  readFileSync(resolve(ROOT, path), 'utf8');

function readTypeScriptSources(directory: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- recursive scan is rooted at the controlled src/main path
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readTypeScriptSources(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name)
      ? [
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from the controlled src/main scan
          readFileSync(path, 'utf8'),
        ]
      : [];
  });
}

const handlersSource = readSource(HANDLERS_PATH);
const teamsSource = readSource(TEAMS_PATH);
const compositionSource = readSource(COMPOSITION_PATH);
const legacyAdaptersSource = readSource(LEGACY_ADAPTERS_PATH);
const facadeSource = readSource(FACADE_PATH);
const factorySource = readSource(FACTORY_PATH);
const portsSource = readSource(PORTS_PATH);
const featureCompositionSource = readSource(FEATURE_COMPOSITION_PATH);
const entrypointSource = readSource(ENTRYPOINT_PATH);
const mainSources = readTypeScriptSources(resolve(ROOT, 'src/main'));

describe('team lifecycle IPC facade boundary', () => {
  it('makes the feature input adapter validate, register, and delegate one atomic command', () => {
    expect(portsSource).toContain('interface TeamLifecycleAtomicCommandPort');
    expect(portsSource).toContain('interface TeamLifecycleIpcHandlerPort');
    expect(portsSource).toContain('interface TeamLifecycleIpcRegistrar');
    expect(portsSource).toContain('interface TeamLifecycleIpcResult');
    expect(facadeSource).toContain('this.dependencies.validateTeamName(teamName)');
    expect(facadeSource).toContain('await this.dependencies.commands[operation](validated.value!)');
    expect(factorySource).toContain('ipcMain.handle(TEAM_DELETE_TEAM_CHANNEL');
    expect(factorySource).toContain('facade.deleteTeam(event, teamName)');
    expect(factorySource).toContain('ipcMain.handle(TEAM_RESTORE_CHANNEL');
    expect(factorySource).toContain('facade.restoreTeam(event, teamName)');
    expect(factorySource).toContain('ipcMain.handle(TEAM_PERMANENTLY_DELETE_CHANNEL');
    expect(factorySource).toContain('facade.permanentlyDeleteTeam(event, teamName)');
    expect(featureCompositionSource).toContain('createTeamLifecycleIpcFacade(dependencies)');
    expect(featureCompositionSource).toContain('registerTeamLifecycleIpcAdapter(ipcMain, feature)');
    expect(featureCompositionSource).toContain('removeTeamLifecycleIpcAdapter(ipcMain)');
    expect(entrypointSource).toContain("from './composition/createTeamLifecycleIpcFeature'");
    expect(entrypointSource).toContain("from '../core/application/ports/TeamLifecycleIpcPorts'");
    expect(entrypointSource).not.toContain("from './adapters/input/ipc");
    expect(entrypointSource).not.toContain('createTeamLifecycleIpcFacade');
    expect(entrypointSource).not.toContain('TeamLifecycleIpcFacade');
    expect(portsSource).not.toMatch(/@main|@preload|electron|adapters|infrastructure/);
    expect(portsSource).not.toMatch(/^import\s/m);
  });

  it('keeps legacy multi-step sequencing in an explicit compatibility ACL', () => {
    expect(legacyAdaptersSource).toContain('function createLegacyTeamLifecycleCommandAcl(');
    expect(legacyAdaptersSource).toContain('const lifecycle = createTeamLifecycleIpcFeature({');
    expect(legacyAdaptersSource).toContain(
      'commands: createLegacyTeamLifecycleCommandAcl(dependencies, facade)'
    );
    expect(legacyAdaptersSource).toContain(
      'await dependencies.capabilities.runtime.stopTeam(teamName)'
    );
    expect(legacyAdaptersSource).toContain(
      'await dependencies.teamDataService.deleteTeam(teamName)'
    );
    expect(legacyAdaptersSource).toContain(
      'getTeamDataWorkerClient().invalidateTeamConfig(teamName)'
    );
    expect(legacyAdaptersSource).toContain('validateTeamName,');
    expect(compositionSource).toContain('createDesktopTeamLegacyAdapters(dependencies, {');
    expect(compositionSource).toContain('registerTeamLifecycleIpc(ipcMain, adapters.lifecycle)');
    expect(compositionSource).not.toContain('createTeamLifecycleIpcFeature');
    expect(compositionSource).not.toContain('createLegacyTeamLifecycleCommandAcl');
    expect(compositionSource).not.toContain('lifecycleIpcFacade');
    expect(`${compositionSource}\n${legacyAdaptersSource}`).not.toMatch(
      /TeamIpcHandlerApis|\bteamHandlerApis\b/
    );

    for (const source of [portsSource, facadeSource, factorySource, featureCompositionSource]) {
      expect(source).not.toContain('createMutationFacade');
      expect(source).not.toContain('stopTeam(');
      expect(source).not.toContain('invalidateTeamConfig');
      expect(source).not.toMatch(/TeamDataService|TeamProvisioningService|TeamProvisioningApis/);
    }
  });

  it('removes lifecycle mutation handlers and sequencing from the legacy teams IPC shell', () => {
    expect(teamsSource).not.toMatch(/TEAM_DELETE_TEAM|TEAM_RESTORE|TEAM_PERMANENTLY_DELETE/);
    expect(teamsSource).not.toMatch(
      /handle(?:DeleteTeam|RestoreTeam|PermanentlyDeleteTeam)|getTeamLifecycleIpcFacade/
    );
    expect(teamsSource).not.toMatch(/\.stopTeam\(|\.deleteTeam\(|\.restoreTeam\(/);
  });

  it('does not activate a second lifecycle, runtime, or process owner in production main', () => {
    for (const source of mainSources) {
      expect(source).not.toMatch(/createTeamLifecycleCommandFeature\s*\(/);
    }
    for (const source of [
      portsSource,
      facadeSource,
      factorySource,
      featureCompositionSource,
      entrypointSource,
      compositionSource,
      legacyAdaptersSource,
    ]) {
      expect(source).not.toMatch(
        /@features\/team-runtime-control|process-supervision|process-recovery|provider-execution|team-runtime-recovery/
      );
      expect(source).not.toMatch(/\bclass\s+\w+\s+extends\b/);
      expect(source).not.toMatch(/\bas unknown as\b|\bServiceHost\b/);
      expect(source).not.toMatch(/child_process|node:child_process|\bspawn\s*\(/);
    }
    expect(facadeSource).not.toMatch(/\bnew\s+(?:Map|Set|WeakMap|WeakSet)\b/);
    expect(factorySource).not.toMatch(/\bnew\s+(?:Map|Set|WeakMap|WeakSet)\b/);
  });

  it('leaves the app-shell handler registry free of lifecycle business logic', () => {
    expect(handlersSource).not.toContain('TeamLifecycleIpcFacade');
    expect(handlersSource).not.toContain('createTeamLifecycleIpcFacade');
    expect(handlersSource).not.toContain('createTeamLifecycleCommandFeature');
  });
});
