import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FACADE_PATH = 'src/main/services/team/TeamDataService.ts';
const COMPATIBILITY_PATH = 'src/main/services/team/TeamDataProcessCompatibilityService.ts';
const COMPATIBILITY_CLASS = 'TeamDataProcessCompatibilityService';
const COMPATIBILITY_FIELD = 'processCompatibilityService';
const DELEGATED_METHODS = [
  'listAliveProcessTeams',
  'startProcessHealthPolling',
  'stopProcessHealthPolling',
  'trackProcessHealthForTeam',
  'untrackProcessHealthForTeam',
  'killProcess',
] as const;
const PORT_METHODS = ['listTeams', 'listProcesses', 'stopProcess', 'killProcessByPid'] as const;
const FORBIDDEN_AUTHORITY =
  /(?:agent-teams-controller|TeamProvisioningService|AgentRuntime|team-runtime-control|orchestrator|createController|child_process|\bspawn\b|\bfork\b)/i;
const PROVIDER_LEAKAGE = /(?:OpenCode|opencode|Codex|codex|Claude|claude|providerBackend)/;

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
  const statementExpression = ts.isReturnStatement(statement)
    ? statement.expression
    : ts.isExpressionStatement(statement)
      ? statement.expression
      : undefined;
  if (!statementExpression) return false;
  const expression = ts.isAwaitExpression(statementExpression)
    ? statementExpression.expression
    : statementExpression;
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return false;
  }
  const receiver = expression.expression.expression;
  return (
    expression.expression.name.text === methodName &&
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
    receiver.name.text === COMPATIBILITY_FIELD
  );
}

function interfaceMethodNames(file: ts.SourceFile, interfaceName: string): string[] {
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  if (!declaration) return [];
  return declaration.members
    .filter(ts.isMethodSignature)
    .map((member) => declarationName(member))
    .filter((name): name is string => name !== null);
}

describe('TeamDataService runtime compatibility boundary', () => {
  it('keeps process health/read/kill behavior in one narrow compatibility service', () => {
    const facadeContents = source(FACADE_PATH);
    const compatibilityContents = source(COMPATIBILITY_PATH);
    const facadeClass = serviceClass(parse(FACADE_PATH, facadeContents), 'TeamDataService');
    const compatibilityFile = parse(COMPATIBILITY_PATH, compatibilityContents);
    const compatibilityClass = serviceClass(compatibilityFile, COMPATIBILITY_CLASS);

    const delegates = facadeClass.members
      .filter(ts.isMethodDeclaration)
      .filter((method) => {
        const name = declarationName(method);
        return name !== null && isThinDelegate(method, name);
      })
      .map((method) => declarationName(method));
    expect(DELEGATED_METHODS.filter((method) => !delegates.includes(method))).toEqual([]);
    expect(interfaceMethodNames(compatibilityFile, 'TeamDataProcessCompatibilityPort')).toEqual(
      PORT_METHODS
    );
    expect(compatibilityClass.heritageClauses).toBeUndefined();
    expect(
      facadeContents.match(new RegExp(`\\bnew\\s+${COMPATIBILITY_CLASS}\\s*\\(`, 'g'))
    ).toHaveLength(1);
    expect(facadeContents).toContain(
      'this.processHealthTeams.observeTeamAlive(teamName, snapshot.isAlive === true)'
    );
    expect(facadeContents).not.toMatch(
      /\b(?:processHealthTimer|processHealthTick|setInterval|clearInterval)\b/
    );
    expect(facadeContents).not.toMatch(/\bprocessHealthTeams\s*=\s*new\s+Set\b/);
    expect(compatibilityContents).toMatch(/\bsetInterval\s*\(/);
    expect(compatibilityContents).toMatch(/\bclearInterval\s*\(/);
  });

  it('adapts existing controller and OS capabilities without acquiring lifecycle authority', () => {
    const facadeContents = source(FACADE_PATH);
    const compatibilityContents = source(COMPATIBILITY_PATH);

    expect(facadeContents).toContain(
      'this.getController(teamName).processes.listProcesses() as TeamProcess[]'
    );
    expect(facadeContents).toContain('this.getController(teamName).processes.stopProcess({ pid })');
    expect(facadeContents).toContain('killProcessByPid,');
    expect(compatibilityContents).not.toMatch(FORBIDDEN_AUTHORITY);
    expect(compatibilityContents).not.toMatch(PROVIDER_LEAKAGE);
    expect(compatibilityContents).not.toMatch(
      /\b(?:launch|provision|restart|attach|detach)\w*\s*\(/i
    );
  });
});
