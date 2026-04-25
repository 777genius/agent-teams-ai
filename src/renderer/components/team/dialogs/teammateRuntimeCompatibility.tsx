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

  if (issues.length === 0) {
    return {
      visible: false,
      blocksSubmission: false,
      checking: false,
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
  if (tmuxReady && !hasOpenCodeLeadMixedUnsupported) {
    return {
      visible: false,
      blocksSubmission: false,
      checking: false,
      title: '',
      message: '',
      details: [],
      tmuxDetail: null,
      memberWarningById: {},
    };
  }

  const checking = !hasOpenCodeLeadMixedUnsupported && tmuxStatusLoading && !tmuxStatus;
  const blocksSubmission = true;
  const hasMixedProviders = issues.some((issue) => issue.reason === 'mixed-provider');
  const hasCodexNative = issues.some((issue) => issue.reason === 'codex-native-runtime');
  const hasExplicitTmux = issues.some((issue) => issue.reason === 'explicit-tmux-mode');
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
        : 'OpenCode-led mixed teams are not supported in this phase.'
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
  if (hasOpenCodeLeadMixedUnsupported) {
    details.push(
      'Fix: keep the team lead on Anthropic, Codex, or Gemini when mixing OpenCode with other providers.'
    );
  } else {
    details.push(
      hasCodexNative && !hasMixedProviders
        ? 'Fix: install tmux/WSL tmux, use Solo team, or choose a same-provider runtime that supports in-process teammates.'
        : 'Fix: install tmux/WSL tmux, use Solo team, or keep every teammate on the same non-Codex-native provider as the lead.'
    );
  }

  for (const issue of issues) {
    if (!issue.memberId || !issue.memberName) {
      continue;
    }
    if (issue.reason === 'mixed-provider') {
      memberWarningById[issue.memberId] =
        `${issue.memberName} uses ${getProviderLabel(issue.memberProviderId ?? leadProviderId)}. ` +
        `Without tmux, teammates must use the same provider as the ${getProviderLabel(leadProviderId)} lead.`;
    } else if (issue.reason === 'codex-native-runtime') {
      memberWarningById[issue.memberId] =
        `${issue.memberName} uses Codex native. Codex native teammates require a separate process, which currently needs tmux.`;
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
    title: checking
      ? 'Checking tmux runtime for teammate support'
      : hasOpenCodeLeadMixedUnsupported
        ? 'OpenCode cannot lead mixed-provider teams'
        : hasCodexNative && !hasMixedProviders
          ? 'Codex teammates need tmux before they can run'
          : 'This team needs tmux before it can run',
    message: checking
      ? 'Some teammates require separate processes. The app is checking whether tmux is available.'
      : hasOpenCodeLeadMixedUnsupported
        ? 'OpenCode teammates can run as secondary runtime lanes under an Anthropic, Codex, or Gemini lead, but OpenCode-led mixed teams are not supported in this phase.'
        : hasCodexNative && !hasMixedProviders
          ? 'The Codex lead can run without tmux, but Codex native teammates cannot use the in-process teammate adapter. They must start as separate Codex processes, and this path currently needs tmux.'
          : 'tmux is not ready on this machine. Same-provider in-process teammates can run without tmux, but this team has teammates that require separate processes.',
    details,
    tmuxDetail: getTmuxDetail(tmuxStatus, tmuxStatusError),
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
