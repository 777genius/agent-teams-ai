import {
  resolveTerminalTabReorderIntent,
  wouldTerminalTabOrderChange,
} from '@features/terminal-workspace/renderer/utils/terminalTabPointerReorder';
import { describe, expect, it } from 'vitest';

const ORDER = ['tab-1', 'tab-2', 'tab-3'];
const GEOMETRIES = [
  { left: 0, tabId: 'tab-1', width: 80 },
  { left: 100, tabId: 'tab-2', width: 80 },
  { left: 200, tabId: 'tab-3', width: 80 },
];

describe('terminal tab pointer reorder geometry', () => {
  it('resolves before and after placement from visual tab centers', () => {
    expect(
      resolveTerminalTabReorderIntent({
        clientX: 220,
        orderedTabIds: ORDER,
        sourceTabId: 'tab-1',
        tabGeometries: GEOMETRIES,
      })
    ).toEqual({
      placementMode: 'before',
      sourceTabId: 'tab-1',
      targetTabId: 'tab-3',
    });
    expect(
      resolveTerminalTabReorderIntent({
        clientX: 260,
        orderedTabIds: ORDER,
        sourceTabId: 'tab-1',
        tabGeometries: GEOMETRIES,
      })
    ).toEqual({
      placementMode: 'after',
      sourceTabId: 'tab-1',
      targetTabId: 'tab-3',
    });
  });

  it('uses measured visual order instead of trusting object insertion order', () => {
    expect(
      resolveTerminalTabReorderIntent({
        clientX: 120,
        orderedTabIds: ORDER,
        sourceTabId: 'tab-3',
        tabGeometries: [GEOMETRIES[2]!, GEOMETRIES[1]!, GEOMETRIES[0]!],
      })
    ).toEqual({
      placementMode: 'before',
      sourceTabId: 'tab-3',
      targetTabId: 'tab-2',
    });
  });

  it('returns no intent for an adjacent no-op placement', () => {
    expect(
      resolveTerminalTabReorderIntent({
        clientX: 110,
        orderedTabIds: ORDER,
        sourceTabId: 'tab-1',
        tabGeometries: GEOMETRIES,
      })
    ).toBeNull();
    expect(
      resolveTerminalTabReorderIntent({
        clientX: 60,
        orderedTabIds: ORDER,
        sourceTabId: 'tab-2',
        tabGeometries: GEOMETRIES,
      })
    ).toBeNull();
  });

  it('rejects stale sources, unusable coordinates, and missing candidates', () => {
    expect(
      resolveTerminalTabReorderIntent({
        clientX: 100,
        orderedTabIds: ORDER,
        sourceTabId: 'removed-tab',
        tabGeometries: GEOMETRIES,
      })
    ).toBeNull();
    expect(
      resolveTerminalTabReorderIntent({
        clientX: Number.NaN,
        orderedTabIds: ORDER,
        sourceTabId: 'tab-1',
        tabGeometries: GEOMETRIES,
      })
    ).toBeNull();
    expect(
      resolveTerminalTabReorderIntent({
        clientX: 100,
        orderedTabIds: ['tab-1'],
        sourceTabId: 'tab-1',
        tabGeometries: [GEOMETRIES[0]!],
      })
    ).toBeNull();
  });

  it('detects order changes without mutating the caller-owned order', () => {
    const order = [...ORDER];
    expect(
      wouldTerminalTabOrderChange(order, {
        placementMode: 'after',
        sourceTabId: 'tab-1',
        targetTabId: 'tab-3',
      })
    ).toBe(true);
    expect(
      wouldTerminalTabOrderChange(order, {
        placementMode: 'before',
        sourceTabId: 'tab-1',
        targetTabId: 'tab-2',
      })
    ).toBe(false);
    expect(order).toEqual(ORDER);
  });
});
