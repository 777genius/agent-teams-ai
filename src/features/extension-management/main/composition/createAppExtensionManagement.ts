import { createDesktopExtensionManagement } from './createDesktopExtensionManagement';

import type { ExtensionClient } from '../../contracts';
import type {
  TeamMemberLifecycleApi,
  TeamProvisioningStartApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamCreateRequest } from '@shared/types/team';

interface AppDependencies {
  resourceRoot: string;
  isLocal(): boolean;
  aliveTeams(): string[];
  savedRequest(teamName: string): Promise<TeamCreateRequest | null>;
}
export function createAppExtensionManagement(deps: AppDependencies) {
  const runtime = createDesktopExtensionManagement({
    resourceRoot: deps.resourceRoot,
    isLocal: deps.isLocal,
    savedRequest: deps.savedRequest,
    async activeClientIds() {
      const clients = new Set<ExtensionClient>();
      for (const name of deps.aliveTeams()) {
        const request = await deps.savedRequest(name);
        const providers = request
          ? [request.providerId, ...(request.members ?? []).map((member) => member.providerId)]
          : [undefined];
        for (const provider of providers) {
          if (provider === 'anthropic') clients.add('claude');
          else if (provider === 'codex' || provider === 'opencode') clients.add(provider);
          else {
            clients.add('claude');
            clients.add('codex');
            clients.add('opencode');
          }
        }
      }
      return clients;
    },
  });
  function guardRuntimeApis(apis: {
    provisioningStart: TeamProvisioningStartApi;
    memberLifecycle?: TeamMemberLifecycleApi;
  }): void {
    const start = apis.provisioningStart;
    apis.provisioningStart = {
      createTeam: (request, progress) =>
        runtime.admitLaunch(request, () => start.createTeam(request, progress)),
      launchTeam: (request, progress) =>
        runtime.admitLaunch(request, () => start.launchTeam(request, progress)),
    };
    const members = apis.memberLifecycle;
    if (!members) return;
    apis.memberLifecycle = {
      ...members,
      attachLiveRosterMember: (teamName, memberName, options) =>
        runtime.admitLaunch({ teamName }, () =>
          members.attachLiveRosterMember(teamName, memberName, options)
        ),
      restartMember: (teamName, memberName, secondary) =>
        runtime.admitLaunch({ teamName }, () =>
          members.restartMember(teamName, memberName, secondary)
        ),
      retryFailedOpenCodeSecondaryLanes: (...args) =>
        runtime.admitLaunch({ teamName: args[0] }, () =>
          members.retryFailedOpenCodeSecondaryLanes(...args)
        ),
      runLiveRosterMutation: (teamName, mutation) =>
        runtime.admitLaunch({ teamName }, () => members.runLiveRosterMutation(teamName, mutation), [
          'anthropic',
          'codex',
          'opencode',
        ]),
      ...(members.tryRunLiveRosterMutation
        ? {
            tryRunLiveRosterMutation: (teamName: string, mutation: () => Promise<void>) =>
              runtime.admitLaunch(
                { teamName },
                () => members.tryRunLiveRosterMutation!(teamName, mutation),
                ['anthropic', 'codex', 'opencode']
              ),
          }
        : {}),
    };
  }
  return { ...runtime, guardRuntimeApis };
}
