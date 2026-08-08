import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkFeatureDependencies,
  type DependencySource,
  FEATURE_DEPENDENCY_DIAGNOSTICS,
} from '../../../../../scripts/hosted-web/phase-1/check-feature-dependencies';

const productPaths = [
  'src/features/team-lifecycle/contracts/team-lifecycle-read.ts',
  'src/features/team-lifecycle/contracts/index.ts',
  'src/features/team-lifecycle/core/application/ListTeamLifecycle.ts',
  'src/features/team-lifecycle/core/application/index.ts',
  'src/features/team-lifecycle/index.ts',
] as const;

const productSources: readonly DependencySource[] = productPaths.map((path) => ({
  path,
  source: readFileSync(join(process.cwd(), path), 'utf8'),
}));

function diagnostics(path: string, source: string): readonly string[] {
  return checkFeatureDependencies([{ path, source }]).map((entry) => entry.diagnostic);
}

describe('P1.1D team-lifecycle read boundaries', () => {
  it('rejects a synthetic legacy aggregate with the exact inherited diagnostic', () => {
    const legacyAggregate = `
      export interface BroadTeamSnapshot {
        teamName: string;
        members: readonly { sessionId: string; providerStatus: string }[];
        tasks: readonly unknown[];
        launchDiagnostics: readonly unknown[];
      }
    `;

    expect(
      diagnostics('src/features/team-lifecycle/contracts/synthetic-legacy.ts', legacyAggregate)
    ).toContain(FEATURE_DEPENDENCY_DIAGNOSTICS.legacyGodDto);
    expect(FEATURE_DEPENDENCY_DIAGNOSTICS.legacyGodDto).toBe('phase1-legacy-god-dto-forbidden');
  });

  it('rejects a synthetic filesystem source with the exact inherited diagnostic', () => {
    const filesystemSource = `
      import { readFile } from 'node:fs';
      export const loadTeams = (projectPath: string) => readFile(projectPath);
    `;

    expect(
      diagnostics(
        'src/features/team-lifecycle/core/application/synthetic-filesystem.ts',
        filesystemSource
      )
    ).toContain(FEATURE_DEPENDENCY_DIAGNOSTICS.filesystemAdapter);
    expect(FEATURE_DEPENDENCY_DIAGNOSTICS.filesystemAdapter).toBe(
      'phase1-filesystem-adapter-forbidden'
    );
  });

  it('accepts the five value-only product files and a test-owned in-memory source neighbor', () => {
    expect(checkFeatureDependencies(productSources)).toEqual([]);

    const inMemorySource = `
      export const source = Object.freeze({
        listTeamLifecycle: (request: Readonly<{ cursor: string | null }>) =>
          Object.freeze({ request, values: Object.freeze([]) }),
      });
    `;
    expect(
      diagnostics('test/features/team-lifecycle/core/in-memory-source.ts', inMemorySource)
    ).toEqual([]);
  });

  it('keeps contracts and application code browser-safe, path-free, and transport-neutral', () => {
    const forbiddenProductSurface =
      /(?:from\s*['"](?:node:)?(?:electron|fastify|react|zustand|fs|path|child_process)|@main|@renderer|@preload|window\.electronAPI|\b(?:IPC|HTTP|Fastify|Electron|filesystemPath|projectPath|rootPath|commandBody|runtimeBody|providerStatus|teamName|members|tasks|messages|sessions)\b)/;

    for (const { path, source } of productSources) {
      expect(source, path).not.toMatch(forbiddenProductSurface);
      expect(source, path).not.toContain('test/fixtures');
      expect(source, path).not.toContain('semantic-harness');
      expect(source, path).not.toContain('RouteCatalog');
    }
  });

  it('uses explicit narrow entrypoints without wildcard implementation exports', () => {
    const contractsIndex = productSources.find(
      ({ path }) => path === 'src/features/team-lifecycle/contracts/index.ts'
    );
    const applicationIndex = productSources.find(
      ({ path }) => path === 'src/features/team-lifecycle/core/application/index.ts'
    );
    const rootIndex = productSources.find(
      ({ path }) => path === 'src/features/team-lifecycle/index.ts'
    );

    expect(contractsIndex?.source).not.toContain('export *');
    expect(applicationIndex?.source).not.toContain('export *');
    expect(rootIndex?.source).not.toContain('export *');
    expect(rootIndex?.source).not.toContain('TeamsAPI');
    expect(rootIndex?.source).not.toContain('ElectronAPI');
    expect(rootIndex?.source).not.toContain('/ListTeamLifecycle');
  });
});
