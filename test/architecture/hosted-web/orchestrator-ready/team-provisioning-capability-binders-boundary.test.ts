import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CONTRACTS_ROOT = 'src/main/services/team/contracts';
const APPLICATION_APIS_PATH = `${CONTRACTS_ROOT}/TeamApplicationCapabilityApis.ts`;
const APPLICATION_BINDER_PATH = `${CONTRACTS_ROOT}/TeamApplicationCapabilityApiBinder.ts`;
const CAPABILITY_BINDER_PATH = `${CONTRACTS_ROOT}/TeamProvisioningCapabilityApiBinder.ts`;
const MESSAGING_BINDER_PATH = `${CONTRACTS_ROOT}/TeamMessagingApiBinder.ts`;
const RUNTIME_BINDER_PATH = `${CONTRACTS_ROOT}/TeamRuntimeApiBinder.ts`;
const AGGREGATE_BINDER_PATH = `${CONTRACTS_ROOT}/TeamProvisioningApiBinders.ts`;
const COMPATIBILITY_FACADE_PATH = `${CONTRACTS_ROOT}/TeamProvisioningApis.ts`;
const DESKTOP_COMPOSITION_PATH = 'src/main/ipc/desktopTeamFeatureCapabilitySources.ts';

const EXPECTED_CAPABILITY_BINDERS = [
  'bindTeamClaudeLogsApi',
  'bindTeamDiagnosticsApi',
  'bindTeamHttpDataApi',
  'bindTeamMemberLifecycleApi',
  'bindTeamProvisioningPreflightApi',
  'bindTeamProvisioningRunApi',
  'bindTeamProvisioningStartApi',
  'bindTeamProvisioningStatusApi',
  'bindTeamTaskActivityRepairApi',
  'bindTeamToolApprovalApi',
] as const;
const EXPECTED_APPLICATION_BINDERS = [
  'bindTeamApplicationDataApi',
  'bindTeamApplicationProvisioningStartApi',
  'bindTeamApplicationProvisioningStatusApi',
  'bindTeamApplicationResumeApi',
  'bindTeamApplicationRuntimeApi',
  'bindTeamApplicationRuntimeIngressApi',
  'bindTeamApplicationTaskActivityApi',
] as const;
const EXPECTED_MESSAGING_BINDERS = [
  'bindTeamCrossTeamMessagingApi',
  'bindTeamMessagingApi',
] as const;
const EXPECTED_RUNTIME_BINDERS = [
  'bindTeamHttpRuntimeApi',
  'bindTeamOpenCodeRuntimeIngressCompatibilityApi',
  'bindTeamRuntimeApi',
  'bindTeamRuntimeControlCompatibilityApi',
] as const;
const EXPECTED_COMPATIBILITY_RUNTIME_REEXPORTS = [
  'bindTeamHttpRuntimeApi',
  'bindTeamRuntimeApi',
  'bindTeamRuntimeControlCompatibilityApi',
] as const;
const EXPECTED_AGGREGATE_BINDERS = ['bindTeamHttpHandlerApis'] as const;

const EXPECTED_HTTP_CAPABILITIES = [
  'provisioningStart',
  'provisioningStatus',
  'runtime',
  'runtimeIngress',
  'taskActivity',
] as const;
const EXPECTED_DESKTOP_CAPABILITY_BINDERS = [
  'bindTeamClaudeLogsApi',
  'bindTeamDiagnosticsApi',
  'bindTeamMemberLifecycleApi',
  'bindTeamMessagingApi',
  'bindTeamProvisioningPreflightApi',
  'bindTeamProvisioningRunApi',
  'bindTeamProvisioningStartApi',
  'bindTeamProvisioningStatusApi',
  'bindTeamRuntimeApi',
  'bindTeamTaskActivityRepairApi',
  'bindTeamToolApprovalApi',
] as const;

