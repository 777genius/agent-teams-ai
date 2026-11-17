import { randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildRealRuntimeMember } from '../../packages/legacy-agent-host/tests/fixtures/real-vendor/host-profile.ts';

import type { RealTarget } from '../../packages/legacy-agent-host/tests/fixtures/real-vendor/discovery.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

/**
 * `prepareDesktopBackendFixture({ profileTransform })` hook: give the offline one-member Team
 * (`alice`) a REAL vendor runtime. It runs before the fixture seeds its Task into the Team store and
 * pins the profile/descriptor digests, so the Team store, the profile and the pins all agree. The
 * runtime member comes from the same builder as the Host-level proof (one implementation).
 */
export const realVendorProfileTransform =
  (target: RealTarget) =>
  async ({ profile, root, node }: { profile: TeamHostProfile; root: string; node: string }) => {
    const team = profile.teams[0];
    const member = team?.members.find((candidate) => candidate.name === 'alice');
    if (!team || !member || profile.runtime)
      throw new Error('real vendor fixture expects the offline one-member Team');
    profile.runtime = {
      members: [
        (await buildRealRuntimeMember(
          target,
          { name: 'alice', memberId: member.memberId, role: member.role },
          { namespace: randomUUID(), teamId: team.scope.teamId },
          root,
          await realpath(node)
        )) as never,
      ],
    };
    // A runtime member must be a delivery target of the Team (the offline fixture member is saved-only).
    member.delivery = {
      ...team.binding,
      runId: team.scope.runId,
      memberId: member.memberId,
      generation: '1',
    };
    team.grants.push({
      principalId: 'alice-session',
      memberName: 'alice',
      permissions: ['read', 'task.write', 'message.write'],
    });
  };

/**
 * `on`/`off`: seed both providers' settings as an explicit true/false. `default`: remove the keys, so the app must apply
 * its own shipped default (proves the default end to end). Not a pinned file.
 */
export async function applyNativeNextPromptPreference(
  root: string,
  mode: 'on' | 'default' | 'off'
): Promise<void> {
  const configPath = join(root, 'claude/agent-teams-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    providerConnections?: Record<string, Record<string, unknown>>;
  };
  const connections = (config.providerConnections ??= {});
  for (const provider of ['anthropic', 'codex']) {
    const settings = (connections[provider] ??= {});
    if (mode === 'default') delete settings.nativeNextPromptSuggestionsEnabled;
    else settings.nativeNextPromptSuggestionsEnabled = mode === 'on';
  }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
}
