import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readSource(relativePath: string): string {
  // Paths are fixed repository-owned test fixtures.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('review decision command architecture boundary', () => {
  it('keeps durable Reject and CAS policy free of runtime dependencies', () => {
    const source = readSource(
      'src/features/review-mutations/core/domain/reviewDecisionCommandPolicy.ts'
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

  it('owns orchestration behind focused ports and isolates Node snapshot identity', () => {
    const application = readSource(
      'src/features/review-mutations/main/application/ReviewDecisionCommandApplication.ts'
    );
    const ports = readSource(
      'src/features/review-mutations/main/application/ReviewDecisionCommandPorts.ts'
    );
    const infrastructure = readSource(
      'src/features/review-mutations/main/infrastructure/nodeReviewDecisionCommandSnapshotIdentity.ts'
    );

    expect(application).not.toMatch(/from\s+['"](?:electron|node:|fs|@main\/)/);
    expect(application).not.toContain('ipcMain');
    expect(application).not.toContain("from './ReviewDecisionBatchApplication'");
    expect(ports).toContain('export interface ReviewDecisionCommandScopePort');
    expect(ports).toContain('export interface ReviewDecisionCommandPersistencePort');
    expect(ports).toContain('export interface ReviewDecisionCommandCoordinatorPort');
    expect(infrastructure).toContain("from 'node:crypto'");
  });

  it('leaves review IPC as exact registration, transport validation, and delegation', () => {
    const shell = readSource('src/main/ipc/review.ts');

    expect(shell).toContain('createReviewDecisionCommandFeature({');
    expect(shell).toContain('reviewDecisionCommandFeature.applyDecisions(request)');
    expect(shell).toContain('ipcMain.handle(REVIEW_APPLY_DECISIONS, handleApplyDecisions)');
    expect(shell).toContain('ipcMain.removeHandler(REVIEW_APPLY_DECISIONS)');
    expect(shell).not.toContain('function applyDecisionsWithDurableJournal');
    expect(shell).not.toContain('function assertExactApplyReviewHistoryTransition');
    expect(shell).not.toContain('const displayedReviewSnapshots = new Map');
  });
});
