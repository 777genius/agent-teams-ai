import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = process.cwd();
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, 'src');
const FEATURES_ROOT = resolve(SOURCE_ROOT, 'features');

const TARGET_FEATURES = ['team-provisioning', 'team-view-read-model'] as const;
const PUBLIC_FEATURE_ENTRYPOINTS = new Set(['contracts', 'main', 'preload', 'renderer']);
const PROVIDER_SPECIFIC_VOCABULARY = /OpenCode|opencode|Claude/;

const REQUIRED_NARROW_EXPORTS = {
  'src/features/team-provisioning/main/index.ts': ['createTeamProvisioningFeature'],
  'src/features/team-view-read-model/main/index.ts': [
    'createTeamViewReadModelFeature',
    'TeamProvisioningRunReadPort',
  ],
} as const;

const LEGACY_DEEP_IMPORT_BASELINE = new Set([
  [
    'src/main/ipc/teams.ts',
    '../../features/team-view-read-model/main/adapters/output/TeamPermanentDeletionTransactionCoordinator',
  ].join('\0'),
]);

const PORT_SOURCE =
  'src/features/team-view-read-model/core/application/ports/TeamViewReadModelPorts.ts';
const PORT_NAME = 'TeamProvisioningRunReadPort';
const PORT_CONSUMERS = {
  'src/features/team-view-read-model/main/adapters/output/FileSystemMissingTeamStateReader.ts':
    '../../../core/application/ports/TeamViewReadModelPorts',
  'src/features/team-view-read-model/main/composition/createTeamViewReadModelFeature.ts':
    '../../core/application/ports/TeamViewReadModelPorts',
} as const;

interface ModuleReference {
  specifier: string;
  line: number;
}

interface DeepImportViolation extends ModuleReference {
  importer: string;
  feature: (typeof TARGET_FEATURES)[number];
}

function toRepositoryPath(path: string): string {
  return path.split('\\').join('/');
}

function source(path: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8');
}

function parseSource(path: string, contents = source(path)): ts.SourceFile {
  const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, scriptKind);
}

function isProductionTypeScript(path: string): boolean {
  const normalized = toRepositoryPath(path);
  return (
    /\.tsx?$/.test(normalized) &&
    !/\.(?:spec|test)\.tsx?$/.test(normalized) &&
    !/(?:^|\/)__tests__(?:\/|$)/.test(normalized)
  );
}

function productionSourceFiles(directory = SOURCE_ROOT): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSourceFiles(absolutePath));
    } else if (entry.isFile()) {
      const repositoryPath = toRepositoryPath(relative(REPOSITORY_ROOT, absolutePath));
      if (isProductionTypeScript(repositoryPath)) {
        files.push(repositoryPath);
      }
    }
  }

  return files.sort();
}

