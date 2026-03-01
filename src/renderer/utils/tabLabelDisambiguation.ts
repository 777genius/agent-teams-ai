/**
 * Tab label disambiguation — adds suffix labels when multiple tabs share the same file name.
 *
 * Algorithm:
 * 1. Group tabs by fileName
 * 2. For groups with >1 tab, find the minimal unique path suffix
 * 3. Format as "(parent/dir)" — e.g. "(main/utils)", "(renderer/hooks)"
 * 4. Unique file names get no label (disambiguatedLabel = undefined)
 */

import type { EditorFileTab } from '@shared/types/editor';

/**
 * Compute disambiguated labels for all tabs.
 * Returns a new array with `disambiguatedLabel` set where needed.
 */
export function computeDisambiguatedTabs(tabs: EditorFileTab[]): EditorFileTab[] {
  if (tabs.length === 0) return tabs;

  // Single tab — just clear any stale label
  if (tabs.length === 1) {
    const tab = tabs[0];
    if (tab.disambiguatedLabel === undefined) return tabs;
    return [{ ...tab, disambiguatedLabel: undefined }];
  }

  // Group tabs by fileName
  const groups = new Map<string, EditorFileTab[]>();
  for (const tab of tabs) {
    const existing = groups.get(tab.fileName);
    if (existing) {
      existing.push(tab);
    } else {
      groups.set(tab.fileName, [tab]);
    }
  }

  // Build a map of tabId → disambiguatedLabel
  const labels = new Map<string, string | undefined>();

  for (const [, group] of groups) {
    if (group.length <= 1) {
      // Unique name — no label needed
      for (const tab of group) {
        labels.set(tab.id, undefined);
      }
      continue;
    }

    // Split paths into segments for comparison
    const pathSegments = group.map((tab) => {
      const parts = tab.filePath.split('/');
      // Remove the file name (last segment)
      parts.pop();
      return parts;
    });

    // Find minimal unique suffix depth
    // Start from depth=1 (immediate parent) and go deeper until all labels are unique
    let depth = 1;
    const maxDepth = Math.max(...pathSegments.map((s) => s.length));

    while (depth <= maxDepth) {
      const suffixes = pathSegments.map((parts) => {
        const start = Math.max(0, parts.length - depth);
        return parts.slice(start).join('/');
      });

      // Check if all suffixes are unique
      const unique = new Set(suffixes);
      if (unique.size === suffixes.length) {
        // All unique — assign labels
        for (let i = 0; i < group.length; i++) {
          labels.set(group[i].id, `(${suffixes[i]})`);
        }
        break;
      }
      depth++;
    }

    // If we couldn't find unique suffixes (shouldn't happen with different file paths),
    // use full parent path
    if (depth > maxDepth) {
      for (let i = 0; i < group.length; i++) {
        const fullParent = pathSegments[i].join('/');
        labels.set(group[i].id, `(${fullParent})`);
      }
    }
  }

  // Apply labels to tabs
  return tabs.map((tab) => {
    const label = labels.get(tab.id);
    if (label === tab.disambiguatedLabel) return tab;
    return { ...tab, disambiguatedLabel: label };
  });
}
