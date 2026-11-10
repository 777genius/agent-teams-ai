import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { TeamListSkeleton } from './TeamListSkeleton';

describe('TeamListSkeleton', () => {
  it('reserves header actions, search, filter, and six cards during both loading phases', () => {
    const markup = renderToStaticMarkup(<TeamListSkeleton label="Loading teams" />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading teams');
    expect(markup).toContain('data-testid="team-list-skeleton-header-actions"');
    expect(markup).toContain('data-testid="team-list-skeleton-search"');
    expect(markup).toContain('data-testid="team-list-skeleton-filter"');
    expect(markup.match(/data-testid="team-list-skeleton-card"/g)).toHaveLength(6);
  });
});
