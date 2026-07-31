import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const OWNED_PATHS = Object.freeze([
  'src/features/team-task-board/index.ts',
  'src/features/team-task-board/core/application/ports/TeamArtifactReconciliationPorts.ts',
  'src/features/team-task-board/core/application/TeamArtifactReconciliationCoordinator.ts',
  'src/features/team-task-board/core/application/TeamArtifactReconciliationCoordinator.test.ts',
  'src/main/services/team/TeamDataService.ts',
  'test/architecture/hosted-web/orchestrator-ready/team-artifact-reconciliation-boundary.test.ts',
]);
const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const COMPOSITION_PATH = 'src/main/services/team/TeamDataServiceFeatureComposition.ts';
const COORDINATOR_PATH =
  'src/features/team-task-board/core/application/TeamArtifactReconciliationCoordinator.ts';
const PORTS_PATH =
  'src/features/team-task-board/core/application/ports/TeamArtifactReconciliationPorts.ts';
const ROOT_ENTRYPOINT_PATH = 'src/features/team-task-board/index.ts';
const PUBLIC_MODULE = '@features/team-task-board';
const COORDINATOR_NAME = 'TeamArtifactReconciliationCoordinator';
const REQUIRED_PORTS = new Set(['maintenance', 'clock', 'logger']);
const REQUIRED_PORT_INTERFACES = new Set([
  'TeamArtifactMaintenanceReconciliationRequest',
  'TeamArtifactMaintenanceReconciliationPort',
  'TeamArtifactReconciliationMonotonicClockPort',
  'TeamArtifactReconciliationWarningLoggerPort',
  'TeamArtifactReconciliationPorts',
]);
const REQUIRED_PUBLIC_EXPORTS = new Set([
  COORDINATOR_NAME,
  ...REQUIRED_PORT_INTERFACES,
  'TeamArtifactReconciliationResult',
  'TeamArtifactReconciliationTrigger',
]);
const RETIRED_SERVICE_IDENTIFIERS = new Set([
  'FileWatchReconcileDiagnostics',
  'fileWatchReconcileDiagnostics',
  'triggerSource',
  'triggerDetail',
  'concurrentAtStart',
  'shouldLogPressure',
]);

type BoundaryDiagnostic =
  | 'clock-adapter-not-direct'
  | 'controller-maintenance-adapter-missing'
  | 'coordinator-construction-missing'
  | 'coordinator-construction-ports-missing'
  | 'coordinator-import-missing'
  | 'coordinator-import-path-invalid'
  | 'coordinator-state-missing'
  | 'core-forbidden-dependency'
  | 'facade-delegation-missing'
  | 'forbidden-owner-or-composition'
  | 'generic-contract-provider-vocabulary'
  | 'legacy-reconciliation-ownership'
  | 'port-interface-missing'
  | 'public-export-missing';

interface BoundaryInputs {
  serviceContents: string;
  coordinatorContents: string;
  portsContents: string;
  entrypointContents: string;
}

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test-owned paths.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function parseSource(path: string, contents: string): ts.SourceFile {
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

function isOneLineFacadeDelegate(node: ts.MethodDeclaration): boolean {
  if (declarationName(node) !== 'reconcileTeamArtifacts' || node.body?.statements.length !== 1) {
    return false;
  }
  const statement = node.body.statements[0];
  if (
    !ts.isReturnStatement(statement) ||
    !statement.expression ||
    !ts.isCallExpression(statement.expression) ||
    !ts.isPropertyAccessExpression(statement.expression.expression) ||
    statement.expression.expression.name.text !== 'reconcile'
  ) {
    return false;
  }
  const receiver = statement.expression.expression.expression;
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === 'artifactReconciliationCoordinator' &&
    (receiver.expression.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === 'features' &&
        receiver.expression.expression.kind === ts.SyntaxKind.ThisKeyword))
  );
}

function isDirectDateNowPort(node: ts.ObjectLiteralElementLike): boolean {
  if (
    !ts.isPropertyAssignment(node) ||
    declarationName(node) !== 'nowMs' ||
    !ts.isArrowFunction(node.initializer) ||
    node.initializer.parameters.length !== 0
  ) {
    return false;
  }
  const readNow = node.initializer;
  if (
    !ts.isArrowFunction(readNow) ||
    readNow.parameters.length !== 0 ||
    !ts.isCallExpression(readNow.body) ||
    readNow.body.arguments.length !== 0 ||
    !ts.isPropertyAccessExpression(readNow.body.expression)
  ) {
    return false;
  }
  return (
    ts.isIdentifier(readNow.body.expression.expression) &&
    readNow.body.expression.expression.text === 'Date' &&
    readNow.body.expression.name.text === 'now'
  );
}

