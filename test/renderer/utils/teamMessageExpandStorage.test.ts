import { beforeEach, describe, expect, it } from 'vitest';

import {
  addExpanded,
  getExpandedOverrides,
  removeExpanded,
} from '@renderer/utils/teamMessageExpandStorage';

describe('teamMessageExpandStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores overrides per team', () => {
    addExpanded('alpha', 'msg-1');
    addExpanded('beta', 'msg-2');

    expect([...getExpandedOverrides('alpha')]).toEqual(['msg-1']);
    expect([...getExpandedOverrides('beta')]).toEqual(['msg-2']);
  });

  it('deduplicates repeated expansions', () => {
    addExpanded('alpha', 'msg-1');
    addExpanded('alpha', 'msg-1');

    expect([...getExpandedOverrides('alpha')]).toEqual(['msg-1']);
  });

  it('removes only the requested override', () => {
    addExpanded('alpha', 'msg-1');
    addExpanded('alpha', 'msg-2');

    removeExpanded('alpha', 'msg-1');

    expect([...getExpandedOverrides('alpha')]).toEqual(['msg-2']);
  });

  it('returns an empty set for malformed stored data', () => {
    localStorage.setItem('team-msg-expanded:alpha', '{bad json');

    expect(getExpandedOverrides('alpha')).toEqual(new Set());
  });
});
