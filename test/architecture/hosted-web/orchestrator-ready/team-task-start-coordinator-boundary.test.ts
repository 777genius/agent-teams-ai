import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const COORDINATOR_PATH = 'src/main/services/team/TeamTaskStartCoordinator.ts';
const TEAM_SERVICE_ENTRYPOINT_PATH = 'src/main/services/team/index.ts';
const COORDINATOR_NAME = 'TeamTaskStartCoordinator';
const COORDINATOR_MODULE = './TeamTaskStartCoordinator';
const DELEGATED_METHODS = [
  'createTask',
  'startTask',
  'startTaskByUser',
  'notifyLeadOnTeammateTaskStart',
] as const;
const EXTRACTED_DECLARATIONS = new Set([
  'notifiedTaskStarts',
  'createTaskWithOutcome',
  'readTaskCreateProjectPath',
  'sendUserTaskStartNotification',
  'sendDurableUserTaskStartNotification',
  'buildUserTaskStartNotification',
  'getTaskLabel',
  'isLeadOwner',
]);
const REQUIRED_COORDINATOR_METHODS = new Set([...DELEGATED_METHODS, 'createTaskWithOutcome']);

type BoundaryDiagnostic =
  | 'coordinator-import-missing'
  | 'coordinator-import-path-invalid'
  | 'coordinator-construction-missing'
  | 'facade-delegation-missing'
  | 'legacy-start-ownership'
  | 'coordinator-method-missing'
  | 'coordinator-provider-vocabulary'
  | 'coordinator-storage-or-lifecycle-owner'
  | 'coordinator-inheritance'
  | 'coordinator-public-barrel-export';

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test-owned paths.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
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

function isCoordinatorDelegateCall(node: ts.CallExpression, methodName: string): boolean {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== methodName) {
    return false;
  }
  const receiver = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === 'taskStartCoordinator' &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

function methodDelegates(node: ts.MethodDeclaration, methodName: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && isCoordinatorDelegateCall(child, methodName)) {
      found = true;
    }
    ts.forEachChild(child, visit);
  };
  if (node.body) visit(node.body);
  return found;
}

