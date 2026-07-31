import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HOST_PATH = 'src/main/composition/team/TeamApplicationHost.ts';
const PORTS_PATH = 'src/main/composition/team/TeamApplicationHostPorts.ts';
const FACTORY_PATH = 'src/main/composition/team/createTeamApplicationHost.ts';
const HTTP_PATH = 'src/main/http/teams.ts';

const EXPECTED_HOST_PORTS = [
  'configPresence',
  'data',
  'listInvalidation',
  'provisioningStart',
  'provisioningStatus',
  'resume',
  'runtime',
  'taskActivity',
] as const;

const EXPECTED_HOST_METHODS = [
  'createTeamDraft',
  'getProvisioningStatus',
  'getRuntimeState',
  'getTeam',
  'launchTeam',
  'listAliveRuntimeStates',
  'listTeams',
  'stopTeam',
] as const;

const MIGRATED_CAPABILITY_METHODS = new Set([
  'createTeamConfig',
  'createTeam',
  'getAliveTeams',
  'getProvisioningStatus',
  'getRuntimeState',
  'getSavedRequest',
  'getTeamData',
  'launchTeam',
  'listTeams',
  'repairStaleTaskActivityIntervalsBeforeSnapshot',
  'stopTeam',
]);

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are test-owned constants.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function parse(path: string, contents: string = source(path)): ts.SourceFile {
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function importedModules(file: ts.SourceFile): string[] {
  return file.statements
    .filter(ts.isImportDeclaration)
    .map((statement) =>
      ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
    );
}

function namedInterfaceMembers(file: ts.SourceFile, interfaceName: string): string[] {
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  return (
    declaration?.members
      .map((member) => member.name?.getText(file))
      .filter((name): name is string => name !== undefined)
      .sort() ?? []
  );
}

function publicHostMethods(file: ts.SourceFile): string[] {
  const declaration = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'TeamApplicationHost'
  );
  return (
    declaration?.members
      .filter(ts.isMethodDeclaration)
      .filter(
        (method) =>
          !method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
      )
      .map((method) => method.name.getText(file))
      .sort() ?? []
  );
}

function propertyAccessPath(expression: ts.Expression): string[] | null {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (!ts.isPropertyAccessExpression(expression)) {
    return null;
  }
  const parent = propertyAccessPath(expression.expression);
  return parent ? [...parent, expression.name.text] : null;
}

function migratedCallsOutsideHost(file: ts.SourceFile): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const path = propertyAccessPath(node.expression);
      const method = path?.at(-1);
      if (
        path &&
        path[0] !== 'applicationHost' &&
        method &&
        MIGRATED_CAPABILITY_METHODS.has(method)
      ) {
        violations.push(path.join('.'));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function applicationHostCalls(file: ts.SourceFile): string[] {
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const path = propertyAccessPath(node.expression);
      if (path?.length === 2 && path[0] === 'applicationHost') {
        calls.push(path[1]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls.sort();
}

describe('team HTTP application-host boundary', () => {
  it('keeps a provider-neutral host over the exact narrow capability ports', () => {
    const host = parse(HOST_PATH);
    const ports = parse(PORTS_PATH);

    expect(namedInterfaceMembers(ports, 'TeamApplicationHostPorts')).toEqual(EXPECTED_HOST_PORTS);
    expect(publicHostMethods(host)).toEqual(EXPECTED_HOST_METHODS);
    expect(importedModules(host)).toEqual(['./TeamApplicationHostPorts', '@shared/types/team']);
    expect(importedModules(ports)).toEqual([
      '@main/services/team/contracts/TeamApplicationCapabilityApis',
      '@shared/types/team',
    ]);
    expect(`${host.text}\n${ports.text}`).not.toMatch(
      /Fastify|Electron|HttpServices|OpenCode|opencode|runtime-control|TeamDataService|TeamProvisioningService/
    );
    expect(`${host.text}\n${ports.text}`).not.toContain('as unknown as');
  });

  it('keeps filesystem and cache mechanisms in the composition adapter', () => {
    const factory = parse(FACTORY_PATH);

    expect(importedModules(factory)).toEqual(
      expect.arrayContaining([
        '@main/composition/team/TeamApplicationHost',
        '@main/services/team/TeamConfigReader',
        '@main/utils/pathDecoder',
        'fs',
        'fs/promises',
        'path',
      ])
    );
    expect(factory.text).toContain('new TeamApplicationHost({');
    expect(factory.text).toContain('TeamConfigReader.invalidateListTeamsCache()');
    expect(factory.text).not.toMatch(
      /createTeamLifecycleCommandFeature|team-runtime-control|OpenCode|opencode|TeamDataService|TeamProvisioningService|TeamProvisioningApis|TeamHttpHandlerApis/
    );
    expect(factory.text).toContain('TeamApplicationCapabilityApiBinder');
    expect(factory.text).toContain('TeamApplicationCapabilityApis');
    expect(factory.text).not.toContain('as unknown as');
  });

  it('keeps HTTP transport-only for every migrated team operation', () => {
    const http = parse(HTTP_PATH);

    expect(applicationHostCalls(http)).toEqual(EXPECTED_HOST_METHODS);
    expect(migratedCallsOutsideHost(http)).toEqual([]);
    expect(importedModules(http)).not.toEqual(
      expect.arrayContaining(['fs', 'fs/promises', 'path'])
    );
    expect(http.text).not.toMatch(
      /TeamConfigReader|getTeamsBasePath|getDraftSavedRequest|getTeamDataWithRuntimeOverlay|createTeamLifecycleCommandFeature/
    );
    expect(http.text).toContain('getTeamRuntimeControlApi(services)');
    expect(http.text).toContain('registerMemberWorkSyncHttp(');
    expect(http.text).toContain('teamLifecycleReadHost.listTeamLifecycle(');
  });

  it('detects direct service bypasses instead of relying on production source strings', () => {
    const fixture = parse(
      'fixture.ts',
      `
        async function bypass(services: any) {
          await services.teamDataApi.getTeamData('demo');
          await services.teamApis.provisioningStart.launchTeam({}, () => undefined);
          return services.teamApis.runtime.getAliveTeams();
        }
      `
    );

    expect(migratedCallsOutsideHost(fixture)).toEqual([
      'services.teamDataApi.getTeamData',
      'services.teamApis.provisioningStart.launchTeam',
      'services.teamApis.runtime.getAliveTeams',
    ]);
  });
});
