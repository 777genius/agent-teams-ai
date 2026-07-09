import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TEAM_PROVISIONING_SERVICE_PATH = resolve(
  process.cwd(),
  'src/main/services/team/TeamProvisioningService.ts'
);
const TEAM_PROVISIONING_SERVICE_LINE_LIMIT = 777;
const SUBSCRIPTION_RUNTIME_REFERENCE_PATTERN = /subscription[-_\s]+runtime|subscriptionRuntime/i;
const TEAM_PROVISIONING_SERVICE_CLASS_NAME = 'TeamProvisioningService';
const DECLARED_PUBLIC_METHODS = ['createTeam', 'launchTeam', 'setTeamChangeEmitter'] as const;
const CONSTRUCTOR_DEPENDENCIES = [
  {
    accessibility: 'private',
    defaultNew: 'TeamConfigReader',
    name: 'configReader',
    type: 'TeamConfigReader',
  },
  {
    accessibility: 'protected',
    defaultNew: 'TeamInboxReader',
    name: 'inboxReader',
    type: 'TeamInboxReader',
  },
  {
    accessibility: 'protected',
    defaultNew: 'TeamMembersMetaStore',
    name: 'membersMetaStore',
    type: 'TeamMembersMetaStore',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamSentMessagesStore',
    name: 'sentMessagesStore',
    type: 'TeamSentMessagesStore',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamMcpConfigBuilder',
    name: 'mcpConfigBuilder',
    type: 'TeamMcpConfigBuilder',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamMetaStore',
    name: 'teamMetaStore',
    type: 'TeamMetaStore',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamInboxWriter',
    name: 'inboxWriter',
    type: 'TeamInboxWriter',
  },
  {
    accessibility: 'private',
    defaultNew: 'OpenCodeTaskLogAttributionStore',
    name: 'openCodeTaskLogAttributionStore',
    type: 'OpenCodeTaskLogAttributionStore',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamMemberWorktreeManager',
    name: 'memberWorktreeManager',
    type: 'TeamMemberWorktreeManager',
  },
  {
    accessibility: 'private',
    defaultNew: 'TeamAttachmentStore',
    name: 'attachmentStore',
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

function parseTeamProvisioningServiceSource(source: string): ts.SourceFile {
  return ts.createSourceFile(
    TEAM_PROVISIONING_SERVICE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function findTeamProvisioningServiceClass(sourceFile: ts.SourceFile): ts.ClassDeclaration {
  const serviceClass = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === TEAM_PROVISIONING_SERVICE_CLASS_NAME
  );

  if (!serviceClass) {
    throw new Error(`Missing ${TEAM_PROVISIONING_SERVICE_CLASS_NAME} class`);
  }

  return serviceClass;
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

function getDeclaredPublicMethodNames(serviceClass: ts.ClassDeclaration): string[] {
  return serviceClass.members
    .filter(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) &&
        !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
        !hasModifier(member, ts.SyntaxKind.ProtectedKeyword) &&
        ts.isIdentifier(member.name)
    )
    .map((member) => (member.name as ts.Identifier).text)
    .sort((a, b) => a.localeCompare(b));
}

function getConstructorDependencySurface(
  sourceFile: ts.SourceFile,
  serviceClass: ts.ClassDeclaration
): Array<{
  accessibility: 'private' | 'protected' | 'public' | 'none';
  defaultNew: string | null;
  name: string;
  type: string | null;
}> {
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

describe('TeamProvisioningService facade guard', () => {
  it('keeps the compatibility facade below the line cap', () => {
    const source = readTeamProvisioningServiceSource();

    expect(countSourceLines(source)).toBeLessThan(TEAM_PROVISIONING_SERVICE_LINE_LIMIT);
  });

  it('keeps subscription runtime references out of the compatibility facade', () => {
    const source = readTeamProvisioningServiceSource();
    const sourceFile = parseTeamProvisioningServiceSource(source);
    const forbiddenImports = collectModuleSpecifiers(sourceFile).filter((specifier) =>
      SUBSCRIPTION_RUNTIME_REFERENCE_PATTERN.test(specifier)
    );

    expect(source).not.toMatch(SUBSCRIPTION_RUNTIME_REFERENCE_PATTERN);
    expect(forbiddenImports).toEqual([]);
  });

  it('keeps the declared public service entrypoints narrow', () => {
    const source = readTeamProvisioningServiceSource();
    const sourceFile = parseTeamProvisioningServiceSource(source);
    const serviceClass = findTeamProvisioningServiceClass(sourceFile);

    expect(getDeclaredPublicMethodNames(serviceClass)).toEqual(
      [...DECLARED_PUBLIC_METHODS].sort((a, b) => a.localeCompare(b))
    );
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
