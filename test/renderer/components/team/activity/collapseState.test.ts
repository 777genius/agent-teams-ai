import { describe, expect, it, vi } from 'vitest';

import {
  findNewestMessageIndex,
  resolveTimelineCollapseState,
} from '@renderer/components/team/activity/collapseState';

describe('team activity collapse state', () => {
  describe('findNewestMessageIndex', () => {
    it('skips a pinned thought group and returns the first real message', () => {
      expect(
        findNewestMessageIndex([
          { type: 'lead-thoughts' },
          { type: 'message' },
          { type: 'lead-thoughts' },
          { type: 'message' },
        ])
      ).toBe(1);
    });

    it('returns -1 when there are no real messages', () => {
      expect(findNewestMessageIndex([{ type: 'lead-thoughts' }, { type: 'lead-thoughts' }])).toBe(
        -1
      );
    });
  });

  describe('resolveTimelineCollapseState', () => {
    it('falls back to default mode when global collapsed mode is off', () => {
      expect(
        resolveTimelineCollapseState({
          allCollapsed: false,
          itemIndex: 3,
          newestMessageIndex: 1,
          isPinnedThoughtGroup: false,
          isExpandedOverride: false,
        })
      ).toEqual({ mode: 'default' });
    });

    it('keeps the newest message open and non-toggleable in collapsed mode', () => {
      expect(
        resolveTimelineCollapseState({
          allCollapsed: true,
          itemIndex: 1,
          newestMessageIndex: 1,
          isPinnedThoughtGroup: false,
          isExpandedOverride: false,
        })
      ).toEqual({
        mode: 'managed',
        isCollapsed: false,
        canToggle: false,
      });
    });

    it('keeps the pinned thought group open and non-toggleable', () => {
      expect(
        resolveTimelineCollapseState({
          allCollapsed: true,
          itemIndex: 0,
          newestMessageIndex: 2,
          isPinnedThoughtGroup: true,
          isExpandedOverride: false,
        })
      ).toEqual({
        mode: 'managed',
        isCollapsed: false,
        canToggle: false,
      });
    });

    it('collapses an older item when it is no longer the newest message', () => {
      const onToggleOverride = vi.fn();
      const state = resolveTimelineCollapseState({
        allCollapsed: true,
        itemIndex: 2,
        newestMessageIndex: 1,
        isPinnedThoughtGroup: false,
        isExpandedOverride: false,
        onToggleOverride,
      });

      expect(state).toMatchObject({
        mode: 'managed',
        isCollapsed: true,
        canToggle: true,
      });

      if (state.mode !== 'managed') {
        throw new Error('Expected managed collapse state');
      }

      state.onToggle?.();
      expect(onToggleOverride).toHaveBeenCalledTimes(1);
    });

    it('reopens older items that have a persisted expand override', () => {
      expect(
        resolveTimelineCollapseState({
          allCollapsed: true,
          itemIndex: 4,
          newestMessageIndex: 1,
          isPinnedThoughtGroup: false,
          isExpandedOverride: true,
          onToggleOverride: () => undefined,
        })
      ).toEqual({
        mode: 'managed',
        isCollapsed: false,
        canToggle: true,
        onToggle: expect.any(Function),
      });
    });
  });
});
