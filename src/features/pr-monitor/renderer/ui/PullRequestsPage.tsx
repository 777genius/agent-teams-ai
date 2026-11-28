import { PullRequestList, PullRequestTimeline } from '@pr-monitor/react';
import { Button } from '@renderer/components/ui/button';
import { GitHubLoginPanel } from './GitHubLoginPanel';

import type { DeviceLogin, MonitorError, RepositoryStatus } from '../../contracts';
import type { PullRequestSnapshot, PullRequestSummary } from '@pr-monitor/core';

interface PullRequestsPageProps {
  repository: RepositoryStatus | null;
  items: readonly PullRequestSummary[];
  snapshot: PullRequestSnapshot | null;
  selectedNumber?: number;
  error: MonitorError | null;
  loading: boolean;
  loadingDetail: boolean;
  hasMore: boolean;
  native: boolean;
  login: DeviceLogin | null;
  loginError: MonitorError | null;
  loginBusy: boolean;
  onSignIn(): void;
  onSignOut(): void;
  onCancelLogin(): void;
  onSelect(item: PullRequestSummary): void;
  onConnect(): void;
  onDisconnect(): void;
  onRefresh(): void;
  onLoadMore(): void;
  onOpenUrl(url: string): void;
}

export function PullRequestsPage(props: PullRequestsPageProps): React.JSX.Element {
  return (
    <section
      aria-label="Pull Requests"
      className="flex min-w-0 flex-1 flex-col gap-5 overflow-auto bg-surface p-6 text-text"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Pull Requests</h1>
          <p className="text-sm text-text-secondary">
            {props.repository
              ? `${props.repository.repository.owner}/${props.repository.repository.repo}`
              : 'GitHub activity for this project'}
          </p>
        </div>
        {props.repository?.connected && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={props.onRefresh} disabled={props.loading}>
              Refresh
            </Button>
            {props.native && props.repository.accountKind === 'device' && (
              <Button
                variant="ghost"
                onClick={props.onSignOut}
                disabled={props.loading || props.loginBusy}
              >
                Sign out
              </Button>
            )}
            {props.native && (
              <Button variant="ghost" onClick={props.onDisconnect} disabled={props.loading}>
                Disconnect
              </Button>
            )}
          </div>
        )}
      </header>
      {props.error && (
        <p role="alert" className="rounded border border-border p-3 text-sm">
          {props.error.message}
          {props.error.retryAt && (
            <span> Retry after {new Date(props.error.retryAt).toLocaleTimeString()}.</span>
          )}
        </p>
      )}
      <GitHubLoginPanel
        login={props.login}
        error={props.loginError}
        busy={props.loginBusy}
        onCancel={props.onCancelLogin}
        onOpenUrl={props.onOpenUrl}
      />
      {props.repository && !props.repository.connected && (
        <div className="rounded-lg border border-border p-5">
          <h2 className="mb-2 font-medium">Connect GitHub for this repository</h2>
          <p className="mb-4 max-w-2xl text-sm text-text-secondary">
            Read pull requests, checks and reviews for this project. A signed-in GitHub CLI account
            is preferred; its credentials stay with GitHub CLI. Repository access ends when you
            disconnect or close the app.
          </p>
          {props.native ? (
            <div className="space-y-3">
              <Button
                onClick={props.onConnect}
                disabled={props.loading || props.loginBusy || props.login !== null}
              >
                Connect GitHub
              </Button>
              {props.repository.login?.available && (
                <div>
                  <p className="mb-3 max-w-2xl text-sm text-text-secondary">
                    {props.repository.login.permissionNotice} Sign-in is saved encrypted on this
                    device. Sign out removes the saved connection.
                  </p>
                  <Button
                    variant="outline"
                    onClick={props.onSignIn}
                    disabled={props.loading || props.loginBusy || props.login !== null}
                  >
                    Sign in to GitHub
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={props.onSignOut}
                    disabled={props.loading || props.loginBusy || props.login !== null}
                  >
                    Forget saved sign-in
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm">Connect your account from the desktop app.</p>
          )}
        </div>
      )}
      {props.repository?.connected && (
        <div className="grid min-h-0 gap-5 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.6fr)]">
          <div>
            <PullRequestList
              items={props.items}
              selectedNumber={props.selectedNumber}
              onSelect={props.onSelect}
              loading={props.loading}
              error={props.error ? { ...props.error, kind: 'unknown' } : null}
              onLoadMore={props.hasMore ? props.onLoadMore : undefined}
            />
          </div>
          <div className="min-w-0">
            {props.snapshot ? (
              <PullRequestTimeline
                snapshot={props.snapshot}
                now={new Date().toISOString()}
                refreshing={props.loading || props.loadingDetail}
                error={props.error ? { ...props.error, kind: 'unknown' } : null}
                onOpenUrl={props.onOpenUrl}
              />
            ) : (
              <p role="status" className="p-5 text-sm text-text-secondary">
                {props.loadingDetail
                  ? 'Loading pull request…'
                  : 'Select a pull request to see checks, workflow attempts and reviews.'}
              </p>
            )}
          </div>
        </div>
      )}
      {!props.repository && props.loading && <p role="status">Loading repository…</p>}
    </section>
  );
}
