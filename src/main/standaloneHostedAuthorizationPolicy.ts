import { classifyHostedTeamConfigurationAuthorization } from './composition/hosted/hostedTeamConfigurationComposition';
import { classifyHostedTeamMessageAuthorization } from './composition/hosted/hostedTeamMessageComposition';
import { classifyHostedWorkspaceRegistryAuthorization } from './composition/hosted/hostedWorkspaceRegistryComposition';

export const classifyStandaloneHostedAuthorization = (method: string, url: string) =>
  classifyHostedTeamMessageAuthorization(method, url, (messageMethod, messageUrl) =>
    classifyHostedWorkspaceRegistryAuthorization(
      messageMethod,
      messageUrl,
      classifyHostedTeamConfigurationAuthorization
    )
  );
