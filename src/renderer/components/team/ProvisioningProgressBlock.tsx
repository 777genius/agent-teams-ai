import { useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { renderLinkifiedText } from '@renderer/utils/linkifiedText';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Info,
  Loader2,
  X,
} from 'lucide-react';

import { MarkdownViewer } from '../chat/viewers/MarkdownViewer';

import { CliLogsRichView } from './CliLogsRichView';
import { DISPLAY_STEPS } from './provisioningSteps';
import { StepProgressBar } from './StepProgressBar';

import type { StepProgressBarStep } from './StepProgressBar';
import type { MemberLaunchDiagnosticsPayload } from '@renderer/utils/memberLaunchDiagnostics';
import type { TeamLaunchDiagnosticItem, TeamLaunchFailureDiagnosticsBundle } from '@shared/types';

const PROVIDER_API_KEY_FLAG_PATTERN =
  /(--(?:openai|codex|anthropic)[-_]api[-_]key(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FLAG_PATTERN =
  /(--(?:api[-_]key|token|password|secret|authorization|auth[-_]token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_ENV_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi;
const AUTH_HEADER_PATTERN = /\b(Authorization\s*:\s*)(Bearer\s+)?("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_VALUE_PATTERN =
  /\b(sk-[A-Za-z0-9._~+/=-]{12,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g;

export interface ProvisioningProgressBlockProps {
  /** Title above the steps, e.g. "Launching team" */
  title: string;
  /** Optional status message */
  message?: string | null;
  /** Visual severity for the message subtitle */
  messageSeverity?: 'error' | 'warning' | 'info';
  /** Visual tone (e.g. highlight errors) */
  tone?: 'default' | 'error';
  /** Whether Live output is expanded by default */
  defaultLiveOutputOpen?: boolean;
  /** Whether CLI logs are expanded by default */
  defaultLogsOpen?: boolean;
  /** Display step index (0-3 for active steps, 4 for ready/all done, -1 for terminal) */
  currentStepIndex: number;
  /** If set, this step index shows a red error indicator */
  errorStepIndex?: number;
  /** Show spinner next to title */
  loading?: boolean;
  /** Cancel button label and handler */
  onCancel?: (() => void) | null;
  /** Success message shown inside the block header (e.g. "Team launched — all N teammates online") */
  successMessage?: string | null;
  /** Visual tone for the status banner above the block. */
  successMessageSeverity?: 'success' | 'warning' | 'info';
  /** Dismiss handler — renders an X button in the block header top-right */
  onDismiss?: (() => void) | null;
  /** ISO timestamp when provisioning started */
  startedAt?: string;
  /** Team/run identity used to enrich copied launch diagnostics with artifact pack data. */
  teamName?: string;
  runId?: string;
  /** PID of the CLI process */
  pid?: number;
  /** CLI logs captured during launch */
  cliLogsTail?: string;
  /** Accumulated assistant text output for live preview */
  assistantOutput?: string;
  /** Bounded structured launch diagnostics */
  launchDiagnostics?: TeamLaunchDiagnosticItem[];
  /** Non-fatal warnings that should stay visible while the run continues. */
  warnings?: string[];
  /** Bounded per-member launch/runtime diagnostics for copy payloads. */
  memberDiagnostics?: MemberLaunchDiagnosticsPayload[];
  /** Visual surface chrome for the outer block */
  surface?: 'raised' | 'flat';
  className?: string;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function useElapsedTimer(startedAt?: string, isRunning = true): string | null {
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!startedAt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync on prop change
      setElapsedSeconds(null);
      return;
    }

    const startMs = Date.parse(startedAt);
    if (isNaN(startMs)) {
      setElapsedSeconds(null);
      return;
    }

    const computeElapsedSeconds = (): number =>
      Math.max(0, Math.floor((Date.now() - startMs) / 1000));

    if (!isRunning) {
      // Freeze timer on terminal states (failed/ready/cancelled) instead of continuing to tick.
      setElapsedSeconds((prev) => (prev === null ? computeElapsedSeconds() : prev));
      return;
    }

    const tick = (): void => {
      setElapsedSeconds(computeElapsedSeconds());
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [startedAt, isRunning]);

  if (!startedAt) return null;
  if (elapsedSeconds === null) return null;
  return formatElapsed(elapsedSeconds);
}

function sanitizeAssistantOutput(raw?: string, isError = false): string | null {
  if (!raw) return null;
  if (!isError) return raw;

  const looksLikeRawApiEnvelope =
    raw.includes('API Error: 400') &&
    (raw.includes('"_requests"') ||
      raw.includes('"session_id"') ||
      raw.includes('"parent_tool_use_id"') ||
      raw.includes('\\u000'));

  if (!looksLikeRawApiEnvelope) {
    return raw;
  }

  return (
    'API Error: 400\n\n' +
    'Raw payload from CLI stream hidden because it contains encoded/binary-like content.\n\n' +
    'Open **CLI logs** below for readable diagnostics.'
  );
}

function redactProvisioningDiagnosticsCopy(text: string): string {
  return text
    .replace(PROVIDER_API_KEY_FLAG_PATTERN, '$1[redacted]')
    .replace(SECRET_FLAG_PATTERN, '$1[redacted]')
    .replace(SECRET_ENV_ASSIGNMENT_PATTERN, '$1[redacted]')
    .replace(AUTH_HEADER_PATTERN, '$1$2[redacted]')
    .replace(SECRET_VALUE_PATTERN, '[redacted]');
}

function formatOptionalValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '(none)';
  }
  return String(value);
}

function formatBooleanValue(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return '(unknown)';
  }
  return value ? 'yes' : 'no';
}

function formatDetailsBlock(summary: string, content: string): string {
  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    content.trim() || '(empty)',
    '',
    '</details>',
  ].join('\n');
}

function formatListOrNone(values: readonly string[] | undefined): string {
  const lines = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (lines.length === 0) {
    return '(none)';
  }
  return lines.map((line) => `- ${line}`).join('\n');
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function findArtifactManifest(
  bundle: TeamLaunchFailureDiagnosticsBundle | null | undefined
): Record<string, unknown> | null {
  const manifestFile = bundle?.files.find(
    (file) => file.label === 'launch-failure-artifacts/manifest.json'
  );
  return parseJsonRecord(manifestFile?.content);
}

function getArrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function getObjectKeyCount(value: unknown): number | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).length
    : null;
}

function getStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function formatLaunchDiagnosticsCopy(
  items: readonly TeamLaunchDiagnosticItem[] | undefined
): string {
  if (!items || items.length === 0) {
    return '(none)';
  }

  return items
    .map((item) =>
      [
        `- id: ${item.id}`,
        item.memberName ? `  member: ${item.memberName}` : undefined,
        `  severity: ${item.severity}`,
        `  code: ${item.code}`,
        `  label: ${item.label}`,
        item.detail ? `  detail: ${item.detail}` : undefined,
        `  observedAt: ${item.observedAt}`,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n')
    )
    .join('\n');
}

function formatMemberDiagnosticsCopy(
  items: readonly MemberLaunchDiagnosticsPayload[] | undefined
): string {
  if (!items || items.length === 0) {
    return '(none)';
  }
  return JSON.stringify(items, null, 2);
}

function formatLaunchFailureArtifactCopy(
  bundle: TeamLaunchFailureDiagnosticsBundle | null | undefined,
  error?: string | null
): string {
  if (error) {
    return `Failed to read launch failure artifact bundle: ${error}`;
  }
  if (!bundle) {
    return '(none)';
  }

  const parts = [
    `teamName: ${bundle.teamName}`,
    `runId: ${formatOptionalValue(bundle.runId)}`,
    `latestPath: ${bundle.latestPath}`,
    `artifactDirectory: ${formatOptionalValue(bundle.artifactDirectory)}`,
    `manifestPath: ${formatOptionalValue(bundle.manifestPath)}`,
    '',
    'classification:',
    bundle.classification ? JSON.stringify(bundle.classification, null, 2) : '(none)',
    '',
    'bootstrapTransportBreadcrumb:',
    bundle.bootstrapTransportBreadcrumb
      ? JSON.stringify(bundle.bootstrapTransportBreadcrumb, null, 2)
      : '(none)',
    '',
    'files:',
  ];

  for (const file of bundle.files) {
    parts.push(
      '',
      `--- ${file.label}`,
      `path: ${file.path}`,
      file.issue ? `issue: ${file.issue}` : 'issue: (none)',
      'content:',
      file.content?.trim() || '(empty)'
    );
  }

  return parts.join('\n');
}

function formatArtifactManifestSummary(manifest: Record<string, unknown> | null): string {
  if (!manifest) {
    return '(manifest unavailable)';
  }
  const progress =
    manifest.progress && typeof manifest.progress === 'object' && !Array.isArray(manifest.progress)
      ? (manifest.progress as Record<string, unknown>)
      : null;
  const lines = [
    `expectedMembers: ${formatOptionalValue(getArrayLength(manifest.expectedMembers))}`,
    `effectiveMembers: ${formatOptionalValue(getArrayLength(manifest.effectiveMembers))}`,
    `memberSpawnStatuses: ${formatOptionalValue(getObjectKeyCount(manifest.memberSpawnStatuses))}`,
    `progress.state: ${formatOptionalValue(getStringField(progress, 'state'))}`,
    `progress.message: ${formatOptionalValue(getStringField(progress, 'message'))}`,
    `progress.error: ${formatOptionalValue(getStringField(progress, 'error'))}`,
    `progress.warnings: ${formatOptionalValue(getArrayLength(progress?.warnings))}`,
    `launchDiagnostics: ${formatOptionalValue(getArrayLength(manifest.launchDiagnostics))}`,
  ];
  return lines.join('\n');
}

function hasNoBootstrapEventSignal(message: string | null | undefined): boolean {
  const normalized = message?.toLowerCase() ?? '';
  return (
    normalized.includes('no team_bootstrap event') ||
    normalized.includes('before deterministic team bootstrap started')
  );
}

function formatConfidence(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '(unknown)';
  }
  return value.toFixed(2);
}

function buildDiagnosticsQuickTriage(input: {
  title: string;
  message?: string | null;
  tone: 'default' | 'error';
  startedAt?: string;
  elapsed?: string | null;
  pid?: number;
  currentStepIndex: number;
  errorStepIndex?: number;
  warnings?: string[];
  launchDiagnostics?: TeamLaunchDiagnosticItem[];
  memberDiagnostics?: MemberLaunchDiagnosticsPayload[];
  launchFailureArtifact?: TeamLaunchFailureDiagnosticsBundle | null;
  launchFailureArtifactError?: string | null;
  cliLogsTail?: string;
  liveOutput?: string | null;
}): string {
  const bundle = input.launchFailureArtifact;
  const artifactManifest = findArtifactManifest(bundle);
  const manifestProgress =
    artifactManifest?.progress &&
    typeof artifactManifest.progress === 'object' &&
    !Array.isArray(artifactManifest.progress)
      ? (artifactManifest.progress as Record<string, unknown>)
      : null;
  const classification = bundle?.classification;
  const breadcrumb = bundle?.bootstrapTransportBreadcrumb;
  const warningCount = input.warnings?.filter((warning) => warning.trim()).length ?? 0;
  const launchDiagnosticCount = input.launchDiagnostics?.length ?? 0;
  const memberDiagnosticCount = input.memberDiagnostics?.length ?? 0;
  const artifactFileCount = bundle?.files.length ?? 0;
  const hasRawCliLogs = Boolean(input.cliLogsTail?.trim());
  const hasLiveOutput = Boolean(input.liveOutput?.trim());
  const largeTeamWarning = input.warnings?.find((warning) =>
    warning.toLowerCase().includes('large codex team launch')
  );
  const noBootstrapEvent = hasNoBootstrapEventSignal(input.message);

  const facts = [
    `- User-visible title: ${input.title}`,
    `- User-visible message: ${formatOptionalValue(input.message)}`,
    `- Tone: ${input.tone}`,
    `- Started at: ${formatOptionalValue(input.startedAt)}; elapsed: ${formatOptionalValue(input.elapsed)}; pid: ${formatOptionalValue(input.pid)}`,
    `- Step index: current=${input.currentStepIndex}; error=${formatOptionalValue(input.errorStepIndex)}`,
    `- Classification: ${classification?.code ?? '(none)'}; confidence=${formatConfidence(classification?.confidence)}`,
    `- Bootstrap transport: submitted=${formatBooleanValue(breadcrumb?.bootstrapSubmitted)}; rejected=${formatBooleanValue(breadcrumb?.submitRejected)}; noStdinWarning=${formatBooleanValue(breadcrumb?.noStdinWarning)}; lastStage=${formatOptionalValue(breadcrumb?.lastTransportStage)}`,
    `- Counts: warnings=${warningCount}; launchDiagnostics=${launchDiagnosticCount}; memberSnapshots=${memberDiagnosticCount}; artifactFiles=${artifactFileCount}`,
    `- Manifest counts: expectedMembers=${formatOptionalValue(getArrayLength(artifactManifest?.expectedMembers))}; effectiveMembers=${formatOptionalValue(getArrayLength(artifactManifest?.effectiveMembers))}; spawnStatuses=${formatOptionalValue(getObjectKeyCount(artifactManifest?.memberSpawnStatuses))}`,
    `- Manifest progress: state=${formatOptionalValue(getStringField(manifestProgress, 'state'))}; message=${formatOptionalValue(getStringField(manifestProgress, 'message'))}; error=${formatOptionalValue(getStringField(manifestProgress, 'error'))}`,
    `- Raw CLI logs present: ${formatBooleanValue(hasRawCliLogs)}; live output present: ${formatBooleanValue(hasLiveOutput)}`,
  ];

  if (noBootstrapEvent) {
    facts.push(
      '- Bootstrap signal: no `system/team_bootstrap` event reached the app before process exit.'
    );
  }
  if (largeTeamWarning) {
    facts.push(`- Large-team signal: ${largeTeamWarning}`);
  }
  if (input.launchFailureArtifactError) {
    facts.push(`- Artifact read error: ${input.launchFailureArtifactError}`);
  }

  return facts.join('\n');
}

function buildProvisioningDiagnosticsCopy(input: {
  title: string;
  message?: string | null;
  messageSeverity?: 'error' | 'warning' | 'info';
  tone: 'default' | 'error';
  startedAt?: string;
  elapsed?: string | null;
  pid?: number;
  currentStepIndex: number;
  errorStepIndex?: number;
  liveOutput?: string | null;
  cliLogsTail?: string;
  warnings?: string[];
  launchDiagnostics?: TeamLaunchDiagnosticItem[];
  memberDiagnostics?: MemberLaunchDiagnosticsPayload[];
  launchFailureArtifact?: TeamLaunchFailureDiagnosticsBundle | null;
  launchFailureArtifactError?: string | null;
}): string {
  const warningsCopy = formatListOrNone(input.warnings);
  const launchDiagnosticsCopy = formatLaunchDiagnosticsCopy(input.launchDiagnostics);
  const memberDiagnosticsCopy = formatMemberDiagnosticsCopy(input.memberDiagnostics);
  const artifactManifest = findArtifactManifest(input.launchFailureArtifact);
  const artifactManifestSummary = formatArtifactManifestSummary(artifactManifest);
  const artifactCopy = formatLaunchFailureArtifactCopy(
    input.launchFailureArtifact,
    input.launchFailureArtifactError
  );
  const liveOutputCopy = input.liveOutput?.trim() || '(empty)';
  const cliLogsCopy = input.cliLogsTail?.trim() || '(empty)';
  const payload = [
    '# Team provisioning diagnostics',
    '',
    '## Quick triage',
    buildDiagnosticsQuickTriage(input),
    '',
    '## Summary',
    `Title: ${input.title}`,
    `Message: ${formatOptionalValue(input.message)}`,
    `Message severity: ${formatOptionalValue(input.messageSeverity)}`,
    `Tone: ${input.tone}`,
    `Started at: ${formatOptionalValue(input.startedAt)}`,
    `Elapsed: ${formatOptionalValue(input.elapsed)}`,
    `PID: ${formatOptionalValue(input.pid)}`,
    `Current step index: ${input.currentStepIndex}`,
    `Error step index: ${formatOptionalValue(input.errorStepIndex)}`,
    '',
    '## Warnings',
    warningsCopy,
    '',
    '## Launch diagnostics',
    launchDiagnosticsCopy,
    '',
    '## Artifact manifest summary',
    artifactManifestSummary,
    '',
    '## Full details',
    formatDetailsBlock('Member launch snapshots', memberDiagnosticsCopy),
    '',
    formatDetailsBlock('Launch failure artifact bundle', artifactCopy),
    '',
    formatDetailsBlock('Live output', liveOutputCopy),
    '',
    formatDetailsBlock('CLI logs tail', cliLogsCopy),
  ].join('\n');

  return redactProvisioningDiagnosticsCopy(payload).trim();
}

export const ProvisioningProgressBlock = ({
  title,
  message,
  messageSeverity,
  tone = 'default',
  defaultLiveOutputOpen = true,
  defaultLogsOpen,
  currentStepIndex,
  errorStepIndex,
  loading = false,
  onCancel,
  successMessage,
  successMessageSeverity = 'success',
  onDismiss,
  startedAt,
  teamName,
  runId,
  pid,
  cliLogsTail,
  assistantOutput,
  launchDiagnostics,
  warnings,
  memberDiagnostics,
  surface = 'raised',
  className,
}: ProvisioningProgressBlockProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const provisioningSteps: StepProgressBarStep[] = DISPLAY_STEPS.map((s) => ({
    key: s.key,
    label: t(s.labelKey),
  }));
  const elapsed = useElapsedTimer(startedAt, loading);
  const [logsOpen, setLogsOpen] = useState(() => defaultLogsOpen ?? false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [liveOutputOpen, setLiveOutputOpen] = useState(defaultLiveOutputOpen);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const isError = tone === 'error';
  const displayAssistantOutput = sanitizeAssistantOutput(assistantOutput, isError);
  const visibleLaunchDiagnostics =
    launchDiagnostics?.filter((item) => item.severity === 'warning' || item.severity === 'error') ??
    [];
  const visibleWarnings =
    warnings
      ?.map((warning) => warning.trim())
      .filter((warning) => warning && !warning.startsWith('Launch runtime:')) ?? [];

  // Auto-scroll assistant output
  useEffect(() => {
    if (liveOutputOpen && outputScrollRef.current) {
      outputScrollRef.current.scrollTop = outputScrollRef.current.scrollHeight;
    }
  }, [assistantOutput, liveOutputOpen]);

  // If parent changes the default (e.g. transitioning to "ready"), respect it.
  useEffect(() => {
    setLiveOutputOpen(defaultLiveOutputOpen);
  }, [defaultLiveOutputOpen]);

  useEffect(() => {
    if (defaultLogsOpen === undefined) {
      return;
    }
    setLogsOpen(defaultLogsOpen);
  }, [defaultLogsOpen]);

  // On error with logs available, prioritize logs view over noisy live stream payload.
  useEffect(() => {
    if (isError && cliLogsTail) {
      setLogsOpen(true);
      setLiveOutputOpen(false);
    }
  }, [isError, cliLogsTail]);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    []
  );

  const copyDiagnostics = async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) {
      setDiagnosticsCopied(false);
      return;
    }
    let launchFailureArtifact: TeamLaunchFailureDiagnosticsBundle | null = null;
    let launchFailureArtifactError: string | null = null;
    if (teamName) {
      try {
        launchFailureArtifact = await api.teams.getLaunchFailureDiagnostics(teamName, runId);
      } catch (error) {
        launchFailureArtifactError = error instanceof Error ? error.message : String(error);
      }
    }
    const diagnosticsCopyText = buildProvisioningDiagnosticsCopy({
      title,
      message,
      messageSeverity,
      tone,
      startedAt,
      elapsed,
      pid,
      currentStepIndex,
      errorStepIndex,
      liveOutput: displayAssistantOutput,
      cliLogsTail,
      warnings,
      launchDiagnostics,
      memberDiagnostics,
      launchFailureArtifact,
      launchFailureArtifactError,
    });
    try {
      await navigator.clipboard.writeText(diagnosticsCopyText);
    } catch {
      setDiagnosticsCopied(false);
      return;
    }
    setDiagnosticsCopied(true);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      copyResetTimerRef.current = null;
      setDiagnosticsCopied(false);
    }, 1500);
  };

  return (
    <div
      className={cn(
        surface === 'flat'
          ? 'rounded-none border-0 bg-transparent p-0'
          : 'rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2',
        isError && 'border-red-500/40 bg-red-500/10',
        className
      )}
    >
      {successMessage ? (
        <div className="mb-1.5 flex items-center gap-2">
          {successMessageSeverity === 'warning' ? (
            <AlertTriangle size={14} className="shrink-0 text-amber-400" />
          ) : successMessageSeverity === 'info' ? (
            <Info size={14} className="shrink-0 text-sky-400" />
          ) : (
            <CheckCircle2 size={14} className="shrink-0 text-[var(--step-done-text)]" />
          )}
          <p
            className={cn(
              'flex-1 text-xs',
              successMessageSeverity === 'warning'
                ? 'text-amber-400'
                : successMessageSeverity === 'info'
                  ? 'text-sky-400'
                  : 'text-[var(--step-success-text)]'
            )}
          >
            {successMessage}
          </p>
          {onDismiss ? (
            <Button
              variant="ghost"
              size="sm"
              className="size-6 shrink-0 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={onDismiss}
            >
              <X size={12} />
            </Button>
          ) : null}
        </div>
      ) : onDismiss ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="size-6 shrink-0 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            onClick={onDismiss}
          >
            <X size={12} />
          </Button>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {loading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--color-text-muted)]" />
          ) : null}
          <p className="text-xs font-medium text-[var(--color-text)]">{title}</p>
          {elapsed !== null ? (
            <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {elapsed}
            </span>
          ) : null}
          {pid !== undefined ? (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {t('provisioning.pid', { pid })}
            </span>
          ) : null}
        </div>
        {onCancel ? (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={onCancel}
          >
            {t('provisioning.cancel')}
          </Button>
        ) : null}
      </div>
      {message ? (
        <div
          className={cn(
            'mt-1.5 whitespace-pre-wrap text-xs',
            isError || messageSeverity === 'error'
              ? 'text-red-400'
              : messageSeverity === 'warning'
                ? 'text-amber-400'
                : messageSeverity === 'info'
                  ? 'text-sky-400'
                  : 'text-[var(--color-text-muted)]'
          )}
        >
          {renderLinkifiedText(message, {
            linkClassName: 'underline underline-offset-2 hover:text-[var(--color-accent)]',
          })}
        </div>
      ) : null}
      {visibleWarnings.length > 0 ? (
        <div className="mt-2 flex gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div className="min-w-0 space-y-1">
            {visibleWarnings.slice(0, 3).map((warning) => (
              <p key={warning} className="whitespace-pre-wrap">
                {warning}
              </p>
            ))}
            {visibleWarnings.length > 3 ? (
              <p>{t('provisioning.moreWarningsHidden', { count: visibleWarnings.length - 3 })}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="mt-2 px-2">
        <StepProgressBar
          steps={provisioningSteps}
          currentIndex={currentStepIndex}
          active={loading}
          errorIndex={errorStepIndex}
        />
      </div>
      {visibleLaunchDiagnostics.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={() => setDiagnosticsOpen((v) => !v)}
          >
            {diagnosticsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('provisioning.diagnostics')}
          </button>
          {diagnosticsOpen ? (
            <div className="mt-1 space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
              {visibleLaunchDiagnostics.map((item) => (
                <div key={item.id} className="text-[11px]">
                  <div
                    className={cn(
                      item.severity === 'error'
                        ? 'text-red-400'
                        : item.severity === 'warning'
                          ? 'text-amber-400'
                          : 'text-[var(--color-text-secondary)]'
                    )}
                  >
                    {item.label}
                  </div>
                  {item.detail ? (
                    <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                      {item.detail}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={() => setLiveOutputOpen((v) => !v)}
          >
            {liveOutputOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('provisioning.liveOutput')}
          </button>
          <Button
            type="button"
            variant={isError ? 'outline' : 'ghost'}
            size="sm"
            className={cn(
              'shrink-0 gap-1',
              isError
                ? 'h-8 animate-pulse border-red-500/60 bg-red-500/15 px-3 text-xs font-medium text-[var(--step-error-text)] shadow-[0_0_0_1px_rgba(248,113,113,0.25)] hover:bg-red-500/20 hover:text-red-100'
                : 'h-6 px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              isError && diagnosticsCopied && 'animate-none'
            )}
            title={
              diagnosticsCopied
                ? t('provisioning.diagnosticsCopied')
                : t('provisioning.copyDiagnostics')
            }
            aria-label={
              diagnosticsCopied
                ? t('provisioning.diagnosticsCopied')
                : t('provisioning.copyDiagnostics')
            }
            onClick={() => void copyDiagnostics()}
          >
            {diagnosticsCopied ? (
              <Check size={isError ? 14 : 12} />
            ) : (
              <ClipboardList size={isError ? 14 : 12} />
            )}
            <span>
              {diagnosticsCopied ? t('provisioning.copied') : t('provisioning.copyDiagnostics')}
            </span>
          </Button>
        </div>
        {liveOutputOpen ? (
          <div
            ref={outputScrollRef}
            className={cn(
              'mt-1 max-h-[400px] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2',
              isError && 'border-red-500/40'
            )}
          >
            {displayAssistantOutput ? (
              <MarkdownViewer content={displayAssistantOutput} bare maxHeight="max-h-none" />
            ) : (
              <p
                className={cn(
                  'text-[11px]',
                  isError ? 'text-[var(--step-error-text-dim)]' : 'text-[var(--color-text-muted)]'
                )}
              >
                {t('provisioning.noOutput')}
              </p>
            )}
          </div>
        ) : null}
      </div>
      {cliLogsTail ? (
        <div className="mt-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={() => setLogsOpen((v) => !v)}
          >
            {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('provisioning.cliLogs')}
          </button>
          {logsOpen ? (
            <CliLogsRichView cliLogsTail={cliLogsTail} order="newest-first" className="mt-1" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
