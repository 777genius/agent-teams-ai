import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const expectedTypeExportsByModule = {
  './TeamProvisioningCapabilityApis': [
    'TeamClaudeLogsApi',
    'TeamDiagnosticsApi',
    'TeamHttpDataApi',
    'TeamLiveRosterAttachReason',
    'TeamMemberLifecycleApi',
    'TeamProvisioningPreflightApi',
    'TeamProvisioningPrepareOptions',
    'TeamProvisioningRunApi',
    'TeamProvisioningStartApi',
    'TeamProvisioningStatusApi',
    'TeamTaskActivityRepairApi',
    'TeamToolApprovalApi',
  ],
  './TeamProvisioningRuntimeApis': [
    'OpenCodeRuntimeControlAck',
    'TeamHttpRuntimeApi',
    'TeamRuntimeApi',
    'TeamRuntimeControlCompatibilityApi',
  ],
  './TeamProvisioningMessagingApis': [
    'TeamCrossTeamMessagingApi',
    'TeamMessageAttachmentPayload',
    'TeamMessagingApi',
    'TeamMessagingDeliveryMetadata',
    'TeamMessagingDeliverySource',
    'TeamOpenCodeMemberInboxDelivery',
    'TeamOpenCodeMemberInboxRelayOptions',
    'TeamOpenCodeMemberInboxRelayResult',
  ],
  './TeamProvisioningApiBinders': ['TeamHttpHandlerApis'],
} as const;

const expectedValueExportsByModule = {
  './TeamMessagingApiBinder': ['bindTeamCrossTeamMessagingApi', 'bindTeamMessagingApi'],
  './TeamProvisioningCapabilityApiBinder': [
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
  ],
  './TeamProvisioningApiBinders': ['bindTeamHttpHandlerApis'],
  './TeamRuntimeApiBinder': [
    'bindTeamHttpRuntimeApi',
    'bindTeamRuntimeApi',
    'bindTeamRuntimeControlCompatibilityApi',
  ],
} as const;

const expectedRuntimeBinderValueExports = [
  'bindTeamHttpRuntimeApi',
  'bindTeamOpenCodeRuntimeIngressCompatibilityApi',
  'bindTeamRuntimeApi',
  'bindTeamRuntimeControlCompatibilityApi',
] as const;

const expectedApplicationTypeExports = [
  'TeamApplicationDataApi',
  'TeamApplicationProvisioningStartApi',
  'TeamApplicationProvisioningStatusApi',
  'TeamApplicationResumeApi',
  'TeamApplicationRuntimeIngressAck',
  'TeamApplicationRuntimeIngressApi',
  'TeamApplicationRuntimeApi',
  'TeamApplicationTaskActivityApi',
] as const;

const expectedApplicationValueExports = [
  'bindTeamApplicationDataApi',
  'bindTeamApplicationProvisioningStartApi',
  'bindTeamApplicationProvisioningStatusApi',
  'bindTeamApplicationResumeApi',
  'bindTeamApplicationRuntimeIngressApi',
  'bindTeamApplicationRuntimeApi',
  'bindTeamApplicationTaskActivityApi',
] as const;

interface ParsedModule {
  readonly path: string;
  readonly source: string;
  readonly sourceFile: ts.SourceFile;
}

interface ImplementationModulePolicy {
  readonly allowFunctionDeclarations: boolean;
  readonly allowedTypeImportModules: ReadonlySet<string>;
  readonly allowedValueImportModules: ReadonlySet<string>;
  readonly allowedLocalTypeExports: readonly string[];
  readonly expectedModuleReexports: readonly string[];
  readonly expectedTypeExports: readonly string[];
  readonly expectedValueExports: readonly string[];
}

interface ImplementationInspection {
  readonly defaultExportViolations: string[];
  readonly exportShapeViolations: string[];
  readonly importViolations: string[];
  readonly localTypeExports: string[];
  readonly localValueExports: string[];
  readonly moduleReexports: string[];
  readonly parseDiagnostics: string[];
  readonly topLevelViolations: string[];
  readonly typeExports: string[];
  readonly valueExports: string[];
}

