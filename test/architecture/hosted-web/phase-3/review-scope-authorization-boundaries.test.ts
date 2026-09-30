import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readSource(relativePath: string): string {
  // Paths are fixed repository-owned test fixtures.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('review scope authorization architecture boundary', () => {
  it('keeps review scope and transport-shape policy free of runtime dependencies', () => {
    const source = readSource('src/features/change-review/core/domain/reviewScopePolicy.ts');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

    expect(
      imports.some(
        (specifier) =>
          specifier === 'electron' ||
          specifier.startsWith('node:') ||
          specifier.startsWith('@main/')
      )
    ).toBe(false);
    expect(source).not.toMatch(/\b(fs|ipcMain|process|ReviewDecisionStore)\b/);
  });

  it('isolates Node filesystem and path security behind feature-owned ports', () => {
    const application = readSource(
      'src/features/change-review/main/application/ReviewScopeAuthorizationApplication.ts'
    );
    const ports = readSource(
      'src/features/change-review/main/application/ReviewScopeAuthorizationPorts.ts'
    );
    const infrastructure = readSource(
      'src/features/change-review/main/infrastructure/nodeReviewScopeAuthorization.ts'
    );

    expect(application).not.toMatch(/from\s+['"](?:node:|fs|path|@main\/)/);
    expect(ports).toContain('export interface ReviewScopePathPort');
    expect(ports).toContain('export interface ReviewScopeFileSystemPort');
    expect(ports).toContain('export interface ReviewScopeChangesPort');
    expect(infrastructure).toContain('isOwnedReviewFileTransactionHardlink');
    expect(infrastructure).toContain('matchesSensitivePattern');
  });

  it('leaves the IPC shell as composition without legacy path-security implementations', () => {
    const shell = readSource('src/main/ipc/review.ts');

    expect(shell).toContain('createReviewScopeAuthorizationFeature({');
    expect(shell).toContain('reviewScopeAuthorizationFeature.validateAuthorizedReviewFilePath(');
    expect(shell).toContain('reviewScopeAuthorizationFeature.resolveReviewPathAuthorization(');
    expect(shell).not.toContain('function resolveAuthorizedReviewRoot');
    expect(shell).not.toContain('function resolveNearestExistingRealPath');
    expect(shell).not.toContain('function collectAuthoritativeReviewedFiles');
  });
});
