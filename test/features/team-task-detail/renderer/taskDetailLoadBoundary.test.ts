// @vitest-environment node
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { eagerChain, sourceGraph, sourceRoot as root } from '../../../helpers/sourceModuleGraph';

const rendererEntry = 'src/renderer/main.tsx';
const feature = 'src/features/team-task-detail/renderer/';
const deferredModules = [
  `${feature}index.ts`,
  `${feature}adapters/TaskDetailTab.tsx`,
  `${feature}adapters/TaskDetailPage.tsx`,
  `${feature}ui/TaskDetailContent.tsx`,
  `${feature}ui/TaskDetailBody.tsx`,
  'src/renderer/components/ui/tiptap/TiptapEditor.tsx',
];
const shellModules = [
  `${feature}adapters/TaskDetailReadCoordinator.tsx`,
  `${feature}adapters/TaskDetailEditorRouteFeedback.tsx`,
  `${feature}adapters/TaskDetailReviewRouteFeedback.tsx`,
  `${feature}hooks/useTaskDetailTabLabel.ts`,
  `${feature}context/TaskDetailFileLinkContext.tsx`,
];

// This is a conservative source import/re-export boundary, not a Vite request
// trace or memory measurement. Normally declared type-only uses may overcount.
describe('TaskDetail renderer load boundary', () => {
  const eager = sourceGraph(rendererEntry);

  it('keeps full TaskDetail UI and its editor outside the eager application graph', () => {
    const reached = deferredModules.filter((file) => eager.parents.has(path.resolve(root, file)));
    const chains = reached.map((file) => eagerChain(eager.parents, path.resolve(root, file)));
    expect(reached, chains.join('\n')).toEqual([]);
  });

  it('keeps the original coordinator, recovery feedback, label and shared context eager', () => {
    expect(shellModules.filter((file) => !eager.parents.has(path.resolve(root, file)))).toEqual([]);
  });

  it.each([
    {
      route: 'task tab',
      from: 'src/renderer/components/layout/PaneContent.tsx',
      to: `${feature}index.ts`,
    },
    {
      route: 'global task dialog',
      from: 'src/renderer/components/layout/GlobalTaskDetailDialogSlot.tsx',
      to: 'src/renderer/components/team/dialogs/GlobalTaskDetailDialog.tsx',
    },
  ])('retains the existing $route on-demand route to the complete detail UI', ({ from, to }) => {
    expect(eager.deferred).toContainEqual({
      from: path.resolve(root, from),
      to: path.resolve(root, to),
    });
    const opened = sourceGraph(to);
    expect(deferredModules.filter((file) => !opened.parents.has(path.resolve(root, file)))).toEqual(
      []
    );
  });
});
