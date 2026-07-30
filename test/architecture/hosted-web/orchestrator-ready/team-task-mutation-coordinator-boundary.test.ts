import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = process.cwd();
const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const COORDINATOR_PATH =
  'src/features/team-task-board/core/application/TeamTaskMutationCoordinator.ts';
const PORTS_PATH =
  'src/features/team-task-board/core/application/ports/TeamTaskMutationCoordinatorPorts.ts';
const MAIN_ENTRYPOINT_PATH = 'src/features/team-task-board/main/index.ts';
const TASK_BOARD_CORE_PATH = 'src/features/team-task-board/core';
const COORDINATOR_NAME = 'TeamTaskMutationCoordinator';
const COORDINATOR_PUBLIC_MODULE = '@features/team-task-board/main';
const DELEGATED_METHODS = [
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
  'requestReview',
  'updateKanban',
  'updateKanbanColumnOrder',
] as const;
const REQUIRED_PORTS = new Set([
  'taskBoards',
  'taskProjection',
  'leadContext',
  'identity',
  'clock',
]);
const REQUIRED_PORT_INTERFACES = new Set([
  'TaskMutationBoardPort',
  'TeamTaskMutationBoardPort',
  'TeamTaskMutationProjectionPort',
  'TeamTaskMutationLeadContextPort',
  'TeamTaskMutationIdentityPort',
  'TeamTaskMutationClockPort',
  'TeamTaskMutationCoordinatorPorts',
]);

type BoundaryDiagnostic =
  | 'coordinator-construction-missing'
  | 'coordinator-construction-ports-missing'
  | 'coordinator-import-missing'
  | 'coordinator-import-path-invalid'
  | 'coordinator-method-missing'
  | 'coordinator-port-interface-missing'
  | 'coordinator-public-export-missing'
  | 'core-electron-ipc-main-dependency'
  | 'facade-delegation-missing'
  | 'facade-retains-mutation-decision'
  | 'forbidden-lifecycle-runtime-provider-dependency'
  | 'outer-service-cast';

function source(path: string): string {
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

function isCoordinatorDelegateCall(node: ts.CallExpression, methodName: string): boolean {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== methodName) {
    return false;
  }
  const receiver = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === 'taskMutationCoordinator' &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

function isThinCoordinatorDelegate(node: ts.MethodDeclaration, methodName: string): boolean {
  if (!node.body || node.body.statements.length !== 1) return false;
  const statement = node.body.statements[0];
  return (
    ts.isReturnStatement(statement) &&
    statement.expression !== undefined &&
    ts.isCallExpression(statement.expression) &&
    isCoordinatorDelegateCall(statement.expression, methodName)
  );
}

function productionCoreSources(
  directory = resolve(REPOSITORY_ROOT, TASK_BOARD_CORE_PATH)
): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return productionCoreSources(absolutePath);
    }
    const repositoryPath = relative(REPOSITORY_ROOT, absolutePath).split('\\').join('/');
    return entry.isFile() && repositoryPath.endsWith('.ts') && !repositoryPath.endsWith('.test.ts')
      ? [repositoryPath]
      : [];
  });
}

function hasPublicCoordinatorExport(entrypointContents: string): boolean {
  return parseSource(MAIN_ENTRYPOINT_PATH, entrypointContents)
    .statements.filter(ts.isExportDeclaration)
    .some((statement) => {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        return false;
      }
      return statement.exportClause.elements.some(
        (element) => (element.propertyName ?? element.name).text === COORDINATOR_NAME
      );
    });
}

