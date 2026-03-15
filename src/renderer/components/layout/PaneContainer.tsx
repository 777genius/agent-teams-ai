/**
 * PaneContainer - Horizontal flex container that renders panes side by side.
 * DndContext is owned by TabbedLayout (parent) for cross-component tab DnD.
 */

import { Fragment } from 'react';

import { useStore } from '@renderer/store';

import { PaneResizeHandle } from './PaneResizeHandle';
import { PaneView } from './PaneView';

export const PaneContainer = (): React.JSX.Element => {
  const panes = useStore((s) => s.paneLayout.panes);

  return (
    <div id="pane-container" className="flex flex-1 overflow-hidden">
      {panes.map((pane, i) => (
        <Fragment key={pane.id}>
          {i > 0 && <PaneResizeHandle leftPaneId={panes[i - 1].id} rightPaneId={pane.id} />}
          <PaneView paneId={pane.id} />
        </Fragment>
      ))}
    </div>
  );
};
