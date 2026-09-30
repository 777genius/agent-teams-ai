import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVICE_PATH = 'src/main/services/team/CrossTeamService.ts';
const BROAD_CONTRACT = './contracts/TeamProvisioningApis';
const NARROW_CONTRACT = './contracts/TeamProvisioningMessagingApis';
const MESSAGING_API = 'TeamCrossTeamMessagingApi';

type BoundaryDiagnostic =
  | 'broad-contract-import'
  | 'messaging-contract-import-missing'
  | 'runtime-proof-kind-branch'
  | 'runtime-proof-last-delivery-access';

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are test-owned constants.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function importedNames(node: ts.ImportDeclaration): readonly string[] {
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) {
    return [];
  }
  return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
}

function scanService(contents: string): readonly BoundaryDiagnostic[] {
  const diagnostics = new Set<BoundaryDiagnostic>();
  const parsed = ts.createSourceFile(
    SERVICE_PATH,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let narrowMessagingImportFound = false;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier === BROAD_CONTRACT) {
        diagnostics.add('broad-contract-import');
      }
      if (specifier === NARROW_CONTRACT && importedNames(node).includes(MESSAGING_API)) {
        narrowMessagingImportFound = true;
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'kind') {
        diagnostics.add('runtime-proof-kind-branch');
      }
      if (node.name.text === 'lastDelivery') {
        diagnostics.add('runtime-proof-last-delivery-access');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  if (!narrowMessagingImportFound) {
    diagnostics.add('messaging-contract-import-missing');
  }
  return [...diagnostics].sort((left, right) => left.localeCompare(right));
}

describe('cross-team runtime delivery ownership boundary', () => {
  it('keeps runtime proof branching behind the focused coordinator and imports the narrow API', () => {
    expect(scanService(source(SERVICE_PATH))).toEqual([]);
  });

  it('rejects the broad API and relay-result proof ownership in CrossTeamService', () => {
    const fixture = `
      import type {
        TeamCrossTeamMessagingApi as Messaging
      } from './contracts/TeamProvisioningApis';
      export class CrossTeamService {
        settle(relay: { kind: string; lastDelivery?: unknown }): void {
          if (relay.kind === 'native_lead' && relay.lastDelivery) return;
        }
      }
    `;

    expect(scanService(fixture)).toEqual([
      'broad-contract-import',
      'messaging-contract-import-missing',
      'runtime-proof-kind-branch',
      'runtime-proof-last-delivery-access',
    ]);
  });

  it('ignores comments and strings that describe the retired proof branches', () => {
    const fixture = `
      import type {
        TeamCrossTeamMessagingApi
      } from './contracts/TeamProvisioningMessagingApis';
      // relay.kind and relay.lastDelivery now belong to the coordinator.
      export const note = 'relay.kind / lastDelivery';
    `;

    expect(scanService(fixture)).toEqual([]);
  });
});
