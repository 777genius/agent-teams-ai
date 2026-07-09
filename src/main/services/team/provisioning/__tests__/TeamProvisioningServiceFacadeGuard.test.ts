import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { format, type Options as PrettierOptions } from 'prettier';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TEAM_PROVISIONING_SERVICE_PATH = resolve(
  process.cwd(),
  'src/main/services/team/TeamProvisioningService.ts'
);
const TEAM_PROVISIONING_FACADE_ROOT = resolve(process.cwd(), 'src/main/services/team/provisioning');
const TEAM_PROVISIONING_COMPATIBILITY_FACADE_OWNER_FILE_PATTERN =
  /^TeamProvisioning(?:AppShellFacade|ServiceFacadeDelegates|.*CompatibilityFacade)\.ts$/;
const TEAM_PROVISIONING_SERVICE_LINE_LIMIT = 777;
const TEAM_PROVISIONING_SERVICE_FORMAT_OPTIONS: PrettierOptions = {
  parser: 'typescript',
  singleQuote: true,
  trailingComma: 'es5',
  printWidth: 100,
  endOfLine: 'lf',
};
const SUBSCRIPTION_RUNTIME_REFERENCE_PATTERN = /subscription[-_\s]+runtime|subscriptionRuntime/i;
const TEAM_PROVISIONING_SERVICE_CLASS_NAME = 'TeamProvisioningService';
const DECLARED_PUBLIC_SERVICE_ENTRYPOINTS = [
  'createTeam',
  'launchTeam',
  'setTeamChangeEmitter',
] as const;
const DOCUMENTED_EFFECTIVE_PUBLIC_SERVICE_INSTANCE_MEMBERS = [
  'answerOpenCodeRuntimePermission',
  'attachLiveRosterMember',
  'buildCrossProviderMemberArgs',
  'buildProvisioningEnv',
  'cancelProvisioning',
  'cleanupPrelaunchBackup',
  'clearPendingCrossTeamReplyExpectation',
  'createTeam',
  'deliverOpenCodeMemberMessage',
  'deliverOpenCodeRuntimeMessage',
  'detachLiveRosterMember',
  'detachOpenCodeOwnedMemberLane',
  'discardLiveMemberMcpLaunchConfig',
  'dismissApprovalNotification',
  'forwardUserDmToTeammate',
  'getAliveTeamNames',
  'getAliveTeams',
  'getClaudeLogs',
  'getCliHelpOutput',
  'getCurrentLeadSessionId',
  'getCurrentRunId',
  'getLeadActivityState',
  'getLeadContextUsage',
  'getLiveLeadProcessMessages',
  'getMemberSpawnStatuses',
  'getOpenCodeMemberDeliveryBusyStatus',
  'getOpenCodeRuntimeAdapter',
  'getOpenCodeRuntimeDeliveryStatus',
  'getProvisioningStatus',
  'getRuntimeState',
  'getTeamAgentRuntimeSnapshot',
  'hasActiveTeamRuntimes',
  'hasProvisioningRun',
  'isOpenCodeRuntimeRecipient',
  'isTeamAlive',
  'launchTeam',
  'notifyLanguageChange',
  'prepareForProvisioning',
  'prepareLiveMemberMcpLaunchConfig',
  'pushLiveLeadProcessMessage',
  'reattachOpenCodeOwnedMemberLane',
  'recordOpenCodeRuntimeBootstrapCheckin',
  'recordOpenCodeRuntimeHeartbeat',
  'recordOpenCodeRuntimeTaskEvent',
  'recoverOpenCodeRuntimeDeliveryJournal',
  'registerPendingCrossTeamReplyExpectation',
  'relayInboxFileToLiveRecipient',
  'relayLeadInboxMessages',
  'relayMemberInboxMessages',
  'relayOpenCodeMemberInboxMessages',
  'repairStaleTaskActivityIntervalsBeforeSnapshot',
  'resolveCrossTeamReplyMetadata',
  'resolveRuntimeRecipientProviderId',
  'respondToToolApproval',
  'restartMember',
  'retryFailedOpenCodeSecondaryLanes',
  'scanOpenCodePromptDeliveryWatchdog',
  'scheduleOpenCodeMemberInboxDeliveryWake',
  'sendMessageToTeam',
  'setControlApiBaseUrlResolver',
  'setCrossTeamSender',
  'setMainWindow',
  'setMemberRuntimeAdvisoryInvalidator',
  'setMemberWorkSyncAcceptedReportChecker',
  'setMemberWorkSyncProofMissingRecoveryScheduler',
  'setRuntimeAdapterRegistry',
  'setRuntimeTurnSettledEnvironmentProvider',
  'setRuntimeTurnSettledHookSettingsProvider',
  'setTeamChangeEmitter',
  'setToolApprovalEventEmitter',
  'setWorkspaceTrustCoordinator',
  'skipMemberForLaunch',
  'stopAllTeams',
  'stopTeam',
  'updateToolApprovalSettings',
  'validateAgentTeamsMcpRuntime',
  'warmup',
] as const;
const PUBLIC_SURFACE_TYPE_ALIAS_NAME = 'TeamProvisioningServicePublicSurface';
const PUBLIC_SURFACE_VIRTUAL_FILE_PATH = resolve(
  process.cwd(),
  '__teamProvisioningServicePublicSurfaceGuard.ts'
);
const PUBLIC_SURFACE_VIRTUAL_SOURCE = `
import { TeamProvisioningService } from './src/main/services/team/TeamProvisioningService';

type ${PUBLIC_SURFACE_TYPE_ALIAS_NAME} = keyof TeamProvisioningService;
`;
type ServiceEntryPointMember =
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.PropertyDeclaration
  | ts.SetAccessorDeclaration;
