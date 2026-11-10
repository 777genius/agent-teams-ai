/**
 * Shared navigation utilities for scroll/highlight orchestration.
 *
 * These helpers are used by useTabNavigationController and can be
 * reused by other navigation-related hooks.
 */

import type { ChatItem } from '@renderer/types/groups';

// =============================================================================
// Target Resolution
// =============================================================================

/**
 * Find the AI group that contains or is closest to the given error timestamp.
 */
export function findAIGroupByTimestamp(items: ChatItem[], errorTimestamp: number): string | null {
  if (items.length === 0) return null;

  let bestGroupId: string | null = null;
  let bestTimeDiff = Infinity;

  for (const item of items) {
    if (item.type !== 'ai') continue;

    const group = item.group;
    const startMs = group.startTime.getTime();
    const endMs = group.endTime.getTime();

    // Check if error timestamp is within this group's time range
    if (errorTimestamp >= startMs && errorTimestamp <= endMs) {
      return group.id; // Exact match
    }

    // Track closest group for fallback
    const startDiff = Math.abs(errorTimestamp - startMs);
    const endDiff = Math.abs(errorTimestamp - endMs);
    const minDiff = Math.min(startDiff, endDiff);

    if (minDiff < bestTimeDiff) {
      bestTimeDiff = minDiff;
      bestGroupId = group.id;
    }
  }

  return bestGroupId;
}

/**
 * Find the chat item (any type) that contains or is closest to the given timestamp.
 * Returns the item's group ID and type.
 */
export function findChatItemByTimestamp(
  items: ChatItem[],
  targetTimestamp: number
): { groupId: string; type: 'user' | 'system' | 'ai' | 'compact' } | null {
  if (items.length === 0) return null;

  let bestMatch: { groupId: string; type: 'user' | 'system' | 'ai' | 'compact' } | null = null;
  let bestTimeDiff = Infinity;

  for (const item of items) {
    let itemTimestamp: number;

    if (item.type === 'user') {
      itemTimestamp = item.group.timestamp.getTime();
    } else if (item.type === 'system') {
      itemTimestamp = item.group.timestamp.getTime();
    } else if (item.type === 'ai') {
      const startMs = item.group.startTime.getTime();
      const endMs = item.group.endTime.getTime();
      if (targetTimestamp >= startMs && targetTimestamp <= endMs) {
        return { groupId: item.group.id, type: 'ai' };
      }
      itemTimestamp = startMs;
    } else if (item.type === 'compact') {
      itemTimestamp = item.group.timestamp.getTime();
    } else {
      continue;
    }

    const timeDiff = Math.abs(targetTimestamp - itemTimestamp);
    if (timeDiff < bestTimeDiff) {
      bestTimeDiff = timeDiff;
      bestMatch = { groupId: item.group.id, type: item.type };
    }
  }

  return bestMatch;
}

// =============================================================================
// Subagent Group Resolution
// =============================================================================

/**
 * Find the AI group that contains a subagent with the given ID.
 * Looks through each AI group's processes array for a matching process ID.
 */
export function findAIGroupBySubagentId(items: ChatItem[], subagentId: string): string | null {
  for (const item of items) {
    if (item.type !== 'ai') continue;
    if (item.group.processes.some((p) => p.id === subagentId)) {
      return item.group.id;
    }
  }
  return null;
}

// =============================================================================
// DOM Readiness Helpers
// =============================================================================

/**
 * Wait for element size to stabilize using ResizeObserver.
 * More reliable than timer-based approaches because it detects actual DOM changes.
 */
export function waitForElementStability(
  element: HTMLElement,
  timeoutMs = 250,
  stableFrames = 2
): Promise<void> {
  return new Promise((resolve) => {
    let lastSize = { width: 0, height: 0 };
    let stableCount = 0;
    let resolved = false;

    const observer = new ResizeObserver((entries) => {
      if (resolved) return;
      const entry = entries[0];
      if (!entry) return;

      const currentSize = {
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      };

      if (currentSize.width === lastSize.width && currentSize.height === lastSize.height) {
        stableCount++;
        if (stableCount >= stableFrames) {
          resolved = true;
          observer.disconnect();
          resolve();
        }
      } else {
        stableCount = 0;
        lastSize = currentSize;
      }
    });

    observer.observe(element);

    // Initial size reading to bootstrap comparison
    const rect = element.getBoundingClientRect();
    lastSize = { width: Math.round(rect.width), height: Math.round(rect.height) };

    // Timeout fallback to prevent infinite waiting
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        resolve();
      }
    }, timeoutMs);
  });
}

/**
 * Wait for scroll animation to complete.
 * Detects completion by monitoring when scrollTop stops changing.
 */
export function waitForScrollEnd(container: HTMLElement, timeoutMs = 400): Promise<void> {
  return new Promise((resolve) => {
    let lastScrollTop = container.scrollTop;
    let stableCount = 0;
    let rafId: number | undefined;
    let resolved = false;

    const checkScroll = (): void => {
      if (resolved) return;

      const currentScrollTop = container.scrollTop;

      if (Math.abs(currentScrollTop - lastScrollTop) < 1) {
        stableCount++;
        if (stableCount >= 3) {
          resolved = true;
          if (rafId !== undefined) cancelAnimationFrame(rafId);
          resolve();
          return;
        }
      } else {
        stableCount = 0;
        lastScrollTop = currentScrollTop;
      }

      rafId = requestAnimationFrame(checkScroll);
    };

    rafId = requestAnimationFrame(checkScroll);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (rafId !== undefined) cancelAnimationFrame(rafId);
        resolve();
      }
    }, timeoutMs);
  });
}

// =============================================================================
// Visibility and Scroll Calculation
// =============================================================================

/**
 * Calculate the scrollTop value to center an element in the visible area
 * of a scroll container, accounting for sticky offset.
 */
export function calculateCenteredScrollTop(
  element: HTMLElement,
  container: HTMLElement,
  stickyOffset: number
): number {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  const visibleHeight = containerRect.height - stickyOffset;
  const elementCenterRelativeToContainer =
    elementRect.top - containerRect.top + container.scrollTop + elementRect.height / 2;
  const targetScrollTop = elementCenterRelativeToContainer - visibleHeight / 2 - stickyOffset;

  return Math.max(0, targetScrollTop);
}

/**
 * Find the current search result element within a container.
 * When item identity is provided, resolves the exact current match for that item/index.
 */
export function findCurrentSearchResultInContainer(
  container: HTMLElement | null | undefined,
  itemId?: string,
  matchIndexInItem?: number
): Element | null {
  if (!container) return null;

  const currentResults = container.querySelectorAll('[data-search-result="current"]');
  if (itemId !== undefined && matchIndexInItem !== undefined) {
    for (const candidate of currentResults) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }
      if (
        candidate.dataset.searchItemId === itemId &&
        candidate.dataset.searchMatchIndex === String(matchIndexInItem)
      ) {
        return candidate;
      }
    }
  }

  return currentResults[0] ?? null;
}
