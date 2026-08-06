import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FACADE_PATH = 'src/main/services/team/TeamDataService.ts';
const SERVICE_PATH = 'src/main/services/team/TeamDataConfigurationCompatibilityService.ts';
const REPOSITORY_PATH =
  'src/features/team-configuration/main/adapters/output/TeamDraftConfigurationPersistenceRepository.ts';
const COMPOSITION_PATH =
  'src/features/team-configuration/main/composition/createTeamDraftConfigurationPersistenceRepository.ts';
const MAIN_ENTRYPOINT_PATH = 'src/features/team-configuration/main/index.ts';
const FACTORY_NAME = 'createTeamDraftConfigurationPersistenceRepository';
const PORT_NAME = 'TeamDraftConfigurationPersistenceRepositoryPort';
const REPOSITORY_NAME = 'TeamDraftConfigurationPersistenceRepository';
const PUBLIC_MODULE = '@features/team-configuration/main';
const DELEGATED_METHODS = ['getSavedRequest', 'createTeamConfig'] as const;
const FACADE_DELEGATED_METHODS = [
  'listTeams',
  'getSavedRequest',
  'updateConfig',
  'deleteTeam',
  'restoreTeam',
  'permanentlyDeleteTeam',
  'createTeamConfig',
] as const;
const EXTRACTED_DECLARATIONS = new Set([
  'applyDistinctRosterColors',
  'normalizeMember',
  'pathExists',
  'teamAlreadyExistsError',
]);
const REQUIRED_FACTORY_DEPENDENCIES = new Set([
  'teamMetaStore',
  'teamMembersMetaStore',
  'fileSystem',
  'invalidateListTeamsCache',
  'now',
]);
const FORBIDDEN_REPOSITORY_METHODS =
  /^(?:updateConfig|deleteTeam|restoreTeam|permanentlyDeleteTeam|addMember|removeMember|replaceMembers|launch|start|stop|kill|provision)/;
const FORBIDDEN_REPOSITORY_IMPORT =
  /(?:^(?:node:)?(?:fs|path)(?:\/|$)|TeamDataService|agent-teams-controller|controller|electron|fastify|opencode|OpenCode|team-runtime-control|TeamProvisioning)/;

type BoundaryDiagnostic =
  | 'adapter-forbidden-dependency'
  | 'adapter-path-root-discovery'
  | 'concrete-adapter-import'
  | 'facade-delegation-missing'
  | 'facade-direct-draft-ownership'
  | 'factory-call-missing'
  | 'factory-call-ports-missing'
  | 'factory-import-missing'
  | 'factory-invalid'
  | 'factory-public-export-missing'
  | 'import-path-invalid'
  | 'port-import-missing'
  | 'port-invalid'
  | 'port-public-export-missing'
  | 'port-usage-missing'
  | 'repository-inheritance'
  | 'repository-method-missing'
  | 'repository-public-export'
  | 'repository-scope-expansion'
  | 'roots-not-explicit'
  | 'store-port-not-narrow';

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test-owned paths.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function parse(path: string, contents: string): ts.SourceFile {
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function declarationName(node: ts.NamedDeclaration): string | null {
  if (!node.name) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

function importedNames(node: ts.ImportDeclaration): readonly string[] {
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
}

function exportedNames(node: ts.ExportDeclaration): readonly string[] {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return [];
  return node.exportClause.elements.map((element) => element.name.text);
}

function isPublicFeatureImport(specifier: string): boolean {
  return specifier === PUBLIC_MODULE;
}

function isDeepFeatureImport(specifier: string): boolean {
  return (
    (specifier.startsWith('@features/team-configuration/') && !isPublicFeatureImport(specifier)) ||
    /features\/team-configuration\/main\//.test(specifier)
  );
}

function isThinDelegate(
  node: ts.MethodDeclaration,
  methodName: string,
  receiverName = 'draftConfigurationPersistenceRepository'
): boolean {
  if (!node.body || node.body.statements.length !== 1) return false;
  const statement = node.body.statements[0];
  if (!ts.isReturnStatement(statement) || !statement.expression) return false;
  const expression = ts.isAwaitExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression;
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return false;
  }
  const receiver = expression.expression.expression;
  return (
    expression.expression.name.text === methodName &&
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === receiverName &&
    (receiver.expression.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === 'legacy' &&
        receiver.expression.expression.kind === ts.SyntaxKind.ThisKeyword))
  );
}

