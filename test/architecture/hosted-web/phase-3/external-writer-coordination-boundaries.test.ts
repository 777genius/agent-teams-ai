import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION,
  ExternalWriterObserver,
  FileObservationState,
} from '@features/external-writer-coordination';
import * as externalWriterMain from '@features/external-writer-coordination/main';
import { describe, expect, expectTypeOf, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CORE_PATHS = [
  'src/features/external-writer-coordination/contracts/externalWriterContracts.ts',
  'src/features/external-writer-coordination/core/domain/fileObservationState.ts',
  'src/features/external-writer-coordination/core/application/ExternalWriterObserver.ts',
  'src/features/external-writer-coordination/core/application/ports.ts',
] as const;
const FORBIDDEN_IMPORTS = [
  'electron',
  'fastify',
  'node:crypto',
  'node:fs',
  'node:path',
  '@main/',
  '@renderer/',
  '@preload/',
] as const;
const MAIN_INFRASTRUCTURE_PATHS = [
  'src/features/external-writer-coordination/main/infrastructure/RegisteredExternalFileCatalog.ts',
  'src/features/external-writer-coordination/main/infrastructure/NodeExternalWriterWatchPort.ts',
  'src/features/external-writer-coordination/main/infrastructure/NodeExternalFileObservationSource.ts',
  'src/features/external-writer-coordination/main/infrastructure/NodeExternalContentChecksum.ts',
] as const;

describe('Phase 3 external-writer coordination boundary', () => {
  it('keeps contracts/core path-free, runtime-free, and behind consumer-owned ports', () => {
    for (const relativePath of CORE_PATHS) {
      // Paths come only from the frozen repository-owned allowlist above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          imports.some((specifier) => specifier === forbidden || specifier.startsWith(forbidden)),
          `${relativePath} imports ${forbidden}`
        ).toBe(false);
      }
      expect(source).not.toMatch(/\b(currentRunRef|readFile|writeFile|watchFile|readdir)\b/);
    }
  });

  it('keeps Node filesystem mechanics scoped to exact-file main infrastructure', () => {
    for (const relativePath of MAIN_INFRASTRUCTURE_PATHS) {
      // Paths come only from the frozen repository-owned allowlist above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source).not.toMatch(
        /\b(readdir|readdirSync|opendir|watchFile|currentRunRef|VerifiedRunActor)\b/
      );
      expect(source).not.toMatch(/recursive\s*:\s*true/);
      expect(source).not.toMatch(
        /@features\/(hosted-app-composition|team-lifecycle|internal-storage)/
      );
    }
  });

  it('exports the real observer/state contract from the public feature entrypoint', () => {
    expect(EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION).toBe(2);
    expect(typeof ExternalWriterObserver).toBe('function');
    expect(typeof FileObservationState.create).toBe('function');
  });

  it('exposes public main contracts without concrete Node adapter implementations', () => {
    expectTypeOf<externalWriterMain.CreateExternalWriterFileAdaptersInput>().toHaveProperty(
      'files'
    );
    expectTypeOf<externalWriterMain.ExternalWriterFileAdapters>().toHaveProperty('catalog');
    expect(typeof externalWriterMain.RegisteredExternalFileCatalogError).toBe('function');
    expect(typeof externalWriterMain.NodeExternalWriterWatchPortError).toBe('function');
    expect(typeof externalWriterMain.NodeExternalFileObservationSourceError).toBe('function');
    for (const concreteExport of [
      'RegisteredExternalFileCatalog',
      'NodeExternalWriterWatchPort',
      'NodeExternalFileObservationSource',
      'NodeExternalContentChecksum',
      'createExternalWriterFileAdapters',
    ]) {
      expect(externalWriterMain).not.toHaveProperty(concreteExport);
    }
  });
});
