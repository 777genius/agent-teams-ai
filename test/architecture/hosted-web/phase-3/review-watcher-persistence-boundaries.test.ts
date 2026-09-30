import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readSource(relativePath: string): string {
  // Paths are fixed repository-owned test fixtures.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('review watcher and persistence architecture boundaries', () => {
  it('keeps watcher policy and orchestration runtime-free behind focused ports', () => {
    const policy = readSource('src/features/change-review/core/domain/reviewFileWatchPolicy.ts');
    const application = readSource(
      'src/features/change-review/main/application/ReviewFileWatchApplication.ts'
    );
    const ports = readSource('src/features/change-review/main/application/ReviewFileWatchPorts.ts');

    expect(policy).not.toMatch(/from\s+['"](?:electron|node:|fs|@main\/)/);
    expect(application).not.toMatch(/from\s+['"](?:electron|node:|fs|@main\/)/);
    expect(application).not.toContain('ipcMain');
    expect(ports).toContain('export interface ReviewFileWatcherPort');
    expect(ports).toContain('export interface ReviewFileWatchEventPort');
    expect(ports).toContain('export type ReviewProjectPathValidator');
  });

  it('isolates watcher runtime details in main adapters, infrastructure, and composition', () => {
    const presenter = readSource(
      'src/features/change-review/main/adapters/output/presenters/ReviewFileWatchEventPresenter.ts'
    );
    const validator = readSource(
      'src/features/change-review/main/infrastructure/validateReviewWatchProjectPath.ts'
    );
    const composition = readSource(
      'src/features/change-review/main/composition/createReviewFileWatchFeature.ts'
    );

    expect(presenter).toContain('safeSendToRenderer(');
    expect(presenter).toContain('REVIEW_FILE_CHANGE');
    expect(validator).toContain("import * as fs from 'fs/promises'");
    expect(validator).toContain('path.resolve(path.normalize(projectPath))');
    expect(composition).toContain('new EditorFileWatcher({ ignoreStartupChanges: false })');
  });

  it('keeps decision persistence policy and application runtime-free', () => {
    const policy = readSource(
      'src/features/change-review/core/domain/reviewDecisionPersistencePolicy.ts'
    );
    const application = readSource(
      'src/features/change-review/main/application/ReviewDecisionPersistenceApplication.ts'
    );
    const ports = readSource(
      'src/features/change-review/main/application/ReviewDecisionPersistencePorts.ts'
    );

    expect(policy).not.toMatch(/from\s+['"](?:electron|node:|fs|@main\/)/);
    expect(application).not.toMatch(/from\s+['"](?:electron|node:|fs|@main\/)/);
    expect(application).not.toContain('ipcMain');
    expect(ports).toContain('export interface ReviewDecisionPersistenceScopePort');
    expect(ports).toContain('export interface ReviewDecisionPersistenceLockPort');
  });

  it('leaves IPC registration and wrapper boundaries exact while delegating lifecycle', () => {
    const shell = readSource('src/main/ipc/review.ts');

    expect(shell).toContain('ipcMain.handle(REVIEW_WATCH_FILES, handleWatchReviewFiles)');
    expect(shell).toContain('ipcMain.removeHandler(REVIEW_WATCH_FILES)');
    expect(shell).toContain("wrapReviewHandler('watchFiles', operation)");
    expect(shell).toContain("wrapReviewHandler('unwatchFiles', operation)");
    expect(shell).toContain('reviewFileWatchFeature.prepareWatch(projectPath, filePaths)');
    expect(shell).toContain('reviewDecisionPersistenceFeature.withLock(');
    expect(shell).not.toContain('let reviewWatcherRequestGeneration');
    expect(shell).not.toContain('function assertReviewDecisionShape');
    expect(shell).not.toContain('function withReviewDecisionPersistenceLock');
  });
});
