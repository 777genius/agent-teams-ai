import { describe, expect, it } from 'vitest';

import {
  normalizeDashboardRecentProjectsPayload,
  type DashboardRecentProject,
} from '@features/recent-projects/contracts';

const project = (id: string): DashboardRecentProject => ({
  id,
  name: id,
  primaryPath: `/tmp/${id}`,
  associatedPaths: [`/tmp/${id}`],
  mostRecentActivity: Date.parse('2026-04-14T12:00:00.000Z'),
  providerIds: ['anthropic'],
  source: 'claude',
  openTarget: {
    type: 'synthetic-path',
    path: `/tmp/${id}`,
  },
});

describe('normalizeDashboardRecentProjectsPayload', () => {
  it('keeps payload objects intact except for degraded normalization', () => {
    expect(
      normalizeDashboardRecentProjectsPayload({
        degraded: true,
        projects: [project('alpha')],
      })
    ).toEqual({
      degraded: true,
      projects: [project('alpha')],
    });
  });

  it('normalizes legacy project arrays into healthy payloads', () => {
    expect(normalizeDashboardRecentProjectsPayload([project('alpha')])).toEqual({
      degraded: false,
      projects: [project('alpha')],
    });
  });

  it('returns null for malformed payloads', () => {
    expect(
      normalizeDashboardRecentProjectsPayload({
        degraded: false,
        projects: null,
      } as unknown as { degraded: boolean; projects: null })
    ).toBeNull();
  });
});
