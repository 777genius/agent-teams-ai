import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeSourceIndex } from '../../dist/composition/RuntimeSourceIndex.js';
import { teamModelProbeProfile } from '../../dist/composition/teamLaunchModelProbe.js';
import type { TeamHostProfile } from '../../dist/composition/TeamHost.js';
import type { RuntimeSourceGrant } from '../../dist/composition/runtimeSourceContracts.js';

/** Real source journal with disposable equal-byte executables; no native provider is executed. */
export function runtimeSourceSelectionFixture(profile: TeamHostProfile, assertWriter: () => void) {
  const template = profile.runtime!.providerTemplates![0]!;
  const bytes = '#!/bin/sh\nprintf TEST-source-selection\n';
  const executable = (name: string) => {
    const path = join(profile.owner.storageRoot, name);
    writeFileSync(path, bytes, { mode: 0o700 });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  template.executable = executable('TEST-seed-provider');
  template.environment.PATH ??= '/usr/bin';
  const seed = teamModelProbeProfile(template);
  profile.management = [seed];
  const grant: RuntimeSourceGrant = {
    targetId: 'd'.repeat(64),
    ownerId: profile.owner.ownerId,
    ownerRevision: profile.owner.revision,
    contextId: profile.creation?.contextIds[0] ?? 'TEST-desktop-context',
    projectPath: template.cwd,
    runtimeId: template.provider,
    profileId: seed.profileId,
    configRevision: seed.configRevision,
    teamScopes: profile.teams.map(({ scope }) => ({
      teamId: scope.teamId,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
    })),
  };
  const index = new RuntimeSourceIndex(profile, assertWriter);
  return {
    index,
    seed: template.executable,
    async publish(name: string) {
      const selected = executable(name);
      const publication = await index.publish(
        {
          grant,
          commandId: name,
          expectedRevision: index.current({ grant }).revision,
          candidate: { sourceKind: 'app-managed', executable: selected },
        },
        () => {}
      );
      return { executable: selected, selection: publication.selection! };
    },
  };
}