type GuardedFacadeSource = {
  filePath: string;
  projectPath: string;
  source: string;
  sourceFile: ts.SourceFile;
};
const CONSTRUCTOR_DEPENDENCIES = [
  {
    accessibility: 'private',
    defaultNew: 'TeamConfigReader',
    name: 'configReader',
    readonly: true,
    type: 'TeamConfigReader',
  },
  {
    accessibility: 'protected',
    defaultNew: 'TeamInboxReader',
    name: 'inboxReader',
    readonly: true,
    type: 'TeamInboxReader',
  },
  {
    accessibility: 'protected',
    defaultNew: 'TeamMembersMetaStore',
    name: 'membersMetaStore',
    readonly: true,
    type: 'TeamMembersMetaStore',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamSentMessagesStore',
    name: 'sentMessagesStore',
    readonly: true,
    type: 'TeamSentMessagesStore',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamMcpConfigBuilder',
    name: 'mcpConfigBuilder',
    readonly: true,
    type: 'TeamMcpConfigBuilder',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamMetaStore',
    name: 'teamMetaStore',
    readonly: true,
    type: 'TeamMetaStore',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamInboxWriter',
    name: 'inboxWriter',
    readonly: true,
    type: 'TeamInboxWriter',
  },
  {
    accessibility: 'private',
    defaultNew: 'OpenCodeTaskLogAttributionStore',
    name: 'openCodeTaskLogAttributionStore',
    readonly: true,
    type: 'OpenCodeTaskLogAttributionStore',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamMemberWorktreeManager',
    name: 'memberWorktreeManager',
    readonly: true,
    type: 'TeamMemberWorktreeManager',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamAttachmentStore',
    name: 'attachmentStore',
    readonly: true,
    type: 'TeamAttachmentStore',
  },
] as const;

function countSourceLines(source: string): number {
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.length;
}

function readTeamProvisioningServiceSource(): string {
  return readFileSync(TEAM_PROVISIONING_SERVICE_PATH, 'utf8');
}

function parseTypeScriptSource(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function parseTeamProvisioningServiceSource(source: string): ts.SourceFile {
  return parseTypeScriptSource(TEAM_PROVISIONING_SERVICE_PATH, source);
}

function formatTypeScriptDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  });
}

function readTsConfigCompilerOptions(): ts.CompilerOptions {
  const configPath = resolve(process.cwd(), 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(formatTypeScriptDiagnostics([configFile.error]));
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    {
      noEmit: true,
      skipLibCheck: true,
    },
    configPath
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(formatTypeScriptDiagnostics(parsedConfig.errors));
  }

  return parsedConfig.options;
}

function createPublicSurfaceTypeProgram(): ts.Program {
  const options = readTsConfigCompilerOptions();
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const isVirtualFile = (fileName: string) =>
    resolve(fileName) === PUBLIC_SURFACE_VIRTUAL_FILE_PATH;

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (isVirtualFile(fileName)) {
      return ts.createSourceFile(
        fileName,
        PUBLIC_SURFACE_VIRTUAL_SOURCE,
        languageVersion,
        true,
        ts.ScriptKind.TS
      );
    }

    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => isVirtualFile(fileName) || originalFileExists(fileName);
  host.readFile = (fileName) =>
    isVirtualFile(fileName) ? PUBLIC_SURFACE_VIRTUAL_SOURCE : originalReadFile(fileName);

  return ts.createProgram({
    rootNames: [PUBLIC_SURFACE_VIRTUAL_FILE_PATH],
    options,
    host,
  });
}

