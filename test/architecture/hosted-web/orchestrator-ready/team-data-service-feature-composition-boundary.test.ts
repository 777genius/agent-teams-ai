import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const OWNED_PATHS = [
  'src/main/services/team/TeamDataControllerCompatibilityAdapter.ts',
  'src/main/services/team/TeamDataLegacyTaskBoardAdapter.ts',
  'src/main/services/team/TeamDataProcessCompatibilityAdapter.ts',
  'src/main/services/team/TeamDataService.ts',
  'src/main/services/team/TeamDataServiceLegacyCompatibilityComposition.ts',
  'test/architecture/hosted-web/orchestrator-ready/team-artifact-reconciliation-boundary.test.ts',
  'test/architecture/hosted-web/orchestrator-ready/team-data-service-feature-composition-boundary.test.ts',
  'test/architecture/hosted-web/orchestrator-ready/team-data-service-roster-boundary.test.ts',
  'test/architecture/hosted-web/orchestrator-ready/team-data-service-runtime-compatibility-boundary.test.ts',
  'test/architecture/hosted-web/orchestrator-ready/team-data-service-task-read-model-boundary.test.ts',
  'test/architecture/hosted-web/orchestrator-ready/team-message-persistence-coordinator-boundary.test.ts',
  'test/main/services/team/TeamDataLegacyCompatibilityAdapters.test.ts',
] as const;
const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const LEGACY_COMPOSITION_PATH =
  'src/main/services/team/TeamDataServiceLegacyCompatibilityComposition.ts';
const FEATURE_COMPOSITION_PATH = 'src/main/services/team/TeamDataServiceFeatureComposition.ts';
const CONTROLLER_ADAPTER_PATH = 'src/main/services/team/TeamDataControllerCompatibilityAdapter.ts';
const TASK_BOARD_ADAPTER_PATH = 'src/main/services/team/TeamDataLegacyTaskBoardAdapter.ts';
const PROCESS_ADAPTER_PATH = 'src/main/services/team/TeamDataProcessCompatibilityAdapter.ts';
const FORBIDDEN_FACADE_RUNTIME_OWNERSHIP =
  /(?:agent-teams-controller|createController|getController|buildLegacyTaskBoard|killProcessByPid|TeamProvisioningService|createTeamLifecycleCommandFeature|team-runtime-control|child_process|\bspawn\b|\bfork\b)/;
const FORBIDDEN_TASK_BOARD_CAPABILITY_MEMBERS = new Set([
  'runtime',
  'lifecycle',
  'launch',
  'stop',
  'create',
]);

type TaskBoardCapabilityBoundaryDiagnostic =
  | 'task-board-controller-adapter-leakage'
  | 'task-board-controller-package-leakage'
  | 'task-board-forbidden-member:create'
  | 'task-board-forbidden-member:launch'
  | 'task-board-forbidden-member:lifecycle'
  | 'task-board-forbidden-member:runtime'
  | 'task-board-forbidden-member:stop'
  | 'task-board-whole-controller-access'
  | 'task-board-whole-controller-type-leakage';
const CONTROLLER_ADAPTER_PUBLIC_CAPABILITIES = [
  'artifactMaintenance',
  'messagePersistence',
  'processes',
  'taskBoard',
] as const;
const CONTROLLER_CAPABILITY_SOURCE_MEMBERS = ['maintenance', 'messages', 'processes'] as const;
const LEGACY_TASK_BOARD_SOURCE_MEMBERS = ['kanban', 'review', 'taskBoard', 'tasks'] as const;
const EXPLICIT_CAPABILITY_PORTS = new Set([
  'TeamDataArtifactMaintenanceCapability',
  'TeamDataMessagePersistenceCapability',
  'TeamDataProcessCapability',
  'TeamDataTaskBoardCapability',
]);
const FORBIDDEN_NARROW_CAPABILITY_MEMBERS = new Set([
  'crossTeam',
  'lifecycle',
  'launch',
  'provider',
  'providers',
  'runtime',
  'stop',
  'create',
]);
const FORBIDDEN_CAPABILITY_OWNERSHIP_IDENTIFIERS = new Set([
  'AgentRuntime',
  'OpenCode',
  'ProcessSupervisor',
  'TeamProvisioningService',
  'TeamRuntimeControl',
  'createTeamLifecycleCommandFeature',
  'lifecycle',
  'opencode',
  'provider',
  'providers',
  'runtime',
]);

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test-owned paths.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function constructorCount(contents: string, className: string): number {
  return (contents.match(new RegExp(`\\bnew\\s+${className}\\s*\\(`, 'g')) ?? []).length;
}