function collectModuleReferences(path: string, contents = source(path)): ModuleReference[] {
  const sourceFile = parseSource(path, contents);
  const references: ModuleReference[] = [];

  const record = (literal: ts.StringLiteralLike): void => {
    references.push({
      specifier: literal.text,
      line: sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        record(argument.literal);
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      record(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

function normalizeFeatureSubpath(parts: string[]): string[] {
  const normalized = [...parts];
  const lastIndex = normalized.length - 1;

  if (lastIndex >= 0) {
    normalized[lastIndex] = normalized[lastIndex].replace(/\.(?:[cm]?js|jsx|tsx?)$/, '');
  }
  if (normalized.at(-1) === 'index') {
    normalized.pop();
  }

  return normalized;
}

function targetFeatureImport(
  importer: string,
  specifier: string
): { feature: (typeof TARGET_FEATURES)[number]; subpath: string[] } | null {
  let featurePath: string;

  if (specifier.startsWith('@features/')) {
    featurePath = specifier.slice('@features/'.length);
  } else if (specifier.startsWith('.')) {
    const importedPath = resolve(dirname(resolve(REPOSITORY_ROOT, importer)), specifier);
    featurePath = toRepositoryPath(relative(FEATURES_ROOT, importedPath));
    if (featurePath === '..' || featurePath.startsWith('../')) {
      return null;
    }
  } else {
    return null;
  }

  const [feature, ...subpath] = featurePath.split('/');
  if (!TARGET_FEATURES.includes(feature as (typeof TARGET_FEATURES)[number])) {
    return null;
  }

  return {
    feature: feature as (typeof TARGET_FEATURES)[number],
    subpath: normalizeFeatureSubpath(subpath),
  };
}

function isInternalFeatureImport(
  importer: string,
  feature: (typeof TARGET_FEATURES)[number]
): boolean {
  return importer.startsWith(`src/features/${feature}/`);
}

function isPublicFeatureEntrypoint(subpath: string[]): boolean {
  return (
    subpath.length === 0 || (subpath.length === 1 && PUBLIC_FEATURE_ENTRYPOINTS.has(subpath[0]))
  );
}

function findDeepImportViolations(
  importer: string,
  contents = source(importer)
): DeepImportViolation[] {
  const violations: DeepImportViolation[] = [];

  for (const reference of collectModuleReferences(importer, contents)) {
    const target = targetFeatureImport(importer, reference.specifier);
    if (
      !target ||
      isInternalFeatureImport(importer, target.feature) ||
      isPublicFeatureEntrypoint(target.subpath)
    ) {
      continue;
    }

    violations.push({ importer, feature: target.feature, ...reference });
  }

  return violations;
}

function deepImportIdentity(violation: DeepImportViolation): string {
  return [violation.importer, violation.specifier].join('\0');
}

function namedExports(path: string): Set<string> {
  const exportedNames = new Set<string>();

  for (const statement of parseSource(path).statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exportedNames.add(element.name.text);
        }
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      continue;
    }

    if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      exportedNames.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exportedNames.add(declaration.name.text);
        }
      }
    }
  }

  return exportedNames;
}

function typeOnlyNamedImports(
  path: string,
  importedName: string
): Array<{ moduleSpecifier: string; typeOnly: boolean }> {
  const imports: Array<{ moduleSpecifier: string; typeOnly: boolean }> = [];

  for (const statement of parseSource(path).statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !statement.importClause.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }

    for (const element of statement.importClause.namedBindings.elements) {
      const localName = element.name.text;
      const sourceName = element.propertyName?.text ?? localName;
      if (sourceName === importedName) {
        imports.push({
          moduleSpecifier: statement.moduleSpecifier.text,
          typeOnly: statement.importClause.isTypeOnly || element.isTypeOnly,
        });
      }
    }
  }

  return imports;
}

function countTypeReferences(path: string, typeName: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === typeName
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(path));
  return count;
}

function countInlineProvisioningRunShapes(path: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeLiteralNode(node) &&
      node.members.some(
        (member) =>
          (ts.isMethodSignature(member) || ts.isPropertySignature(member)) &&
          ts.isIdentifier(member.name) &&
          member.name.text === 'hasProvisioningRun'
      )
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(path));
  return count;
}