function findTypeAliasDeclaration(
  sourceFile: ts.SourceFile,
  aliasName: string
): ts.TypeAliasDeclaration {
  const typeAlias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === aliasName
  );

  if (!typeAlias) {
    throw new Error(`Missing ${aliasName} type alias in ${sourceFile.fileName}`);
  }

  return typeAlias;
}

function getStringLiteralUnionValues(checker: ts.TypeChecker, type: ts.Type): string[] {
  const values: string[] = [];

  const collect = (currentType: ts.Type): void => {
    if (currentType.isUnion()) {
      currentType.types.forEach(collect);
      return;
    }

    if ((currentType.flags & ts.TypeFlags.StringLiteral) !== 0) {
      values.push((currentType as ts.StringLiteralType).value);
      return;
    }

    throw new Error(
      `Expected string literal public surface member, got ${checker.typeToString(currentType)}`
    );
  };

  collect(type);
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getEffectivePublicServiceInstanceMemberNames(): string[] {
  const program = createPublicSurfaceTypeProgram();
  const sourceFile = program.getSourceFile(PUBLIC_SURFACE_VIRTUAL_FILE_PATH);
  if (!sourceFile) {
    throw new Error(`Missing ${PUBLIC_SURFACE_VIRTUAL_FILE_PATH}`);
  }

  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];
  if (diagnostics.length > 0) {
    throw new Error(formatTypeScriptDiagnostics(diagnostics));
  }

  const checker = program.getTypeChecker();
  const typeAlias = findTypeAliasDeclaration(sourceFile, PUBLIC_SURFACE_TYPE_ALIAS_NAME);
  const surfaceType = checker.getTypeFromTypeNode(typeAlias.type);

  return getStringLiteralUnionValues(checker, surfaceType);
}

function projectRelativePath(filePath: string): string {
  return relative(process.cwd(), filePath);
}

function readGuardedFacadeSource(filePath: string): GuardedFacadeSource {
  const source = readFileSync(filePath, 'utf8');

  return {
    filePath,
    projectPath: projectRelativePath(filePath),
    source,
    sourceFile: parseTypeScriptSource(filePath, source),
  };
}

async function formatTeamProvisioningServiceSource(source: string): Promise<string> {
  return await format(source, TEAM_PROVISIONING_SERVICE_FORMAT_OPTIONS);
}

function findClassDeclaration(sourceFile: ts.SourceFile, className: string): ts.ClassDeclaration {
  const serviceClass = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
  );

  if (!serviceClass) {
    throw new Error(`Missing ${className} class in ${projectRelativePath(sourceFile.fileName)}`);
  }

  return serviceClass;
}

function findTeamProvisioningServiceClass(sourceFile: ts.SourceFile): ts.ClassDeclaration {
  return findClassDeclaration(sourceFile, TEAM_PROVISIONING_SERVICE_CLASS_NAME);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === kind));
}

function getAccessibility(node: ts.Node): 'private' | 'protected' | 'public' | 'none' {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  if (hasModifier(node, ts.SyntaxKind.PublicKeyword)) return 'public';
  return 'none';
}

function isServiceEntryPointMember(member: ts.ClassElement): member is ServiceEntryPointMember {
  return (
    ts.isGetAccessorDeclaration(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isPropertyDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  );
}

function getDeclaredPublicServiceEntryPointNames(
  sourceFile: ts.SourceFile,
  serviceClass: ts.ClassDeclaration
): string[] {
  return serviceClass.members
    .filter(
      (member): member is ServiceEntryPointMember =>
        isServiceEntryPointMember(member) &&
        !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
        !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
    )
    .map((member) => member.name.getText(sourceFile))
    .sort((a, b) => a.localeCompare(b));
}

function getClassElementBody(member: ts.ClassElement): ts.Block | undefined {
  if (
    ts.isConstructorDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return member.body;
  }

  return undefined;
}

function getClassElementName(sourceFile: ts.SourceFile, member: ts.ClassElement): string {
  if (ts.isConstructorDeclaration(member)) {
    return 'constructor';
  }

  return member.name?.getText(sourceFile) ?? member.getText(sourceFile).slice(0, 80);
}

function getSingleLineBodyMemberNames(
  sourceFile: ts.SourceFile,
  serviceClass: ts.ClassDeclaration
): string[] {
  return serviceClass.members.flatMap((member) => {
    const body = getClassElementBody(member);
    if (!body) {
      return [];
    }

    const bodyStartLine = sourceFile.getLineAndCharacterOfPosition(body.getStart(sourceFile)).line;
    const bodyEndLine = sourceFile.getLineAndCharacterOfPosition(body.end).line;
    return bodyStartLine === bodyEndLine ? [getClassElementName(sourceFile, member)] : [];
  });
}

function getConstructorDependencySurface(
  sourceFile: ts.SourceFile,
  serviceClass: ts.ClassDeclaration
): {
  accessibility: 'private' | 'protected' | 'public' | 'none';
  defaultNew: string | null;
  name: string;
  readonly: boolean;
  type: string | null;
}[] {
  const constructor = serviceClass.members.find(ts.isConstructorDeclaration);
  if (!constructor) {
    throw new Error(`${TEAM_PROVISIONING_SERVICE_CLASS_NAME} must declare a constructor`);
  }

  return constructor.parameters.map((parameter) => ({
    accessibility: getAccessibility(parameter),
    defaultNew:
      parameter.initializer && ts.isNewExpression(parameter.initializer)
        ? parameter.initializer.expression.getText(sourceFile)
        : null,
    name: parameter.name.getText(sourceFile),
    readonly: hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword),
    type: parameter.type?.getText(sourceFile) ?? null,
  }));
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text];
    }

    return [];
  });
}