function publicExportNames(entrypointContents: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of parseSource(ROOT_ENTRYPOINT_PATH, entrypointContents).statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      names.add((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

function scanBoundary(inputs: BoundaryInputs): readonly BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const serviceFile = parseSource(SERVICE_PATH, inputs.serviceContents);
  let coordinatorImportFound = false;
  let coordinatorConstructionFound = false;
  let maintenanceAdapterFound = false;
  let directClockAdapterFound = false;
  let directDateNowConstructionFound = false;
  let facadeDelegationFound = false;
  const wiredPorts = new Set<string>();

  const visitService = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importedNames(node).includes(COORDINATOR_NAME)) {
      coordinatorImportFound = true;
      if (
        !ts.isStringLiteralLike(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== PUBLIC_MODULE
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
          if (
            name === 'maintenance' &&
            /\bports\.reconcileArtifacts\s*\(/.test(property.getText(serviceFile))
          ) {
            maintenanceAdapterFound = true;
          }
          if (name === 'clock' && /\bports\.nowMs\s*\(/.test(property.getText(serviceFile))) {
            directClockAdapterFound = true;
          }
        }
      }
    }
    if (ts.isPropertyAssignment(node) && isDirectDateNowPort(node)) {
      directDateNowConstructionFound = true;
    }
    if (ts.isMethodDeclaration(node) && isOneLineFacadeDelegate(node)) {
      facadeDelegationFound = true;
    }
    if (
      (ts.isInterfaceDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      RETIRED_SERVICE_IDENTIFIERS.has(declarationName(node) ?? '')
    ) {
      diagnostics.add('legacy-reconciliation-ownership');
    }
    ts.forEachChild(node, visitService);
  };
  visitService(serviceFile);

  if (!coordinatorImportFound) diagnostics.add('coordinator-import-missing');
  if (!coordinatorConstructionFound) diagnostics.add('coordinator-construction-missing');
  if ([...REQUIRED_PORTS].some((name) => !wiredPorts.has(name))) {
    diagnostics.add('coordinator-construction-ports-missing');
  }
  if (!maintenanceAdapterFound) diagnostics.add('controller-maintenance-adapter-missing');
  if (!directClockAdapterFound || !directDateNowConstructionFound) {
    diagnostics.add('clock-adapter-not-direct');
  }
  if (!facadeDelegationFound) diagnostics.add('facade-delegation-missing');

  const coordinatorFile = parseSource(COORDINATOR_PATH, inputs.coordinatorContents);
  let coordinatorStateFound = false;
  const visitCoordinator = (node: ts.Node): void => {
    if (
      ts.isPropertyDeclaration(node) &&
      declarationName(node) === 'diagnosticsByTeam' &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.expression.getText(coordinatorFile) === 'Map'
    ) {
      coordinatorStateFound = true;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (
        /(?:^node:|electron|fastify|@main(?:\/|$)|@renderer(?:\/|$)|@preload(?:\/|$)|team-runtime-control|process-supervision|lifecycle|provider)/i.test(
          specifier
        )
      ) {
        diagnostics.add('core-forbidden-dependency');
      }
    }
    ts.forEachChild(node, visitCoordinator);
  };
  visitCoordinator(coordinatorFile);
  if (!coordinatorStateFound) diagnostics.add('coordinator-state-missing');

  const portInterfaces = new Set(
    parseSource(PORTS_PATH, inputs.portsContents)
      .statements.filter(ts.isInterfaceDeclaration)
      .map((statement) => statement.name.text)
  );
  if ([...REQUIRED_PORT_INTERFACES].some((name) => !portInterfaces.has(name))) {
    diagnostics.add('port-interface-missing');
  }
  if (/(?:OpenCode|opencode|Claude|Codex|agent-teams-controller)/.test(inputs.portsContents)) {
    diagnostics.add('generic-contract-provider-vocabulary');
  }

  const exports = publicExportNames(inputs.entrypointContents);
  if ([...REQUIRED_PUBLIC_EXPORTS].some((name) => !exports.has(name))) {
    diagnostics.add('public-export-missing');
  }

  const productionContents = [
    inputs.serviceContents,
    inputs.coordinatorContents,
    inputs.portsContents,
    inputs.entrypointContents,
  ].join('\n');
  if (
    /\b(?:createTeamLifecycleCommandFeature|TeamIpcHandlerApis|TeamRuntimeControl|ProcessSupervisor)\b/.test(
      productionContents
    )
  ) {
    diagnostics.add('forbidden-owner-or-composition');
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

function currentInputs(): BoundaryInputs {
  return {
    serviceContents: `${source(SERVICE_PATH)}\n${source(COMPOSITION_PATH)}`,
    coordinatorContents: source(COORDINATOR_PATH),
    portsContents: source(PORTS_PATH),
    entrypointContents: source(ROOT_ENTRYPOINT_PATH),
  };
}

describe('team artifact-reconciliation boundary', () => {
  it('keeps the admitted lane to exactly six owned paths', () => {
    expect(OWNED_PATHS).toHaveLength(6);
    expect(new Set(OWNED_PATHS).size).toBe(6);
    expect(OWNED_PATHS.every(existsSync)).toBe(true);
  });

  it('keeps reconciliation in one feature coordinator behind narrow generic ports', () => {
    expect(scanBoundary(currentInputs())).toEqual([]);
  });

  it('rejects facade state, deep imports, concrete runtime ownership, and provider contracts', () => {
    expect(
      scanBoundary({
        serviceContents: `
          import { TeamArtifactReconciliationCoordinator } from './internal';
          export class TeamDataService {
            private fileWatchReconcileDiagnostics = new Map();
            reconcileTeamArtifacts() { this.getController().maintenance.reconcileArtifacts(); }
          }
        `,
        coordinatorContents: `
          import { ProcessSupervisor } from '@features/team-runtime-control';
          export class TeamArtifactReconciliationCoordinator {
            reconcile(): void { createTeamLifecycleCommandFeature(); }
          }
        `,
        portsContents: `
          export interface TeamArtifactMaintenanceReconciliationPort {
            reconcileThroughOpenCode(): void;
          }
        `,
        entrypointContents: 'export interface TeamIpcHandlerApis {}',
      })
    ).toEqual([
      'clock-adapter-not-direct',
      'controller-maintenance-adapter-missing',
      'coordinator-construction-missing',
      'coordinator-construction-ports-missing',
      'coordinator-import-path-invalid',
      'coordinator-state-missing',
      'core-forbidden-dependency',
      'facade-delegation-missing',
      'forbidden-owner-or-composition',
      'generic-contract-provider-vocabulary',
      'legacy-reconciliation-ownership',
      'port-interface-missing',
      'public-export-missing',
    ]);
  });
});
