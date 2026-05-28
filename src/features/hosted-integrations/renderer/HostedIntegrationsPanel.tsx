import { useState } from 'react';

import { GitBranch, KeyRound, Loader2, Plug, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';

import { useHostedIntegrationState } from './hooks/useHostedIntegrationState';

import type {
  HostedGitHubAvailableRepositoryDto,
  StartHostedPairingResponseDto,
} from '../contracts';

const buttonClass =
  'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50';

export const HostedIntegrationsPanel = (): React.JSX.Element => {
  const { actions, busy, error, loading, state } = useHostedIntegrationState();
  const [baseUrl, setBaseUrl] = useState('');
  const [availableRepositories, setAvailableRepositories] = useState<
    readonly HostedGitHubAvailableRepositoryDto[]
  >([]);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingSession, setPairingSession] = useState<StartHostedPairingResponseDto | null>(null);

  const configuredBaseUrl = state?.controlPlaneBaseUrl ?? '';
  const activeSetup = state?.activeSetup;
  const connected = state?.session?.state === 'paired';
  const firstConnection = state?.connections[0];

  async function loadAvailableRepositories(connectionId: string): Promise<void> {
    const result = await actions.listAvailableRepositories(connectionId);
    if (Array.isArray(result)) {
      setAvailableRepositories(result);
    }
  }

  async function startPairing(): Promise<void> {
    const result = await actions.startPairing();
    if (result) {
      setPairingSession(result);
      setPairingCode(result.pairingCode);
    }
  }

  async function completePairing(): Promise<void> {
    const result = await actions.completePairing(pairingCode);
    if (result) {
      setPairingSession(null);
      setPairingCode('');
    }
  }

  return (
    <section className="space-y-4 py-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
            <GitBranch className="size-4" />
            GitHub App
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {connected ? 'Connected through hosted control-plane' : 'Not connected'}
          </p>
        </div>
        <button
          className={buttonClass}
          disabled={busy || loading}
          onClick={() => void actions.refresh()}
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </button>
      </div>

      <div className="rounded-md border border-[var(--color-border)] p-3">
        <label
          htmlFor="hosted-integrations-control-plane-url"
          className="block text-xs font-medium text-[var(--color-text-secondary)]"
        >
          Control-plane URL
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="hosted-integrations-control-plane-url"
            value={baseUrl || configuredBaseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://control-plane.example.com"
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-1 focus:ring-blue-400"
          />
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => void actions.configure(baseUrl || configuredBaseUrl)}
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          >
            <Plug className="size-3.5" />
            Save
          </button>
          <button
            className={buttonClass}
            disabled={busy || !configuredBaseUrl}
            onClick={() => void actions.bootstrapWorkspace('Agent Teams Workspace')}
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          >
            <ShieldCheck className="size-3.5" />
            Connect
          </button>
          <button
            className={buttonClass}
            disabled={busy || !connected}
            onClick={() => void startPairing()}
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          >
            <KeyRound className="size-3.5" />
            Pair
          </button>
        </div>
        {(pairingSession || !connected) && (
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input
              aria-label="Pairing code"
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value)}
              placeholder="Pairing code"
              className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-1 focus:ring-blue-400"
            />
            <button
              className={buttonClass}
              disabled={busy || !configuredBaseUrl || !pairingCode.trim()}
              onClick={() => void completePairing()}
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            >
              <KeyRound className="size-3.5" />
              Complete pairing
            </button>
          </div>
        )}
        {state?.session && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
            <span>
              Workspace: {state.session.workspaceDisplayName ?? state.session.workspaceId}
            </span>
            <span>
              Desktop: {state.session.desktopDisplayName ?? state.session.desktopClientId}
            </span>
          </div>
        )}
      </div>

      <div className="rounded-md border border-[var(--color-border)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium text-[var(--color-text-secondary)]">GitHub setup</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {activeSetup ? activeSetup.state : 'No active setup session'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={busy || !connected}
              onClick={() => void actions.startGitHubSetup()}
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            >
              <GitBranch className="size-3.5" />
              Start setup
            </button>
            {activeSetup?.setupUrl && (
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() =>
                  void actions.openSetupUrl(activeSetup.setupSessionId, activeSetup.setupUrl!)
                }
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              >
                <Plug className="size-3.5" />
                Open
              </button>
            )}
            {activeSetup && (
              <>
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void actions.refreshSetup(activeSetup.setupSessionId)}
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                >
                  <RefreshCw className="size-3.5" />
                  Poll
                </button>
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void actions.dismissSetup(activeSetup.setupSessionId)}
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {firstConnection && (
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-[var(--color-text-secondary)]">
                {firstConnection.githubAccountLogin}
              </p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {state?.targets.length ?? 0} enabled repositories
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() => void actions.refreshConnections()}
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              >
                <RefreshCw className="size-3.5" />
                Connections
              </button>
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() => void loadAvailableRepositories(firstConnection.connectionId)}
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              >
                <GitBranch className="size-3.5" />
                Repositories
              </button>
            </div>
          </div>

          {availableRepositories.length > 0 && (
            <div className="mt-3 max-h-44 space-y-2 overflow-auto">
              {availableRepositories.slice(0, 20).map((repo) => (
                <div
                  key={repo.githubRepositoryId}
                  className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-surface-raised)] px-3 py-2"
                >
                  <span className="truncate text-xs text-[var(--color-text)]">
                    {repo.displayFullName}
                  </span>
                  <button
                    className={buttonClass}
                    disabled={busy || Boolean(repo.targetId)}
                    onClick={() =>
                      void actions.enableTarget(repo.connectionId, repo.githubRepositoryId)
                    }
                    style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  >
                    Enable
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(state?.targets.length ?? 0) > 0 && (
        <div className="space-y-2">
          {state!.targets.map((target) => (
            <div
              key={target.targetId}
              className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-[var(--color-text)]">
                  {target.displayFullName}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {target.status} - repo {target.githubRepositoryId}
                </p>
              </div>
              <button
                className={buttonClass}
                disabled={
                  busy ||
                  target.status === 'disabled' ||
                  target.status === 'deleted' ||
                  target.status === 'revoked'
                }
                onClick={() => void actions.disableTarget(target.targetId)}
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
              >
                <Trash2 className="size-3.5" />
                Disable
              </button>
            </div>
          ))}
        </div>
      )}

      {state?.session && (
        <div className="flex flex-wrap gap-2">
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => void actions.rotateSessionToken()}
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          >
            <KeyRound className="size-3.5" />
            Rotate token
          </button>
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => void actions.revokeSession()}
            style={{ borderColor: 'rgba(239,68,68,0.35)', color: '#f87171' }}
          >
            <Trash2 className="size-3.5" />
            Revoke desktop connection
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </section>
  );
};