function scanBoundary(inputs: {
  serviceContents: string;
  coordinatorContents: string;
  portsContents: string;
  entrypointContents: string;
  coreSources: Readonly<Record<string, string>>;
}): readonly BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const serviceFile = parseSource(SERVICE_PATH, inputs.serviceContents);
  let coordinatorImportFound = false;
  let coordinatorConstructionFound = false;
  const wiredPorts = new Set<string>();
  const delegatedMethods = new Set<string>();

  const visitService = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importedNames(node).includes(COORDINATOR_NAME)) {
      coordinatorImportFound = true;
      if (
        !ts.isStringLiteralLike(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== COORDINATOR_PUBLIC_MODULE
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
      const ports = node.arguments?.[0];
      if (ports && ts.isObjectLiteralExpression(ports)) {
        for (const property of ports.properties) {
          const name = propertyName(property);
          if (name) wiredPorts.add(name);
        }
      }
    }
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name && DELEGATED_METHODS.includes(name as (typeof DELEGATED_METHODS)[number])) {
        if (isThinCoordinatorDelegate(node, name)) {
          delegatedMethods.add(name);
        } else {
          diagnostics.add('facade-retains-mutation-decision');
        }
      }
    }
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      /\b(?:TeamDataService|TeamTaskMutationCoordinatorPorts)\b/.test(
        node.type.getText(serviceFile)
      )
    ) {
      diagnostics.add('outer-service-cast');
    }
    ts.forEachChild(node, visitService);
  };
  visitService(serviceFile);

  if (!coordinatorImportFound) diagnostics.add('coordinator-import-missing');
  if (!coordinatorConstructionFound) diagnostics.add('coordinator-construction-missing');
  if ([...REQUIRED_PORTS].some((name) => !wiredPorts.has(name))) {
    diagnostics.add('coordinator-construction-ports-missing');
  }
  if (DELEGATED_METHODS.some((name) => !delegatedMethods.has(name))) {
    diagnostics.add('facade-delegation-missing');
  }

  const coordinatorFile = parseSource(COORDINATOR_PATH, inputs.coordinatorContents);
  const coordinatorMethods = new Set<string>();
  const visitCoordinator = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name) coordinatorMethods.add(name);
    }
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      /\bTeamDataService\b/.test(node.type.getText(coordinatorFile))
    ) {
      diagnostics.add('outer-service-cast');
    }
    ts.forEachChild(node, visitCoordinator);
  };
  visitCoordinator(coordinatorFile);
  if (DELEGATED_METHODS.some((name) => !coordinatorMethods.has(name))) {
    diagnostics.add('coordinator-method-missing');
  }

  const portInterfaces = new Set(
    parseSource(PORTS_PATH, inputs.portsContents)
      .statements.filter(ts.isInterfaceDeclaration)
      .map((statement) => statement.name.text)
  );
  if ([...REQUIRED_PORT_INTERFACES].some((name) => !portInterfaces.has(name))) {
    diagnostics.add('coordinator-port-interface-missing');
  }
  if (!hasPublicCoordinatorExport(inputs.entrypointContents)) {
    diagnostics.add('coordinator-public-export-missing');
  }

  for (const [path, contents] of Object.entries(inputs.coreSources)) {
    const sourceFile = parseSource(path, contents);
    for (const statement of sourceFile.statements.filter(ts.isImportDeclaration)) {
      if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (
        /(?:^electron$|ipc|@main(?:\/|$)|(?:^|\/)main\/services(?:\/|$)|src\/main)/i.test(specifier)
      ) {
        diagnostics.add('core-electron-ipc-main-dependency');
      }
      if (
        /(?:team-runtime-control|team-runtime-recovery|provider|opencode|process-supervision|lifecycle-command)/i.test(
          specifier
        )
      ) {
        diagnostics.add('forbidden-lifecycle-runtime-provider-dependency');
      }
    }
    if (/\b(?:OpenCode|opencode)\b/.test(contents)) {
      diagnostics.add('forbidden-lifecycle-runtime-provider-dependency');
    }
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

function currentInputs() {
  return {
    serviceContents: source(SERVICE_PATH),
    coordinatorContents: source(COORDINATOR_PATH),
    portsContents: source(PORTS_PATH),
    entrypointContents: source(MAIN_ENTRYPOINT_PATH),
    coreSources: Object.fromEntries(productionCoreSources().map((path) => [path, source(path)])),
  };
}

describe('team task-mutation coordinator boundary', () => {
  it('keeps TeamDataService as a one-line facade over feature-owned narrow ports', () => {
    expect(scanBoundary(currentInputs())).toEqual([]);
  });

  it('rejects facade decisions, outer-service casts, and runtime-bound task-board core', () => {
    const fixture = currentInputs();
    fixture.serviceContents = `
      import { TeamTaskMutationCoordinator } from './TeamTaskMutationCoordinator';
      export class TeamDataService {
        private taskMutationCoordinator =
          {} as TeamTaskMutationCoordinatorPorts;
        updateTaskStatus() { this.getTaskBoard().setTaskStatus(); }
      }
    `;
    fixture.coordinatorContents = `
      import { runLifecycleCommand } from '@features/team-runtime-control/main';
      import type { TeamDataService } from '@main/services/team/TeamDataService';
      export class TeamTaskMutationCoordinator {
        updateTaskStatus(host: unknown) { return host as TeamDataService; }
      }
    `;
    fixture.portsContents = 'export interface TaskMutationBoardPort {}';
    fixture.entrypointContents = 'export const unrelated = true;';
    fixture.coreSources = {
      [COORDINATOR_PATH]: fixture.coordinatorContents,
      'src/features/team-task-board/core/application/BadIpcDependency.ts':
        "import { ipcMain } from 'electron';",
    };

    expect(scanBoundary(fixture)).toEqual([
      'coordinator-construction-missing',
      'coordinator-construction-ports-missing',
      'coordinator-import-path-invalid',
      'coordinator-method-missing',
      'coordinator-port-interface-missing',
      'coordinator-public-export-missing',
      'core-electron-ipc-main-dependency',
      'facade-delegation-missing',
      'facade-retains-mutation-decision',
      'forbidden-lifecycle-runtime-provider-dependency',
      'outer-service-cast',
    ]);
  });
});
