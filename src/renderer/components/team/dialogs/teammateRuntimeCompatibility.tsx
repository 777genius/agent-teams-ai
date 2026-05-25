import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { parseCliArgs } from '@shared/utils/cliArgsParser';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TmuxStatus } from '@features/tmux-installer/contracts';
import type { TeamProviderId } from '@shared/types';

type TeammateRuntimeIssueReason =
  | 'mixed-provider'
  | 'codex-native-runtime'
  | 'explicit-tmux-mode'
  | 'explicit-in-process-mode'
  | 'opencode-led-mixed-unsupported';

interface RuntimeMemberInput {
  id?: string;
  name: string;
  providerId?: TeamProviderId;
  providerBackendId?: string | null;
  removedAt?: number | string | null;
}

interface RuntimeIssue {
  reason: TeammateRuntimeIssueReason;
  memberId?: string;
  memberName?: string;
  memberProviderId?: TeamProviderId;
}

export interface TeammateRuntimeCompatibility {
  visible: boolean;
  blocksSubmission: boolean;
  checking: boolean;
  providerNoticeProviderId: TeamProviderId | null;
  title: string;
  message: string;
  details: string[];
  tmuxDetail: string | null;
  memberWarningById: Record<string, string>;
}

interface AnalyzeTeammateRuntimeCompatibilityInput {
  leadProviderId: TeamProviderId;
  leadProviderBackendId?: string | null;
  members: readonly RuntimeMemberInput[];
  soloTeam?: boolean;
  extraCliArgs?: string;
  tmuxStatus: TmuxStatus | null;
  tmuxStatusLoading: boolean;
  tmuxStatusError: string | null;
}

export interface TmuxRuntimeReadiness {
  status: TmuxStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const PROVIDER_LABELS: Record<TeamProviderId, string> = {
  anthropic: 'Anthropic',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  kilocode: 'KiloCode',
};

function getProviderLabel(providerId: TeamProviderId): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}

function getExplicitTeammateMode(
  rawExtraCliArgs: string | undefined
): 'auto' | 'tmux' | 'in-process' | null {
  const tokens = parseCliArgs(rawExtraCliArgs);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    // eslint-disable-next-line security/detect-possible-timing-attacks -- parsing UI CLI flags, not comparing secrets
    if (token === '--teammate-mode') {
      const value = tokens[index + 1];
      return value === 'auto' || value === 'tmux' || value === 'in-process' ? value : null;
    }
    if (token.startsWith('--teammate-mode=')) {
      const value = token.slice('--teammate-mode='.length);
      return value === 'auto' || value === 'tmux' || value === 'in-process' ? value : null;
    }
  }
  return null;
}

function isTmuxRuntimeReady(status: TmuxStatus | null): boolean {
  return status?.effective.available === true && status.effective.runtimeReady === true;
}

function getTmuxDetail(status: TmuxStatus | null, error: string | null): string | null {
  if (error) {
    return error;
  }
  return status?.effective.detail ?? status?.wsl?.statusDetail ?? status?.error ?? null;
}

