import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = process.cwd();
const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const COMPOSITION_PATH = 'src/main/services/team/TeamDataServiceFeatureComposition.ts';
const LEGACY_COORDINATOR_PATH = 'src/main/services/team/TeamTaskStartCoordinator.ts';
const FEATURE_COORDINATOR_PATH =
  'src/features/team-task-board/main/application/TeamTaskStartCoordinator.ts';
const FEATURE_MAIN_ENTRYPOINT_PATH = 'src/features/team-task-board/main/index.ts';
const COORDINATOR_NAME = 'TeamTaskStartCoordinator';
const LEGACY_COORDINATOR_MODULE = './TeamTaskStartCoordinator';
const FEATURE_PUBLIC_MODULE = '@features/team-task-board/main';
const FEATURE_COORDINATOR_MODULE = './application/TeamTaskStartCoordinator';
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
const REQUIRED_BOARD_PORT_METHODS = new Set([
  'getTask',
  'listTasks',
  'listDeletedTasks',
  'createTask',
  'startTask',
  'reconcileTaskCreation',
]);
const REQUIRED_PUBLIC_EXPORTS = new Set([
  COORDINATOR_NAME,
  'TeamTaskCreateOutcome',
  'TeamTaskStartBoardPort',
  'TeamTaskStartCoordinatorPorts',
]);

type BoundaryDiagnostic =
  | 'coordinator-construction-missing'
  | 'coordinator-controller-dependency'
  | 'coordinator-import-missing'
  | 'coordinator-import-path-invalid'
  | 'coordinator-inheritance'
  | 'coordinator-method-missing'
  | 'coordinator-provider-or-owner-leakage'
  | 'coordinator-public-export-missing'
  | 'facade-delegation-missing'
  | 'legacy-re-export-invalid'
  | 'legacy-start-ownership'
  | 'start-board-port-broad'
  | 'start-board-port-missing';

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test-owned paths.
  return readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8');
}

