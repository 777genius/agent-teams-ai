import { classifyHostedTeamConfigurationAuthorization } from './composition/hosted/hostedTeamConfigurationComposition';
import { classifyHostedTeamMessageAuthorization } from './composition/hosted/hostedTeamMessageComposition';
import { classifyHostedWorkspaceRegistryAuthorization } from './composition/hosted/hostedWorkspaceRegistryComposition';

export const classifyStandaloneHostedAuthorization = (method: string, url: string) => {
  const path = url.split('?', 1)[0];
  if (method.toUpperCase() === 'GET' && path === '/api/dashboard/recent-projects') {
    return { kind: 'forbidden' as const };
  }
  if (
    method.toUpperCase() === 'POST' &&
    (path === '/api/hosted/v1/dashboard/recent-projects' ||
      path === '/api/teams/lifecycle/read/scoped' ||
      path === '/api/hosted/v1/workspace-access/project')
  ) {
    return {
      kind: 'authenticated' as const,
      permission: 'hosted.query' as const,
      csrfRequired: true,
      workspaceRequired: false,
    };
  }
  return classifyHostedTeamMessageAuthorization(method, url, (messageMethod, messageUrl) =>
    classifyHostedWorkspaceRegistryAuthorization(
      messageMethod,
      messageUrl,
      classifyHostedTeamConfigurationAuthorization
    )
  );
};
