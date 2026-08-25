import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const TEAMS_PATH = 'src/main/ipc/teams.ts';
const COMPOSITION_PATH = 'src/main/ipc/teamFeatureComposition.ts';
const LEGACY_ADAPTERS_PATH = 'src/main/ipc/teamLegacyAdapters.ts';
const PERMANENT_DELETION_COORDINATOR_PATH =
  'src/features/team-view-read-model/main/application/TeamPermanentDeletionTransactionCoordinator.ts';
const PERMANENT_DELETION_COORDINATOR_IMPORT = '@features/team-view-read-model/main';

const NARROW_LEGACY_ADAPTER_TYPE_IMPORTS = [
  ['@features/team-approvals/main', ['TeamApprovalsIpcDependencies']],
  ['@features/team-configuration/main', ['TeamConfigurationFeature']],
  [
    '@features/team-lifecycle/main',
    ['TeamLifecycleAtomicCommandPort', 'TeamLifecycleIpcFeature', 'TeamLifecycleReadIpcFeature'],
  ],
  ['@features/team-message-delivery/main', ['DesktopTeamMessageDeliveryFeature']],
  ['@features/team-provisioning/main', ['TeamProvisioningFeature']],
  ['@features/team-roster-mutations/main', ['TeamRosterMutationFeature']],
  ['@features/team-runtime-operations/main', ['TeamRuntimeOperationsFeature']],
  ['@features/team-task-board/main', ['TeamTaskBoardFeature']],
  ['@features/team-view-read-model/main', ['TeamViewReadModelFeature']],
] as const;

const source = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const parsedSource = (path: string, contents = source(path)): ts.SourceFile =>
  ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const handlersSource = source('src/main/ipc/handlers.ts');
const teamsSource = source(TEAMS_PATH);
const compositionSource = source(COMPOSITION_PATH);
const legacyAdaptersSource = source(LEGACY_ADAPTERS_PATH);
const permanentDeletionCoordinatorSource = source(PERMANENT_DELETION_COORDINATOR_PATH);

const STABLE_TEAM_EXPORTS = [
  'createIdentityFencedProvisioningStart',
  'createIdentityFencedTeamConfigurationRepository',
  'handleListTeamLifecycle',
  'initializeTeamHandlers',
  'initializeTeamLifecycleReadHandler',
  'permanentlyDeleteDraftTeam',
  'permanentlyDeleteTeam',
  'registerTeamHandlers',
  'removeTeamHandlers',
  'showTeamNativeNotification',
  'waitForPendingPermanentDeletionRecoveryForTests',
] as const;

const EXPECTED_REGISTRATIONS = [
  ['registerTeamHandlers', ['ipcMain']],
  ['registerTeamLifecycleReadIpc', ['ipcMain', 'adapters.lifecycleRead']],
  ['registerTeamLifecycleIpc', ['ipcMain', 'adapters.lifecycle']],
  ['registerTeamRuntimeOperationsIpc', ['ipcMain', 'adapters.runtimeOperations']],
  [
    'registerTeamProvisioningIpc',
    [
      'ipcMain',
      'adapters.provisioning',
      'createDesktopTeamProvisioningIpcHost(adapters.provisioning.logger)',
    ],
  ],
  [
    'registerTeamConfigurationIpc',
    ['ipcMain', 'adapters.configuration', '{\n        isAbsolutePath: path.isAbsolute,\n      }'],
  ],
  [
    'registerTeamMessageDeliveryIpc',
    ['createTeamMessageDeliveryIpcMainPort(ipcMain)', 'adapters.messageDelivery'],
  ],
  ['registerLegacyTeamProcessIpc', ['ipcMain', 'adapters.legacyProcess']],
  ['registerTeamRosterMutationIpc', ['ipcMain', 'adapters.rosterMutation']],
  ['registerTeamViewReadModelIpc', ['ipcMain', 'adapters.viewReadModel']],
  ['registerTeamTaskBoardIpc', ['ipcMain', 'adapters.taskBoard']],
  ['registerTeamApprovalsIpc', ['ipcMain', 'adapters.approvals']],
  ['registerTaskLogObservabilityIpc', ['ipcMain', 'adapters.taskLogObservability']],
] as const;

const EXPECTED_REMOVALS = [
  'removeTeamHandlers',
  'removeTeamLifecycleReadIpc',
  'removeTeamLifecycleIpc',
  'removeTeamRuntimeOperationsIpc',
  'removeTeamProvisioningIpc',
  'removeTeamConfigurationIpc',
  'removeTeamMessageDeliveryIpc',
  'removeLegacyTeamProcessIpc',
  'removeTeamRosterMutationIpc',
  'removeTeamViewReadModelIpc',
  'removeTeamTaskBoardIpc',
  'removeTeamApprovalsIpc',
  'removeTaskLogObservabilityIpc',
] as const;