function summarizeIssueNames(
  issues: readonly RuntimeIssue[],
  reason: TeammateRuntimeIssueReason
): string {
  const names = issues
    .filter((issue) => issue.reason === reason)
    .map((issue) => issue.memberName)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) {
    return '';
  }
  if (names.length <= 3) {
    return names.join(', ');
  }
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export function analyzeTeammateRuntimeCompatibility({
  leadProviderId,
  leadProviderBackendId,
  members,
  soloTeam = false,
  extraCliArgs,
  tmuxStatus,
  tmuxStatusLoading,
  tmuxStatusError,
}: AnalyzeTeammateRuntimeCompatibilityInput): TeammateRuntimeCompatibility {
  const activeMembers = soloTeam
    ? []
    : members.filter((member) => member.removedAt == null && member.name.trim().length > 0);
  const explicitTeammateMode = getExplicitTeammateMode(extraCliArgs);
  const leadBackendId = migrateProviderBackendId(leadProviderId, leadProviderBackendId);
  const issues: RuntimeIssue[] = [];

  if (explicitTeammateMode === 'tmux' && activeMembers.length > 0) {
    issues.push({ reason: 'explicit-tmux-mode' });
  }

  for (const member of activeMembers) {
    const memberProviderId = normalizeOptionalTeamProviderId(member.providerId) ?? leadProviderId;
    const memberName = member.name.trim();
    if (memberProviderId !== leadProviderId) {
      if (leadProviderId !== 'opencode' && memberProviderId === 'opencode') {
        continue;
      }
      if (leadProviderId === 'opencode') {
        issues.push({
          reason: 'opencode-led-mixed-unsupported',
          memberId: member.id,
          memberName,
          memberProviderId,
        });
        continue;
      }
      issues.push({
        reason: 'mixed-provider',
        memberId: member.id,
        memberName,
        memberProviderId,
      });
      continue;
    }

    const memberBackendId = migrateProviderBackendId(
      memberProviderId,
      member.providerBackendId ?? leadBackendId
    );
    if (memberProviderId === 'codex' && memberBackendId === 'codex-native') {
      issues.push({
        reason: 'codex-native-runtime',
        memberId: member.id,
        memberName,
        memberProviderId,
      });
    }
  }

  const requiresSeparateProcess = issues.some(
    (issue) => issue.reason === 'mixed-provider' || issue.reason === 'codex-native-runtime'
  );
  if (explicitTeammateMode === 'in-process' && requiresSeparateProcess) {
    issues.push({ reason: 'explicit-in-process-mode' });
  }

  if (issues.length === 0) {
    return {
      visible: false,
      blocksSubmission: false,
      checking: false,
      providerNoticeProviderId: null,
      title: '',
      message: '',
      details: [],
      tmuxDetail: null,
      memberWarningById: {},
    };
  }

  const tmuxReady = isTmuxRuntimeReady(tmuxStatus);
  const hasOpenCodeLeadMixedUnsupported = issues.some(
    (issue) => issue.reason === 'opencode-led-mixed-unsupported'
  );
  const hasExplicitTmux = issues.some((issue) => issue.reason === 'explicit-tmux-mode');
  const hasExplicitInProcess = issues.some((issue) => issue.reason === 'explicit-in-process-mode');
  if (!hasOpenCodeLeadMixedUnsupported && !hasExplicitTmux && !hasExplicitInProcess) {
    return {
      visible: false,
      blocksSubmission: false,
      checking: false,
      providerNoticeProviderId: null,
      title: '',
      message: '',
      details: [],
      tmuxDetail: null,
      memberWarningById: {},
    };
  }

  if (tmuxReady && hasExplicitTmux && !hasOpenCodeLeadMixedUnsupported && !hasExplicitInProcess) {
    return {
      visible: false,
      blocksSubmission: false,
      checking: false,
      providerNoticeProviderId: null,
      title: '',
      message: '',
      details: [],
      tmuxDetail: null,
      memberWarningById: {},
    };
  }

  const checking =
    hasExplicitTmux &&
    !hasOpenCodeLeadMixedUnsupported &&
    !hasExplicitInProcess &&
    tmuxStatusLoading &&
    !tmuxStatus;
  const blocksSubmission = true;
  const hasMixedProviders = issues.some((issue) => issue.reason === 'mixed-provider');
  const hasCodexNative = issues.some((issue) => issue.reason === 'codex-native-runtime');
  const details: string[] = [];
  const memberWarningById: Record<string, string> = {};

  if (hasMixedProviders) {
    const names = summarizeIssueNames(issues, 'mixed-provider');
    details.push(
      names
        ? `Mixed providers: ${names} use a different provider than the ${getProviderLabel(leadProviderId)} lead.`
        : 'Mixed providers require teammate processes.'
    );
  }
  if (hasOpenCodeLeadMixedUnsupported) {
    const names = summarizeIssueNames(issues, 'opencode-led-mixed-unsupported');
    details.push(
      names
        ? `OpenCode-led mixed team: ${names} use a non-OpenCode provider.`
        : 'Mixed teams cannot use OpenCode as the lead in this phase.'
    );
  }
  if (hasCodexNative) {
    const names = summarizeIssueNames(issues, 'codex-native-runtime');
    details.push(
      names
        ? `Codex native teammates: ${names} must run through separate Codex processes.`
        : 'Codex native teammates must run through separate Codex processes.'
    );
  }
  if (hasExplicitTmux) {
    details.push('Custom CLI args force --teammate-mode tmux.');
  }
  if (hasExplicitInProcess) {
    details.push('Custom CLI args force --teammate-mode in-process.');
  }
  if (hasOpenCodeLeadMixedUnsupported) {
    details.push(
      'Fix: keep the team lead on Anthropic or Codex when mixing OpenCode with other providers.'
    );
  } else if (hasExplicitInProcess) {
    details.push(
      'Fix: remove --teammate-mode in-process so teammates can use native process transport.'
    );
  } else {
    details.push(
      'Fix: install tmux/WSL tmux, or remove --teammate-mode tmux so the app can use native process transport.'
    );
  }

  for (const issue of issues) {
    if (!issue.memberId || !issue.memberName) {
      continue;
    }
    if (issue.reason === 'mixed-provider') {
      memberWarningById[issue.memberId] =
        `${issue.memberName} uses ${getProviderLabel(issue.memberProviderId ?? leadProviderId)}. ` +
        `This teammate requires a separate process outside the ${getProviderLabel(leadProviderId)} lead.`;
    } else if (issue.reason === 'codex-native-runtime') {
      memberWarningById[issue.memberId] =
        `${issue.memberName} uses Codex native. Codex native teammates require a separate Codex process.`;
    } else if (issue.reason === 'opencode-led-mixed-unsupported') {
      memberWarningById[issue.memberId] =
        `${issue.memberName} uses ${getProviderLabel(issue.memberProviderId ?? leadProviderId)}. ` +
        'OpenCode cannot be the team lead when mixing providers in this phase.';
    }
  }

  return {
    visible: blocksSubmission || checking,
    blocksSubmission,
    checking,
    providerNoticeProviderId: hasOpenCodeLeadMixedUnsupported ? 'opencode' : null,
    title: checking
      ? 'Checking tmux runtime for explicit teammate mode'
      : hasOpenCodeLeadMixedUnsupported
        ? 'OpenCode cannot lead mixed-provider teams'
        : hasExplicitInProcess
          ? 'This team cannot use in-process teammates'
          : 'tmux is not ready for explicit teammate mode',
    message: checking
      ? 'Custom CLI args request tmux teammates. The app is checking whether tmux is available.'
      : hasOpenCodeLeadMixedUnsupported
        ? 'OpenCode can be added as a teammate under an Anthropic or Codex lead, but mixed teams cannot use OpenCode as the lead in this phase.'
        : hasExplicitInProcess
          ? 'Some teammates require separate processes. Remove --teammate-mode in-process so the app can use native process transport.'
          : 'Custom CLI args force --teammate-mode tmux, but tmux is not ready. Remove that arg to use native process transport on Windows, or install tmux/WSL tmux.',
    details,
    tmuxDetail: hasOpenCodeLeadMixedUnsupported ? null : getTmuxDetail(tmuxStatus, tmuxStatusError),
    memberWarningById,
  };
}

export function useTmuxRuntimeReadiness(enabled: boolean): TmuxRuntimeReadiness {
  const [status, setStatus] = useState<TmuxStatus | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (typeof api.tmux?.getStatus !== 'function') {
        throw new Error('tmux status API is not available. Restart the app.');
      }
      const nextStatus = await api.tmux.getStatus();
      setStatus(nextStatus);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load tmux status');
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    if (typeof api.tmux?.onProgress !== 'function') {
      return undefined;
    }
    return api.tmux.onProgress(() => {
      void refresh();
    });
  }, [enabled, refresh]);

  const effectiveLoading = enabled && (loading || (!status && !error));

  return useMemo(
    () => ({
      status,
      loading: effectiveLoading,
      error,
      refresh,
    }),
    [effectiveLoading, error, refresh, status]
  );
}