const FACADE_PATH = 'src/main/services/team/contracts/TeamProvisioningApis.ts';
const AGGREGATE_BINDER_PATH = 'src/main/services/team/contracts/TeamProvisioningApiBinders.ts';

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function parseModule(path: string, source = readFileSync(path, 'utf8')): ParsedModule {
  return {
    path,
    source,
    sourceFile: ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

const facade = parseModule(FACADE_PATH);
const aggregateBinders = parseModule(AGGREGATE_BINDER_PATH);

const implementationModules: readonly [string, ParsedModule, ImplementationModulePolicy][] = [
  [
    'application capabilities',
    parseModule('src/main/services/team/contracts/TeamApplicationCapabilityApis.ts'),
    {
      allowFunctionDeclarations: false,
      allowedTypeImportModules: new Set(['@shared/types/team']),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [],
      expectedTypeExports: expectedApplicationTypeExports,
      expectedValueExports: [],
    },
  ],
  [
    'application capability binders',
    parseModule('src/main/services/team/contracts/TeamApplicationCapabilityApiBinder.ts'),
    {
      allowFunctionDeclarations: true,
      allowedTypeImportModules: new Set(['./TeamApplicationCapabilityApis']),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [],
      expectedTypeExports: [],
      expectedValueExports: expectedApplicationValueExports,
    },
  ],
  [
    'capability',
    parseModule('src/main/services/team/contracts/TeamProvisioningCapabilityApis.ts'),
    {
      allowFunctionDeclarations: false,
      allowedTypeImportModules: new Set([
        '@features/team-provisioning/contracts',
        '@shared/types/team',
      ]),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [],
      expectedTypeExports: expectedTypeExportsByModule['./TeamProvisioningCapabilityApis'],
      expectedValueExports: [],
    },
  ],
  [
    'runtime',
    parseModule('src/main/services/team/contracts/TeamProvisioningRuntimeApis.ts'),
    {
      allowFunctionDeclarations: false,
      allowedTypeImportModules: new Set([
        '../runtime-control',
        '@features/team-provisioning/contracts',
        '@shared/types/team',
      ]),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: ['OpenCodeRuntimeControlAck'],
      expectedModuleReexports: [],
      expectedTypeExports: expectedTypeExportsByModule['./TeamProvisioningRuntimeApis'],
      expectedValueExports: [],
    },
  ],
  [
    'messaging',
    parseModule('src/main/services/team/contracts/TeamProvisioningMessagingApis.ts'),
    {
      allowFunctionDeclarations: false,
      allowedTypeImportModules: new Set([
        '@features/team-provisioning/contracts',
        '@shared/types/team',
      ]),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [],
      expectedTypeExports: expectedTypeExportsByModule['./TeamProvisioningMessagingApis'],
      expectedValueExports: [],
    },
  ],
  [
    'capability binders',
    parseModule('src/main/services/team/contracts/TeamProvisioningCapabilityApiBinder.ts'),
    {
      allowFunctionDeclarations: true,
      allowedTypeImportModules: new Set(['./TeamProvisioningCapabilityApis']),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [],
      expectedTypeExports: [],
      expectedValueExports: expectedValueExportsByModule['./TeamProvisioningCapabilityApiBinder'],
    },
  ],
  [
    'messaging binders',
    parseModule('src/main/services/team/contracts/TeamMessagingApiBinder.ts'),
    {
      allowFunctionDeclarations: true,
      allowedTypeImportModules: new Set(['./TeamProvisioningMessagingApis']),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [],
      expectedTypeExports: [],
      expectedValueExports: expectedValueExportsByModule['./TeamMessagingApiBinder'],
    },
  ],
  [
    'runtime binders',
    parseModule('src/main/services/team/contracts/TeamRuntimeApiBinder.ts'),
    {
      allowFunctionDeclarations: true,
      allowedTypeImportModules: new Set([
        './TeamApplicationCapabilityApis',
        './TeamProvisioningRuntimeApis',
      ]),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [],
      expectedTypeExports: [],
      expectedValueExports: expectedRuntimeBinderValueExports,
    },
  ],
  [
    'aggregate binders',
    aggregateBinders,
    {
      allowFunctionDeclarations: true,
      allowedTypeImportModules: new Set([
        './TeamApplicationCapabilityApis',
        './TeamProvisioningCapabilityApis',
        './TeamProvisioningRuntimeApis',
      ]),
      allowedValueImportModules: new Set([
        './TeamProvisioningCapabilityApiBinder',
        './TeamRuntimeApiBinder',
      ]),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [
        './TeamMessagingApiBinder',
        './TeamProvisioningCapabilityApiBinder',
        './TeamRuntimeApiBinder',
      ],
      expectedTypeExports: expectedTypeExportsByModule['./TeamProvisioningApiBinders'],
      expectedValueExports: expectedValueExportsByModule['./TeamProvisioningApiBinders'],
    },
  ],
];

function parseDiagnostics(module: ParsedModule): string[] {
  const result = ts.transpileModule(module.source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.Latest,
    },
    fileName: module.path,
    reportDiagnostics: true,
  });

  return (result.diagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  );
}

function productionTypeScriptPaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return productionTypeScriptPaths(path);
    }
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function moduleSpecifierText(moduleSpecifier: ts.Expression | undefined): string | null {
  return moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier) ? moduleSpecifier.text : null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind))
  );
}

function isTypeOnlyImport(statement: ts.ImportDeclaration): boolean {
  const importClause = statement.importClause;
  if (!importClause) return false;
  if (importClause.isTypeOnly) return true;
  if (importClause.name) return false;

  const bindings = importClause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;

  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function statementKind(statement: ts.Statement): string {
  if (ts.isVariableStatement(statement)) return 'VariableStatement';
  return ts.SyntaxKind[statement.kind];
}

function facadeExportEntries(exportMap: Readonly<Record<string, readonly string[]>>): string[] {
  return sorted(
    Object.entries(exportMap).flatMap(([moduleSpecifier, names]) =>
      names.map((name) => `${moduleSpecifier}:${name}`)
    )
  );
}

function inspectFacade(module: ParsedModule): {
  readonly exportShapeViolations: string[];
  readonly modules: string[];
  readonly parseDiagnostics: string[];
  readonly topLevelViolations: string[];
  readonly typeExports: string[];
  readonly valueExports: string[];
} {
  const exportShapeViolations: string[] = [];
  const modules = new Set<string>();
  const topLevelViolations: string[] = [];
  const typeExports: string[] = [];
  const valueExports: string[] = [];

  for (const statement of module.sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      topLevelViolations.push(statementKind(statement));
      continue;
    }

    const moduleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
    if (!moduleSpecifier) {
      exportShapeViolations.push(statement.getText(module.sourceFile));
      continue;
    }
    modules.add(moduleSpecifier);

    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      exportShapeViolations.push(statement.getText(module.sourceFile));
      continue;
    }

    for (const element of statement.exportClause.elements) {
      if (element.propertyName) {
        exportShapeViolations.push(element.getText(module.sourceFile));
      }
      const entry = `${moduleSpecifier}:${element.name.text}`;
      if (statement.isTypeOnly || element.isTypeOnly) {
        typeExports.push(entry);
      } else {
        valueExports.push(entry);
      }
    }
  }

  return {
    exportShapeViolations,
    modules: sorted(modules),
    parseDiagnostics: parseDiagnostics(module),
    topLevelViolations,
    typeExports: sorted(typeExports),
    valueExports: sorted(valueExports),
  };
}

function inspectInterfaceShape(
  module: ParsedModule,
  interfaceName: string
): {
  readonly heritageCount: number;
  readonly nonPropertyMembers: string[];
  readonly propertyNames: string[];
} | null {
  const declaration = module.sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  if (!declaration) {
    return null;
  }

  return {
    heritageCount: declaration.heritageClauses?.length ?? 0,
    nonPropertyMembers: declaration.members
      .filter((member) => !ts.isPropertySignature(member))
      .map((member) => member.getText(module.sourceFile)),
    propertyNames: sorted(
      declaration.members.flatMap((member) =>
        ts.isPropertySignature(member) && member.name
          ? [member.name.getText(module.sourceFile)]
          : []
      )
    ),
  };
}

