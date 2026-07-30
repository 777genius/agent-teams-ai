import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const REPOSITORY_PATH =
  'src/features/team-roster-mutations/main/adapters/output/TeamRosterPersistenceRepository.ts';
const COMPOSITION_PATH =
  'src/features/team-roster-mutations/main/composition/createTeamRosterPersistenceRepository.ts';
const MAIN_ENTRYPOINT_PATH = 'src/features/team-roster-mutations/main/index.ts';
const ROOT_ENTRYPOINT_PATH = 'src/features/team-roster-mutations/index.ts';
const CONTRACTS_ENTRYPOINT_PATH = 'src/features/team-roster-mutations/contracts/index.ts';
const CONTRACTS_CHANNELS_PATH = 'src/features/team-roster-mutations/contracts/channels.ts';
const REPOSITORY_NAME = 'TeamRosterPersistenceRepository';
const FACTORY_NAME = 'createTeamRosterPersistenceRepository';
const PORT_NAME = 'TeamRosterPersistenceRepositoryPort';
const PUBLIC_MODULE = '@features/team-roster-mutations/main';
const DELEGATED_METHODS = [
  'addMember',
  'updateMemberRole',
  'replaceMembers',
  'removeMember',
  'restoreMember',
] as const;
const EXTRACTED_DECLARATIONS = new Set([
  'ensureMemberInMeta',
  'readTeamLaneMutationContext',
  'assertRosterMutationAllowed',
  'resolveEffectiveMemberProviderId',
  'isSupportedRunningMixedRosterMutation',
  'toProvisioningMemberShape',
]);
const REQUIRED_DEPENDENCIES = new Set([
  'members',
  'config',
  'inbox',
  'teamMetadata',
  'launchSnapshots',
  'processes',
  'now',
]);

type BoundaryDiagnostic =
  | 'facade-delegation-missing'
  | 'facade-direct-roster-ownership'
  | 'factory-call-missing'
  | 'factory-call-ports-missing'
  | 'factory-import-missing'
  | 'factory-public-export-missing'
  | 'persistence-port-import-missing'
  | 'persistence-port-public-export-missing'
  | 'persistence-port-usage-missing'
  | 'repository-concrete-adapter-import'
  | 'repository-factory-invalid'
  | 'repository-import-path-invalid'
  | 'repository-inheritance'
  | 'repository-method-missing'
  | 'repository-port-invalid'
  | 'repository-public-export'
  | 'repository-runtime-control-owner'
  | 'roster-contract-provider-leakage';

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

function isThinRepositoryDelegate(node: ts.MethodDeclaration, methodName: string): boolean {
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
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
    receiver.name.text === 'rosterPersistenceRepository'
  );
}

function exportedRepository(contents: string, path: string): boolean {
  const file = parse(path, contents);
  let exported = false;
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node)) {
      const directlyExportsRepository =
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some(
          (element) => (element.propertyName ?? element.name).text === REPOSITORY_NAME
        );
      const starExportsRepositoryModule =
        !node.exportClause &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        /(?:^|\/)TeamRosterPersistenceRepository$/.test(node.moduleSpecifier.text);
      if (directlyExportsRepository || starExportsRepositoryModule) {
        exported = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return exported;
}

function exportsNamedSymbol(contents: string, path: string, symbolName: string): boolean {
  const file = parse(path, contents);
  return file.statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => element.name.text === symbolName)
  );
}

function isDeepRosterFeatureImport(specifier: string): boolean {
  if (specifier.startsWith('@features/team-roster-mutations/')) {
    return specifier !== PUBLIC_MODULE;
  }
  return /features\/team-roster-mutations\/main\//.test(specifier);
}