function createDelegatePassesRoots(node: ts.MethodDeclaration): boolean {
  if (!node.body || node.body.statements.length !== 1) return false;
  const statement = node.body.statements[0];
  if (!ts.isReturnStatement(statement) || !statement.expression) return false;
  const expression = ts.isAwaitExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression;
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 2) return false;
  const roots = expression.arguments[1];
  if (!ts.isObjectLiteralExpression(roots)) return false;
  const properties = new Map(
    roots.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => [declarationName(property), property.initializer])
  );
  const teamsRoot = properties.get('teamsRoot');
  const tasksRoot = properties.get('tasksRoot');
  return (
    !!teamsRoot &&
    ts.isCallExpression(teamsRoot) &&
    ts.isIdentifier(teamsRoot.expression) &&
    teamsRoot.expression.text === 'getTeamsBasePath' &&
    !!tasksRoot &&
    ts.isCallExpression(tasksRoot) &&
    ts.isIdentifier(tasksRoot.expression) &&
    tasksRoot.expression.text === 'getTasksBasePath'
  );
}

function exportsNamedSymbol(contents: string, path: string, symbolName: string): boolean {
  return parse(path, contents)
    .statements.filter(ts.isExportDeclaration)
    .some((statement) => exportedNames(statement).includes(symbolName));
}

function exportsConcreteRepository(contents: string, path: string): boolean {
  return parse(path, contents)
    .statements.filter(ts.isExportDeclaration)
    .some((statement) => {
      if (exportedNames(statement).includes(REPOSITORY_NAME)) return true;
      return (
        !statement.exportClause &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        /TeamDraftConfigurationPersistenceRepository$/.test(statement.moduleSpecifier.text)
      );
    });
}

function interfaceMethodNames(
  file: ts.SourceFile,
  interfaceName: string
): readonly string[] | null {
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  if (!declaration) return null;
  return declaration.members
    .filter(ts.isMethodSignature)
    .map((member) => declarationName(member))
    .filter((name): name is string => name !== null);
}

