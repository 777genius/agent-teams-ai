import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FACADE_PATH = 'src/main/services/team/TeamDataService.ts';
const READ_MODEL_PATH = 'src/main/services/team/TeamTaskReadModelService.ts';
const READ_MODEL_NAME = 'TeamTaskReadModelService';
const READ_MODEL_MODULE = './TeamTaskReadModelService';
const REQUIRED_CONSTRUCTION_PORTS = new Set([
  'taskReader',
  'configReader',
  'kanbanReader',
  'readTask',
  'invalidateGlobalTaskProjectionCache',
  'logDebug',
]);
const REQUIRED_PORT_INTERFACES = new Set([
  'TeamTaskReadModelReaderPort',
  'TeamTaskReadModelConfigReaderPort',
  'TeamTaskReadModelKanbanReaderPort',
  'TeamTaskReadModelServicePorts',
]);
const DELEGATED_METHODS = [
  'getTask',
  'setTaskChangePresenceServices',
  'setTaskChangePresenceTracking',
  'getTaskChangePresence',
  'getAllTasks',
  'getDeletedTasks',
] as const;
const VOID_DELEGATED_METHODS = new Set([
  'setTaskChangePresenceServices',
  'setTaskChangePresenceTracking',
]);
const DIRECT_INVALIDATING_MUTATIONS = [
  'updateTaskStatus',
  'softDeleteTask',
  'restoreTask',
  'updateTaskOwner',
  'updateTaskFields',
  'addTaskAttachment',
  'removeTaskAttachment',
  'setTaskNeedsClarification',
  'addTaskRelationship',
  'removeTaskRelationship',
  'addTaskComment',
] as const;
const MOVED_DECLARATIONS = new Set([
  'TASK_MAP_YIELD_EVERY',
  'GLOBAL_TASK_TEAM_CONFIG_CONCURRENCY',
  'TaskChangeLogSourceSnapshot',
  'GlobalTaskTeamInfo',
  'mapLimitLocal',
  'readGlobalTaskTeamInfoFromListTeams',
  'readGlobalTaskTeamInfo',
  'invalidateGlobalTaskProjectionCache',
  'readTasksForUiSnapshot',
  'resolveTaskReviewState',
  'attachKanbanCompatibility',
  'resolveTaskKanbanColumn',
  'resolveReviewerFromHistory',
  'resolveTaskChangePresenceMap',
]);
const REQUIRED_READ_MODEL_METHODS = new Set([
  'readGlobalTaskTeamInfoFromListTeams',
  'readGlobalTaskTeamInfo',
  'invalidateGlobalTaskProjectionCache',
  'readTasksForUiSnapshot',
  'resolveTaskReviewState',
  'attachKanbanCompatibility',
  'getTask',
  'resolveTaskKanbanColumn',
  'resolveReviewerFromHistory',
  'setTaskChangePresenceServices',
  'setTaskChangePresenceTracking',
  'resolveTaskChangePresenceMap',
  'getTaskChangePresence',
  'getAllTasks',
  'getDeletedTasks',
]);
const FORBIDDEN_READ_MODEL_IMPORT =
  /(?:agent-teams-controller|TeamDataService|TeamProvisioning|provisioning|opencode|OpenCode|electron|fastify)/;
const CONCRETE_READER_IMPORTS = new Set([
  'TeamTaskReader',
  'TeamConfigReader',
  'TeamKanbanManager',
]);

type BoundaryDiagnostic =
  | 'cache-invalidator-injection-invalid'
  | 'concrete-reader-dependency'
  | 'facade-delegation-missing'
  | 'facade-direct-read-model-ownership'
  | 'facade-static-invalidation-duplicated'
  | 'mutation-invalidation-not-exact-once'
  | 'read-model-construction-missing'
  | 'read-model-construction-ports-missing'
  | 'read-model-forbidden-dependency'
  | 'read-model-import-missing'
  | 'read-model-import-path-invalid'
  | 'read-model-inheritance'
  | 'read-model-method-missing'
  | 'read-model-port-interface-missing'
  | 'read-model-self-invalidation-invalid';

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

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return declarationName(node);
  }
  return null;
}