function exportedVariableNames(
  statement: ts.VariableStatement,
  sourceFile: ts.SourceFile
): string[] {
  return statement.declarationList.declarations.map((declaration) =>
    declaration.name.getText(sourceFile)
  );
}

function inspectImplementationModule(
  module: ParsedModule,
  policy: ImplementationModulePolicy
): ImplementationInspection {
  const allowedTopLevelKinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.ExportDeclaration,
    ts.SyntaxKind.ImportDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
  ]);
  if (policy.allowFunctionDeclarations) {
    allowedTopLevelKinds.add(ts.SyntaxKind.FunctionDeclaration);
  }

  const defaultExportViolations: string[] = [];
  const exportShapeViolations: string[] = [];
  const importViolations: string[] = [];
  const localTypeExports: string[] = [];
  const localValueExports: string[] = [];
  const moduleReexports: string[] = [];
  const topLevelViolations: string[] = [];
  const typeExports: string[] = [];
  const valueExports: string[] = [];

  for (const statement of module.sourceFile.statements) {
    if (!allowedTopLevelKinds.has(statement.kind)) {
      topLevelViolations.push(statementKind(statement));
    }

    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      defaultExportViolations.push(statement.getText(module.sourceFile));
    }

    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
      const allowedModules = isTypeOnlyImport(statement)
        ? policy.allowedTypeImportModules
        : policy.allowedValueImportModules;
      if (!moduleSpecifier || !allowedModules.has(moduleSpecifier)) {
        importViolations.push(statement.getText(module.sourceFile));
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const moduleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
      if (statement.moduleSpecifier) {
        moduleReexports.push(
          moduleSpecifier ?? statement.moduleSpecifier.getText(module.sourceFile)
        );
        continue;
      }
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        exportShapeViolations.push(statement.getText(module.sourceFile));
        continue;
      }
      if (statement.exportClause.elements.length === 0) {
        exportShapeViolations.push(statement.getText(module.sourceFile));
      }

      for (const element of statement.exportClause.elements) {
        if (element.propertyName) {
          exportShapeViolations.push(element.getText(module.sourceFile));
        }
        if (statement.isTypeOnly || element.isTypeOnly) {
          localTypeExports.push(element.name.text);
          typeExports.push(element.name.text);
        } else {
          localValueExports.push(element.name.text);
          valueExports.push(element.name.text);
        }
      }
      continue;
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }

    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      typeExports.push(statement.name.text);
    } else if (ts.isFunctionDeclaration(statement)) {
      valueExports.push(statement.name?.text ?? 'default');
    } else if (ts.isVariableStatement(statement)) {
      valueExports.push(...exportedVariableNames(statement, module.sourceFile));
    } else if (
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      valueExports.push(statement.name?.getText(module.sourceFile) ?? 'default');
    } else if (ts.isImportEqualsDeclaration(statement)) {
      valueExports.push(statement.name.text);
    }
  }

  for (const statement of module.sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      defaultExportViolations.push(statement.getText(module.sourceFile));
      valueExports.push('default');
    }
  }

  return {
    defaultExportViolations,
    exportShapeViolations,
    importViolations,
    localTypeExports: sorted(localTypeExports),
    localValueExports: sorted(localValueExports),
    moduleReexports: sorted(moduleReexports),
    parseDiagnostics: parseDiagnostics(module),
    topLevelViolations,
    typeExports: sorted(typeExports),
    valueExports: sorted(valueExports),
  };
}

