import { describe, expect, it } from 'vitest';

import {
  compareModelReleaseFreshness,
  getModelReleaseTimestamp,
  isRecentlyReleasedModel,
  NEW_MODEL_BADGE_WINDOW_MS,
} from '../modelReleaseFreshness';

import type { CliProviderModelCatalogItem } from '@shared/types';

const NOW_MS = Date.parse('2026-09-05T12:00:00.000Z');

function buildModel(options: {
  id: string;
  releaseDate?: string | null;
  recentlyReleased?: boolean;
}): CliProviderModelCatalogItem {
  return {
    id: options.id,
    launchModel: options.id,
    displayName: options.id,
    hidden: false,
    supportedReasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: false,
    upgrade: false,
    source: 'app-server',
    metadata: {
      releaseDate: options.releaseDate ?? null,
      recentlyReleased: options.recentlyReleased === true,
    },
  };
}

describe('model release freshness', () => {
  it('uses an inclusive fourteen-day window', () => {
    const boundary = new Date(NOW_MS - NEW_MODEL_BADGE_WINDOW_MS).toISOString();
    const expired = new Date(NOW_MS - NEW_MODEL_BADGE_WINDOW_MS - 1).toISOString();

    expect(
      isRecentlyReleasedModel(buildModel({ id: 'boundary', releaseDate: boundary }), NOW_MS)
    ).toBe(true);
    expect(
      isRecentlyReleasedModel(buildModel({ id: 'expired', releaseDate: expired }), NOW_MS)
    ).toBe(false);
  });

  it('rejects invalid and future release dates', () => {
    expect(
      getModelReleaseTimestamp(buildModel({ id: 'invalid', releaseDate: 'not-a-date' }), NOW_MS)
    ).toBeNull();
    expect(
      getModelReleaseTimestamp(
        buildModel({ id: 'future', releaseDate: '2026-09-06T12:00:00.000Z' }),
        NOW_MS
      )
    ).toBeNull();
  });

  it('honors the runtime new-model hint when no release date is available', () => {
    expect(
      isRecentlyReleasedModel(buildModel({ id: 'astra', recentlyReleased: true }), NOW_MS)
    ).toBe(true);
  });

  it('sorts recent runtime hints first, then known release dates newest-first', () => {
    const hinted = buildModel({ id: 'hinted', recentlyReleased: true });
    const newer = buildModel({ id: 'newer', releaseDate: '2026-08-01T00:00:00.000Z' });
    const older = buildModel({ id: 'older', releaseDate: '2026-07-01T00:00:00.000Z' });

    expect(compareModelReleaseFreshness(hinted, newer, NOW_MS)).toBeLessThan(0);
    expect(compareModelReleaseFreshness(newer, older, NOW_MS)).toBeLessThan(0);
  });
});