function getSuperclassIdentifier(classDeclaration: ts.ClassDeclaration): string | null {
  const extendsClause = classDeclaration.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
  );
  const superType = extendsClause?.types[0];
  if (!superType) {
    return null;
  }

  if (ts.isIdentifier(superType.expression)) {
    return superType.expression.text;
  }

  if (ts.isPropertyAccessExpression(superType.expression)) {
    return superType.expression.name.text;
  }

  return null;
}

function resolveLocalModuleSpecifier(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const basePath = resolve(dirname(importerPath), specifier);
  const candidatePaths = [`${basePath}.ts`, resolve(basePath, 'index.ts')];

  return candidatePaths.find((candidatePath) => existsSync(candidatePath)) ?? null;
}

function resolveImportedIdentifierPath(
  sourceFile: ts.SourceFile,
  importerPath: string,
  identifier: string
): string | null {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const importClause = statement.importClause;
    const namedBindings = importClause?.namedBindings;
    const isDefaultMatch = importClause?.name?.text === identifier;
    const isNamedMatch =
      namedBindings &&
      ts.isNamedImports(namedBindings) &&
      namedBindings.elements.some((element) => element.name.text === identifier);

    if (isDefaultMatch || isNamedMatch) {
      return resolveLocalModuleSpecifier(importerPath, statement.moduleSpecifier.text);
    }
  }

  return null;
}

function collectLocalSuperclassChainPaths(
  initialFilePath = TEAM_PROVISIONING_SERVICE_PATH,
  initialClassName = TEAM_PROVISIONING_SERVICE_CLASS_NAME
): string[] {
  const filePaths: string[] = [];
  const seenClasses = new Set<string>();
  let currentFilePath = initialFilePath;
  let currentClassName: string | null = initialClassName;

  while (currentClassName) {
    const seenKey = `${currentFilePath}#${currentClassName}`;
    if (seenClasses.has(seenKey)) {
      throw new Error(
        `Circular facade superclass chain at ${projectRelativePath(currentFilePath)}`
      );
    }
    seenClasses.add(seenKey);
    filePaths.push(currentFilePath);

    const { sourceFile } = readGuardedFacadeSource(currentFilePath);
    const classDeclaration = findClassDeclaration(sourceFile, currentClassName);
    const superclassIdentifier = getSuperclassIdentifier(classDeclaration);
    if (!superclassIdentifier) {
      break;
    }

    const superclassPath = resolveImportedIdentifierPath(
      sourceFile,
      currentFilePath,
      superclassIdentifier
    );
    if (!superclassPath) {
      break;
    }

    currentFilePath = superclassPath;
    currentClassName = superclassIdentifier;
  }

  return filePaths;
}

function collectNamedCompatibilityFacadeOwnershipPaths(): string[] {
  return readdirSync(TEAM_PROVISIONING_FACADE_ROOT)
    .filter((fileName) => TEAM_PROVISIONING_COMPATIBILITY_FACADE_OWNER_FILE_PATTERN.test(fileName))
    .map((fileName) => resolve(TEAM_PROVISIONING_FACADE_ROOT, fileName));
}

function getTeamProvisioningCompatibilityFacadeGuardPaths(): string[] {
  return [
    ...new Set([
      TEAM_PROVISIONING_SERVICE_PATH,
      ...collectNamedCompatibilityFacadeOwnershipPaths(),
      ...collectLocalSuperclassChainPaths(),
    ]),
  ].sort((a, b) => projectRelativePath(a).localeCompare(projectRelativePath(b)));
}