describe('Team Provisioning API capability boundary', () => {
  it('keeps the compatibility facade at exactly 25 type and 16 value re-exports', () => {
    const inspection = inspectFacade(facade);
    const expectedTypes = facadeExportEntries(expectedTypeExportsByModule);
    const expectedValues = facadeExportEntries(expectedValueExportsByModule);

    expect(expectedTypes).toHaveLength(25);
    expect(expectedValues).toHaveLength(16);
    expect(inspection).toEqual({
      exportShapeViolations: [],
      modules: sorted([
        './TeamMessagingApiBinder',
        './TeamProvisioningApiBinders',
        './TeamProvisioningCapabilityApiBinder',
        './TeamProvisioningCapabilityApis',
        './TeamProvisioningMessagingApis',
        './TeamRuntimeApiBinder',
        './TeamProvisioningRuntimeApis',
      ]),
      parseDiagnostics: [],
      topLevelViolations: [],
      typeExports: expectedTypes,
      valueExports: expectedValues,
    });
    expect(inspection.typeExports).toHaveLength(25);
    expect(inspection.valueExports).toHaveLength(16);
  });

  it('prevents the compatibility-only HTTP handler aggregate from growing', () => {
    expect(inspectInterfaceShape(aggregateBinders, 'TeamHttpHandlerApis')).toEqual({
      heritageCount: 0,
      nonPropertyMembers: [],
      propertyNames: [
        'provisioningStart',
        'provisioningStatus',
        'runtime',
        'runtimeIngress',
        'taskActivity',
      ],
    });
    expect(inspectInterfaceShape(aggregateBinders, 'TeamIpcHandlerApis')).toBeNull();
  });

  it('forbids the removed IPC aggregate throughout production source', () => {
    const forbiddenAggregate = /\b(?:TeamIpcHandlerApis|bindTeamIpcHandlerApis)\b/;
    const violations = productionTypeScriptPaths('src').filter((path) =>
      forbiddenAggregate.test(readFileSync(path, 'utf8'))
    );

    expect(violations).toEqual([]);
  });

  it('keeps every export in its one allowlisted implementation module', () => {
    const allTypeExports: string[] = [];
    const allValueExports: string[] = [];

    for (const [home, module, policy] of implementationModules) {
      const inspection = inspectImplementationModule(module, policy);

      expect(inspection, home).toEqual({
        defaultExportViolations: [],
        exportShapeViolations: [],
        importViolations: [],
        localTypeExports: sorted(policy.allowedLocalTypeExports),
        localValueExports: [],
        moduleReexports: sorted(policy.expectedModuleReexports),
        parseDiagnostics: [],
        topLevelViolations: [],
        typeExports: sorted(policy.expectedTypeExports),
        valueExports: sorted(policy.expectedValueExports),
      });
      allTypeExports.push(...inspection.typeExports);
      allValueExports.push(...inspection.valueExports);
    }

    expect(allTypeExports).toHaveLength(33);
    expect(new Set(allTypeExports).size).toBe(33);
    expect(allValueExports).toHaveLength(24);
    expect(new Set(allValueExports).size).toBe(24);
  });

  it('detects named implementation re-exports and exported value declarations', () => {
    const typeOnlyPolicy: ImplementationModulePolicy = {
      allowFunctionDeclarations: false,
      allowedTypeImportModules: new Set(),
      allowedValueImportModules: new Set(),
      allowedLocalTypeExports: [],
      expectedModuleReexports: [],
      expectedTypeExports: [],
      expectedValueExports: [],
    };
    const namedReexport = inspectImplementationModule(
      parseModule('named-reexport.ts', "export type { HiddenRuntimeApi } from './hidden-runtime';"),
      typeOnlyPolicy
    );
    const exportedValues = inspectImplementationModule(
      parseModule(
        'exported-values.ts',
        [
          'export const runtimeValue = 1;',
          'export class RuntimeClass {}',
          'export function startRuntime() {}',
        ].join('\n')
      ),
      typeOnlyPolicy
    );

    expect(namedReexport.moduleReexports).toEqual(['./hidden-runtime']);
    expect(exportedValues.topLevelViolations).toEqual([
      'VariableStatement',
      'ClassDeclaration',
      'FunctionDeclaration',
    ]);
    expect(exportedValues.valueExports).toEqual(['RuntimeClass', 'runtimeValue', 'startRuntime']);
  });
});
