import { api, isElectronMode } from '@renderer/api';

import { useGitHubLogin } from './hooks/useGitHubLogin';
import { useProjectPullRequests } from './hooks/useProjectPullRequests';
import { PullRequestsPage } from './ui/PullRequestsPage';

export function PrMonitorTab({
  projectId,
  isActive,
}: {
  projectId: string;
  isActive: boolean;
}): React.JSX.Element {
  const state = useProjectPullRequests(projectId, isActive);
  const login = useGitHubLogin(projectId, isActive, state.connectionChanged);
  const open = (value: string): void => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'github.com' ||
        url.username ||
        url.password
      )
        return;
      if (isElectronMode()) void api.openExternal(url.href);
      else window.open(url.href, '_blank', 'noopener,noreferrer');
    } catch {
      /* Ignore invalid provider links. */
    }
  };
  return (
    <PullRequestsPage
      {...state}
      login={login.login}
      loginError={login.error}
      loginBusy={login.busy}
      onSignIn={() => {
        void login.begin();
      }}
      onSignOut={() => {
        void login.signOut();
      }}
      onCancelLogin={login.cancel}
      hasMore={state.nextPage !== null}
      native={isElectronMode()}
      onSelect={(item) => {
        void state.select(item);
      }}
      onConnect={() => {
        void state.connect();
      }}
      onDisconnect={() => {
        void state.disconnect();
      }}
      onRefresh={state.refresh}
      onLoadMore={() => {
        void state.loadMore();
      }}
      onOpenUrl={open}
    />
  );
}