const EXPECTED_FACADE_TYPE_EXPORTS = [
  './TeamProvisioningApiBinders:TeamHttpHandlerApis',
  './TeamProvisioningCapabilityApis:TeamClaudeLogsApi',
  './TeamProvisioningCapabilityApis:TeamDiagnosticsApi',
  './TeamProvisioningCapabilityApis:TeamHttpDataApi',
  './TeamProvisioningCapabilityApis:TeamLiveRosterAttachReason',
  './TeamProvisioningCapabilityApis:TeamMemberLifecycleApi',
  './TeamProvisioningCapabilityApis:TeamProvisioningPreflightApi',
  './TeamProvisioningCapabilityApis:TeamProvisioningPrepareOptions',
  './TeamProvisioningCapabilityApis:TeamProvisioningRunApi',
  './TeamProvisioningCapabilityApis:TeamProvisioningStartApi',
  './TeamProvisioningCapabilityApis:TeamProvisioningStatusApi',
  './TeamProvisioningCapabilityApis:TeamTaskActivityRepairApi',
  './TeamProvisioningCapabilityApis:TeamToolApprovalApi',
  './TeamProvisioningMessagingApis:TeamCrossTeamMessagingApi',
  './TeamProvisioningMessagingApis:TeamMessageAttachmentPayload',
  './TeamProvisioningMessagingApis:TeamMessagingApi',
  './TeamProvisioningMessagingApis:TeamMessagingDeliveryMetadata',
  './TeamProvisioningMessagingApis:TeamMessagingDeliverySource',
  './TeamProvisioningMessagingApis:TeamOpenCodeMemberInboxDelivery',
  './TeamProvisioningMessagingApis:TeamOpenCodeMemberInboxRelayOptions',
  './TeamProvisioningMessagingApis:TeamOpenCodeMemberInboxRelayResult',
  './TeamProvisioningRuntimeApis:OpenCodeRuntimeControlAck',
  './TeamProvisioningRuntimeApis:TeamHttpRuntimeApi',
  './TeamProvisioningRuntimeApis:TeamRuntimeApi',
  './TeamProvisioningRuntimeApis:TeamRuntimeControlCompatibilityApi',
] as const;
const EXPECTED_FACADE_VALUE_EXPORTS = [
  ...EXPECTED_CAPABILITY_BINDERS.map((name) => `./TeamProvisioningCapabilityApiBinder:${name}`),
  ...EXPECTED_MESSAGING_BINDERS.map((name) => `./TeamMessagingApiBinder:${name}`),
  ...EXPECTED_COMPATIBILITY_RUNTIME_REEXPORTS.map((name) => `./TeamRuntimeApiBinder:${name}`),
  ...EXPECTED_AGGREGATE_BINDERS.map((name) => `./TeamProvisioningApiBinders:${name}`),
].sort();

interface ImportRecord {
  readonly names: readonly string[];
  readonly specifier: string;
  readonly typeOnly: boolean;
}

interface ExportShape {
  readonly aliasedExports: readonly string[];
  readonly otherStatements: readonly string[];
  readonly starExports: readonly string[];
  readonly typeExports: readonly string[];
  readonly valueExports: readonly string[];
}

interface LocalExportShape {
  readonly defaultExports: readonly string[];
  readonly localNamedExports: readonly string[];
  readonly typeExports: readonly string[];
  readonly valueExports: readonly string[];
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are test-owned constants.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function sourceFile(path: string, contents = source(path)): ts.SourceFile {
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function moduleSpecifier(statement: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  return statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : null;
}

function namedBindingNames(bindings: ts.NamedImports | ts.NamedExports): readonly {
  readonly name: string;
  readonly sourceName: string;
  readonly typeOnly: boolean;
}[] {
  return bindings.elements.map((element) => ({
    name: element.name.text,
    sourceName: element.propertyName?.text ?? element.name.text,
    typeOnly: element.isTypeOnly,
  }));
}

function imports(path: string, contents = source(path)): ImportRecord[] {
  return sourceFile(path, contents).statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)) return [];
    const specifier = moduleSpecifier(statement);
    const bindings = statement.importClause?.namedBindings;
    if (!specifier || !bindings || !ts.isNamedImports(bindings)) return [];
    const names = namedBindingNames(bindings);
    return [
      {
        names: names.map(({ name }) => name),
        specifier,
        typeOnly:
          statement.importClause?.isTypeOnly === true || names.every(({ typeOnly }) => typeOnly),
      },
    ];
  });
}