function importedNames(node: ts.ImportDeclaration): readonly string[] {
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
}

function scanTaskBoardCapabilityBoundary(
  contents: string
): readonly TaskBoardCapabilityBoundaryDiagnostic[] {
  const diagnostics = new Set<TaskBoardCapabilityBoundaryDiagnostic>();
  const file = ts.createSourceFile(
    TASK_BOARD_ADAPTER_PATH,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const names = importedNames(node);
      if (
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'agent-teams-controller'
      ) {
        diagnostics.add('task-board-controller-package-leakage');
      }
      if (names.includes('TeamDataControllerCompatibilityAdapter')) {
        diagnostics.add('task-board-controller-adapter-leakage');
      }
      if (names.includes('AgentTeamsController')) {
        diagnostics.add('task-board-whole-controller-type-leakage');
      }
    }
    if (ts.isTypeReferenceNode(node) && node.typeName.getText(file) === 'AgentTeamsController') {
      diagnostics.add('task-board-whole-controller-type-leakage');
    }
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      if (member === 'getController') {
        diagnostics.add('task-board-whole-controller-access');
      }
      if (FORBIDDEN_TASK_BOARD_CAPABILITY_MEMBERS.has(member)) {
        diagnostics.add(
          `task-board-forbidden-member:${member}` as TaskBoardCapabilityBoundaryDiagnostic
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

function declarationName(node: ts.NamedDeclaration): string | null {
  if (!node.name) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

function hasExactMembers(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  return actual.size === expected.length && expected.every((name) => actual.has(name));
}

function namedInterfaceMembers(file: ts.SourceFile, interfaceName: string): ReadonlySet<string> {
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  if (!declaration) return new Set();
  return new Set(
    declaration.members
      .map((member) => {
        if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) return null;
        return declarationName(member);
      })
      .filter((name): name is string => name !== null)
  );
}

function publicClassMembers(file: ts.SourceFile, className: string): ReadonlySet<string> {
  const declaration = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  if (!declaration) return new Set();
  return new Set(
    declaration.members
      .map((member) => {
        if (
          !ts.isPropertyDeclaration(member) &&
          !ts.isMethodDeclaration(member) &&
          !ts.isGetAccessorDeclaration(member)
        ) {
          return null;
        }
        if ((ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) !== 0) {
          return null;
        }
        return declarationName(member);
      })
      .filter((name): name is string => name !== null)
  );
}

function scanNarrowCapabilityBoundary(
  contents: string,
  allowedCapabilityPorts: readonly string[]
): readonly string[] {
  const diagnostics = new Set<string>();
  const allowedPorts = new Set(allowedCapabilityPorts);
  const file = ts.createSourceFile(
    'narrow-capability.ts',
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const names = importedNames(node);
      if (
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'agent-teams-controller'
      ) {
        diagnostics.add('capability-controller-package-leakage');
      }
      if (names.includes('TeamDataControllerCompatibilityAdapter')) {
        diagnostics.add('capability-controller-adapter-leakage');
      }
      if (names.includes('AgentTeamsController')) {
        diagnostics.add('capability-whole-controller-type-leakage');
      }
      for (const capabilityPort of EXPLICIT_CAPABILITY_PORTS) {
        if (names.includes(capabilityPort) && !allowedPorts.has(capabilityPort)) {
          diagnostics.add('capability-foreign-port-leakage:' + capabilityPort);
        }
      }
    }
    if (ts.isTypeReferenceNode(node) && node.typeName.getText(file) === 'AgentTeamsController') {
      diagnostics.add('capability-whole-controller-type-leakage');
    }
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      if (member === 'getController') {
        diagnostics.add('capability-whole-controller-access');
      }
      if (FORBIDDEN_NARROW_CAPABILITY_MEMBERS.has(member)) {
        diagnostics.add('capability-forbidden-member:' + member);
      }
    }
    if (ts.isIdentifier(node) && FORBIDDEN_CAPABILITY_OWNERSHIP_IDENTIFIERS.has(node.text)) {
      if (node.text === 'provider' || node.text === 'providers' || node.text === 'OpenCode') {
        diagnostics.add('capability-provider-vocabulary-leakage');
      } else {
        diagnostics.add('capability-runtime-lifecycle-owner-leakage:' + node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

function scanControllerAdapterBoundary(contents: string): readonly string[] {
  const diagnostics = new Set<string>();
  const file = ts.createSourceFile(
    CONTROLLER_ADAPTER_PATH,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importedNames(node).includes('AgentTeamsController')) {
      diagnostics.add('controller-adapter-whole-controller-type-leakage');
    }
    if (ts.isIdentifier(node) && node.text === 'AgentTeamsController') {
      diagnostics.add('controller-adapter-whole-controller-type-leakage');
    }
    if (ts.isIdentifier(node) && FORBIDDEN_CAPABILITY_OWNERSHIP_IDENTIFIERS.has(node.text)) {
      if (node.text === 'provider' || node.text === 'providers' || node.text === 'OpenCode') {
        diagnostics.add('controller-adapter-provider-vocabulary-leakage');
      } else {
        diagnostics.add('controller-adapter-runtime-lifecycle-owner-leakage:' + node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (
    !hasExactMembers(
      publicClassMembers(file, 'TeamDataControllerCompatibilityAdapter'),
      CONTROLLER_ADAPTER_PUBLIC_CAPABILITIES
    )
  ) {
    diagnostics.add('controller-adapter-public-surface-leakage');
  }
  if (
    !hasExactMembers(
      namedInterfaceMembers(file, 'TeamDataControllerCompatibilityCapabilities'),
      CONTROLLER_ADAPTER_PUBLIC_CAPABILITIES
    )
  ) {
    diagnostics.add('controller-adapter-capability-contract-leakage');
  }
  if (
    !hasExactMembers(
      namedInterfaceMembers(file, 'TeamDataControllerCapabilitySource'),
      CONTROLLER_CAPABILITY_SOURCE_MEMBERS
    ) ||
    !hasExactMembers(
      namedInterfaceMembers(file, 'LegacyTaskBoardController'),
      LEGACY_TASK_BOARD_SOURCE_MEMBERS
    )
  ) {
    diagnostics.add('controller-adapter-capability-source-leakage');
  }

  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

describe('TeamDataService legacy composition boundary', () => {
  it('keeps the v706 extraction limited to the exact admitted paths', () => {
    expect(OWNED_PATHS).toHaveLength(12);
    expect(new Set(OWNED_PATHS).size).toBe(12);
    expect(OWNED_PATHS.every((path) => existsSync(resolve(process.cwd(), path)))).toBe(true);
  });

  it('keeps TeamDataService below 450 lines and free of controller, task-board, and process ownership', () => {
    const service = source(SERVICE_PATH);

    expect(service.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(450);
    expect(constructorCount(service, 'TeamDataServiceLegacyCompatibilityComposition')).toBe(1);
    expect(service).not.toMatch(FORBIDDEN_FACADE_RUNTIME_OWNERSHIP);
    expect(service).not.toMatch(
      /\b(?:TeamDataServiceFeatureComposition|TeamDataProcessCompatibilityService|createTeamMessagePersistenceFacade|createTeamRosterPersistenceRepository)\b/
    );
  });

  it('wires retained compatibility only through the narrow outer adapters', () => {
    const composition = source(LEGACY_COMPOSITION_PATH);
    const controllerAdapter = source(CONTROLLER_ADAPTER_PATH);
    const taskBoardAdapter = source(TASK_BOARD_ADAPTER_PATH);
    const processAdapter = source(PROCESS_ADAPTER_PATH);

    expect(constructorCount(composition, 'TeamDataServiceFeatureComposition')).toBe(1);
    expect(constructorCount(composition, 'TeamDataControllerCompatibilityAdapter')).toBe(1);
    expect(constructorCount(composition, 'TeamDataLegacyTaskBoardAdapter')).toBe(1);
    expect(constructorCount(composition, 'TeamDataProcessCompatibilityAdapter')).toBe(1);
    expect(constructorCount(composition, 'TeamDataProcessCompatibilityService')).toBe(1);
    expect(constructorCount(composition, 'TeamDataConfigurationCompatibilityService')).toBe(1);
    expect(composition.match(/\bcreateTeamMessagePersistenceFacade\s*\(/g)).toHaveLength(1);
    expect(composition.match(/\bcreateTeamRosterPersistenceRepository\s*\(/g)).toHaveLength(1);
    expect(composition).not.toMatch(
      /(?:agent-teams-controller|killProcessByPid|createController|TeamProvisioningService|createTeamLifecycleCommandFeature|team-runtime-control)/
    );
    expect(controllerAdapter).toContain("from 'agent-teams-controller'");
    expect(controllerAdapter).not.toMatch(/\bAgentTeamsController\b/);
    expect(scanControllerAdapterBoundary(controllerAdapter)).toEqual([]);
    expect(composition).toContain('controllerCapabilities.taskBoard');
    expect(composition).toContain('controllerCapabilities.processes');
    expect(composition).toContain('controllerCapabilities.messagePersistence');
    expect(composition).toContain('controllerCapabilities.artifactMaintenance');
    expect(controllerAdapter).toContain(
      'readonly artifactMaintenance: TeamDataArtifactMaintenanceCapability'
    );
    expect(taskBoardAdapter).toContain('TeamDataTaskBoardCapability');
    expect(taskBoardAdapter).toContain('this.taskBoardCapability.getTaskBoard(teamName)');
    expect(scanTaskBoardCapabilityBoundary(taskBoardAdapter)).toEqual([]);
    expect(processAdapter).toContain('TeamDataProcessCapability');
    expect(processAdapter).toContain('this.processes.listProcesses(teamName)');
    expect(processAdapter).toContain('this.processes.stopProcess(teamName, pid)');
    expect(scanNarrowCapabilityBoundary(processAdapter, ['TeamDataProcessCapability'])).toEqual([]);
    expect(processAdapter).toContain("from '@main/utils/processKill'");
    expect([controllerAdapter, taskBoardAdapter, processAdapter].join('\n')).not.toMatch(
      /(?:OpenCode|opencode|createTeamLifecycleCommandFeature|team-runtime-control|TeamProvisioningService)/
    );
  });

  it('rejects whole-controller and runtime/lifecycle leakage from the task-board capability', () => {
    expect(
      scanTaskBoardCapabilityBoundary(`
        import { TeamDataControllerCompatibilityAdapter } from './TeamDataControllerCompatibilityAdapter';
        import type { AgentTeamsController } from 'agent-teams-controller';

        declare const controller: AgentTeamsController;
        controller.getController('team');
        controller.runtime;
        controller.lifecycle;
        controller.launch;
        controller.stop;
        controller.create;
      `)
    ).toEqual([
      'task-board-controller-adapter-leakage',
      'task-board-controller-package-leakage',
      'task-board-forbidden-member:create',
      'task-board-forbidden-member:launch',
      'task-board-forbidden-member:lifecycle',
      'task-board-forbidden-member:runtime',
      'task-board-forbidden-member:stop',
      'task-board-whole-controller-access',
      'task-board-whole-controller-type-leakage',
    ]);
  });

  it('rejects whole-controller, foreign capability, provider, and runtime/lifecycle leakage', () => {
    expect(
      scanNarrowCapabilityBoundary(
        [
          "import { TeamDataControllerCompatibilityAdapter, TeamDataProcessCapability } from './TeamDataControllerCompatibilityAdapter';",
          "import type { AgentTeamsController } from 'agent-teams-controller';",
          'declare const controller: AgentTeamsController;',
          "controller.getController('team');",
          'controller.runtime;',
          'controller.lifecycle;',
          'controller.launch;',
          'controller.stop;',
          'controller.create;',
          'controller.crossTeam;',
          'controller.provider;',
        ].join('\n'),
        ['TeamDataTaskBoardCapability', 'TeamDataTaskBoardPort']
      )
    ).toEqual([
      'capability-controller-adapter-leakage',
      'capability-controller-package-leakage',
      'capability-forbidden-member:create',
      'capability-forbidden-member:crossTeam',
      'capability-forbidden-member:launch',
      'capability-forbidden-member:lifecycle',
      'capability-forbidden-member:provider',
      'capability-forbidden-member:runtime',
      'capability-forbidden-member:stop',
      'capability-foreign-port-leakage:TeamDataProcessCapability',
      'capability-provider-vocabulary-leakage',
      'capability-runtime-lifecycle-owner-leakage:lifecycle',
      'capability-runtime-lifecycle-owner-leakage:runtime',
      'capability-whole-controller-access',
      'capability-whole-controller-type-leakage',
    ]);
    expect(
      scanControllerAdapterBoundary(
        [
          "import type { AgentTeamsController } from 'agent-teams-controller';",
          'interface LegacyTaskBoardController {',
          '  readonly taskBoard?: unknown;',
          '  readonly tasks?: unknown;',
          '  readonly kanban?: unknown;',
          '  readonly review?: unknown;',
          '}',
          'interface TeamDataControllerCapabilitySource extends LegacyTaskBoardController {',
          '  readonly processes: unknown;',
          '  readonly messages: unknown;',
          '  readonly maintenance: unknown;',
          '  readonly runtime: unknown;',
          '  readonly provider: unknown;',
          '}',
          'export interface TeamDataControllerCompatibilityCapabilities {',
          '  readonly taskBoard: unknown;',
          '  readonly processes: unknown;',
          '  readonly messagePersistence: unknown;',
          '  readonly artifactMaintenance: unknown;',
          '}',
          'export class TeamDataControllerCompatibilityAdapter {',
          '  readonly taskBoard: unknown;',
          '  readonly processes: unknown;',
          '  readonly messagePersistence: unknown;',
          '  readonly artifactMaintenance: unknown;',
          '  getController(): AgentTeamsController { throw new Error(); }',
          '}',
        ].join('\n')
      )
    ).toEqual([
      'controller-adapter-capability-source-leakage',
      'controller-adapter-provider-vocabulary-leakage',
      'controller-adapter-public-surface-leakage',
      'controller-adapter-runtime-lifecycle-owner-leakage:runtime',
      'controller-adapter-whole-controller-type-leakage',
    ]);
  });

  it('keeps feature composition policy-free and mutable compatibility collaborators late-bound', () => {
    const legacyComposition = source(LEGACY_COMPOSITION_PATH);
    const featureComposition = source(FEATURE_COMPOSITION_PATH);

    expect(legacyComposition).toContain(
      'getTaskBoardCommandFacade: () => this.taskBoardCommandFacade'
    );
    expect(legacyComposition).toContain(
      'getMemberRuntimeAdvisoryService: () => this.memberRuntimeAdvisoryService'
    );
    expect(legacyComposition).toContain(
      'setTaskBoardCommandFacade(facade: TaskBoardCommandFacade | null)'
    );
    expect(legacyComposition).toContain(
      'setMemberRuntimeAdvisoryService(service: TeamMemberRuntimeAdvisoryService)'
    );
    expect(featureComposition).not.toMatch(
      /(?:agent-teams-controller|TeamProvisioningService|team-runtime-control|OpenCode|opencode|child_process|electron|fastify)/i
    );
    expect(featureComposition).not.toMatch(
      /\b(?:setInterval|setTimeout|clearInterval|clearTimeout|spawn|fork|createController)\s*\(/
    );
    expect(featureComposition).not.toMatch(/\bTeamMessagePersistenceCoordinator\b/);
  });
});
