import { describe, expect, it } from 'vitest';

import {
  checkRendererBoundaries,
  RENDERER_BOUNDARY_DIAGNOSTIC,
} from '../../../../../scripts/hosted-web/phase-1/check-renderer-boundaries';
import { hostedElectronApiFixtureSource } from '../fixtures/hosted-electron-api';

describe('P1.1C renderer boundary scanner', () => {
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