function interfacePropertyNames(path: string, interfaceName: string, contents = source(path)) {
  const declaration = sourceFile(path, contents).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  if (!declaration) {
    return null;
  }
  return {
    heritageCount: declaration.heritageClauses?.length ?? 0,
    names: sorted(
      declaration.members.flatMap((member) => {
        if (!ts.isPropertySignature(member) || !member.name) return [];
        return [ts.isIdentifier(member.name) ? member.name.text : member.name.getText()];
      })
    ),
    nonPropertyCount: declaration.members.filter((member) => !ts.isPropertySignature(member))
      .length,
  };
}

function exportShape(path: string, contents = source(path)): ExportShape {
  const aliasedExports: string[] = [];
  const otherStatements: string[] = [];
  const starExports: string[] = [];
  const typeExports: string[] = [];
  const valueExports: string[] = [];

  for (const statement of sourceFile(path, contents).statements) {
    if (!ts.isExportDeclaration(statement)) {
      otherStatements.push(ts.SyntaxKind[statement.kind]);
      continue;
    }
    const specifier = moduleSpecifier(statement);
    if (!specifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      starExports.push(statement.getText());
      continue;
    }
    for (const binding of namedBindingNames(statement.exportClause)) {
      const entry = `${specifier}:${binding.name}`;
      if (binding.sourceName !== binding.name) {
        aliasedExports.push(`${specifier}:${binding.sourceName}->${binding.name}`);
      }
      if (statement.isTypeOnly || binding.typeOnly) {
        typeExports.push(entry);
      } else {
        valueExports.push(entry);
      }
    }
  }

  return {
    aliasedExports: sorted(aliasedExports),
    otherStatements,
    starExports,
    typeExports: sorted(typeExports),
    valueExports: sorted(valueExports),
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind))
  );
}

function localExportShape(path: string, contents = source(path)): LocalExportShape {
  const defaultExports: string[] = [];
  const localNamedExports: string[] = [];
  const typeExports: string[] = [];
  const valueExports: string[] = [];

  for (const statement of sourceFile(path, contents).statements) {
    if (ts.isExportAssignment(statement)) {
      defaultExports.push(statement.getText());
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        localNamedExports.push(
          ...namedBindingNames(statement.exportClause).map(
            ({ name, sourceName }) => `${sourceName}->${name}`
          )
        );
      }
      continue;
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      defaultExports.push(statement.getText());
    }

    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      typeExports.push(statement.name.text);
    } else if (ts.isFunctionDeclaration(statement)) {
      valueExports.push(statement.name?.text ?? 'default');
    } else if (ts.isVariableStatement(statement)) {
      valueExports.push(
        ...statement.declarationList.declarations.map((declaration) => declaration.name.getText())
      );
    } else if (
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      valueExports.push(statement.name?.getText() ?? 'default');
    } else if (ts.isImportEqualsDeclaration(statement)) {
      valueExports.push(statement.name.text);
    }
  }

  return {
    defaultExports,
    localNamedExports: sorted(localNamedExports),
    typeExports: sorted(typeExports),
    valueExports: sorted(valueExports),
  };
}

function moduleReexports(path: string): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const statement of sourceFile(path).statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    const specifier = moduleSpecifier(statement);
    if (!specifier) continue;
    result[specifier] ??= [];
    result[specifier].push(...namedBindingNames(statement.exportClause).map(({ name }) => name));
  }
  return Object.fromEntries(
    Object.entries(result).map(([specifier, names]) => [specifier, sorted(names)])
  );
}

function calledIdentifiers(path: string, functionName: string): string[] {
  const declaration = sourceFile(path).statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  );
  const calls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  if (declaration) visit(declaration);
  return sorted(calls);
}