function readTeamProvisioningCompatibilityFacadeGuardSources(): GuardedFacadeSource[] {
  return getTeamProvisioningCompatibilityFacadeGuardPaths().map((filePath) =>
    readGuardedFacadeSource(filePath)
  );
}

describe('TeamProvisioningService facade guard', () => {
  it('keeps the compatibility facade below the line cap', () => {
    const source = readTeamProvisioningServiceSource();

    expect(countSourceLines(source)).toBeLessThan(TEAM_PROVISIONING_SERVICE_LINE_LIMIT);
  });

  it('keeps the compatibility facade below the line cap after normal formatting', async () => {
    const source = readTeamProvisioningServiceSource();
    const formattedSource = await formatTeamProvisioningServiceSource(source);

    expect(countSourceLines(formattedSource)).toBeLessThan(TEAM_PROVISIONING_SERVICE_LINE_LIMIT);
  });

  it('does not rely on one-line class-member wrapper compression', () => {
    const source = readTeamProvisioningServiceSource();
    const sourceFile = parseTeamProvisioningServiceSource(source);
    const serviceClass = findTeamProvisioningServiceClass(sourceFile);

    expect(getSingleLineBodyMemberNames(sourceFile, serviceClass)).toEqual([]);
  });

  it('keeps subscription runtime references out of the compatibility facade', () => {
    const forbiddenReferences = readTeamProvisioningCompatibilityFacadeGuardSources().flatMap(
      ({ projectPath, source, sourceFile }) => {
        const forbiddenImports = collectModuleSpecifiers(sourceFile).filter((specifier) =>
          SUBSCRIPTION_RUNTIME_REFERENCE_PATTERN.test(specifier)
        );

        if (!SUBSCRIPTION_RUNTIME_REFERENCE_PATTERN.test(source) && forbiddenImports.length === 0) {
          return [];
        }

        return [{ forbiddenImports, projectPath }];
      }
    );

    expect(forbiddenReferences).toEqual([]);
  });

  it('includes extracted facade delegates and superclasses in forbidden-reference coverage', () => {
    const guardedProjectPaths = getTeamProvisioningCompatibilityFacadeGuardPaths().map((filePath) =>
      projectRelativePath(filePath)
    );
    const superclassProjectPaths = collectLocalSuperclassChainPaths().map((filePath) =>
      projectRelativePath(filePath)
    );

    expect(guardedProjectPaths).toEqual(expect.arrayContaining(superclassProjectPaths));
    expect(guardedProjectPaths).toEqual(
      expect.arrayContaining([
        'src/main/services/team/provisioning/TeamProvisioningAppShellFacade.ts',
        'src/main/services/team/provisioning/TeamProvisioningCompatibilityFacade.ts',
        'src/main/services/team/provisioning/TeamProvisioningServiceFacadeDelegates.ts',
      ])
    );
  });

  it('keeps the declared public service entrypoints narrow', () => {
    const source = readTeamProvisioningServiceSource();
    const sourceFile = parseTeamProvisioningServiceSource(source);
    const serviceClass = findTeamProvisioningServiceClass(sourceFile);

    expect(getDeclaredPublicServiceEntryPointNames(sourceFile, serviceClass)).toEqual(
      [...DECLARED_PUBLIC_SERVICE_ENTRYPOINTS].sort((a, b) => a.localeCompare(b))
    );
  });

  it('keeps the effective public service instance surface documented and bounded', () => {
    const publicMemberNames = getEffectivePublicServiceInstanceMemberNames();
    const declaredEntryPoints = new Set<string>(DECLARED_PUBLIC_SERVICE_ENTRYPOINTS);

    expect(publicMemberNames).toEqual(
      [...DOCUMENTED_EFFECTIVE_PUBLIC_SERVICE_INSTANCE_MEMBERS].sort((a, b) => a.localeCompare(b))
    );
    expect(publicMemberNames.some((memberName) => !declaredEntryPoints.has(memberName))).toBe(true);
  });

  it('keeps the constructor dependency surface explicit and bounded', () => {
    const source = readTeamProvisioningServiceSource();
    const sourceFile = parseTeamProvisioningServiceSource(source);
    const serviceClass = findTeamProvisioningServiceClass(sourceFile);

    expect(getConstructorDependencySurface(sourceFile, serviceClass)).toEqual([
      ...CONSTRUCTOR_DEPENDENCIES,
    ]);
  });
});
