import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { AlertTriangle, CheckCircle2, GitBranch, Loader2 } from 'lucide-react';

import type { TeamWorktreeGitStatus } from '@shared/types';

interface WorktreeGitReadinessState {
  status: TeamWorktreeGitStatus | null;
  loading: boolean;
  actionLoading: 'init' | 'commit' | null;
  error: string | null;
  refresh: () => Promise<void>;
  initializeRepository: () => Promise<void>;
  createInitialCommit: () => Promise<void>;
}

export function useWorktreeGitReadiness(
  projectPath: string | null,
  enabled: boolean
): WorktreeGitReadinessState {
  const [status, setStatus] = useState<TeamWorktreeGitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<'init' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || !projectPath?.trim()) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.teams.getWorktreeGitStatus(projectPath));
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : 'Failed to inspect Git repository');
    } finally {
      setLoading(false);
    }
  }, [enabled, projectPath]);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !projectPath?.trim()) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void api.teams
      .getWorktreeGitStatus(projectPath)
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus(null);
          setError(err instanceof Error ? err.message : 'Failed to inspect Git repository');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectPath]);

  const initializeRepository = useCallback(async () => {
    if (!projectPath?.trim()) return;
    setActionLoading('init');
    setError(null);
    try {
      setStatus(await api.teams.initializeGitRepository(projectPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize Git repository');
    } finally {
      setActionLoading(null);
    }
  }, [projectPath]);

  const createInitialCommit = useCallback(async () => {
    if (!projectPath?.trim()) return;
    setActionLoading('commit');
    setError(null);
    try {
      setStatus(await api.teams.createInitialGitCommit(projectPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create initial Git commit');
    } finally {
      setActionLoading(null);
    }
  }, [projectPath]);

  return useMemo(
    () => ({
      status,
      loading,
      actionLoading,
      error,
      refresh,
      initializeRepository,
      createInitialCommit,
    }),
    [actionLoading, createInitialCommit, error, initializeRepository, loading, refresh, status]
  );
}

export function getWorktreeGitBlockingMessage(
  state: Pick<WorktreeGitReadinessState, 'status' | 'loading' | 'error'>,
  hasSelectedWorktreeIsolation: boolean
): string | null {
  if (!hasSelectedWorktreeIsolation) {
    return null;
  }
  if (state.loading) {
    return 'Checking Git repository status before enabling worktree isolation.';
  }
  if (state.error) {
    return state.error;
  }
  if (!state.status) {
    return 'Worktree isolation requires a Git repository with an initial commit.';
  }
  return state.status.canUseWorktrees ? null : (state.status.message ?? null);
}

export function getWorktreeGitControlDisabledReason(
  state: Pick<WorktreeGitReadinessState, 'status' | 'loading' | 'error'>
): string | null {
  if (state.loading) {
    return 'Checking Git repository status...';
  }
  if (state.error) {
    return state.error;
  }
  if (!state.status) {
    return null;
  }
  return state.status.canUseWorktrees ? null : (state.status.message ?? null);
}

export const WorktreeGitReadinessBanner = ({
  state,
  showReady = false,
}: {
  state: WorktreeGitReadinessState;
  showReady?: boolean;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { status, loading, actionLoading, error, initializeRepository, createInitialCommit } =
    state;

  if (loading) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-[11px] leading-relaxed text-sky-300">
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
        <p>{t('worktreeGitReadiness.checking')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/8 flex items-start gap-2 rounded-md border border-red-500/25 px-3 py-2 text-[11px] leading-relaxed text-red-200">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <p>{error}</p>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  if (status.canUseWorktrees) {
    if (!showReady) return null;
    return (
      <div className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] leading-relaxed text-emerald-300">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
        <p>
          {status.branch
            ? t('worktreeGitReadiness.readyOnBranch', { branch: status.branch })
            : t('worktreeGitReadiness.ready')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-amber-500/8 space-y-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
      <div className="flex items-start gap-2">
        <GitBranch className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-amber-100">{t('worktreeGitReadiness.needsSetup')}</p>
          <p className="mt-0.5 text-amber-100/85">
            {status.message ??
              'Worktree isolation requires a Git repository with an initial commit.'}
          </p>
          {status.reason === 'missing_head' ? (
            <p className="mt-1 text-amber-100/70">
              {t('worktreeGitReadiness.initialCommitNotice')}{' '}
              <span className="font-mono">{t('worktreeGitReadiness.initialCommitMessage')}</span>.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-5">
        {status.reason === 'not_git_repo' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            disabled={actionLoading !== null}
            onClick={initializeRepository}
          >
            {actionLoading === 'init' ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
            {t('worktreeGitReadiness.initializeRepository')}
          </Button>
        ) : null}
        {status.reason === 'missing_head' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 border-amber-400/50 text-[11px] text-amber-100 hover:bg-amber-500/15"
            disabled={actionLoading !== null}
            onClick={createInitialCommit}
          >
            {actionLoading === 'commit' ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
            {t('worktreeGitReadiness.createInitialCommit')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
