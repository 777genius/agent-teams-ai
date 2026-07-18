import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const contractPaths = [
  'src/features/team-lifecycle/contracts/team-lifecycle-read.ts',
  'src/features/team-lifecycle/contracts/team-lifecycle-read-api.ts',
] as const;

const corePaths = [
  'src/features/team-lifecycle/core/application/ListTeamLifecycle.ts',
  'src/features/team-lifecycle/core/application/GetTeamLifecycleSnapshot.ts',
  'src/features/team-lifecycle/core/application/GetRuntimeStateProjection.ts',
  'src/features/team-lifecycle/core/application/ListAliveTeamProjections.ts',
] as const;

const adapterPaths = [
  'src/features/team-lifecycle/main/infrastructure/LegacyTeamLifecycleReadSource.ts',
  'src/features/team-lifecycle/main/adapters/input/TeamLifecycleReadApiAdapter.ts',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('P2.E team-lifecycle read boundaries', () => {
  it('keeps domain and application sources independent of outer runtime mechanisms', () => {
    const forbiddenDependency =
      /(?:from\s*['"](?:node:)?(?:electron|fastify|react|zustand|fs|path|child_process|process)['"]|@main|@renderer|@preload|\/main\/|window\.electronAPI)/;

    expect(forbiddenDependency.test("import { ipcMain } from 'electron';")).toBe(true);
    expect(forbiddenDependency.test("import { readFile } from 'node:fs';")).toBe(true);
    expect(forbiddenDependency.test("import value from '@main/value';")).toBe(true);

    for (const path of [...contractPaths, ...corePaths]) {
      expect(source(path), path).not.toMatch(forbiddenDependency);
    }
  });

  it('keeps the API facet small and free of protocol-specific surface area', () => {
    const api = source(contractPaths[1]);
    const forbiddenApiSurface =
      /(?:IpcMain|IpcRenderer|Fastify|Electron|Http|RequestEvent|Reply|statusCode|status\(|headers?|route|channel|callback|serialize|deserialize|WebSocket)/i;
    const mutationSurface =
      /(?:create|update|delete|remove|restore|launch|prepare|cancel|stop|send|write|save|retry)[A-Z]/;

    expect(forbiddenApiSurface.test('FastifyReply')).toBe(true);
    expect(mutationSurface.test('deleteTeam')).toBe(true);
    expect(api).not.toMatch(forbiddenApiSurface);
    expect(api).not.toMatch(mutationSurface);
    expect(api.match(/^\s{2}[a-z][A-Za-z]+\(/gm)).toHaveLength(5);
    expect(api).toContain('interface TeamLifecycleReadTransportApi');
    expect(api).toContain('listTeamLifecycle(');
    expect(api).toContain('getTeamLifecycleSnapshot(');
    expect(api).toContain('getRuntimeStateProjection(');
    expect(api).toContain('listAliveTeamProjections(');
  });

  it('publishes canonical value fields without legacy names or private locations', () => {
    const contracts = contractPaths.map(source).join('\n');
    const rawBrowserField = /readonly\s+(?:teamName|projectPath|cwd|rootPath|filePath)\s*[?:]/;

    expect(rawBrowserField.test('readonly teamName: string')).toBe(true);
    expect(contracts).not.toMatch(rawBrowserField);
    expect(contracts).toContain('readonly workspaceId: WorkspaceId');
    expect(contracts).toContain('readonly teamId: TeamId');
    expect(contracts).toContain('parseWorkspaceId');
    expect(contracts).toContain('parseTeamId');
  });

  it('confines legacy-name mapping to the driven compatibility source', () => {
    const legacySource = source(adapterPaths[0]);
    const otherSources = [...contractPaths, ...corePaths, adapterPaths[1]].map(source).join('\n');

    expect(legacySource).toContain('legacyTeamName');
    expect(otherSources).not.toContain('legacyTeamName');
    expect(legacySource).not.toMatch(/from\s*['"]@main/);
    expect(legacySource).not.toMatch(/TeamDataService|TeamProvisioningService|TeamsAPI/);
    expect(legacySource).not.toMatch(/node:fs|node:path|process\.|child_process/);
  });

  it('keeps the input adapter validating values before application invocation', () => {
    const adapter = source(adapterPaths[1]);
    const methods = [
      ['parseListTeamLifecycleRequest', 'useCases.list.execute'],
      ['parseGetTeamLifecycleSnapshotRequest', 'useCases.snapshot.execute'],
      ['parseGetRuntimeStateProjectionRequest', 'useCases.runtime.execute'],
      ['parseListAliveTeamProjectionsRequest', 'useCases.alive.execute'],
    ] as const;

    for (const [parser, invocation] of methods) {
      expect(adapter.indexOf(parser), parser).toBeGreaterThanOrEqual(0);
      expect(adapter.indexOf(invocation), invocation).toBeGreaterThan(adapter.indexOf(parser));
    }
    expect(adapter).not.toMatch(/electron|fastify|ipcMain|statusCode|reply\.|request\.params/i);
  });

  it('contains no composition, public-barrel, production registration, or mutation wiring', () => {
    const production = [...contractPaths, ...corePaths, ...adapterPaths].map(source).join('\n');
    const forbiddenWiring =
      /(?:registerTeamRoutes|ipcMain\.handle|RouteCatalog|window\.electronAPI|createTeamConfig|deleteDraft|launchTeam|stopTeam)/;

    expect(forbiddenWiring.test('registerTeamRoutes(app)')).toBe(true);
    expect(production).not.toMatch(forbiddenWiring);
    expect(production).not.toContain("from '../../index'");
    expect(production).not.toContain("from '../../../index'");
  });

  it('routes production composition and renderer transport through public feature entrypoints', () => {
    const composition = source('src/main/composition/hosted/phase2ReadComposition.ts');
    const rendererClient = source('src/renderer/api/httpClient.ts');

    expect(composition).toContain("from '@features/internal-storage/contracts'");
    expect(composition).toContain("from '@features/team-lifecycle/main'");
    expect(composition).not.toMatch(/@features\/internal-storage\/contracts\//);
    expect(composition).not.toMatch(/@features\/team-lifecycle\/(?:core|main)\//);
    expect(rendererClient).toContain("from '@features/team-lifecycle/contracts'");
    expect(rendererClient).not.toMatch(/from ['"]@features\/team-lifecycle['"]/);
  });

  it('has one canonical identity port implementation and one legacy lifecycle source', () => {
    const composition = source('src/main/composition/hosted/phase2ReadComposition.ts');

    expect(composition.match(/implements LegacyTeamIdentityReadPort/g)).toHaveLength(1);
    expect(composition.match(/new LegacyTeamLifecycleReadSource\(/g)).toHaveLength(1);
    expect(composition).toContain("type IdentityProjectionPurpose = 'lifecycle' | 'runtime'");
    expect(composition).toContain('class CanonicalIdentityProjectionReadPort');
    expect(composition).not.toContain('DurableIdentityReadPort');
    expect(composition).not.toContain('RuntimeProjectionIdentityReadPort');
  });
});