function scanBoundary(input: {
  service: string;
  repository: string;
  composition: string;
  mainEntrypoint: string;
  rootEntrypoint: string;
  contracts: string;
}): readonly BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const serviceFile = parse(SERVICE_PATH, input.service);
  let factoryImportFound = false;
  let persistencePortImportFound = false;
  let factoryCallFound = false;
  let persistencePortUsageFound = false;
  const wiredDependencies = new Set<string>();
  const delegatedMethods = new Set<string>();

  const visitService = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names = importedNames(node);
      const moduleSpecifier = node.moduleSpecifier.text;
      if (names.includes(FACTORY_NAME)) {
        factoryImportFound = true;
        if (moduleSpecifier !== PUBLIC_MODULE) {
          diagnostics.add('repository-import-path-invalid');
        }
      }
      if (names.includes(PORT_NAME)) {
        persistencePortImportFound = true;
        if (moduleSpecifier !== PUBLIC_MODULE) {
          diagnostics.add('repository-import-path-invalid');
        }
      }
      if (names.includes(REPOSITORY_NAME)) {
        diagnostics.add('repository-concrete-adapter-import');
      }
      if (isDeepRosterFeatureImport(moduleSpecifier)) {
        diagnostics.add('repository-import-path-invalid');
      }
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
          if (
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
            property.name
          ) {
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
      persistencePortUsageFound = true;
    }
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isPropertyDeclaration(node)) &&
      EXTRACTED_DECLARATIONS.has(declarationName(node) ?? '')
    ) {
      diagnostics.add('facade-direct-roster-ownership');
    }
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (
        name &&
        DELEGATED_METHODS.includes(name as (typeof DELEGATED_METHODS)[number]) &&
        isThinRepositoryDelegate(node, name)
      ) {
        delegatedMethods.add(name);
      }
    }
    ts.forEachChild(node, visitService);
  };
  visitService(serviceFile);

  if (!factoryImportFound) diagnostics.add('factory-import-missing');
  if (!persistencePortImportFound) diagnostics.add('persistence-port-import-missing');
  if (!factoryCallFound) diagnostics.add('factory-call-missing');
  if (!persistencePortUsageFound) diagnostics.add('persistence-port-usage-missing');
  if ([...REQUIRED_DEPENDENCIES].some((name) => !wiredDependencies.has(name))) {
    diagnostics.add('factory-call-ports-missing');
  }
  if (DELEGATED_METHODS.some((name) => !delegatedMethods.has(name))) {
    diagnostics.add('facade-delegation-missing');
  }

  const repositoryFile = parse(REPOSITORY_PATH, input.repository);
  const repositoryMethods = new Set<string>();
  const visitRepository = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name) repositoryMethods.add(name);
    }
    if (
      ts.isClassDeclaration(node) &&
      node.name?.text === REPOSITORY_NAME &&
      node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ) {
      diagnostics.add('repository-inheritance');
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      /team-runtime-control|TeamProvisioning|electron|fastify/.test(node.moduleSpecifier.text)
    ) {
      diagnostics.add('repository-runtime-control-owner');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(?:attach|detach|start|stop|kill|launch|provision)/.test(node.expression.name.text)
    ) {
      diagnostics.add('repository-runtime-control-owner');
    }
    ts.forEachChild(node, visitRepository);
  };
  visitRepository(repositoryFile);

  if (DELEGATED_METHODS.some((name) => !repositoryMethods.has(name))) {
    diagnostics.add('repository-method-missing');
  }

  const compositionFile = parse(COMPOSITION_PATH, input.composition);
  let factoryCreatesRepository = false;
  let persistencePortFound = false;
  const persistencePortMethods = new Set<string>();
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
    if (ts.isInterfaceDeclaration(node) && node.name.text === PORT_NAME) {
      persistencePortFound = true;
      const methodNames = node.members
        .filter(ts.isMethodSignature)
        .map((member) => declarationName(member))
        .filter((name): name is string => name !== null);
      for (const methodName of methodNames) persistencePortMethods.add(methodName);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      /team-runtime-control|TeamProvisioning|electron|fastify/.test(node.moduleSpecifier.text)
    ) {
      diagnostics.add('repository-runtime-control-owner');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(?:attach|detach|start|stop|kill|launch|provision)/.test(node.expression.name.text)
    ) {
      diagnostics.add('repository-runtime-control-owner');
    }
    ts.forEachChild(node, visitComposition);
  };
  visitComposition(compositionFile);

  if (!factoryCreatesRepository) diagnostics.add('repository-factory-invalid');
  if (
    !persistencePortFound ||
    persistencePortMethods.size !== DELEGATED_METHODS.length ||
    DELEGATED_METHODS.some((name) => !persistencePortMethods.has(name))
  ) {
    diagnostics.add('repository-port-invalid');
  }
  if (!exportsNamedSymbol(input.mainEntrypoint, MAIN_ENTRYPOINT_PATH, FACTORY_NAME)) {
    diagnostics.add('factory-public-export-missing');
  }
  if (!exportsNamedSymbol(input.mainEntrypoint, MAIN_ENTRYPOINT_PATH, PORT_NAME)) {
    diagnostics.add('persistence-port-public-export-missing');
  }
  if (
    exportedRepository(input.mainEntrypoint, MAIN_ENTRYPOINT_PATH) ||
    exportedRepository(input.rootEntrypoint, ROOT_ENTRYPOINT_PATH)
  ) {
    diagnostics.add('repository-public-export');
  }
  if (
    /(?:OpenCode|opencode|TeamRosterPersistenceRepository)/.test(input.contracts) ||
    /(?:OpenCode|opencode)/.test(input.composition)
  ) {
    diagnostics.add('roster-contract-provider-leakage');
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

describe('TeamDataService roster-persistence boundary', () => {
  it('keeps the five compatibility methods thin over the internal repository', () => {
    expect(
      scanBoundary({
        service: source(SERVICE_PATH),
        repository: source(REPOSITORY_PATH),
        composition: source(COMPOSITION_PATH),
        mainEntrypoint: source(MAIN_ENTRYPOINT_PATH),
        rootEntrypoint: source(ROOT_ENTRYPOINT_PATH),
        contracts: `${source(CONTRACTS_ENTRYPOINT_PATH)}\n${source(CONTRACTS_CHANNELS_PATH)}`,
      })
    ).toEqual([]);
  });

  it('rejects restored facade logic, public export, runtime ownership, and contract leakage', () => {
    const serviceFixture = `
      import {
        createTeamRosterPersistenceRepository,
        type TeamRosterPersistenceRepositoryPort,
        TeamRosterPersistenceRepository,
      } from '@features/team-roster-mutations/main/adapters/output/TeamRosterPersistenceRepository';
      export class TeamDataService {
        private rosterPersistenceRepository: TeamRosterPersistenceRepository;
        private ensureMemberInMeta(): void {}
        addMember(): void {}
        updateMemberRole(): void {}
        replaceMembers(): void {}
        removeMember(): void {}
        restoreMember(): void {}
      }
    `;
    const repositoryFixture = `
      import { TeamRuntimeControl } from '@features/team-runtime-control';
      export class TeamRosterPersistenceRepository extends TeamRuntimeControl {
        addMember(): void { this.attach(); }
      }
    `;
    const compositionFixture = `
      import { TeamRuntimeControl } from '@features/team-runtime-control';
      export interface TeamRosterPersistenceRepositoryPort {
        addMember(): void;
      }
      export function createTeamRosterPersistenceRepository(): TeamRosterPersistenceRepositoryPort {
        new TeamRuntimeControl().start();
        return { addMember(): void {} };
      }
    `;

    expect(
      scanBoundary({
        service: serviceFixture,
        repository: repositoryFixture,
        composition: compositionFixture,
        mainEntrypoint:
          "export { TeamRosterPersistenceRepository } from './adapters/output/TeamRosterPersistenceRepository';",
        rootEntrypoint: 'export {};',
        contracts: 'export interface OpenCodeRosterContract {}',
      })
    ).toEqual([
      'facade-delegation-missing',
      'facade-direct-roster-ownership',
      'factory-call-missing',
      'factory-call-ports-missing',
      'factory-public-export-missing',
      'persistence-port-public-export-missing',
      'persistence-port-usage-missing',
      'repository-concrete-adapter-import',
      'repository-factory-invalid',
      'repository-import-path-invalid',
      'repository-inheritance',
      'repository-method-missing',
      'repository-port-invalid',
      'repository-public-export',
      'repository-runtime-control-owner',
      'roster-contract-provider-leakage',
    ]);
  });
});
