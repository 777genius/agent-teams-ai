import type { GitHubLoginConfiguration } from '../../core/application/deviceAuthorization';

/** Public registration metadata only. Never use another app's client ID/secret. */
export function githubLoginConfiguration(): GitHubLoginConfiguration | null {
  const clientId = process.env.AGENT_TEAMS_GITHUB_CLIENT_ID?.trim();
  const kind = process.env.AGENT_TEAMS_GITHUB_APP_KIND;
  if (
    !clientId ||
    !/^[a-z\d_.-]{10,100}$/i.test(clientId) ||
    (kind !== 'github-app' && kind !== 'oauth-app')
  )
    return null;
  return kind === 'github-app'
    ? {
        clientId,
        scope: '',
        permissionNotice:
          'GitHub will show the app permissions and repositories you authorize. Pull Requests uses only read requests.',
      }
    : {
        clientId,
        scope: 'repo',
        permissionNotice:
          'For private repositories, GitHub OAuth requires the repo scope, which also permits writes. Pull Requests uses only read requests. Review this access on GitHub before approving.',
      };
}