function isReadModelCall(node: ts.CallExpression, methodName: string): boolean {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== methodName) {
    return false;
  }
  const receiver = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === 'taskReadModelService' &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

function countCalls(node: ts.Node, predicate: (call: ts.CallExpression) => boolean): number {
  let count = 0;
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate) && predicate(candidate)) count += 1;
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return count;
}

function isThinReadModelDelegate(node: ts.MethodDeclaration, methodName: string): boolean {
  if (node.body?.statements.length !== 1) return false;
  const statement = node.body.statements[0];
  let statementExpression: ts.Expression | undefined;
  if (VOID_DELEGATED_METHODS.has(methodName)) {
    if (!ts.isExpressionStatement(statement)) return false;
    statementExpression = statement.expression;
  } else {
    if (!ts.isReturnStatement(statement) || !statement.expression) return false;
    statementExpression = statement.expression;
  }
  const expression = ts.isAwaitExpression(statementExpression)
    ? statementExpression.expression
    : statementExpression;
  return ts.isCallExpression(expression) && isReadModelCall(expression, methodName);
}

function methodFixture(contents: string): ts.MethodDeclaration {
  const file = parse('TeamDataService.fixture.ts', `class TeamDataService { ${contents} }`);
  const classDeclaration = file.statements.find(ts.isClassDeclaration);
  const method = classDeclaration?.members.find(ts.isMethodDeclaration);
  if (!method) throw new Error('Fixture must contain a method declaration');
  return method;
}

function isStaticTaskReaderInvalidation(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'invalidateAllTasksCache' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'TeamTaskReader'
  );
}

function isPortInvalidation(node: ts.CallExpression): boolean {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== 'invalidateGlobalTaskProjectionCache'
  ) {
    return false;
  }
  const receiver = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === 'ports' &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