describe('team provisioning capability binder boundary', () => {
  it('owns each binder in exactly one narrow implementation module', () => {
    expect(localExportShape(APPLICATION_BINDER_PATH)).toEqual({
      defaultExports: [],
      localNamedExports: [],
      typeExports: [],
      valueExports: EXPECTED_APPLICATION_BINDERS,
    });
    expect(localExportShape(CAPABILITY_BINDER_PATH)).toEqual({
      defaultExports: [],
      localNamedExports: [],
      typeExports: [],
      valueExports: EXPECTED_CAPABILITY_BINDERS,
    });
    expect(localExportShape(MESSAGING_BINDER_PATH)).toEqual({
      defaultExports: [],
      localNamedExports: [],
      typeExports: [],
      valueExports: EXPECTED_MESSAGING_BINDERS,
    });
    expect(localExportShape(RUNTIME_BINDER_PATH)).toEqual({
      defaultExports: [],
      localNamedExports: [],
      typeExports: [],
      valueExports: EXPECTED_RUNTIME_BINDERS,
    });

    expect(imports(CAPABILITY_BINDER_PATH)).toEqual([
      {
        names: [
          'TeamClaudeLogsApi',
          'TeamDiagnosticsApi',
          'TeamHttpDataApi',
          'TeamMemberLifecycleApi',
          'TeamProvisioningPreflightApi',
          'TeamProvisioningPrepareOptions',
          'TeamProvisioningRunApi',
          'TeamProvisioningStartApi',
          'TeamProvisioningStatusApi',
          'TeamTaskActivityRepairApi',
          'TeamToolApprovalApi',
        ],
        specifier: './TeamProvisioningCapabilityApis',
        typeOnly: true,
      },
    ]);
    expect(imports(APPLICATION_BINDER_PATH)).toEqual([
      {
        names: [
          'TeamApplicationDataApi',
          'TeamApplicationProvisioningStartApi',
          'TeamApplicationProvisioningStatusApi',
          'TeamApplicationResumeApi',
          'TeamApplicationRuntimeApi',
          'TeamApplicationRuntimeIngressApi',
          'TeamApplicationTaskActivityApi',
        ],
        specifier: './TeamApplicationCapabilityApis',
        typeOnly: true,
      },
    ]);
    expect(imports(MESSAGING_BINDER_PATH)).toEqual([
      {
        names: ['TeamCrossTeamMessagingApi', 'TeamMessagingApi'],
        specifier: './TeamProvisioningMessagingApis',
        typeOnly: true,
      },
    ]);
    expect(imports(RUNTIME_BINDER_PATH)).toEqual([
      {
        names: ['TeamApplicationRuntimeIngressApi'],
        specifier: './TeamApplicationCapabilityApis',
        typeOnly: true,
      },
      {
        names: ['TeamHttpRuntimeApi', 'TeamRuntimeApi', 'TeamRuntimeControlCompatibilityApi'],
        specifier: './TeamProvisioningRuntimeApis',
        typeOnly: true,
      },
    ]);

    for (const path of [
      APPLICATION_BINDER_PATH,
      CAPABILITY_BINDER_PATH,
      MESSAGING_BINDER_PATH,
      RUNTIME_BINDER_PATH,
    ]) {
      const contents = source(path);
      expect(contents).not.toContain('TeamProvisioningApis');
      expect(contents).not.toContain('TeamIpcHandlerApis');
      expect(contents).not.toContain('TeamHttpHandlerApis');
    }
    expect(source(APPLICATION_APIS_PATH)).not.toMatch(/OpenCode|opencode|runtime-control/);
  });

  it('keeps only the HTTP handler binder as compatibility composition', () => {
    expect(localExportShape(AGGREGATE_BINDER_PATH)).toEqual({
      defaultExports: [],
      localNamedExports: [],
      typeExports: ['TeamHttpHandlerApis'],
      valueExports: EXPECTED_AGGREGATE_BINDERS,
    });
    expect(interfacePropertyNames(AGGREGATE_BINDER_PATH, 'TeamHttpHandlerApis')).toEqual({
      heritageCount: 0,
      names: EXPECTED_HTTP_CAPABILITIES,
      nonPropertyCount: 0,
    });
    expect(interfacePropertyNames(AGGREGATE_BINDER_PATH, 'TeamIpcHandlerApis')).toBeNull();
    expect(moduleReexports(AGGREGATE_BINDER_PATH)).toEqual({
      './TeamMessagingApiBinder': EXPECTED_MESSAGING_BINDERS,
      './TeamProvisioningCapabilityApiBinder': EXPECTED_CAPABILITY_BINDERS,
      './TeamRuntimeApiBinder': EXPECTED_COMPATIBILITY_RUNTIME_REEXPORTS,
    });
  });

  it('composes the legacy HTTP aggregate only from its narrow binder imports', () => {
    const valueImports = imports(AGGREGATE_BINDER_PATH)
      .filter(({ typeOnly }) => !typeOnly)
      .map(({ names, specifier }) => ({ names: sorted(names), specifier }))
      .sort((left, right) => left.specifier.localeCompare(right.specifier));

    expect(valueImports).toEqual([
      {
        names: [
          'bindTeamProvisioningStartApi',
          'bindTeamProvisioningStatusApi',
          'bindTeamTaskActivityRepairApi',
        ],
        specifier: './TeamProvisioningCapabilityApiBinder',
      },
      {
        names: ['bindTeamHttpRuntimeApi', 'bindTeamOpenCodeRuntimeIngressCompatibilityApi'],
        specifier: './TeamRuntimeApiBinder',
      },
    ]);
    expect(calledIdentifiers(AGGREGATE_BINDER_PATH, 'bindTeamHttpHandlerApis')).toEqual([
      'bindTeamHttpRuntimeApi',
      'bindTeamOpenCodeRuntimeIngressCompatibilityApi',
      'bindTeamProvisioningStartApi',
      'bindTeamProvisioningStatusApi',
      'bindTeamTaskActivityRepairApi',
    ]);
  });

  it('composes Desktop capability sources directly from every narrow binder', () => {
    const desktopComposition = source(DESKTOP_COMPOSITION_PATH);

    expect(desktopComposition).toContain(
      'export function createDesktopTeamFeatureCapabilitySources('
    );
    expect(desktopComposition).toContain('): DesktopTeamFeatureCapabilitySources');
    expect(desktopComposition).not.toMatch(
      /TeamProvisioningApis|TeamIpcHandlerApis|TeamHttpHandlerApis|TeamProvisioningService/
    );
    for (const binder of EXPECTED_DESKTOP_CAPABILITY_BINDERS) {
      expect(
        desktopComposition.match(new RegExp(`\\b${binder}\\(teamProvisioningService\\)`, 'g')),
        binder
      ).toHaveLength(1);
    }
  });

  it('freezes TeamProvisioningApis as a named-reexport-only compatibility facade', () => {
    expect(exportShape(COMPATIBILITY_FACADE_PATH)).toEqual({
      aliasedExports: [],
      otherStatements: [],
      starExports: [],
      typeExports: sorted(EXPECTED_FACADE_TYPE_EXPORTS),
      valueExports: EXPECTED_FACADE_VALUE_EXPORTS,
    });
  });

  it('detects public export and removed IPC aggregate regressions in fixtures', () => {
    const facadeFixture = `${source(COMPATIBILITY_FACADE_PATH)}
      export { bindUnexpectedApi } from './TeamProvisioningCapabilityApiBinder';
    `;
    const aggregateFixture = `${source(AGGREGATE_BINDER_PATH)}
      export interface TeamIpcHandlerApis {
        runtime: TeamRuntimeApi;
      }
      export function bindTeamIpcHandlerApis(): TeamIpcHandlerApis {
        throw new Error('fixture');
      }
    `;
    const capabilityFixture = `${source(CAPABILITY_BINDER_PATH)}
      export const bindUnexpectedApi = bindTeamDiagnosticsApi;
    `;

    expect(exportShape(COMPATIBILITY_FACADE_PATH, facadeFixture).valueExports).toEqual(
      [
        ...EXPECTED_FACADE_VALUE_EXPORTS,
        './TeamProvisioningCapabilityApiBinder:bindUnexpectedApi',
      ].sort()
    );
    expect(localExportShape(AGGREGATE_BINDER_PATH, aggregateFixture)).toMatchObject({
      typeExports: ['TeamHttpHandlerApis', 'TeamIpcHandlerApis'],
      valueExports: ['bindTeamHttpHandlerApis', 'bindTeamIpcHandlerApis'],
    });
    expect(localExportShape(CAPABILITY_BINDER_PATH, capabilityFixture).valueExports).toEqual(
      [...EXPECTED_CAPABILITY_BINDERS, 'bindUnexpectedApi'].sort()
    );
  });
});