function parseSource(path: string, contents = source(path)): ts.SourceFile {
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

function exportedNames(sourceFile: ts.SourceFile, moduleSpecifier: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements.filter(ts.isExportDeclaration)) {
    if (
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      names.add((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

function isCoordinatorDelegateCall(node: ts.CallExpression, methodName: string): boolean {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== methodName) {
    return false;
  }
  const receiver = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === 'taskStartCoordinator' &&
    (receiver.expression.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === 'features' &&
        receiver.expression.expression.kind === ts.SyntaxKind.ThisKeyword))
  );
}

function isThinCoordinatorDelegate(node: ts.MethodDeclaration, methodName: string): boolean {
  if (!node.body || node.body.statements.length !== 1) return false;
  const statement = node.body.statements[0];
  if (ts.isReturnStatement(statement)) {
    return (
      statement.expression !== undefined &&
      ts.isCallExpression(statement.expression) &&
      isCoordinatorDelegateCall(statement.expression, methodName)
    );
  }
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = ts.isAwaitExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression;
  return ts.isCallExpression(expression) && isCoordinatorDelegateCall(expression, methodName);
}

function scanBoundary(inputs: {
  serviceContents: string;
  legacyCoordinatorContents: string;
  featureCoordinatorContents: string;
  featureEntrypointContents: string;
}): readonly BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const serviceFile = parseSource(SERVICE_PATH, inputs.serviceContents);
  let coordinatorImportFound = false;
  let coordinatorConstructionFound = false;
  const delegatedMethods = new Set<string>();

  const visitService = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importedNames(node).includes(COORDINATOR_NAME)) {
      coordinatorImportFound = true;
      if (
        !ts.isStringLiteralLike(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== LEGACY_COORDINATOR_MODULE
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
        if (isThinCoordinatorDelegate(node, name)) {
          delegatedMethods.add(name);
        } else {
          diagnostics.add('legacy-start-ownership');
        }
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

  const featureCoordinatorFile = parseSource(
    FEATURE_COORDINATOR_PATH,
    inputs.featureCoordinatorContents
  );
  const coordinatorMethods = new Set<string>();
  let boardPortFound = false;
  let coordinatorPortsUseBoardPort = false;

  const visitCoordinator = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name) coordinatorMethods.add(name);
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'TeamTaskStartBoardPort') {
      boardPortFound = true;
      const methods = new Set(
        node.members
          .map((member) => declarationName(member))
          .filter((name): name is string => name !== null)
      );
      if (
        [...REQUIRED_BOARD_PORT_METHODS].some((name) => !methods.has(name)) ||
        [...methods].some((name) => !REQUIRED_BOARD_PORT_METHODS.has(name))
      ) {
        diagnostics.add('start-board-port-broad');
      }
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'TeamTaskStartCoordinatorPorts') {
      coordinatorPortsUseBoardPort = node.members.some(
        (member) =>
          declarationName(member) === 'getTaskBoard' &&
          member.getText(featureCoordinatorFile).includes('TeamTaskStartBoardPort')
      );
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      /(?:agent-teams-controller|^@main(?:\/|$)|(?:^|\/)main\/services(?:\/|$))/i.test(
        node.moduleSpecifier.text
      )
    ) {
      diagnostics.add('coordinator-controller-dependency');
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      /(?:^node:|electron|fastify|provider|opencode|runtime|lifecycle|repository|storage)/i.test(
        node.moduleSpecifier.text
      )
    ) {
      diagnostics.add('coordinator-provider-or-owner-leakage');
    }
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      /\b(?:AgentTeamsController|TeamDataService|OpenCode|opencode)\b/.test(
        node.getText(featureCoordinatorFile)
      )
    ) {
      diagnostics.add('coordinator-controller-dependency');
    }
    if (
      ts.isClassDeclaration(node) &&
      node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ) {
      diagnostics.add('coordinator-inheritance');
    }
    ts.forEachChild(node, visitCoordinator);
  };
  visitCoordinator(featureCoordinatorFile);

  if ([...REQUIRED_COORDINATOR_METHODS].some((name) => !coordinatorMethods.has(name))) {
    diagnostics.add('coordinator-method-missing');
  }
  if (!boardPortFound || !coordinatorPortsUseBoardPort) {
    diagnostics.add('start-board-port-missing');
  }
  if (
    /\b(?:writeFile|appendFile|mkdir|rm|unlink|rename|spawn|startRuntime|stopRuntime)\s*\(/.test(
      inputs.featureCoordinatorContents
    )
  ) {
    diagnostics.add('coordinator-provider-or-owner-leakage');
  }

  const featureExports = exportedNames(
    parseSource(FEATURE_MAIN_ENTRYPOINT_PATH, inputs.featureEntrypointContents),
    FEATURE_COORDINATOR_MODULE
  );
  if ([...REQUIRED_PUBLIC_EXPORTS].some((name) => !featureExports.has(name))) {
    diagnostics.add('coordinator-public-export-missing');
  }

  const legacyCoordinatorFile = parseSource(
    LEGACY_COORDINATOR_PATH,
    inputs.legacyCoordinatorContents
  );
  const legacyExports = exportedNames(legacyCoordinatorFile, FEATURE_PUBLIC_MODULE);
  const legacyIsOnlyNamedPublicReExports = legacyCoordinatorFile.statements.every(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === FEATURE_PUBLIC_MODULE &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
  );
  if (
    !legacyIsOnlyNamedPublicReExports ||
    [...REQUIRED_PUBLIC_EXPORTS].some((name) => !legacyExports.has(name))
  ) {
    diagnostics.add('legacy-re-export-invalid');
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

function currentInputs() {
  return {
    serviceContents: `${source(SERVICE_PATH)}\n${source(COMPOSITION_PATH)}`,
    legacyCoordinatorContents: source(LEGACY_COORDINATOR_PATH),
    featureCoordinatorContents: source(FEATURE_COORDINATOR_PATH),
    featureEntrypointContents: source(FEATURE_MAIN_ENTRYPOINT_PATH),
  };
}

describe('team task-start coordinator boundary', () => {
  it('owns task-start coordination behind the public feature boundary and a narrow board port', () => {
    expect(scanBoundary(currentInputs())).toEqual([]);
  });

  it('rejects a broad controller, provider ownership, retained facade behavior, and active shim', () => {
    const fixture = currentInputs();
    fixture.serviceContents = `
      export class TeamDataService {
        private notifiedTaskStarts = new Set<string>();
        async createTask(): Promise<void> {}
        async startTask(): Promise<void> {}
      }
    `;
    fixture.featureCoordinatorContents = `
      import type { AgentTeamsController } from 'agent-teams-controller';
      import { spawn } from 'node:child_process';
      interface TeamTaskStartBoardPort {
        createTask(input: object): unknown;
        stopRuntime(): void;
      }
      export class TeamTaskStartCoordinator extends AgentTeamsController {
        createTask(): void { spawn('provider'); }
      }
    `;
    fixture.featureEntrypointContents = 'export const unrelated = true;';
    fixture.legacyCoordinatorContents = `
      export class TeamTaskStartCoordinator {
        startTask(): void {}
      }
    `;

    expect(scanBoundary(fixture)).toEqual([
      'coordinator-construction-missing',
      'coordinator-controller-dependency',
      'coordinator-import-missing',
      'coordinator-inheritance',
      'coordinator-method-missing',
      'coordinator-provider-or-owner-leakage',
      'coordinator-public-export-missing',
      'facade-delegation-missing',
      'legacy-re-export-invalid',
      'legacy-start-ownership',
      'start-board-port-broad',
      'start-board-port-missing',
    ]);
  });
});
