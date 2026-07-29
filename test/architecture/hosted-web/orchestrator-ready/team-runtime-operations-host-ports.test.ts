import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HOST_PORTS_PATH =
  'src/features/team-runtime-operations/main/composition/TeamRuntimeOperationsHostPorts.ts';
const FACTORY_PATH =
  'src/features/team-runtime-operations/main/composition/createTeamRuntimeOperationsFeature.ts';
const LIFECYCLE_ADAPTER_PATH =
  'src/features/team-runtime-operations/main/composition/createTeamRuntimeLifecycleHostPort.ts';
const MAIN_ENTRYPOINT_PATH = 'src/features/team-runtime-operations/main/index.ts';
const DESKTOP_CAPABILITIES_PATH = 'src/main/ipc/teamFeatureCapabilities.ts';
const DESKTOP_COMPOSITION_PATH = 'src/main/ipc/teamFeatureComposition.ts';
const APPLICATION_PORTS_PATH =
  'src/features/team-runtime-operations/core/application/ports/TeamRuntimeOperationPorts.ts';
const COMMAND_IPC_PATH =
  'src/features/team-runtime-operations/main/adapters/input/ipc/createTeamRuntimeCommandIpcHandlers.ts';
const EXPECTED_HOST_CAPABILITIES = [
  'diagnostics',
  'effects',
  'feed',
  'lifecycle',
  'logger',
  'logs',
  'messaging',
  'processes',
  'runtime',
  'worker',
] as const;

interface ImportRecord {
  readonly names: readonly string[];
  readonly specifier: string;
}

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are test-owned constants.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function sourceFile(path: string, contents: string): ts.SourceFile {
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function importRecords(path: string, contents: string): ImportRecord[] {
  return sourceFile(path, contents).statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      return [];
    }
    const bindings = statement.importClause?.namedBindings;
    const names =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => element.propertyName?.text ?? element.name.text)
        : [];
    return [{ names, specifier: statement.moduleSpecifier.text }];
  });
}

function broadFactoryImports(contents: string): ImportRecord[] {
  return importRecords(FACTORY_PATH, contents).filter(
    ({ names, specifier }) =>
      specifier === '@main/services' ||
      specifier.startsWith('@main/services/') ||
      specifier.includes('TeamProvisioningApis') ||
      names.includes('TeamDataService')
  );
}

function hostCapabilityNames(contents: string): string[] {
  const declaration = sourceFile(HOST_PORTS_PATH, contents).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === 'TeamRuntimeOperationsHostPorts'
  );
  return (
    declaration?.members
      .map((member) =>
        member.name && ts.isIdentifier(member.name) ? member.name.text : member.name?.getText()
      )
      .filter((name): name is string => name !== undefined)
      .sort() ?? []
  );
}

