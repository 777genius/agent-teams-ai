import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FACADE_PATH = 'src/main/services/team/TeamDataService.ts';
const LEGACY_COMPOSITION_PATH =
  'src/main/services/team/TeamDataServiceLegacyCompatibilityComposition.ts';
const PROCESS_ADAPTER_PATH = 'src/main/services/team/TeamDataProcessCompatibilityAdapter.ts';
const PROCESS_COMPATIBILITY_PATH = 'src/main/services/team/TeamDataProcessCompatibilityService.ts';
const CONTROLLER_ADAPTER_PATH = 'src/main/services/team/TeamDataControllerCompatibilityAdapter.ts';
const DELEGATED_METHODS = [
  'listAliveProcessTeams',
  'startProcessHealthPolling',
  'stopProcessHealthPolling',
  'trackProcessHealthForTeam',
  'untrackProcessHealthForTeam',
  'killProcess',
] as const;
const FORBIDDEN_LIFECYCLE_OWNERS =
  /(?:TeamProvisioningService|createTeamLifecycleCommandFeature|team-runtime-control|AgentRuntime|orchestrator|child_process|\bspawn\b|\bfork\b)/i;
const PROVIDER_LEAKAGE =
  /\b(?:AgentTeamsController|Claude|Codex|OpenCode|opencode|provider|providers)\b/;

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

function serviceClass(file: ts.SourceFile, className: string): ts.ClassDeclaration {
  const declaration = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  if (!declaration) throw new Error(`Missing class: ${className}`);
  return declaration;
}

function isThinDelegate(node: ts.MethodDeclaration, methodName: string): boolean {
  if (!node.body || node.body.statements.length !== 1) return false;
  const statement = node.body.statements[0];
  const expression = ts.isReturnStatement(statement)
    ? statement.expression
    : ts.isExpressionStatement(statement)
      ? statement.expression
      : undefined;
  const call = expression && ts.isAwaitExpression(expression) ? expression.expression : expression;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
    return false;
  }
  const receiver = call.expression.expression;
  return (
    call.expression.name.text === methodName &&
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
    receiver.name.text === 'processCompatibilityService'
  );
}

function constructorCount(contents: string, className: string): number {
  return (contents.match(new RegExp(`\\bnew\\s+${className}\\s*\\(`, 'g')) ?? []).length;
}

describe('TeamDataService runtime compatibility boundary', () => {
  it('keeps every legacy process method a one-step facade delegation without controller or OS ownership', () => {
    const facadeContents = source(FACADE_PATH);
    const facadeClass = serviceClass(parse(FACADE_PATH, facadeContents), 'TeamDataService');
    const delegates = facadeClass.members
      .filter(ts.isMethodDeclaration)
      .map((method) => declarationName(method))
      .filter((name): name is string => name !== null)
      .filter((name) => {
        const method = facadeClass.members.find(
          (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) && declarationName(member) === name
        );
        return method ? isThinDelegate(method, name) : false;
      });

    expect(DELEGATED_METHODS.filter((method) => !delegates.includes(method))).toEqual([]);
    expect(facadeContents).toContain(
      'this.processCompatibilityService.observeTeamAlive(teamName, snapshot.isAlive === true)'
    );
    expect(facadeContents).not.toMatch(
      /(?:agent-teams-controller|createController|getController|killProcessByPid|processHealthTimer|processHealthTick|setInterval|clearInterval)/
    );
    expect(constructorCount(facadeContents, 'TeamDataProcessCompatibilityService')).toBe(0);
  });

  it('adapts existing controller and OS capabilities behind one compatibility owner', () => {
    const composition = source(LEGACY_COMPOSITION_PATH);
    const adapter = source(PROCESS_ADAPTER_PATH);
    const compatibility = source(PROCESS_COMPATIBILITY_PATH);
    const controllerAdapter = source(CONTROLLER_ADAPTER_PATH);

    expect(constructorCount(composition, 'TeamDataProcessCompatibilityAdapter')).toBe(1);
    expect(constructorCount(composition, 'TeamDataProcessCompatibilityService')).toBe(1);
    expect(adapter).toContain('implements TeamDataProcessCompatibilityPort');
    expect(adapter).toContain('listTeams(): Promise<TeamSummary[]>');
    expect(adapter).toContain('listProcesses(teamName: string)');
    expect(adapter).toContain('stopProcess(teamName: string, pid: number): void');
    expect(adapter).toContain('killProcessByPid(pid: number): void');
    expect(adapter).toContain("from '@main/utils/processKill'");
    expect(adapter).toContain('TeamDataProcessCapability');
    expect(adapter).toContain('this.processes.listProcesses(teamName)');
    expect(adapter).toContain('this.processes.stopProcess(teamName, pid)');
    expect(compatibility).toMatch(/\bsetInterval\s*\(/);
    expect(compatibility).toMatch(/\bclearInterval\s*\(/);
    expect(adapter).not.toMatch(
      /\b(?:setInterval|clearInterval|processHealthTimer|processHealthTick)\b/
    );
    expect(controllerAdapter).toContain('readonly processes: TeamDataProcessCapability');
    expect(controllerAdapter).not.toMatch(/\b(?:AgentTeamsController|getController)\b/);
  });

  it('does not activate a second lifecycle/process owner or leak provider vocabulary into compatibility ports', () => {
    const sources = [
      source(FACADE_PATH),
      source(LEGACY_COMPOSITION_PATH),
      source(PROCESS_ADAPTER_PATH),
      source(PROCESS_COMPATIBILITY_PATH),
      source(CONTROLLER_ADAPTER_PATH),
    ].join('\n');

    expect(sources).not.toMatch(FORBIDDEN_LIFECYCLE_OWNERS);
    expect(sources).not.toMatch(PROVIDER_LEAKAGE);
  });
});
