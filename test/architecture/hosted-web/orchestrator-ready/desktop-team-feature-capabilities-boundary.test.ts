import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CAPABILITIES_PATH = 'src/main/ipc/teamFeatureCapabilities.ts';
const COMPOSITION_PATH = 'src/main/ipc/teamFeatureComposition.ts';
const HANDLERS_PATH = 'src/main/ipc/handlers.ts';
const LEGACY_ADAPTERS_PATH = 'src/main/ipc/teamLegacyAdapters.ts';

const source = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const parsedSource = (path: string, contents = source(path)): ts.SourceFile =>
  ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const capabilitySource = source(CAPABILITIES_PATH);
const compositionSource = source(COMPOSITION_PATH);
const handlersSource = source(HANDLERS_PATH);
const legacyAdaptersSource = source(LEGACY_ADAPTERS_PATH);

const EXPECTED_CAPABILITIES = {
  liveLeadMessages: 'DesktopTeamLiveLeadMessagesCapability',
  messageDeliveryCompatibility: 'DesktopTeamMessageDeliveryCompatibilityCapability',
  messaging: 'DesktopTeamMessagingCapability',
  preflight: 'DesktopTeamProvisioningPreflightCapability',
  provisioningRun: 'DesktopTeamProvisioningRunCapability',
  provisioningStart: 'DesktopTeamProvisioningStartCapability',
  provisioningStatus: 'DesktopTeamProvisioningStatusCapability',
  rosterLifecycle: 'DesktopTeamRosterLifecycleCapability',
  runtime: 'DesktopTeamRuntimeCapability',
  runtimeDiagnostics: 'DesktopTeamDiagnosticsCapability',
  runtimeLifecycle: 'DesktopTeamRuntimeLifecycleCapability',
  runtimeLogs: 'DesktopTeamRuntimeLogsCapability',
  taskActivity: 'DesktopTeamTaskActivityCapability',
  toolApproval: 'DesktopTeamToolApprovalCapability',
} as const;

const EXPECTED_REGISTRATION_ORDER = [
  'registerTeamHandlers',
  'registerTeamLifecycleReadIpc',
  'registerTeamLifecycleIpc',
  'registerTeamRuntimeOperationsIpc',
  'registerTeamProvisioningIpc',
  'registerTeamConfigurationIpc',
  'registerTeamMessageDeliveryIpc',
  'registerTeamRosterMutationIpc',
  'registerTeamViewReadModelIpc',
  'registerTeamTaskBoardIpc',
  'registerTeamApprovalsIpc',
  'registerTaskLogObservabilityIpc',
] as const;

const EXPECTED_REMOVAL_ORDER = [
  'removeTeamHandlers',
  'removeTeamLifecycleReadIpc',
  'removeTeamLifecycleIpc',
  'removeTeamRuntimeOperationsIpc',
  'removeTeamProvisioningIpc',
  'removeTeamConfigurationIpc',
  'removeTeamMessageDeliveryIpc',
  'removeTeamRosterMutationIpc',
  'removeTeamViewReadModelIpc',
  'removeTeamTaskBoardIpc',
  'removeTeamApprovalsIpc',
  'removeTaskLogObservabilityIpc',
] as const;

interface InterfaceMember {
  readonly name: string;
  readonly readonly: boolean;
  readonly type: string;
}

function interfaceMembers(interfaceName: string, contents: string): InterfaceMember[] {
  const parsed = parsedSource(CAPABILITIES_PATH, contents);
  const declaration = parsed.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  return (declaration?.members ?? []).flatMap((member) =>
    ts.isPropertySignature(member)
      ? [
          {
            name: member.name?.getText(parsed) ?? '',
            readonly:
              member.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword
              ) === true,
            type: member.type?.getText(parsed) ?? '',
          },
        ]
      : []
  );
}

function desktopCapabilityMembers(contents: string): Record<string, string> {
  return Object.fromEntries(
    interfaceMembers('DesktopTeamFeatureCapabilities', contents).map((member) => [
      member.name,
      member.type,
    ])
  );
}

function orderedCallsInCompositionMember(
  memberName: string,
  identifierPrefix: 'register' | 'initialize'
): string[] {
  const parsed = parsedSource(COMPOSITION_PATH, compositionSource);
  let calls: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === memberName && node.body) {
      const memberCalls: string[] = [];
      const visitMember = (candidate: ts.Node): void => {
        if (
          ts.isCallExpression(candidate) &&
          ts.isIdentifier(candidate.expression) &&
          candidate.expression.text.startsWith(identifierPrefix)
        ) {
          memberCalls.push(candidate.expression.text);
        }
        ts.forEachChild(candidate, visitMember);
      };
      visitMember(node.body);
      calls = memberCalls;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return calls;
}

function orderedCallsInFunction(functionName: string, identifierPrefix: 'remove'): string[] {
  const parsed = parsedSource(COMPOSITION_PATH, compositionSource);
  const declaration = parsed.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  );
  const calls: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.startsWith(identifierPrefix)
    ) {
      calls.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };

  if (declaration?.body) visit(declaration.body);
  return calls;
}

