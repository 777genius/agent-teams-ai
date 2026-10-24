import { AttachmentArtifactStore } from '../../attachments/AttachmentArtifactStore.js';
import { join } from 'node:path';

import { TeamOwner } from '../../team/TeamOwner.js';
import { TeamOwnerError } from '../../team/contracts.js';
import { createTeamPolicy } from './ControllerAdapter.js';
import { TeamOwnerStore } from './TeamOwnerStore.js';
import { TaskEffectPlan } from './TaskEffectPlan.js';
import { admitTeamNamespace } from './admitTeamNamespace.js';
import { FileTeamRuntimeBindings } from './FileTeamRuntimeBindings.js';

import type { TeamOwnerOptions } from '../../team/TeamOwner.js';

export type FilesystemTeamOwnerOptions = Omit<
  TeamOwnerOptions,
  'store' | 'policy' | 'taskMutations'
> & {
  root: string;
  store?: TeamOwnerStore;
  taskMutations?: TeamOwnerOptions['taskMutations'];
};

/** Trusted composition owns namespace selection; no ambient HOME or Electron globals. */
export function createFilesystemTeamOwner(options: FilesystemTeamOwnerOptions): TeamOwner {
  if (
    options.store &&
    (options.store.root !== options.root ||
      options.store.directory !==
        join(options.root, 'teams', options.binding.teamName, '.host-owner'))
  )
    throw new TeamOwnerError('invalid');
  admitTeamNamespace(options.root, options.binding);
  const store = options.store ?? new TeamOwnerStore(options.root, options.binding.teamName);
  return new TeamOwner({
    binding: options.binding,
    members: options.members,
    ...(options.savedSettings === undefined ? {} : { savedSettings: options.savedSettings }),
    grants: options.grants,
    store,
    runtimeBindings: new FileTeamRuntimeBindings(store),
    ...(options.assertRosterEditable ? { assertRosterEditable: options.assertRosterEditable } : {}),
    ...(options.crossTeamSourceAuthority
      ? { crossTeamSourceAuthority: options.crossTeamSourceAuthority }
      : {}),
    policy: { ...createTeamPolicy(options.root, options.binding.teamName), attachments: new AttachmentArtifactStore(options.root, options.binding, store) },
    taskMutations:
      options.taskMutations ?? new TaskEffectPlan(options.root, options.binding.teamName, store),
  });
}
