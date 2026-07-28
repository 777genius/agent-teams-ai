import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TEAM_DATA_SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const TEAM_VIEW_MAIN_ENTRYPOINT_PATH = 'src/features/team-view-read-model/main/index.ts';
const TEAM_VIEW_MAIN_ENTRYPOINT = '@features/team-view-read-model/main';
const READER_NAME = 'TeamLeadSessionMessageReader';
const EXTRACTED_METHOD_NAMES = new Set([
  'getLeadSessionJsonlPaths',
  'getRecentLeadSessionIds',
  'readLeadSessionJsonlTailLines',
  'extractLeadAssistantTextsFromJsonlLines',
  'extractLeadSessionTextsFromJsonl',
  'getLeadSessionFileSignature',
  'extractLeadSessionTexts',
]);

type BoundaryDiagnostic =
  | 'legacy-method-declared'
  | 'reader-import-missing'
  | 'reader-import-outside-main-entrypoint'
  | 'reader-main-export-missing';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function moduleName(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) ? node.text : null;
}

function declarationName(node: ts.NamedDeclaration): string | null {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
    return node.name.text;
  }
  return null;
}

function importedNames(node: ts.ImportDeclaration): readonly string[] {
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) {
    return [];
  }
  return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
}

function exportedNames(node: ts.ExportDeclaration): readonly string[] {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
    return [];
  }
  return node.exportClause.elements.map((element) => element.name.text);
}

function scanBoundary(
  serviceSource: string,
  mainEntrypointSource: string
): readonly BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const serviceFile = ts.createSourceFile(
    TEAM_DATA_SERVICE_PATH,
    serviceSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let readerImportCount = 0;

  const visitService = (node: ts.Node): void => {
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isPropertyDeclaration(node)) &&
      EXTRACTED_METHOD_NAMES.has(declarationName(node) ?? '')
    ) {
      diagnostics.add('legacy-method-declared');
    }

    if (ts.isImportDeclaration(node) && importedNames(node).includes(READER_NAME)) {
      readerImportCount += 1;
      if (moduleName(node.moduleSpecifier) !== TEAM_VIEW_MAIN_ENTRYPOINT) {
        diagnostics.add('reader-import-outside-main-entrypoint');
      }
    }
    ts.forEachChild(node, visitService);
  };
  visitService(serviceFile);
  if (readerImportCount === 0) {
    diagnostics.add('reader-import-missing');
  }

  const entrypointFile = ts.createSourceFile(
    TEAM_VIEW_MAIN_ENTRYPOINT_PATH,
    mainEntrypointSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const readerIsExported = entrypointFile.statements
    .filter(ts.isExportDeclaration)
    .some((statement) => exportedNames(statement).includes(READER_NAME));
  if (!readerIsExported) {
    diagnostics.add('reader-main-export-missing');
  }

  return [...diagnostics].sort();
}

describe('team lead-session read-model boundary', () => {
  it('keeps TeamDataService delegated through the process-specific feature entrypoint', () => {
    expect(
      scanBoundary(source(TEAM_DATA_SERVICE_PATH), source(TEAM_VIEW_MAIN_ENTRYPOINT_PATH))
    ).toEqual([]);
  });

  it('rejects legacy method ownership and a deep reader import', () => {
    const serviceFixture = `
      import { TeamLeadSessionMessageReader } from
        '@features/team-view-read-model/main/application/TeamLeadSessionMessageReader';
      export class TeamDataService {
        private extractLeadSessionTexts(): void {}
      }
    `;
    const entrypointFixture = `export { TeamLeadSessionMessageReader } from './application/TeamLeadSessionMessageReader';`;

    expect(scanBoundary(serviceFixture, entrypointFixture)).toEqual([
      'legacy-method-declared',
      'reader-import-outside-main-entrypoint',
    ]);
  });

  it('rejects missing reader imports and exports', () => {
    expect(
      scanBoundary('export class TeamDataService {}', 'export const unrelated = true;')
    ).toEqual(['reader-import-missing', 'reader-main-export-missing']);
  });

  it('ignores comments and string content that mention legacy method names', () => {
    const serviceFixture = `
      import { TeamLeadSessionMessageReader } from '@features/team-view-read-model/main';
      // extractLeadSessionTextsFromJsonl used to live here.
      export class TeamDataService {
        private note = 'getLeadSessionJsonlPaths';
        constructor(private readonly reader: TeamLeadSessionMessageReader) {}
      }
    `;
    const entrypointFixture = `
      // export { TeamLeadSessionMessageReader } from a legacy path
      export { TeamLeadSessionMessageReader } from './application/TeamLeadSessionMessageReader';
    `;

    expect(scanBoundary(serviceFixture, entrypointFixture)).toEqual([]);
  });
});
