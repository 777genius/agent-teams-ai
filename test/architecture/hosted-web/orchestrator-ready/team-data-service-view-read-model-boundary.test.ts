import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FACADE_PATH = 'src/main/services/team/TeamDataService.ts';
const READ_MODEL_PATH = 'src/main/services/team/TeamViewReadModelService.ts';
const READ_MODEL_NAME = 'TeamViewReadModelService';
const READ_MODEL_MODULE = './TeamViewReadModelService';
const CONCRETE_COLLABORATORS = new Set([
  'TeamViewSnapshotAssembler',
  'TeamLeadSessionMessageReader',
  'TeamMessageFeedService',
  'MemberActivityMetaService',
]);
const MOVED_FACADE_DECLARATIONS = new Set([
  'teamViewSnapshotAssembler',
  'leadSessionMessageReader',
  'messageFeedService',
  'memberActivityMetaService',
  'notificationContextCache',
  'notificationContextInFlight',
  'notificationContextGenerationByTeam',
  'isLeadThoughtCandidateForSlashResult',
  'annotateSlashCommandResponses',
  'linkPassiveUserReplySummaries',
  'normalizePassiveUserReplyLinkText',
  'extractPassiveUserPeerSummaryBody',
]);
const REQUIRED_CONSTRUCTION_PORTS = new Set([
  'readConfig',
  'readTasks',
  'readInboxNames',
  'readMembersMeta',
  'readTeamMeta',
  'readLaunchSnapshot',
  'readKanbanState',
  'startTaskChangePresenceRead',
  'projectTaskWithKanban',
  'projectTaskChangePresence',
  'resolveMembers',
  'readMemberRuntimeAdvisories',
  'resolveGitBranch',
  'memberBranchConcurrency',
  'readProcesses',
  'selectCurrentActiveTask',
  'compactTask',
  'logDebug',
  'logWarning',
  'projectResolver',
  'leadSessionParseCache',
  'readInboxMessages',
  'readInboxMessagesWindow',
  'readSentMessages',
]);
const THIN_DELEGATES = [
  'getMessagesPage',
  'getMessageFeed',
  'getMemberActivityMeta',
  'getTeamDisplayName',
  'getTeamNotificationContext',
  'invalidateMessageFeed',
  'invalidateNotificationContext',
] as const;
const REQUIRED_READ_MODEL_METHODS = new Set(['getTeamData', ...THIN_DELEGATES]);
const REQUIRED_CACHE_PROPERTIES = new Set([
  'notificationContextCache',
  'notificationContextInFlight',
  'notificationContextGenerationByTeam',
]);
const FORBIDDEN_READ_MODEL_IMPORT =
  /(?:agent-teams-controller|TeamDataService|TeamProvisioning|provisioning|opencode|OpenCode|electron|fastify)/;

type BoundaryDiagnostic =
  | 'facade-concrete-collaborator-import'
  | 'facade-construction-ports-missing'
  | 'facade-delegation-missing'
  | 'facade-direct-read-model-ownership'
  | 'facade-process-health-policy-missing'
  | 'read-model-cache-ownership-missing'
  | 'read-model-collaborator-construction-missing'
  | 'read-model-forbidden-dependency'
  | 'read-model-import-missing'
  | 'read-model-import-path-invalid'
  | 'read-model-inheritance'
  | 'read-model-method-missing'
  | 'read-model-port-interface-missing'
  | 'read-model-service-construction-missing';

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

function valueImportedNames(node: ts.ImportDeclaration): readonly string[] {
  if (node.importClause?.isTypeOnly) return [];
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text);
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
    receiver.name.text === 'viewReadModelService' &&
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

function isThinDelegate(node: ts.MethodDeclaration, methodName: string): boolean {
  if (!node.body || node.body.statements.length !== 1) return false;
  const statement = node.body.statements[0];
  const statementExpression = ts.isReturnStatement(statement)
    ? statement.expression
    : ts.isExpressionStatement(statement)
      ? statement.expression
      : undefined;
  if (!statementExpression) return false;
  const expression = ts.isAwaitExpression(statementExpression)
    ? statementExpression.expression
    : statementExpression;
  return ts.isCallExpression(expression) && isReadModelCall(expression, methodName);
}

function referencesProcessHealthPolicy(node: ts.MethodDeclaration): boolean {
  let referencesPolicy = false;
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(candidate) &&
      candidate.name.text === 'processHealthTeams' &&
      candidate.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      referencesPolicy = true;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return referencesPolicy;
}