function hasLegacyRetryAdapter(path: string, contents: string): boolean {
  let found = false;
  const parsed = sourceFile(path, contents);
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(parsed) === 'retryFailedRuntimeLanes' &&
      node.initializer.getText(parsed).includes('retryFailedOpenCodeSecondaryLanes')
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

describe('team runtime operations host composition boundary', () => {
  it('owns one narrow provider-neutral host contract over application ports', () => {
    const contents = source(HOST_PORTS_PATH);

    expect(hostCapabilityNames(contents)).toEqual(EXPECTED_HOST_CAPABILITIES);
    expect(contents).not.toMatch(/OpenCode|opencode|Claude/);
    expect(importRecords(HOST_PORTS_PATH, contents).map(({ specifier }) => specifier)).toEqual([
      '../../core/application/ports/TeamRuntimeOperationPorts',
    ]);
  });

  it('keeps generic host and application ports free of provider vocabulary', () => {
    for (const path of [HOST_PORTS_PATH, APPLICATION_PORTS_PATH]) {
      expect(source(path)).not.toMatch(/OpenCode|opencode|Claude/);
    }
  });

  it('prevents broad main-service contracts from returning to the feature factory', () => {
    const contents = source(FACTORY_PATH);

    expect(broadFactoryImports(contents)).toEqual([]);
    expect(contents).toContain('dependencies: TeamRuntimeOperationsHostPorts');
    expect(contents).not.toContain('{ data: never }');
    expect(contents).not.toContain('as TeamRuntimeOperationsHostPorts');
    expect(contents).not.toMatch(/OpenCode|opencode|Claude/);
    expect(contents).toContain('lifecycle: ManageTeamRuntimeLifecycle');
    expect(
      importRecords(FACTORY_PATH, contents).some(
        ({ names, specifier }) =>
          specifier === './TeamRuntimeOperationsHostPorts' &&
          names.includes('TeamRuntimeOperationsHostPorts')
      )
    ).toBe(true);
  });

  it('publishes the narrow host contract from the main-process entrypoint', () => {
    const contents = source(MAIN_ENTRYPOINT_PATH);

    expect(contents).toContain('TeamRuntimeOperationsHostPorts');
    expect(contents).toContain("from './composition/TeamRuntimeOperationsHostPorts'");
  });

  it('detects aliased broad service imports as boundary violations', () => {
    expect(
      broadFactoryImports(
        "import type { TeamDataService as Data } from '@main/services';\nexport {};"
      )
    ).toHaveLength(1);
    expect(
      broadFactoryImports(
        "import type { TeamRuntimeApi as Runtime } from '@main/services/team/contracts/TeamProvisioningApis';\nexport {};"
      )
    ).toHaveLength(1);
  });

  it('translates the legacy provider retry name only behind feature main composition', () => {
    expect(hasLegacyRetryAdapter(LIFECYCLE_ADAPTER_PATH, source(LIFECYCLE_ADAPTER_PATH))).toBe(
      true
    );
    expect(source(DESKTOP_CAPABILITIES_PATH)).toContain(
      'runtimeLifecycle: createTeamRuntimeLifecycleHostPort(sources.memberLifecycle)'
    );
    expect(hasLegacyRetryAdapter(DESKTOP_COMPOSITION_PATH, source(DESKTOP_COMPOSITION_PATH))).toBe(
      false
    );
    expect(source(DESKTOP_COMPOSITION_PATH)).toContain(
      'const lifecycle = dependencies.capabilities.runtimeLifecycle'
    );
    expect(source(DESKTOP_COMPOSITION_PATH)).not.toContain('createTeamRuntimeLifecycleHostPort');
    expect(source(MAIN_ENTRYPOINT_PATH)).toContain(
      "from './composition/createTeamRuntimeLifecycleHostPort'"
    );
    expect(importRecords(LIFECYCLE_ADAPTER_PATH, source(LIFECYCLE_ADAPTER_PATH))).toEqual([
      {
        names: ['TeamMemberSpawnStatusPort', 'TeamRuntimeLifecycleCommandPort'],
        specifier: '../../core/application/ports/TeamRuntimeOperationPorts',
      },
    ]);
    expect(source(HOST_PORTS_PATH)).toContain('TeamRuntimeLifecycleCommandPort');
    expect(source(HOST_PORTS_PATH)).not.toContain('retryFailedOpenCodeSecondaryLanes');
    expect(source(COMMAND_IPC_PATH)).toContain(
      'feature.lifecycle.retryFailedRuntimeLanes(team.value)'
    );
  });

  it('does not activate a second runtime lifecycle owner', () => {
    for (const path of [
      HOST_PORTS_PATH,
      FACTORY_PATH,
      LIFECYCLE_ADAPTER_PATH,
      DESKTOP_CAPABILITIES_PATH,
      DESKTOP_COMPOSITION_PATH,
    ]) {
      const contents = source(path);
      expect(contents).not.toContain('createTeamLifecycleCommandFeature');
      expect(contents).not.toContain('team-runtime-control');
    }
  });
});