function scanBoundary(
  serviceContents: string,
  coordinatorContents: string,
  entrypointContents: string
): readonly BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const serviceFile = ts.createSourceFile(
    SERVICE_PATH,
    serviceContents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let coordinatorImportFound = false;
  let coordinatorConstructionFound = false;
  const delegatedMethods = new Set<string>();

  const visitService = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importedNames(node).includes(COORDINATOR_NAME)) {
      coordinatorImportFound = true;
      if (
        !ts.isStringLiteralLike(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== COORDINATOR_MODULE
      ) {
        diagnostics.add('coordinator-import-path-invalid');
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === COORDINATOR_NAME
    ) {
      coordinatorConstructionFound = true;
    }
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      EXTRACTED_DECLARATIONS.has(declarationName(node) ?? '')
    ) {
      diagnostics.add('legacy-start-ownership');
    }
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name && DELEGATED_METHODS.includes(name as (typeof DELEGATED_METHODS)[number])) {
        if (methodDelegates(node, name)) delegatedMethods.add(name);
      }
    }
    ts.forEachChild(node, visitService);
  };
  visitService(serviceFile);

  if (!coordinatorImportFound) diagnostics.add('coordinator-import-missing');
  if (!coordinatorConstructionFound) diagnostics.add('coordinator-construction-missing');
  if (DELEGATED_METHODS.some((methodName) => !delegatedMethods.has(methodName))) {
    diagnostics.add('facade-delegation-missing');
  }

  const coordinatorFile = ts.createSourceFile(
    COORDINATOR_PATH,
    coordinatorContents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const coordinatorMethods = new Set<string>();
  const forbiddenOwnershipImport =
    /(?:^node:|TeamTask(?:Reader|Writer)|TeamDataService|TeamProvisioning|Repository|Lifecycle|electron|fastify)/i;

  const visitCoordinator = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name) coordinatorMethods.add(name);
    }
    if (
      ts.isInterfaceDeclaration(node) &&
      /(?:OpenCode|opencode)/.test(node.getText(coordinatorFile))
    ) {
      diagnostics.add('coordinator-provider-vocabulary');
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      forbiddenOwnershipImport.test(node.moduleSpecifier.text)
    ) {
      diagnostics.add('coordinator-storage-or-lifecycle-owner');
    }
    if (
      ts.isClassDeclaration(node) &&
      node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ) {
      diagnostics.add('coordinator-inheritance');
    }
    ts.forEachChild(node, visitCoordinator);
  };
  visitCoordinator(coordinatorFile);

  if ([...REQUIRED_COORDINATOR_METHODS].some((name) => !coordinatorMethods.has(name))) {
    diagnostics.add('coordinator-method-missing');
  }
  if (
    /\b(?:writeFile|appendFile|mkdir|rm|unlink|rename|spawn|startRuntime|stopRuntime)\s*\(/.test(
      coordinatorContents
    )
  ) {
    diagnostics.add('coordinator-storage-or-lifecycle-owner');
  }

  const entrypointFile = ts.createSourceFile(
    TEAM_SERVICE_ENTRYPOINT_PATH,
    entrypointContents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const exportsCoordinator = entrypointFile.statements
    .filter(ts.isExportDeclaration)
    .some((statement) => {
      if (
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === COORDINATOR_MODULE
      ) {
        return true;
      }
      return (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(
          (element) => (element.propertyName ?? element.name).text === COORDINATOR_NAME
        )
      );
    });
  if (exportsCoordinator) diagnostics.add('coordinator-public-barrel-export');

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

describe('team task-start coordinator boundary', () => {
  it('keeps TeamDataService as a compatibility facade over one focused coordinator', () => {
    expect(
      scanBoundary(
        source(SERVICE_PATH),
        source(COORDINATOR_PATH),
        source(TEAM_SERVICE_ENTRYPOINT_PATH)
      )
    ).toEqual([]);
  });

  it('rejects retained facade behavior, provider vocabulary, inheritance, and a second owner', () => {
    const serviceFixture = `
      export class TeamDataService {
        private notifiedTaskStarts = new Set<string>();
        async createTask(): Promise<void> {}
        async startTask(): Promise<void> {}
        async startTaskByUser(): Promise<void> {}
        async notifyLeadOnTeammateTaskStart(): Promise<void> {}
      }
    `;
    const coordinatorFixture = `
      import { TeamTaskWriter } from './TeamTaskWriter';
      interface GenericStartPort { deliverThroughOpenCode(): void }
      export class TeamTaskStartCoordinator extends TeamTaskWriter {
        createTask(): void {}
      }
    `;
    const entrypointFixture = `
      export { TeamTaskStartCoordinator } from './TeamTaskStartCoordinator';
    `;

    expect(scanBoundary(serviceFixture, coordinatorFixture, entrypointFixture)).toEqual([
      'coordinator-construction-missing',
      'coordinator-import-missing',
      'coordinator-inheritance',
      'coordinator-method-missing',
      'coordinator-provider-vocabulary',
      'coordinator-public-barrel-export',
      'coordinator-storage-or-lifecycle-owner',
      'facade-delegation-missing',
      'legacy-start-ownership',
    ]);
  });

  it('ignores comments and strings that only describe retired ownership', () => {
    const serviceFixture = `
      import { TeamTaskStartCoordinator } from './TeamTaskStartCoordinator';
      export class TeamDataService {
        private taskStartCoordinator = new TeamTaskStartCoordinator({});
        // notifiedTaskStarts and createTaskWithOutcome moved out.
        createTask() { return this.taskStartCoordinator.createTask(); }
        startTask() { return this.taskStartCoordinator.startTask(); }
        startTaskByUser() { return this.taskStartCoordinator.startTaskByUser(); }
        notifyLeadOnTeammateTaskStart() {
          return this.taskStartCoordinator.notifyLeadOnTeammateTaskStart();
        }
      }
    `;
    const coordinatorFixture = `
      export class TeamTaskStartCoordinator {
        constructor(_ports: unknown) {}
        createTask(): void {}
        createTaskWithOutcome(): void {}
        startTask(): void {}
        startTaskByUser(): void {}
        notifyLeadOnTeammateTaskStart(): void {}
      }
    `;

    expect(
      scanBoundary(serviceFixture, coordinatorFixture, 'export const unrelated = true;')
    ).toEqual([]);
  });
});
