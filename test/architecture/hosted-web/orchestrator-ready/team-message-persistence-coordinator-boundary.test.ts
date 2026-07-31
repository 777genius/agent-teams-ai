import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const COMPOSITION_PATH = 'src/main/services/team/TeamDataServiceFeatureComposition.ts';
const COORDINATOR_PATH = 'src/main/services/team/TeamMessagePersistenceCoordinator.ts';
const TEAM_SERVICE_ENTRYPOINT_PATH = 'src/main/services/team/index.ts';
const COORDINATOR_NAME = 'TeamMessagePersistenceCoordinator';
const COORDINATOR_MODULE = './TeamMessagePersistenceCoordinator';
const DELEGATED_METHODS = [
  'sendMessage',
  'sendRuntimeRecipientMessage',
  'sendSystemNotificationToLead',
  'sendDirectToLead',
  'getLeadMemberName',
] as const;
const REQUIRED_COORDINATOR_METHODS = new Set([
  ...DELEGATED_METHODS,
  'resolveLeadNameFromConfig',
  'resolveLeadName',
  'resolveLeadRuntimeContext',
  'enrichRequest',
  'toControllerPersistedMessage',
]);
const REQUIRED_PORTS = new Set([
  'leadContext',
  'memberMeta',
  'controllerPersistence',
  'runtimeRecipientInbox',
  'messageFeed',
  'identity',
]);
const REQUIRED_PORT_INTERFACES = new Set([
  'TeamMessageLeadContextPort',
  'TeamMessageMemberMetaPort',
  'TeamMessageControllerPersistencePort',
  'TeamRuntimeRecipientInboxPort',
  'TeamMessageFeedInvalidationPort',
  'TeamMessageIdentityPort',
  'TeamMessagePersistenceCoordinatorPorts',
]);
const EXTRACTED_DECLARATIONS = new Set([
  'buildEnrichedSendMessageRequest',
  'enrichRequest',
  'toControllerPersistedMessage',
  'resolveLeadNameFromConfig',
  'resolveLeadName',
  'resolveLeadRuntimeContext',
  'isExplicitLeadRole',
  'TASK_COMMENT_NOTIFICATION_SOURCE',
]);

type BoundaryDiagnostic =
  | 'coordinator-construction-missing'
  | 'coordinator-construction-ports-missing'
  | 'coordinator-concrete-owner'
  | 'coordinator-delivery-policy-owner'
  | 'coordinator-import-missing'
  | 'coordinator-import-path-invalid'
  | 'coordinator-inheritance'
  | 'coordinator-method-missing'
  | 'coordinator-port-interface-missing'
  | 'coordinator-provider-vocabulary'
  | 'coordinator-public-barrel-export'
  | 'facade-delegation-missing'
  | 'legacy-message-ownership';

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
    receiver.name.text === 'messagePersistenceCoordinator' &&
    (receiver.expression.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === 'features' &&
        receiver.expression.expression.kind === ts.SyntaxKind.ThisKeyword))
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

