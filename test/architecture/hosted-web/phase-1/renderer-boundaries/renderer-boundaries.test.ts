import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkRendererBoundaries,
  RENDERER_BOUNDARY_DIAGNOSTIC,
  type RendererBoundarySource,
} from '../../../../../scripts/hosted-web/phase-1/check-renderer-boundaries';
import { hostedElectronApiFixtureSource } from '../fixtures/hosted-electron-api';

const HOSTED_SOURCE_ROOTS = [
  'src/features/team-lifecycle',
  'src/shared/contracts/hosted',
  'src/main/composition/hosted',
] as const;

function collectHostedSources(): RendererBoundarySource[] {
  return HOSTED_SOURCE_ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name))
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return { path, source: readFileSync(path, 'utf8') };
      })
  );
}

describe('P1.1C renderer boundary scanner', () => {
  it('keeps every real hosted source free of Electron widening and transport bypasses', () => {
    const sources = collectHostedSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(checkRendererBoundaries(sources)).toEqual([]);
  });

  it('accepts a narrow value-only hosted team-read facet', () => {
    expect(
      checkRendererBoundaries([
        {
          path: 'src/features/team-lifecycle/renderer/team-read-facet.ts',
          source: [
            'export interface TeamReadFacet {',
            '  listSummaries(input: unknown): Promise<unknown>;',
            '}',
          ].join('\n'),
        },
      ])
    ).toEqual([]);
  });

  it('rejects a hosted facet structurally widened to ElectronAPI', () => {
    expect(
      checkRendererBoundaries([
        {
          path: 'src/features/team-lifecycle/renderer/hosted-facet.ts',
          source: hostedElectronApiFixtureSource,
        },
      ])
    ).toEqual([
      {
        path: 'src/features/team-lifecycle/renderer/hosted-facet.ts',
        diagnostic: RENDERER_BOUNDARY_DIAGNOSTIC,
      },
    ]);
  });

  it('rejects direct Electron and generic transport bypasses', () => {
    expect(
      checkRendererBoundaries([
        {
          path: 'src/features/team-lifecycle/renderer/bypass.ts',
          source: 'export const list = () => window.electronAPI.teams.list();',
        },
      ])[0]?.diagnostic
    ).toBe(RENDERER_BOUNDARY_DIAGNOSTIC);
  });
});