function scanBoundary(facadeContents: string, readModelContents: string): BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const facadeFile = parse(FACADE_PATH, facadeContents);
  let readModelImportFound = false;
  let constructionFound = false;
  const constructionPorts = new Set<string>();
  const delegates = new Set<string>();
  let getTeamDataOwnsProcessHealth = false;

  const visitFacade = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const names = importedNames(node);
      if (names.includes(READ_MODEL_NAME)) {
        readModelImportFound = true;
        if (
          !ts.isStringLiteralLike(node.moduleSpecifier) ||
          node.moduleSpecifier.text !== READ_MODEL_MODULE
        ) {
          diagnostics.add('read-model-import-path-invalid');
        }
      }
      if (valueImportedNames(node).some((name) => CONCRETE_COLLABORATORS.has(name))) {
        diagnostics.add('facade-concrete-collaborator-import');
      }
    }

    if (
      (ts.isPropertyDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node)) &&
      MOVED_FACADE_DECLARATIONS.has(declarationName(node) ?? '')
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
        }
      }
    }

    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (
        name &&
        THIN_DELEGATES.includes(name as (typeof THIN_DELEGATES)[number]) &&
        isThinDelegate(node, name)
      ) {
        delegates.add(name);
      }
      if (name === 'getTeamData') {
        getTeamDataOwnsProcessHealth =
          countCalls(node, (call) => isReadModelCall(call, 'getTeamData')) === 1 &&
          referencesProcessHealthPolicy(node);
      }
    }
    ts.forEachChild(node, visitFacade);
  };
  visitFacade(facadeFile);

  if (!readModelImportFound) diagnostics.add('read-model-import-missing');
  if (!constructionFound) diagnostics.add('read-model-service-construction-missing');
  if ([...REQUIRED_CONSTRUCTION_PORTS].some((name) => !constructionPorts.has(name))) {
    diagnostics.add('facade-construction-ports-missing');
  }
  if (THIN_DELEGATES.some((name) => !delegates.has(name))) {
    diagnostics.add('facade-delegation-missing');
  }
  if (!getTeamDataOwnsProcessHealth) {
    diagnostics.add('facade-process-health-policy-missing');
  }

  const readModelFile = parse(READ_MODEL_PATH, readModelContents);
  const constructionCount = new Map<string, number>();
  const readModelMethods = new Set<string>();
  const cacheProperties = new Set<string>();
  let portInterfaceFound = false;

  const visitReadModel = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      FORBIDDEN_READ_MODEL_IMPORT.test(node.moduleSpecifier.text)
    ) {
      diagnostics.add('read-model-forbidden-dependency');
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CONCRETE_COLLABORATORS.has(node.expression.text)
    ) {
      constructionCount.set(
        node.expression.text,
        (constructionCount.get(node.expression.text) ?? 0) + 1
      );
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'TeamViewReadModelServicePorts') {
      portInterfaceFound = true;
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
        }
        if (ts.isPropertyDeclaration(member)) {
          const name = declarationName(member);
          if (name && REQUIRED_CACHE_PROPERTIES.has(name)) cacheProperties.add(name);
        }
      }
    }
    ts.forEachChild(node, visitReadModel);
  };
  visitReadModel(readModelFile);

  if (
    [...CONCRETE_COLLABORATORS].some((collaborator) => constructionCount.get(collaborator) !== 1)
  ) {
    diagnostics.add('read-model-collaborator-construction-missing');
  }
  if (!portInterfaceFound) diagnostics.add('read-model-port-interface-missing');
  if ([...REQUIRED_READ_MODEL_METHODS].some((method) => !readModelMethods.has(method))) {
    diagnostics.add('read-model-method-missing');
  }
  if ([...REQUIRED_CACHE_PROPERTIES].some((property) => !cacheProperties.has(property))) {
    diagnostics.add('read-model-cache-ownership-missing');
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

describe('TeamDataService view read-model boundary', () => {
  it('keeps concrete view and message collaborators behind one narrow service', () => {
    expect(scanBoundary(source(FACADE_PATH), source(READ_MODEL_PATH))).toEqual([]);
  });

  it('rejects concrete collaborator ownership and restored facade read logic', () => {
    const facadeFixture = `
      import { TeamViewSnapshotAssembler } from '@features/team-view-read-model/main';
      import { TeamViewReadModelService } from './TeamViewReadModelService';
      export class TeamDataService {
        private messageFeedService = {};
        private notificationContextCache = new Map();
        private annotateSlashCommandResponses(): void {}
        private viewReadModelService = new TeamViewReadModelService({});
        getTeamData(): void {}
        getMessagesPage(): void {}
        getMessageFeed(): void {}
        getMemberActivityMeta(): void {}
        getTeamDisplayName(): void {}
        getTeamNotificationContext(): void {}
        invalidateMessageFeed(): void {}
        invalidateNotificationContext(): void {}
      }
    `;

    expect(scanBoundary(facadeFixture, source(READ_MODEL_PATH))).toEqual([
      'facade-concrete-collaborator-import',
      'facade-construction-ports-missing',
      'facade-delegation-missing',
      'facade-direct-read-model-ownership',
      'facade-process-health-policy-missing',
    ]);
  });

  it('rejects missing collaborator ownership, ports, methods, and broad dependencies', () => {
    const readModelFixture = `
      import { TeamDataService } from './TeamDataService';
      export class TeamViewReadModelService extends TeamDataService {
        getTeamData(): void {}
      }
    `;

    expect(scanBoundary(source(FACADE_PATH), readModelFixture)).toEqual([
      'read-model-cache-ownership-missing',
      'read-model-collaborator-construction-missing',
      'read-model-forbidden-dependency',
      'read-model-inheritance',
      'read-model-method-missing',
      'read-model-port-interface-missing',
    ]);
  });
});
