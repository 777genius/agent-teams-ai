import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkFeatureDependencies,
  FEATURE_DEPENDENCY_DIAGNOSTICS,
} from '../../../../../scripts/hosted-web/phase-1/check-feature-dependencies';
import { coreSideEffectFixtureSource } from '../fixtures/core-side-effect';
import { filesystemAdapterFixtureSource } from '../fixtures/filesystem-adapter';
import { forbiddenCoreImportFixtureSource } from '../fixtures/forbidden-core-import';
import { legacyGodDtoFixtureSource } from '../fixtures/legacy-god-dto';
import { productionAdapterMountFixtureSource } from '../fixtures/production-adapter-mount';

function diagnostics(path: string, source: string): readonly string[] {
  return checkFeatureDependencies([{ path, source }]).map((entry) => entry.diagnostic);
}

const frozenProductionBoundaries = [
  'src/main/http/index.ts',
  'src/main/http/teams.ts',
  'src/main/ipc/teams.ts',
  'src/main/services/infrastructure/HttpServer.ts',
  'src/main/standalone.ts',
  'src/preload/constants/ipcChannels.ts',
  'src/preload/index.ts',
  'src/renderer/api/index.ts',
].map((path) => ({ path, source: readFileSync(join(process.cwd(), path), 'utf8') }));

describe('P1.1C feature dependency scanner', () => {
  it('accepts a pure value-only core specimen', () => {
    expect(
      diagnostics(
        'src/features/team-lifecycle/core/domain/pure-specimen.ts',
        'export const normalize = (value: string) => value.trim();'
      )
    ).toEqual([]);
  });

  it('detects forbidden imports and core side effects with frozen diagnostics', () => {
    expect(
      diagnostics(
        'src/features/team-lifecycle/core/application/forbidden.ts',
        forbiddenCoreImportFixtureSource
      )
    ).toContain(FEATURE_DEPENDENCY_DIAGNOSTICS.forbiddenCoreImport);
    expect(
      diagnostics(
        'src/features/team-lifecycle/core/application/side-effect.ts',
        coreSideEffectFixtureSource
      )
    ).toContain(FEATURE_DEPENDENCY_DIAGNOSTICS.coreSideEffect);
  });

  it('detects the legacy aggregate and path-taking reader halves', () => {
    expect(
      diagnostics(
        'src/features/team-lifecycle/contracts/legacy-aggregate.ts',
        legacyGodDtoFixtureSource
      )
    ).toContain(FEATURE_DEPENDENCY_DIAGNOSTICS.legacyGodDto);
    expect(
      diagnostics(
        'test/features/team-lifecycle/conformance/filesystem-reader.ts',
        filesystemAdapterFixtureSource
      )
    ).toContain(FEATURE_DEPENDENCY_DIAGNOSTICS.filesystemAdapter);
  });

  it('detects production imports of test-only transport composition', () => {
    expect(
      diagnostics(
        'src/main/composition/hosted/team-lifecycle.ts',
        productionAdapterMountFixtureSource
      )
    ).toContain(FEATURE_DEPENDENCY_DIAGNOSTICS.productionAdapterMount);

    expect(
      checkFeatureDependencies(frozenProductionBoundaries).filter(
        (entry) => entry.diagnostic === FEATURE_DEPENDENCY_DIAGNOSTICS.productionAdapterMount
      )
    ).toEqual([]);
  });
});
