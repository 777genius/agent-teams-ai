import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const dialogPath =
  'src/features/runtime-provider-management/renderer/RuntimeLocalProviderSetupDialog.tsx';
const portPath =
  'src/features/runtime-provider-management/renderer/ports/RuntimeProviderProvisioningReadinessPort.ts';
const adapterPath =
  'src/renderer/composition/team/createRuntimeProviderProvisioningReadinessTransport.ts';
const selectorPath = 'src/renderer/components/team/dialogs/TeamModelSelector.tsx';
const publicEntryPath = 'src/features/runtime-provider-management/renderer/index.ts';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

describe('runtime provider provisioning renderer port boundary', () => {
  it('keeps the feature-owned readiness port narrow and lifecycle neutral', () => {
    const contents = source(portPath);
    const port = parse(portPath).statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text === 'RuntimeProviderProvisioningReadinessPort'
    );

    expect(port).toBeDefined();
    expect(port?.members).toHaveLength(1);
    expect(port?.members[0]?.getText()).toContain(
      'checkReadiness(cwd: string, modelRoute: string)'
    );
    expect(contents).not.toMatch(
      /OpenCode|opencode|Claude|Anthropic|Codex|providerIds?|lifecycle|spawn|stop|restart|kill/i
    );
  });

  it('confines the existing team preparation call to the renderer API adapter', () => {
    const dialog = source(dialogPath);
    const port = source(portPath);
    const adapter = source(adapterPath);
    const selector = source(selectorPath);

    expect(dialog).toContain('provisioningReadinessPort.checkReadiness(');
    expect(dialog).toContain(
      "from '@renderer/composition/team/createRuntimeProviderProvisioningReadinessTransport'"
    );
    expect(selector).toContain(
      "from '@renderer/composition/team/createRuntimeProviderProvisioningReadinessTransport'"
    );
    expect(selector).toContain(
      'checkReadiness: runtimeProviderProvisioningReadinessTransport.checkReadiness'
    );
    expect(dialog).not.toMatch(/\bapi\.teams\b|prepareProvisioning/);
    expect(selector).not.toMatch(/\bapi\.teams\b|prepareProvisioning/);
    expect(port).not.toMatch(/@renderer\/api|\bapi\.|window\.|ElectronAPI/);
    expect(adapter).toContain("from '@renderer/api'");
    expect(adapter.match(/\bapi\.teams\.prepareProvisioning\b/g) ?? []).toHaveLength(1);
    expect(adapter).not.toMatch(/httpClient|window\.electronAPI|renderer\/store/);
  });

  it('publishes the port without exposing the concrete adapter', () => {
    const publicEntry = source(publicEntryPath);

    expect(publicEntry).toContain(
      "export type { RuntimeProviderProvisioningReadinessPort } from './ports/RuntimeProviderProvisioningReadinessPort'"
    );
    expect(publicEntry).not.toContain('createRuntimeProviderProvisioningReadinessTransport');
  });
});
