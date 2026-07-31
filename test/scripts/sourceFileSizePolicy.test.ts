import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

interface SourceFileRecord {
  path: string;
  lineCount: number;
}

interface SourceFileSizePolicy {
  maxLines: number;
  legacy: Record<string, number>;
}

interface SourceFileSizePolicyModule {
  countPhysicalLines(contents: string): number;
  evaluateSourceFileSizes(
    records: SourceFileRecord[],
    policy: SourceFileSizePolicy
  ): {
    checkedFiles: number;
    legacyFiles: number;
    maxLines: number;
    ratchetCandidates: Array<{ path: string; lineCount: number; legacyCap: number }>;
    violations: Array<{ code: string; path?: string; message: string }>;
  };
  isProductionSourcePath(filePath: string): boolean;
}

let policyModule: SourceFileSizePolicyModule;

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'scripts/ci/check-source-file-size.mjs')
  ).href;
  policyModule = (await import(moduleUrl)) as SourceFileSizePolicyModule;
});

describe('source file size policy', () => {
  const policy: SourceFileSizePolicy = {
    maxLines: 800,
    legacy: { 'src/main/legacy.ts': 1200 },
  };

  it('counts physical lines without adding a phantom line for a trailing newline', () => {
    expect(policyModule.countPhysicalLines('')).toBe(0);
    expect(policyModule.countPhysicalLines('one')).toBe(1);
    expect(policyModule.countPhysicalLines('one\n')).toBe(1);
    expect(policyModule.countPhysicalLines('one\ntwo')).toBe(2);
  });

  it('includes production source and excludes tests, fixtures, generated sources, and smoke scripts', () => {
    expect(policyModule.isProductionSourcePath('src/main/service.ts')).toBe(true);
    expect(policyModule.isProductionSourcePath('landing/components/Hero.vue')).toBe(true);
    expect(policyModule.isProductionSourcePath('src/types/handwritten.d.ts')).toBe(true);
    expect(policyModule.isProductionSourcePath('src/main/service.test.ts')).toBe(false);
    expect(policyModule.isProductionSourcePath('src/main/service.spec.d.ts')).toBe(false);
    expect(policyModule.isProductionSourcePath('src/main/service.safe-e2e.ts')).toBe(false);
    expect(policyModule.isProductionSourcePath('src/main/service.integration.test.ts')).toBe(false);
    expect(policyModule.isProductionSourcePath('src/main/__tests__/service.ts')).toBe(false);
    expect(policyModule.isProductionSourcePath('src/main/fixtures/service.ts')).toBe(false);
    expect(
      policyModule.isProductionSourcePath('src/features/localization/renderer/resources.d.ts')
    ).toBe(false);
    expect(policyModule.isProductionSourcePath('scripts/prove-runtime.mjs')).toBe(false);
  });

  it('rejects a new production file above 800 lines', () => {
    const result = policyModule.evaluateSourceFileSizes(
      [
        { path: 'src/main/new-service.ts', lineCount: 801 },
        { path: 'src/main/legacy.ts', lineCount: 1200 },
      ],
      policy
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'new-oversized-file', path: 'src/main/new-service.ts' })
    );
  });

  it('allows a frozen legacy file to stay at or below its cap but rejects growth', () => {
    const unchanged = policyModule.evaluateSourceFileSizes(
      [{ path: 'src/main/legacy.ts', lineCount: 1200 }],
      policy
    );
    expect(unchanged.violations).toEqual([]);

    const smaller = policyModule.evaluateSourceFileSizes(
      [{ path: 'src/main/legacy.ts', lineCount: 1100 }],
      policy
    );
    expect(smaller.violations).toEqual([]);
    expect(smaller.ratchetCandidates).toEqual([
      { path: 'src/main/legacy.ts', lineCount: 1100, legacyCap: 1200 },
    ]);

    const larger = policyModule.evaluateSourceFileSizes(
      [{ path: 'src/main/legacy.ts', lineCount: 1201 }],
      policy
    );
    expect(larger.violations).toContainEqual(
      expect.objectContaining({ code: 'legacy-file-grew', path: 'src/main/legacy.ts' })
    );
  });

  it('requires an exception to be removed once a legacy file reaches the normal limit', () => {
    const result = policyModule.evaluateSourceFileSizes(
      [{ path: 'src/main/legacy.ts', lineCount: 800 }],
      policy
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'retired-legacy-file', path: 'src/main/legacy.ts' })
    );
  });

  it('rejects stale exceptions whose files no longer exist', () => {
    const result = policyModule.evaluateSourceFileSizes([], policy);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'missing-legacy-file', path: 'src/main/legacy.ts' })
    );
  });
});