function exportsCoordinator(entrypointContents: string): boolean {
  const entrypointFile = ts.createSourceFile(
    TEAM_SERVICE_ENTRYPOINT_PATH,
    entrypointContents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  return entrypointFile.statements.filter(ts.isExportDeclaration).some((statement) => {
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
  const wiredPorts = new Set<string>();
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
      const ports = node.arguments?.[0];
      if (ports && ts.isObjectLiteralExpression(ports)) {
        for (const property of ports.properties) {
          const name = propertyName(property);
          if (name) wiredPorts.add(name);
        }
      }
    }
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      EXTRACTED_DECLARATIONS.has(declarationName(node) ?? '')
    ) {
      diagnostics.add('legacy-message-ownership');
    }
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name && DELEGATED_METHODS.includes(name as (typeof DELEGATED_METHODS)[number])) {
        if (isThinCoordinatorDelegate(node, name)) delegatedMethods.add(name);
      }
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

  const coordinatorFile = ts.createSourceFile(
    COORDINATOR_PATH,
    coordinatorContents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const coordinatorMethods = new Set<string>();
  const portInterfaces = new Set<string>();
  const concreteOwnerImport =
    /(?:agent-teams-controller|TeamConfigReader|TeamDataService|TeamInboxWriter|TeamMembersMetaStore|TeamSentMessagesStore)/;

  const visitCoordinator = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name) coordinatorMethods.add(name);
    }
    if (ts.isInterfaceDeclaration(node)) {
      portInterfaces.add(node.name.text);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      concreteOwnerImport.test(node.moduleSpecifier.text)
    ) {
      diagnostics.add('coordinator-concrete-owner');
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      /team-message-delivery/.test(node.moduleSpecifier.text)
    ) {
      diagnostics.add('coordinator-delivery-policy-owner');
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
  if ([...REQUIRED_PORT_INTERFACES].some((name) => !portInterfaces.has(name))) {
    diagnostics.add('coordinator-port-interface-missing');
  }
  if (/(?:OpenCode|opencode|Claude|Codex)/.test(coordinatorContents)) {
    diagnostics.add('coordinator-provider-vocabulary');
  }
  if (/(?:TeamConfig|SendMessageRequest|SendMessageResult)/.test(coordinatorContents)) {
    diagnostics.add('coordinator-provider-vocabulary');
  }
  if (
    /\b(?:writeFile|appendFile|mkdir|rm|unlink|rename|spawn|startRuntime|stopRuntime)\s*\(/.test(
      coordinatorContents
    )
  ) {
    diagnostics.add('coordinator-concrete-owner');
  }
  if (exportsCoordinator(entrypointContents)) {
    diagnostics.add('coordinator-public-barrel-export');
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

describe('team message-persistence coordinator boundary', () => {
  it('keeps TeamDataService as a compatibility facade over narrow persistence ports', () => {
    expect(
      scanBoundary(
        `${source(SERVICE_PATH)}\n${source(COMPOSITION_PATH)}`,
        source(COORDINATOR_PATH),
        source(TEAM_SERVICE_ENTRYPOINT_PATH)
      )
    ).toEqual([]);
  });

  it('rejects retained facade logic, concrete owners, delivery policy, and provider leakage', () => {
    const serviceFixture = `
      export class TeamDataService {
        private resolveLeadRuntimeContext(): void {}
        async sendMessage(): Promise<void> {}
        async sendRuntimeRecipientMessage(): Promise<void> {}
        async sendSystemNotificationToLead(): Promise<void> {}
        async sendDirectToLead(): Promise<void> {}
        async getLeadMemberName(): Promise<null> { return null; }
      }
    `;
    const coordinatorFixture = `
      import { TeamInboxWriter } from './TeamInboxWriter';
      import { SendTeamMessageUseCase } from '@features/team-message-delivery';
      interface ProviderPort { sendThroughOpenCode(): void }
      export class TeamMessagePersistenceCoordinator extends TeamInboxWriter {
        sendMessage(): void { writeFile('message.json', 'payload'); }
      }
    `;
    const entrypointFixture = `
      export { TeamMessagePersistenceCoordinator } from './TeamMessagePersistenceCoordinator';
    `;

    expect(scanBoundary(serviceFixture, coordinatorFixture, entrypointFixture)).toEqual([
      'coordinator-concrete-owner',
      'coordinator-construction-missing',
      'coordinator-construction-ports-missing',
      'coordinator-delivery-policy-owner',
      'coordinator-import-missing',
      'coordinator-inheritance',
      'coordinator-method-missing',
      'coordinator-port-interface-missing',
      'coordinator-provider-vocabulary',
      'coordinator-public-barrel-export',
      'facade-delegation-missing',
      'legacy-message-ownership',
    ]);
  });
});