interface CallShape {
  readonly callee: string;
  readonly arguments: readonly string[];
}

interface SemanticCall {
  readonly path: string;
  readonly awaited: boolean;
  readonly position: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function modifiersOf(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiersOf(node).some((modifier) => modifier.kind === kind);
}

function exportedRuntimeNames(contents: string): string[] {
  const parsed = parsedSource(TEAMS_PATH, contents);
  const names: string[] = [];
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (
        !statement.isTypeOnly &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        names.push(
          ...statement.exportClause.elements
            .filter((element) => !element.isTypeOnly)
            .map((element) => element.name.text)
        );
      }
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return names.sort();
}

function assertStableTeamExports(contents: string): void {
  assertEqual(
    exportedRuntimeNames(contents),
    [...STABLE_TEAM_EXPORTS].sort(),
    'stable teams facade exports'
  );
}

function importShapes(
  path: string,
  contents: string
): Array<{
  readonly module: string;
  readonly names: readonly string[];
  readonly typeNames: readonly string[];
}> {
  const parsed = parsedSource(path, contents);
  return parsed.statements.filter(ts.isImportDeclaration).map((declaration) => {
    const names: string[] = [];
    const typeNames: string[] = [];
    const clause = declaration.importClause;
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        names.push(element.name.text);
        if (clause.isTypeOnly || element.isTypeOnly) typeNames.push(element.name.text);
      }
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      names.push(clause.namedBindings.name.text);
      if (clause.isTypeOnly) typeNames.push(clause.namedBindings.name.text);
    }
    return {
      module: (declaration.moduleSpecifier as ts.StringLiteral).text,
      names,
      typeNames,
    };
  });
}

function identifiersIn(path: string, contents: string): Set<string> {
  const parsed = parsedSource(path, contents);
  const identifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return identifiers;
}

function callPath(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(expression)) {
    return `${callPath(expression.expression)}.${expression.name.text}`;
  }
  if (ts.isCallExpression(expression)) return `${callPath(expression.expression)}()`;
  if (ts.isParenthesizedExpression(expression)) return callPath(expression.expression);
  return expression.getText();
}

function isAwaited(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (node.parent && !ts.isStatement(node.parent) && !ts.isFunctionLike(node.parent)) {
    if (ts.isAwaitExpression(node.parent)) return true;
    node = node.parent;
  }
  return ts.isAwaitExpression(node.parent);
}

function semanticCalls(node: ts.Node): SemanticCall[] {
  const calls: SemanticCall[] = [];
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate)) {
      calls.push({
        path: callPath(candidate.expression),
        awaited: isAwaited(candidate),
        position: candidate.getStart(),
      });
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return calls.sort((left, right) => left.position - right.position);
}

function findFunction(parsed: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = parsed.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  return declaration ?? fail(`missing function ${name}`);
}

function findMethod(
  parsed: ts.SourceFile,
  name: string,
  parentClass?: string
): ts.MethodDeclaration {
  let match: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(parsed) === name &&
      (!parentClass ||
        (ts.isClassDeclaration(node.parent) && node.parent.name?.text === parentClass))
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return match ?? fail(`missing method ${parentClass ? `${parentClass}.` : ''}${name}`);
}

function directCallShapes(body: ts.Block, parsed: ts.SourceFile): CallShape[] {
  return body.statements.map((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      return fail(`non-call statement in frozen sequence: ${statement.getText(parsed)}`);
    }
    return {
      callee: callPath(statement.expression.expression),
      arguments: statement.expression.arguments.map((argument) => argument.getText(parsed)),
    };
  });
}

function assertRegistrationAndRemovalStructure(contents: string): void {
  const parsed = parsedSource(COMPOSITION_PATH, contents);
  const register = findMethod(parsed, 'register');
  const remove = findFunction(parsed, 'removeDesktopTeamFeatureComposition');
  if (!register.body || !remove.body) fail('registration or removal body is missing');
  assertEqual(
    directCallShapes(register.body, parsed),
    EXPECTED_REGISTRATIONS.map(([callee, args]) => ({ callee, arguments: args })),
    'registrar sequence'
  );
  assertEqual(
    directCallShapes(remove.body, parsed),
    EXPECTED_REMOVALS.map((callee) => ({
      callee,
      arguments:
        callee === 'removeTeamMessageDeliveryIpc'
          ? ['createTeamMessageDeliveryIpcMainPort(ipcMain)']
          : ['ipcMain'],
    })),
    'remover sequence'
  );
}