describe('team feature public entrypoint freeze', () => {
  it('keeps the required narrow exports as a presence-only public subset', () => {
    for (const [entrypoint, requiredExports] of Object.entries(REQUIRED_NARROW_EXPORTS)) {
      const exports = namedExports(entrypoint);
      for (const requiredExport of requiredExports) {
        expect(exports.has(requiredExport), `${entrypoint} must export ${requiredExport}`).toBe(
          true
        );
      }
    }
  });

  it('publishes one provider-neutral provisioning-run read port', () => {
    const contents = source(PORT_SOURCE);
    const sourceFile = parseSource(PORT_SOURCE, contents);
    const port = sourceFile.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === PORT_NAME
    );

    expect(contents).not.toMatch(PROVIDER_SPECIFIC_VOCABULARY);
    expect(
      sourceFile.statements.some(
        (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === PORT_NAME
      )
    ).toBe(false);
    if (!port) {
      throw new Error(`${PORT_SOURCE} must declare ${PORT_NAME} as an interface`);
    }

    expect(port.members).toHaveLength(1);
    const method = port.members.find(
      (member): member is ts.MethodSignature =>
        ts.isMethodSignature(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'hasProvisioningRun'
    );
    if (!method) {
      throw new Error(`${PORT_NAME} must declare hasProvisioningRun`);
    }

    expect(method.parameters).toHaveLength(1);
    expect(method.parameters[0].type?.kind).toBe(ts.SyntaxKind.StringKeyword);
    expect(method.type?.kind).toBe(ts.SyntaxKind.BooleanKeyword);
  });

  it('uses the shared port in both real consumers without duplicate structural types', () => {
    for (const [consumer, expectedModuleSpecifier] of Object.entries(PORT_CONSUMERS)) {
      expect(typeOnlyNamedImports(consumer, PORT_NAME)).toContainEqual({
        moduleSpecifier: expectedModuleSpecifier,
        typeOnly: true,
      });
      expect(countTypeReferences(consumer, PORT_NAME)).toBeGreaterThan(0);
      expect(countInlineProvisioningRunShapes(consumer)).toBe(0);
      expect(source(consumer)).not.toMatch(PROVIDER_SPECIFIC_VOCABULARY);
    }
  });

  it('exports the shared port type-only from the main entrypoint', () => {
    const sourceFile = parseSource('src/features/team-view-read-model/main/index.ts');
    const exportDeclaration = sourceFile.statements.find(
      (statement): statement is ts.ExportDeclaration =>
        ts.isExportDeclaration(statement) &&
        !!statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => element.name.text === PORT_NAME)
    );

    expect(exportDeclaration?.isTypeOnly).toBe(true);
    expect(sourceFile.text).not.toMatch(PROVIDER_SPECIFIC_VOCABULARY);
  });

  it('recognizes every supported module edge without comments or strings becoming imports', () => {
    const importer = 'src/main/ipc/deepImportProbe.ts';
    const contents = `
      import { Hidden as Aliased } from '@features/team-view-read-model/core/domain/Hidden';
      import type { HiddenType } from '@features/team-provisioning/core/application/Hidden';
      export { Hidden as Reexported } from '@features/team-view-read-model/main/composition/Hidden';
      type Imported = import('@features/team-provisioning/core/domain/Hidden').Hidden;
      const dynamicValue = import('@features/team-view-read-model/renderer/internal/Hidden');
      const requiredValue = require('../../features/team-view-read-model/core/domain/Hidden');
      // import '@features/team-view-read-model/core/domain/CommentOnly';
      const text = "require('@features/team-provisioning/core/domain/StringOnly')";
    `;

    expect(collectModuleReferences(importer, contents).map(({ specifier }) => specifier)).toEqual([
      '@features/team-view-read-model/core/domain/Hidden',
      '@features/team-provisioning/core/application/Hidden',
      '@features/team-view-read-model/main/composition/Hidden',
      '@features/team-provisioning/core/domain/Hidden',
      '@features/team-view-read-model/renderer/internal/Hidden',
      '../../features/team-view-read-model/core/domain/Hidden',
    ]);
    expect(findDeepImportViolations(importer, contents)).toHaveLength(6);
  });

  it('exempts imports internal to the same target feature', () => {
    const importer =
      'src/features/team-view-read-model/main/composition/internalDeepImportProbe.ts';
    const contents = `
      import type { Internal } from '../../core/application/Internal';
      import type { AliasedInternal } from '@features/team-view-read-model/core/domain/Internal';
    `;

    expect(findDeepImportViolations(importer, contents)).toEqual([]);
  });

  it('scans all production TypeScript under src and freezes exact legacy deep-import edges', () => {
    const productionFiles = productionSourceFiles();

    expect(productionFiles).toContain('src/main/ipc/teamFeatureCapabilities.ts');
    expect(productionFiles.some((path) => !path.startsWith('src/features/'))).toBe(true);

    const violations = productionFiles.flatMap((path) => findDeepImportViolations(path));
    const violationIdentities = new Set(violations.map(deepImportIdentity));
    expect(
      [...violationIdentities].sort(),
      violations
        .map(
          ({ importer, line, specifier, feature }) =>
            `${importer}:${line} deep-imports ${feature} via ${specifier}`
        )
        .join('\n')
    ).toEqual([...LEGACY_DEEP_IMPORT_BASELINE].sort());
  }, 60_000);
});
