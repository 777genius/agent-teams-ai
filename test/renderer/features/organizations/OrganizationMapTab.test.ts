import { DEFAULT_ORGANIZATION_MAP_LAYOUT_MODE } from '@features/organizations/renderer/adapters/organizationMapLayout';
import { describe, expect, it } from 'vitest';

describe('OrganizationMapTab', () => {
  it('opens in hierarchical layout by default', () => {
    expect(DEFAULT_ORGANIZATION_MAP_LAYOUT_MODE).toBe('hierarchical');
  });
});