function assertAwaitedCall(calls: readonly SemanticCall[], suffix: string): void {
  const matches = calls.filter((call) => call.path.endsWith(suffix));
  if (matches.length !== 1 || !matches[0]?.awaited) {
    fail(`${suffix} must occur exactly once beneath await`);
  }
}

function assertCoordinatorSemantics(contents: string): void {
  const parsed = parsedSource(PERMANENT_DELETION_COORDINATOR_PATH, contents);
  const permanentlyDelete = findMethod(
    parsed,
    'permanentlyDelete',
    'TeamPermanentDeletionTransactionCoordinator'
  );
  const cleanup = findMethod(parsed, 'runCleanup', 'TeamPermanentDeletionTransactionCoordinator');
  if (
    !hasModifier(permanentlyDelete, ts.SyntaxKind.AsyncKeyword) ||
    !hasModifier(cleanup, ts.SyntaxKind.AsyncKeyword)
  ) {
    fail('permanent deletion transaction methods must remain async');
  }

  const deletionCalls = semanticCalls(permanentlyDelete);
  assertEqual(
    deletionCalls
      .filter((call) =>
        [
          'backupService.beginPermanentDeletion',
          'backupService.commitPermanentDeletionBoundary',
          'this.runCleanup',
        ].some((suffix) => call.path.endsWith(suffix))
      )
      .map((call) => call.path.split('.').at(-1)),
    ['beginPermanentDeletion', 'commitPermanentDeletionBoundary', 'runCleanup'],
    'destructive-boundary sequence'
  );
  assertAwaitedCall(deletionCalls, 'backupService.beginPermanentDeletion');
  assertAwaitedCall(deletionCalls, 'backupService.commitPermanentDeletionBoundary');
  assertAwaitedCall(deletionCalls, 'this.runCleanup');

  const cleanupCalls = semanticCalls(cleanup);
  const cleanupSequence = [
    'prepareTeamDeletion',
    'permanentlyDeleteTeam',
    'invalidateTeamConfig',
    'attachmentStore.deleteTeamAttachments',
    'taskAttachmentStore.deleteTeamAttachments',
    'completePermanentDeletion',
    'completeTeamDeletion',
  ];
  assertEqual(
    cleanupCalls
      .filter((call) => cleanupSequence.some((suffix) => call.path.endsWith(suffix)))
      .map((call) => cleanupSequence.find((suffix) => call.path.endsWith(suffix))),
    cleanupSequence,
    'permanent-deletion cleanup sequence'
  );
  assertAwaitedCall(cleanupCalls, 'backupService.completePermanentDeletion');
}

function replaceOnce(contents: string, before: string, after: string): string {
  const first = contents.indexOf(before);
  if (first < 0 || contents.indexOf(before, first + before.length) >= 0) {
    return fail(`mutation target must occur exactly once: ${before}`);
  }
  return `${contents.slice(0, first)}${after}${contents.slice(first + before.length)}`;
}