function scanBoundary(input: {
  service: string;
  repository: string;
  composition: string;
  mainEntrypoint: string;
}): readonly BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const serviceFile = parse(SERVICE_PATH, input.service);
  let factoryImportFound = false;
  let portImportFound = false;
  let factoryCallFound = false;
  let portUsageFound = false;
  const wiredDependencies = new Set<string>();
  const delegatedMethods = new Set<string>();
  let rootsPassedExplicitly = false;

  const visitService = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names = importedNames(node);
      const specifier = node.moduleSpecifier.text;
      if (names.includes(FACTORY_NAME)) {
        factoryImportFound = true;
        if (!isPublicFeatureImport(specifier)) diagnostics.add('import-path-invalid');
      }
      if (names.includes(PORT_NAME)) {
        portImportFound = true;
        if (!isPublicFeatureImport(specifier)) diagnostics.add('import-path-invalid');
      }
      if (names.includes(REPOSITORY_NAME)) diagnostics.add('concrete-adapter-import');
      if (isDeepFeatureImport(specifier)) diagnostics.add('import-path-invalid');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === FACTORY_NAME
    ) {
      factoryCallFound = true;
      const dependencies = node.arguments[0];
      if (dependencies && ts.isObjectLiteralExpression(dependencies)) {
        for (const property of dependencies.properties) {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            const name = declarationName(property);
            if (name) wiredDependencies.add(name);
          }
        }
      }
    }
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === PORT_NAME
    ) {
      portUsageFound = true;
    }
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isPropertyDeclaration(node)) &&
      EXTRACTED_DECLARATIONS.has(declarationName(node) ?? '')
    ) {
      diagnostics.add('facade-direct-draft-ownership');
    }
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (
        name &&
        DELEGATED_METHODS.includes(name as (typeof DELEGATED_METHODS)[number]) &&
        isThinDelegate(node, name)
      ) {
        delegatedMethods.add(name);
        if (name === 'createTeamConfig') {
          rootsPassedExplicitly = createDelegatePassesRoots(node);
        }
      }
    }
    ts.forEachChild(node, visitService);
  };
  visitService(serviceFile);

  if (!factoryImportFound) diagnostics.add('factory-import-missing');
  if (!portImportFound) diagnostics.add('port-import-missing');
  if (!factoryCallFound) diagnostics.add('factory-call-missing');
  if (!portUsageFound) diagnostics.add('port-usage-missing');
  if ([...REQUIRED_FACTORY_DEPENDENCIES].some((name) => !wiredDependencies.has(name))) {
    diagnostics.add('factory-call-ports-missing');
  }
  if (DELEGATED_METHODS.some((name) => !delegatedMethods.has(name))) {
    diagnostics.add('facade-delegation-missing');
  }
  if (!rootsPassedExplicitly) diagnostics.add('roots-not-explicit');

  const repositoryFile = parse(REPOSITORY_PATH, input.repository);
  const repositoryMethods = new Set<string>();
  const visitRepository = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      FORBIDDEN_REPOSITORY_IMPORT.test(node.moduleSpecifier.text)
    ) {
      diagnostics.add('adapter-forbidden-dependency');
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      /pathDecoder/.test(node.moduleSpecifier.text)
    ) {
      diagnostics.add('adapter-path-root-discovery');
    }
    if (ts.isClassDeclaration(node) && node.name?.text === REPOSITORY_NAME) {
      if (node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) {
        diagnostics.add('repository-inheritance');
      }
      for (const member of node.members.filter(ts.isMethodDeclaration)) {
        const name = declarationName(member);
        if (name) repositoryMethods.add(name);
        if (name && FORBIDDEN_REPOSITORY_METHODS.test(name)) {
          diagnostics.add('repository-scope-expansion');
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(?:attach|detach|start|stop|kill|launch|provision)/.test(node.expression.name.text)
    ) {
      diagnostics.add('repository-scope-expansion');
    }
    ts.forEachChild(node, visitRepository);
  };
  visitRepository(repositoryFile);

  if (DELEGATED_METHODS.some((name) => !repositoryMethods.has(name))) {
    diagnostics.add('repository-method-missing');
  }
  const metaStoreMethods = interfaceMethodNames(repositoryFile, 'DraftTeamMetaStorePort');
  const membersStoreMethods = interfaceMethodNames(repositoryFile, 'DraftTeamMembersMetaStorePort');
  const fileSystemMethods = interfaceMethodNames(
    repositoryFile,
    'DraftConfigurationFileSystemPort'
  );
  if (
    !metaStoreMethods ||
    metaStoreMethods.length !== 2 ||
    !metaStoreMethods.includes('getMeta') ||
    !metaStoreMethods.includes('writeMeta') ||
    !membersStoreMethods ||
    membersStoreMethods.length !== 2 ||
    !membersStoreMethods.includes('getMeta') ||
    !membersStoreMethods.includes('writeMembers') ||
    !fileSystemMethods ||
    fileSystemMethods.length !== 4 ||
    !fileSystemMethods.includes('join') ||
    !fileSystemMethods.includes('lstat') ||
    !fileSystemMethods.includes('mkdir') ||
    !fileSystemMethods.includes('rm')
  ) {
    diagnostics.add('store-port-not-narrow');
  }

  const compositionFile = parse(COMPOSITION_PATH, input.composition);
  let factoryCreatesRepository = false;
  const visitComposition = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === FACTORY_NAME &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const visitFactory = (factoryNode: ts.Node): void => {
        if (
          ts.isNewExpression(factoryNode) &&
          ts.isIdentifier(factoryNode.expression) &&
          factoryNode.expression.text === REPOSITORY_NAME
        ) {
          factoryCreatesRepository = true;
        }
        ts.forEachChild(factoryNode, visitFactory);
      };
      visitFactory(node);
    }
    ts.forEachChild(node, visitComposition);
  };
  visitComposition(compositionFile);
  if (!factoryCreatesRepository) diagnostics.add('factory-invalid');

  const portMethods = interfaceMethodNames(compositionFile, PORT_NAME);
  if (
    !portMethods ||
    portMethods.length !== DELEGATED_METHODS.length ||
    DELEGATED_METHODS.some((name) => !portMethods.includes(name))
  ) {
    diagnostics.add('port-invalid');
  }
  if (!exportsNamedSymbol(input.mainEntrypoint, MAIN_ENTRYPOINT_PATH, FACTORY_NAME)) {
    diagnostics.add('factory-public-export-missing');
  }
  if (!exportsNamedSymbol(input.mainEntrypoint, MAIN_ENTRYPOINT_PATH, PORT_NAME)) {
    diagnostics.add('port-public-export-missing');
  }
  if (exportsConcreteRepository(input.mainEntrypoint, MAIN_ENTRYPOINT_PATH)) {
    diagnostics.add('repository-public-export');
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

describe('TeamDataService draft-configuration persistence boundary', () => {
  it('keeps draft persistence feature-owned behind the public main entrypoint', () => {
    expect(
      scanBoundary({
        service: source(SERVICE_PATH),
        repository: source(REPOSITORY_PATH),
        composition: source(COMPOSITION_PATH),
        mainEntrypoint: source(MAIN_ENTRYPOINT_PATH),
      })
    ).toEqual([]);
  });

  it('keeps TeamDataService as a thin configuration compatibility facade', () => {
    const facadeContents = source(FACADE_PATH);
    const facadeFile = parse(FACADE_PATH, facadeContents);
    const delegated = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) {
        const name = declarationName(node);
        if (
          name &&
          FACADE_DELEGATED_METHODS.includes(name as (typeof FACADE_DELEGATED_METHODS)[number]) &&
          isThinDelegate(node, name, 'configurationCompatibilityService')
        ) {
          delegated.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(facadeFile);

    expect([...delegated].sort()).toEqual([...FACADE_DELEGATED_METHODS].sort());
    expect(facadeContents).not.toContain('createTeamDraftConfigurationPersistenceRepository');
    expect(facadeContents).not.toContain('draftConfigurationPersistenceRepository');
    expect(facadeContents).not.toContain('atomicWriteAsync');
    expect(facadeContents).not.toContain('permanentlyDeleteTeamData');
  });

  it('rejects facade persistence logic, deep imports, and implicit root discovery', () => {
    const serviceFixture = `
      import {
        TeamDraftConfigurationPersistenceRepository,
      } from '@features/team-configuration/main/adapters/output/TeamDraftConfigurationPersistenceRepository';
      export class TeamDataService {
        private applyDistinctRosterColors(): void {}
        getSavedRequest(): void {}
        createTeamConfig(): void {}
      }
    `;
    const repositoryFixture = `
      import { getTeamsBasePath } from '@main/utils/pathDecoder';
      import { TeamDataService } from '@main/services/team/TeamDataService';
      interface DraftTeamMetaStorePort { getMeta(): void; writeMeta(): void; deleteMeta(): void; }
      interface DraftTeamMembersMetaStorePort { getMeta(): void; writeMembers(): void; }
      interface DraftConfigurationFileSystemPort { mkdir(): void; }
      export class TeamDraftConfigurationPersistenceRepository extends TeamDataService {
        updateConfig(): void { this.stop(); }
      }
    `;

    expect(
      scanBoundary({
        service: serviceFixture,
        repository: repositoryFixture,
        composition:
          'export interface TeamDraftConfigurationPersistenceRepositoryPort { createTeamConfig(): void; }',
        mainEntrypoint:
          "export { TeamDraftConfigurationPersistenceRepository } from './adapters/output/TeamDraftConfigurationPersistenceRepository';",
      })
    ).toEqual([
      'adapter-forbidden-dependency',
      'adapter-path-root-discovery',
      'concrete-adapter-import',
      'facade-delegation-missing',
      'facade-direct-draft-ownership',
      'factory-call-missing',
      'factory-call-ports-missing',
      'factory-import-missing',
      'factory-invalid',
      'factory-public-export-missing',
      'import-path-invalid',
      'port-import-missing',
      'port-invalid',
      'port-public-export-missing',
      'port-usage-missing',
      'repository-inheritance',
      'repository-method-missing',
      'repository-public-export',
      'repository-scope-expansion',
      'roots-not-explicit',
      'store-port-not-narrow',
    ]);
  });
});
