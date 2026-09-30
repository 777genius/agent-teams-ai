import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readSource(relativePath: string): string {
  // Paths are fixed repository-owned test fixtures.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('review history mutation architecture boundary', () => {
  it('keeps durable transition policy free of runtime and shell dependencies', () => {
    const source = readSource(
      'src/features/review-mutations/core/domain/reviewHistoryMutationPolicy.ts'
    );
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

    expect(
      imports.some(
        (specifier) =>
          specifier === 'electron' ||
          specifier.startsWith('node:') ||
          specifier.startsWith('@main/')
      )
    ).toBe(false);
    expect(source).not.toMatch(/\b(readFile|writeFile|ipcMain|ReviewDecisionStore)\b/);
  });

  it('keeps authoritative binding behind feature-owned scope and file ports', () => {
    const application = readSource(
      'src/features/review-mutations/main/application/ReviewHistoryMutationApplication.ts'
    );
    const ports = readSource(
      'src/features/review-mutations/main/application/ReviewHistoryMutationPorts.ts'
    );
    const composition = readSource(
      'src/features/review-mutations/main/composition/createReviewHistoryMutationFeature.ts'
    );

    expect(application).not.toMatch(/from\s+['"](?:electron|@main\/)/);
    expect(application).not.toContain('ipcMain');
    expect(ports).toContain('export interface ReviewHistoryMutationScopePort');
    expect(ports).toContain('export interface ReviewHistoryMutationFilePort');
    expect(composition).toContain('new ReviewHistoryMutationApplication(dependencies)');
  });

  it('leaves the review shell as composition without legacy history orchestration', () => {
    const shell = readSource('src/main/ipc/review.ts');

    expect(shell).toContain('createReviewHistoryMutationFeature({');
    expect(shell).toContain('reviewHistoryMutationFeature.assertExactTransition(');
    expect(shell).toContain('reviewHistoryMutationFeature.bindAuthoritativeForwardMutation(');
    expect(shell).toContain('reviewHistoryMutationFeature.bindNewHistorySnapshots(');
    expect(shell).not.toContain('function assertExactReviewHistoryTransition');
    expect(shell).not.toContain('function assertAuthoritativeForwardReviewMutation');
    expect(shell).not.toContain('function bindNewReviewHistorySnapshots');
  });
});