describe('desktop team IPC composition freeze', () => {
  it('keeps handlers on the single desktop team composition surface', () => {
    const parsed = parsedSource('src/main/ipc/handlers.ts', handlersSource);
    const imports = importShapes('src/main/ipc/handlers.ts', handlersSource);
    const calls = semanticCalls(parsed);
    expect(
      calls.filter((call) => call.path === 'createDesktopTeamFeatureComposition')
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.path === 'teamFeatureComposition.initializeLegacyHandlers')
    ).toHaveLength(1);
    expect(calls.filter((call) => call.path === 'teamFeatureComposition.register')).toHaveLength(1);
    expect(
      calls.filter((call) => call.path === 'removeDesktopTeamFeatureComposition')
    ).toHaveLength(1);
    expect(
      imports.some(
        ({ module }) =>
          module === './teams' ||
          module === './teamLegacyAdapters' ||
          module === './teamAuxiliaryIpc' ||
          module.startsWith('@features/team-')
      )
    ).toBe(false);
    expect(
      calls.some(({ path }) =>
        [
          'ipcMain.handle',
          'ipcMain.on',
          'ipcMain.removeHandler',
          'ipcMain.removeAllListeners',
        ].includes(path)
      )
    ).toBe(false);
  });

  it('keeps teams.ts as an exact stable facade below the hard size ceiling', () => {
    const parsed = parsedSource(TEAMS_PATH, teamsSource);
    const identifiers = identifiersIn(TEAMS_PATH, teamsSource);
    const imports = importShapes(TEAMS_PATH, teamsSource);
    const calls = semanticCalls(parsed);
    expect(teamsSource.split(/\r?\n/).length).toBeLessThanOrEqual(80);
    assertStableTeamExports(teamsSource);
    expect(
      [...identifiers].some((identifier) =>
        [
          'createSafeAppError',
          'withTeamIdentityFence',
          'TeamDataWorkerClient',
          'LegacyTeamPermanentDeletionCoordinator',
        ].includes(identifier)
      )
    ).toBe(false);
    expect(
      imports
        .filter(({ module }) => module.startsWith('@features/'))
        .map(({ module, names }) => ({ module, names }))
    ).toEqual([
      {
        module: '@features/team-view-read-model/main',
        names: ['TeamPermanentDeletionTransactionCoordinator'],
      },
    ]);
    expect(
      parsed.statements.some(
        (statement) =>
          ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      )
    ).toBe(false);
    expect(
      calls.some(({ path }) => path === 'ipcMain.handle' || path === 'ipcMain.removeHandler')
    ).toBe(false);
    expect(
      parsed.statements.some(
        (statement) => ts.isExportDeclaration(statement) && !statement.exportClause
      )
    ).toBe(false);
  });

  it('proves stable export removal is rejected by the structural ratchet', () => {
    const mutated = replaceOnce(teamsSource, '  permanentlyDeleteTeam,\n', '');
    expect(() => assertStableTeamExports(mutated)).toThrow(/stable teams facade exports/);
  });

  it('freezes registration and removal by direct call target and adapter argument', () => {
    assertRegistrationAndRemovalStructure(compositionSource);
    const mutated = replaceOnce(
      compositionSource,
      '      registerTeamLifecycleReadIpc(ipcMain, adapters.lifecycleRead);\n' +
        '      registerTeamLifecycleIpc(ipcMain, adapters.lifecycle);\n',
      '      registerTeamLifecycleIpc(ipcMain, adapters.lifecycle);\n' +
        '      registerTeamLifecycleReadIpc(ipcMain, adapters.lifecycleRead);\n'
    );
    expect(() => assertRegistrationAndRemovalStructure(mutated)).toThrow(/registrar sequence/);
  });

  it('keeps composition declarative and ownership exclusions structural', () => {
    const compositionParsed = parsedSource(COMPOSITION_PATH, compositionSource);
    const legacyParsed = parsedSource(LEGACY_ADAPTERS_PATH, legacyAdaptersSource);
    const compositionIdentifiers = identifiersIn(COMPOSITION_PATH, compositionSource);
    const legacyIdentifiers = identifiersIn(LEGACY_ADAPTERS_PATH, legacyAdaptersSource);
    const forbiddenIdentifiers = [
      'TeamIpcHandlerApis',
      'TeamProvisioningApis',
      'createTeamLifecycleCommandFeature',
      'createTeamRuntimeLifecycleHostPort',
      'OpenCode',
      'spawn',
    ];
    const forbiddenModules = [
      'node:child_process',
      '@features/team-runtime-control',
      '@features/provider-execution',
      '@features/process-supervision',
      '@features/process-recovery',
      '@features/team-runtime-recovery',
    ];

    expect(
      semanticCalls(compositionParsed).filter(
        ({ path }) => path === 'createDesktopTeamLegacyAdapters'
      )
    ).toHaveLength(1);
    expect(
      semanticCalls(compositionParsed).some(
        ({ path }) =>
          /^createTeam[A-Z]\w*Feature$/.test(path) ||
          ['getTeamData', 'deleteTeam', 'restoreTeam', 'killProcess', 'invalidateMessageFeed'].some(
            (name) => path.endsWith(name)
          )
      )
    ).toBe(false);
    expect(
      [...compositionIdentifiers, ...legacyIdentifiers].some((identifier) =>
        forbiddenIdentifiers.includes(identifier)
      )
    ).toBe(false);
    expect(
      [
        ...importShapes(COMPOSITION_PATH, compositionSource),
        ...importShapes(LEGACY_ADAPTERS_PATH, legacyAdaptersSource),
      ].some(({ module }) => forbiddenModules.some((forbidden) => module.startsWith(forbidden)))
    ).toBe(false);
    expect(
      importShapes(LEGACY_ADAPTERS_PATH, legacyAdaptersSource)
        .filter(({ module }) => module.startsWith('@features/'))
        .every(({ module }) => /^@features\/[^/]+\/(?:contracts|main)$/.test(module))
    ).toBe(true);
    expect(
      importShapes(LEGACY_ADAPTERS_PATH, legacyAdaptersSource)
        .filter(({ module }) => module.endsWith('/main'))
        .map(({ module, typeNames }) => [module, typeNames])
    ).toEqual(NARROW_LEGACY_ADAPTER_TYPE_IMPORTS);
    expect(
      importShapes(LEGACY_ADAPTERS_PATH, legacyAdaptersSource)
        .filter(({ module }) => module.startsWith('../../features/'))
        .map(({ module }) => module)
    ).toEqual([]);
    expect(
      semanticCalls(legacyParsed)
        .filter(({ path }) => path === 'ipcMain.handle' || path === 'ipcMain.removeHandler')
        .map(({ path }) => path)
    ).toEqual([
      'ipcMain.handle',
      'ipcMain.handle',
      'ipcMain.removeHandler',
      'ipcMain.removeHandler',
    ]);
  });

  it('uses the one canonical permanent-deletion application service without copying its transaction', () => {
    const teamsImports = importShapes(TEAMS_PATH, teamsSource);
    const canonicalParsed = parsedSource(
      PERMANENT_DELETION_COORDINATOR_PATH,
      permanentDeletionCoordinatorSource
    );
    const legacyParsed = parsedSource(LEGACY_ADAPTERS_PATH, legacyAdaptersSource);
    const canonicalClasses = canonicalParsed.statements.filter(ts.isClassDeclaration);
    const legacyClasses = legacyParsed.statements.filter(ts.isClassDeclaration);
    const transactionIdentifiers = [
      'beginPermanentDeletion',
      'commitPermanentDeletionBoundary',
      'abortPreparedPermanentDeletion',
      'reconcilePermanentDeletionProgress',
      'withPermanentDeletionTargetFence',
      'completePermanentDeletion',
    ];

    expect(
      teamsImports.filter(
        ({ module, names }) =>
          module === PERMANENT_DELETION_COORDINATOR_IMPORT &&
          names.includes('TeamPermanentDeletionTransactionCoordinator')
      )
    ).toHaveLength(1);
    expect(
      canonicalClasses.filter(
        (declaration) => declaration.name?.text === 'TeamPermanentDeletionTransactionCoordinator'
      )
    ).toHaveLength(1);
    expect(legacyClasses).toHaveLength(0);
    expect(
      transactionIdentifiers.some((identifier) =>
        identifiersIn(LEGACY_ADAPTERS_PATH, legacyAdaptersSource).has(identifier)
      )
    ).toBe(false);
  });

  it('preserves identity fences, safe lifecycle-read failures, singleton stores, and recovery', () => {
    const parsed = parsedSource(LEGACY_ADAPTERS_PATH, legacyAdaptersSource);
    const calls = semanticCalls(parsed);
    const stringLiterals = new Set<string>();
    let hasSingletonAssignment = false;
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) stringLiterals.add(node.text);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
        ts.isIdentifier(node.left) &&
        node.left.text === 'permanentDeletionStores'
      ) {
        hasSingletonAssignment = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);

    expect(calls.some(({ path }) => path === 'backupService.withTeamIdentityFence')).toBe(true);
    expect(stringLiterals).toContain('identity_storage_unavailable');
    expect(stringLiterals).toContain('transport_unavailable');
    expect(hasSingletonAssignment).toBe(true);
    expect(calls.some(({ path }) => path === 'permanentDeletionCoordinator.startRecovery')).toBe(
      true
    );
    expect(calls.some(({ path }) => path === 'permanentDeletionCoordinator.waitForRecovery')).toBe(
      true
    );
  });

  it('enforces awaited destructive-boundary and completion semantics with negative mutations', () => {
    assertCoordinatorSemantics(permanentDeletionCoordinatorSource);
    const boundaryWithoutAwait = replaceOnce(
      permanentDeletionCoordinatorSource,
      'intent = await backupService.commitPermanentDeletionBoundary(intent);',
      'intent = backupService.commitPermanentDeletionBoundary(intent);'
    );
    const completionWithoutAwait = replaceOnce(
      permanentDeletionCoordinatorSource,
      'await backupService.completePermanentDeletion(intent);',
      'backupService.completePermanentDeletion(intent);'
    );

    expect(() => assertCoordinatorSemantics(boundaryWithoutAwait)).toThrow(
      /commitPermanentDeletionBoundary must occur exactly once beneath await/
    );
    expect(() => assertCoordinatorSemantics(completionWithoutAwait)).toThrow(
      /completePermanentDeletion must occur exactly once beneath await/
    );
  });
});
