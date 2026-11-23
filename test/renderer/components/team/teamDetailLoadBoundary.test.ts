// @vitest-environment node
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { eagerChain, sourceGraph, sourceRoot } from '../../../helpers/sourceModuleGraph';

const team = 'src/renderer/components/team/';
const memberSettings = 'src/features/team-provisioning/renderer/';
const deferred = [
  `${team}dialogs/AddMemberDialog.tsx`,
  `${team}dialogs/EditTeamDialog.tsx`,
  `${team}dialogs/ReviewDialog.tsx`,
  `${team}kanban/TrashDialog.tsx`,
  `${memberSettings}ui/EditTeamMemberDialog.tsx`,
  `${memberSettings}ui/TeamMemberSettingsDialogBridge.tsx`,
  `${team}members/MembersEditorSection.tsx`,
];

describe('Team detail cold load boundary', () => {
  it.each([`${team}TeamDetailView.tsx`, `${memberSettings}index.ts`])(
    'keeps closed dialogs and the member editor outside the eager graph of %s',
    (entry) => {
      const graph = sourceGraph(entry);
      const reached = deferred.filter((file) => graph.parents.has(path.resolve(sourceRoot, file)));
      const chains = reached.map((file) =>
        eagerChain(graph.parents, path.resolve(sourceRoot, file))
      );
      expect(reached, chains.join('\n')).toEqual([]);
    }
  );
});
