import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readSource(relativePath: string): string {
  // Paths are fixed repository-owned test fixtures.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('review decision batch architecture boundary', () => {
  it('keeps durable batch policy pure and main-shell independent', () => {
    const source = readSource('src/features/review-mutations/core/domain/reviewDecisionBatch.ts');
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

  it('keeps disk/WAL/CAS orchestration behind feature-owned ports', () => {
    const application = readSource(
      'src/features/review-mutations/main/application/ReviewDecisionBatchApplication.ts'
    );
    const ports = readSource(
      'src/features/review-mutations/main/application/ReviewMutationRecoveryPorts.ts'
    );
    const composition = readSource(
      'src/features/review-mutations/main/composition/createReviewDecisionBatchFeature.ts'
    );

    expect(application).not.toMatch(/from\s+['"](?:electron|@main\/)/);
    expect(application).not.toContain('ipcMain');
    expect(ports).toContain('export interface ReviewDecisionBatchApplierPort');
    expect(ports).toContain('export interface ReviewDecisionBatchPersistencePort');
    expect(ports).toContain('export interface ReviewDecisionBatchFilePort');
    expect(composition).toContain('new ReviewDecisionBatchApplication(dependencies)');
  });

  it('leaves review IPC as composition and transport validation only for this seam', () => {
    const shell = readSource('src/main/ipc/review.ts');

    expect(shell).toContain('createReviewDecisionBatchFeature({');
    expect(shell).toContain('reviewDecisionBatchFeature.applyDisk(');
    expect(shell).toContain('reviewDecisionBatchFeature.commit(record)');
    expect(shell).not.toContain('function applyJournalDecisionBatchDisk');
    expect(shell).not.toContain('function readReviewMutationPathPostimages');
    expect(shell).not.toContain('function commitReviewMutationDecisions');
  });
});