function scanBoundary(facadeContents: string, readModelContents: string): BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const facadeFile = parse(FACADE_PATH, facadeContents);
  let readModelImportFound = false;
  let constructionFound = false;
  const constructionPorts = new Set<string>();
  const delegates = new Set<string>();
  const mutationInvalidations = new Map<string, number>();
  let staticInvalidationCount = 0;
  let injectedStaticInvalidationCount = 0;

  const visitFacade = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importedNames(node).includes(READ_MODEL_NAME)) {
      readModelImportFound = true;
      if (
        !ts.isStringLiteralLike(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== READ_MODEL_MODULE
      ) {
        diagnostics.add('read-model-import-path-invalid');
      }
    }
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      MOVED_DECLARATIONS.has(declarationName(node) ?? '')
    ) {
      diagnostics.add('facade-direct-read-model-ownership');
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === READ_MODEL_NAME
    ) {
      constructionFound = true;
      const ports = node.arguments?.[0];
      if (ports && ts.isObjectLiteralExpression(ports)) {
        for (const property of ports.properties) {
          const name = propertyName(property);
          if (name) constructionPorts.add(name);
          if (
            name === 'invalidateGlobalTaskProjectionCache' &&
            (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))
          ) {
            injectedStaticInvalidationCount += countCalls(property, isStaticTaskReaderInvalidation);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && isStaticTaskReaderInvalidation(node)) {
      staticInvalidationCount += 1;
    }
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (
        name &&
        DELEGATED_METHODS.includes(name as (typeof DELEGATED_METHODS)[number]) &&
        isThinReadModelDelegate(node, name)
      ) {
        delegates.add(name);
      }
      if (
        name &&
        DIRECT_INVALIDATING_MUTATIONS.includes(
          name as (typeof DIRECT_INVALIDATING_MUTATIONS)[number]
        )
      ) {
        mutationInvalidations.set(
          name,
          countCalls(node, (call) => isReadModelCall(call, 'invalidateGlobalTaskProjectionCache'))
        );
      }
    }
    ts.forEachChild(node, visitFacade);
  };
  visitFacade(facadeFile);

  if (!readModelImportFound) diagnostics.add('read-model-import-missing');
  if (!constructionFound) diagnostics.add('read-model-construction-missing');
  if ([...REQUIRED_CONSTRUCTION_PORTS].some((name) => !constructionPorts.has(name))) {
    diagnostics.add('read-model-construction-ports-missing');
  }
  if (DELEGATED_METHODS.some((name) => !delegates.has(name))) {
    diagnostics.add('facade-delegation-missing');
  }
  if (DIRECT_INVALIDATING_MUTATIONS.some((name) => mutationInvalidations.get(name) !== 1)) {
    diagnostics.add('mutation-invalidation-not-exact-once');
  }
  if (staticInvalidationCount !== 1) {
    diagnostics.add('facade-static-invalidation-duplicated');
  }
  if (injectedStaticInvalidationCount !== 1) {
    diagnostics.add('cache-invalidator-injection-invalid');
  }

  const readModelFile = parse(READ_MODEL_PATH, readModelContents);
  const portInterfaces = new Set<string>();
  const readModelMethods = new Set<string>();
  let readModelInvalidationCount = 0;

  const visitReadModel = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (FORBIDDEN_READ_MODEL_IMPORT.test(node.moduleSpecifier.text)) {
        diagnostics.add('read-model-forbidden-dependency');
      }
      if (importedNames(node).some((name) => CONCRETE_READER_IMPORTS.has(name))) {
        diagnostics.add('concrete-reader-dependency');
      }
    }
    if (ts.isInterfaceDeclaration(node)) {
      portInterfaces.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name?.text === READ_MODEL_NAME) {
      if (
        node.heritageClauses?.some(
          (clause) =>
            clause.token === ts.SyntaxKind.ExtendsKeyword ||
            clause.token === ts.SyntaxKind.ImplementsKeyword
        )
      ) {
        diagnostics.add('read-model-inheritance');
      }
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member)) {
          const name = declarationName(member);
          if (name) readModelMethods.add(name);
          if (name === 'invalidateGlobalTaskProjectionCache') {
            readModelInvalidationCount = countCalls(member, isPortInvalidation);
          }
        }
      }
    }
    ts.forEachChild(node, visitReadModel);
  };
  visitReadModel(readModelFile);

  if ([...REQUIRED_PORT_INTERFACES].some((name) => !portInterfaces.has(name))) {
    diagnostics.add('read-model-port-interface-missing');
  }
  if ([...REQUIRED_READ_MODEL_METHODS].some((name) => !readModelMethods.has(name))) {
    diagnostics.add('read-model-method-missing');
  }
  if (readModelInvalidationCount !== 1) {
    diagnostics.add('read-model-self-invalidation-invalid');
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

describe('TeamDataService task read-model boundary', () => {
  it.each([
    [
      'setTaskChangePresenceServices',
      `
        setTaskChangePresenceServices(repository: unknown, tracker: unknown): void {
          this.taskReadModelService.setTaskChangePresenceServices(repository, tracker);
        }
      `,
    ],
    [
      'setTaskChangePresenceTracking',
      `
        setTaskChangePresenceTracking(teamName: string, enabled: boolean): void {
          this.taskReadModelService.setTaskChangePresenceTracking(teamName, enabled);
        }
      `,
    ],
  ])('accepts one same-method void delegation for %s', (methodName, contents) => {
    expect(isThinReadModelDelegate(methodFixture(contents), methodName)).toBe(true);
  });

  it('keeps accepting one same-method value delegation as a return statement', () => {
    const method = methodFixture(`
      getTask(teamName: string, taskId: string): unknown {
        return this.taskReadModelService.getTask(teamName, taskId);
      }
    `);

    expect(isThinReadModelDelegate(method, 'getTask')).toBe(true);
  });

  it('rejects a value delegation without a return statement', () => {
    const method = methodFixture(`
      getTask(teamName: string, taskId: string): unknown {
        this.taskReadModelService.getTask(teamName, taskId);
      }
    `);

    expect(isThinReadModelDelegate(method, 'getTask')).toBe(false);
  });

  it.each([
    [
      'missing delegation',
      `
        setTaskChangePresenceTracking(): void {}
      `,
    ],
    [
      'wrong target',
      `
        setTaskChangePresenceTracking(): void {
          this.otherService.setTaskChangePresenceTracking();
        }
      `,
    ],
    [
      'wrong method',
      `
        setTaskChangePresenceTracking(): void {
          this.taskReadModelService.setTaskChangePresenceServices();
        }
      `,
    ],
    [
      'multiple statements',
      `
        setTaskChangePresenceTracking(): void {
          this.taskReadModelService.setTaskChangePresenceTracking();
          this.taskReadModelService.setTaskChangePresenceTracking();
        }
      `,
    ],
  ])('rejects a void delegate with %s', (_caseName, contents) => {
    expect(isThinReadModelDelegate(methodFixture(contents), 'setTaskChangePresenceTracking')).toBe(
      false
    );
  });

  it('keeps task reads in one narrow service and cache invalidation exact-once', () => {
    expect(scanBoundary(source(FACADE_PATH), source(READ_MODEL_PATH))).toEqual([]);
  });

  it('rejects restored facade logic, missing delegates, and duplicate cache invalidation', () => {
    const facadeFixture = `
      import { TeamTaskReadModelService } from './TeamTaskReadModelService';
      import { TeamTaskReader } from './TeamTaskReader';
      const TASK_MAP_YIELD_EVERY = 250;
      export class TeamDataService {
        private taskReadModelService = new TeamTaskReadModelService({
          taskReader: {},
          configReader: {},
          kanbanReader: {},
          readTask: () => null,
          invalidateGlobalTaskProjectionCache: () => {
            TeamTaskReader.invalidateAllTasksCache();
            TeamTaskReader.invalidateAllTasksCache();
          },
          logDebug: () => undefined,
        });
        private resolveTaskReviewState(): void {}
        getTask(): void {}
        setTaskChangePresenceServices(): void {}
        setTaskChangePresenceTracking(): void {}
        getTaskChangePresence(): void {}
        getAllTasks(): void {}
        getDeletedTasks(): void {}
        updateTaskStatus(): void {
          this.taskReadModelService.invalidateGlobalTaskProjectionCache();
          this.taskReadModelService.invalidateGlobalTaskProjectionCache();
        }
      }
    `;

    expect(scanBoundary(facadeFixture, source(READ_MODEL_PATH))).toEqual([
      'cache-invalidator-injection-invalid',
      'facade-delegation-missing',
      'facade-direct-read-model-ownership',
      'facade-static-invalidation-duplicated',
      'mutation-invalidation-not-exact-once',
    ]);
  });

  it('rejects broad dependencies, inheritance, missing ports, and missing read-model behavior', () => {
    const readModelFixture = `
      import { TeamTaskReader } from './TeamTaskReader';
      import { TeamDataService } from './TeamDataService';
      export class TeamTaskReadModelService extends TeamDataService {
        invalidateGlobalTaskProjectionCache(): void {}
      }
    `;

    expect(scanBoundary(source(FACADE_PATH), readModelFixture)).toEqual([
      'concrete-reader-dependency',
      'read-model-forbidden-dependency',
      'read-model-inheritance',
      'read-model-method-missing',
      'read-model-port-interface-missing',
      'read-model-self-invalidation-invalid',
    ]);
  });
});