describe('desktop team feature capability freeze boundary', () => {
  it('freezes the explicitly enumerated feature capability surface', () => {
    expect(desktopCapabilityMembers(capabilitySource)).toEqual(EXPECTED_CAPABILITIES);
    expect(
      interfaceMembers('DesktopTeamFeatureCapabilities', capabilitySource).every(
        (member) => member.readonly
      )
    ).toBe(true);
    expect(capabilitySource).toContain("TeamRuntimeOperationsHostPorts['runtime']");
    expect(capabilitySource).toContain(
      "DesktopTeamRosterLifecycleCapability = TeamRosterMutationDependencies['lifecycle']"
    );
    expect(capabilitySource).toContain('Parameters<typeof createTeamRuntimeLifecycleHostPort>[0]');
    expect(capabilitySource).toContain(
      "Pick<\n  TeamRuntimeOperationsHostPorts['logs'],\n  'getClaudeLogs'\n>"
    );
    expect(capabilitySource).toContain("TeamApprovalsDependencies['toolApprovalApi']");
    expect(capabilitySource).toContain('return Object.freeze({');
  });

  it('derives every port from current public feature consumers without a broad service API', () => {
    const parsed = parsedSource(CAPABILITIES_PATH, capabilitySource);
    const imports = parsed.statements.filter(ts.isImportDeclaration);

    expect(
      imports.map((declaration) => ({
        specifier: (declaration.moduleSpecifier as ts.StringLiteral).text,
        typeOnly: declaration.importClause?.isTypeOnly === true,
      }))
    ).toEqual([
      { specifier: '@features/team-runtime-operations/main', typeOnly: false },
      { specifier: '@features/team-approvals/main', typeOnly: true },
      { specifier: '@features/team-configuration/main', typeOnly: true },
      { specifier: '@features/team-message-delivery/main', typeOnly: true },
      { specifier: '@features/team-provisioning/main', typeOnly: true },
      { specifier: '@features/team-roster-mutations/main', typeOnly: true },
      { specifier: '@features/team-task-board/main', typeOnly: true },
      { specifier: '@features/team-view-read-model/main', typeOnly: true },
    ]);
    expect(
      parsed.statements.every(
        (statement) =>
          ts.isImportDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isFunctionDeclaration(statement)
      )
    ).toBe(true);
    expect(capabilitySource).not.toMatch(
      /TeamIpcHandlerApis|TeamProvisioningApis|@main\/services|electron|OpenCode|opencode/
    );
  });

  it('keeps the app shell registration/composition-only and passes one capability object', () => {
    expect(handlersSource).toContain(
      'teamFeatureCapabilitySources: DesktopTeamFeatureCapabilitySources'
    );
    expect(handlersSource).toContain(
      'capabilities: createDesktopTeamFeatureCapabilities(teamFeatureCapabilitySources),'
    );
    expect(handlersSource.match(/createDesktopTeamFeatureCapabilities\(/g)).toHaveLength(1);
    expect(handlersSource).not.toMatch(/TeamIpcHandlerApis|\bteamHandlerApis\b/);
    expect(handlersSource).not.toMatch(/teamFeatureCapabilitySources\.\w+/);
    expect(handlersSource).not.toMatch(/ipcMain\.(?:handle|on|removeHandler|removeAllListeners)\(/);
  });

  it('keeps composition on narrow capabilities without activating another runtime owner', () => {
    expect(compositionSource).toContain(
      'export type DesktopTeamFeatureCompositionDependencies = DesktopTeamLegacyAdapterDependencies;'
    );
    expect(legacyAdaptersSource).toContain('capabilities: DesktopTeamFeatureCapabilities;');
    expect(compositionSource).not.toMatch(/TeamIpcHandlerApis|\bteamHandlerApis\b/);
    expect(legacyAdaptersSource).not.toMatch(/TeamIpcHandlerApis|\bteamHandlerApis\b/);
    expect(compositionSource).not.toContain('createTeamRuntimeLifecycleHostPort');
    expect(legacyAdaptersSource).not.toContain('createTeamRuntimeLifecycleHostPort');

    for (const contents of [capabilitySource, compositionSource, legacyAdaptersSource]) {
      expect(contents).not.toMatch(
        /createTeamLifecycleCommandFeature|team-runtime-control|process-supervision|process-recovery|provider-execution|team-runtime-recovery/
      );
      expect(contents).not.toMatch(
        /node:child_process|\bspawn\s*\(|\bServiceHost\b|\bas unknown as\b/
      );
    }
  });

  it('freezes the existing IPC registrar and remover order without adding operations', () => {
    expect(orderedCallsInCompositionMember('initializeLegacyHandlers', 'initialize')).toEqual([
      'initializeTeamHandlers',
    ]);
    expect(orderedCallsInCompositionMember('register', 'register')).toEqual(
      EXPECTED_REGISTRATION_ORDER
    );
    expect(orderedCallsInFunction('removeDesktopTeamFeatureComposition', 'remove')).toEqual(
      EXPECTED_REMOVAL_ORDER
    );
    expect(capabilitySource).not.toMatch(/\b(?:ipcMain|IpcMain|IPC|http|HTTP)\b/);
  });
});
