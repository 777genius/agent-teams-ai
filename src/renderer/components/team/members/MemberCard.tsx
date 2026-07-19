import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { SyncedLoader2 } from '@renderer/components/ui/SyncedLoader2';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { renderLinkifiedText } from '@renderer/utils/linkifiedText';
import {
  agentAvatarUrl,
  buildMemberLaunchPresentation,
  displayMemberName,
  isOpenCodeRelaunchActionable,
  shouldDisplayMemberCurrentTask,
} from '@renderer/utils/memberHelpers';
import {
  buildMemberLaunchDiagnosticsPayload,
  hasMemberLaunchDiagnosticsDetails,
  hasMemberLaunchDiagnosticsError,
  normalizeMemberLaunchFailureReason,
} from '@renderer/utils/memberLaunchDiagnostics';
import { getRuntimeMemorySourceLabel } from '@renderer/utils/memberRuntimeSummary';
import { isLeadMember } from '@shared/utils/leadDetection';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import {
  hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext,
  isBootstrapConfirmedProvisionedButNotAliveFailure,
} from '@shared/utils/teamLaunchFailureReason';
import {
  Activity,
  AlertTriangle,
  Ban,
  Check,
  Clock3,
  Cpu,
  GitBranch,
  HardDrive,
  Info,
  Layers3,
  MessageSquare,
  Plus,
  RotateCcw,
  Server,
  Undo2,
} from 'lucide-react';

import { CurrentTaskIndicator } from './CurrentTaskIndicator';
import { MemberLaunchDiagnosticsButton } from './MemberLaunchDiagnosticsButton';
import { MemberPresenceDot } from './MemberPresenceDot';

import type { PendingMemberDeliveryState } from '../messages/messagesPanelLogic';
import type { MemberActivityTimerAnchor } from '@renderer/utils/memberActivityTimer';
import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type {
  LeadActivityState,
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeResourceSample,
  TeamTaskWithKanban,
} from '@shared/types';

export interface RuntimeTelemetryScale {
  memoryCapBytes?: number;
  cpuCapPercent?: number;
}

interface MemberCardProps {
  teamName?: string;
  member: ResolvedTeamMember;
  memberColor: string;
  avatarUrl?: string;
  fullBleedSurface?: boolean;
  runtimeSummary?: string;
  runtimeEntry?: TeamAgentRuntimeEntry;
  runtimeRunId?: string | null;
  taskCounts?: TaskStatusCounts | null;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  currentTask?: TeamTaskWithKanban | null;
  reviewTask?: TeamTaskWithKanban | null;
  currentTaskTimer?: MemberActivityTimerAnchor | null;
  reviewTaskTimer?: MemberActivityTimerAnchor | null;
  currentTaskTimerRunning?: boolean;
  reviewTaskTimerRunning?: boolean;
  isAwaitingReply?: boolean;
  pendingDeliveryState?: PendingMemberDeliveryState;
  isRemoved?: boolean;
  spawnStatus?: MemberSpawnStatus;
  spawnEntry?: MemberSpawnStatusEntry;
  spawnError?: string;
  spawnLivenessSource?: MemberSpawnLivenessSource;
  spawnLaunchState?: MemberLaunchState;
  spawnRuntimeAlive?: boolean;
  isLaunchSettling?: boolean;
  runtimeTelemetryScale?: RuntimeTelemetryScale;
  renderRuntimeTelemetryStrip?: boolean;
  onOpenTask?: () => void;
  onOpenReviewTask?: () => void;
  onClick?: () => void;
  onSendMessage?: () => void;
  onAssignTask?: () => void;
  onRestartMember?: (memberName: string) => Promise<void> | void;
  onSkipMemberForLaunch?: (memberName: string) => Promise<void> | void;
  onRestoreMember?: (memberName: string) => Promise<void> | void;
}

const MEMBER_ROW_SURFACE_BLEED_CLASS = '-mx-[calc(1rem-5px)] px-[calc(1rem-5px)]';
const RUNTIME_TELEMETRY_TOOLTIP_DELAY_MS = 1000;
const RUNTIME_TELEMETRY_TOOLTIP_OPEN_EVENT = 'member-runtime-telemetry-tooltip-open';

let runtimeTelemetryTooltipIdSequence = 0;

function createRuntimeTelemetryTooltipId(): string {
  runtimeTelemetryTooltipIdSequence += 1;
  return `runtime-telemetry-tooltip-${runtimeTelemetryTooltipIdSequence}`;
}

function notifyRuntimeTelemetryTooltipOpen(id: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<{ id: string }>(RUNTIME_TELEMETRY_TOOLTIP_OPEN_EVENT, {
      detail: { id },
    })
  );
}

function isRuntimeTelemetryTooltipBlockedTarget(
  currentTarget: EventTarget,
  target: EventTarget | null
): boolean {
  if (!(currentTarget instanceof Element) || !(target instanceof Element)) {
    return false;
  }
  const blockedTarget = target.closest('button,a,[title],[data-runtime-telemetry-exempt="true"]');
  return Boolean(blockedTarget && blockedTarget !== currentTarget);
}

function splitRuntimeSummaryMemory(runtimeSummary: string | undefined): {
  summary: string | undefined;
  memory: string | undefined;
} {
  const trimmed = runtimeSummary?.trim();
  if (!trimmed) {
    return { summary: undefined, memory: undefined };
  }

  const match = /^(.*?)(?:\s·\s(\d+(?:\.\d+)?\s(?:B|KB|MB|GB|TB)))$/.exec(trimmed);
  if (!match) {
    return { summary: trimmed, memory: undefined };
  }

  return {
    summary: match[1]?.trim() || undefined,
    memory: match[2]?.trim() || undefined,
  };
}

function getLaunchFailureLinkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'openrouter.ai' && parsed.pathname === '/settings/credits') {
      return 'OpenRouter credits';
    }
  } catch {
    return url;
  }
  return url;
}

const RUNTIME_TELEMETRY_SAMPLE_LIMIT = 48;
const RUNTIME_TELEMETRY_WIDTH = 100;
const RUNTIME_TELEMETRY_HEIGHT = 18;
const RUNTIME_TELEMETRY_BASELINE_Y = 16.5;

interface TelemetryPoint {
  x: number;
  y: number;
}

interface RuntimeTelemetryPaths {
  memoryAreaPath?: string;
  memoryLinePath?: string;
  cpuLinePath?: string;
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function formatTelemetryCoordinate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function buildLinePath(points: readonly TelemetryPoint[]): string | undefined {
  if (points.length < 2) {
    return undefined;
  }
  return points
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L';
      return `${command}${formatTelemetryCoordinate(point.x)} ${formatTelemetryCoordinate(point.y)}`;
    })
    .join(' ');
}

function buildAreaPath(points: readonly TelemetryPoint[]): string | undefined {
  if (points.length < 2) {
    return undefined;
  }
  const first = points[0];
  const last = points[points.length - 1];
  return [
    `M${formatTelemetryCoordinate(first.x)} ${formatTelemetryCoordinate(RUNTIME_TELEMETRY_BASELINE_Y)}`,
    `L${formatTelemetryCoordinate(first.x)} ${formatTelemetryCoordinate(first.y)}`,
    ...points
      .slice(1)
      .map(
        (point) => `L${formatTelemetryCoordinate(point.x)} ${formatTelemetryCoordinate(point.y)}`
      ),
    `L${formatTelemetryCoordinate(last.x)} ${formatTelemetryCoordinate(RUNTIME_TELEMETRY_BASELINE_Y)}`,
    'Z',
  ].join(' ');
}

function getRelativeTelemetryY(
  value: number,
  values: readonly number[],
  options: {
    bottomY: number;
    amplitude: number;
    fallbackRatio: number;
    minimumSpan?: number;
  }
): number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  if (span <= 0) {
    return options.bottomY - options.fallbackRatio * options.amplitude;
  }

  const effectiveSpan = Math.max(span, options.minimumSpan ?? 0);
  const ratio = Math.max(0, Math.min(1, (value - min) / effectiveSpan));
  return options.bottomY - ratio * options.amplitude;
}

function getCappedTelemetryY(
  value: number,
  cap: number | undefined,
  options: {
    bottomY: number;
    amplitude: number;
    curve?: 'linear' | 'sqrt';
  }
): number | undefined {
  if (!isFiniteNonNegative(cap) || cap <= 0) {
    return undefined;
  }
  const rawRatio = Math.max(0, Math.min(1, value / cap));
  const ratio = options.curve === 'sqrt' ? Math.sqrt(rawRatio) : rawRatio;
  return options.bottomY - ratio * options.amplitude;
}

function formatRuntimeTelemetryPercent(value: number | undefined): string | undefined {
  if (!isFiniteNonNegative(value)) {
    return undefined;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
}

function formatRuntimeTelemetryBytes(value: number | undefined): string | undefined {
  if (!isFiniteNonNegative(value)) {
    return undefined;
  }
  const mib = value / (1024 * 1024);
  if (mib < 1024) {
    return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
  }
  return `${(mib / 1024).toFixed(1)} GB`;
}

function isRuntimeTelemetrySampleLike(value: unknown): value is TeamAgentRuntimeResourceSample {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const sample = value as Partial<TeamAgentRuntimeResourceSample>;
  return (
    typeof sample.timestamp === 'string' ||
    isFiniteNonNegative(sample.cpuPercent) ||
    isFiniteNonNegative(sample.rssBytes)
  );
}

function normalizeRuntimeTelemetrySamples(history: unknown): TeamAgentRuntimeResourceSample[] {
  return (Array.isArray(history) ? history : []).filter(isRuntimeTelemetrySampleLike);
}

function hasRuntimeTelemetrySamples(history: unknown): boolean {
  return Array.isArray(history) && history.some(isRuntimeTelemetrySampleLike);
}

const RuntimeTelemetryTooltipContent = ({
  runtimeEntry,
}: Readonly<{
  runtimeEntry: TeamAgentRuntimeEntry | undefined;
}>): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  if (!runtimeEntry) {
    return null;
  }

  const aggregateCpuLabel = formatRuntimeTelemetryPercent(runtimeEntry.cpuPercent);
  const primaryCpuLabel = formatRuntimeTelemetryPercent(runtimeEntry.primaryCpuPercent);
  const childCpuLabel = formatRuntimeTelemetryPercent(runtimeEntry.childCpuPercent);
  const rssLabel = formatRuntimeTelemetryBytes(runtimeEntry.rssBytes);
  const detailParts = [
    runtimeEntry.pid ? `root PID ${runtimeEntry.pid}` : undefined,
    runtimeEntry.processCount ? `${runtimeEntry.processCount} processes` : undefined,
    runtimeEntry.runtimeLoadScope ? `scope ${runtimeEntry.runtimeLoadScope}` : undefined,
    'sample 5s',
  ].filter((part): part is string => Boolean(part));
  const cpuSplit = [
    primaryCpuLabel ? `root ${primaryCpuLabel}` : undefined,
    childCpuLabel ? `children ${childCpuLabel}` : undefined,
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="w-[320px] max-w-[min(320px,var(--radix-tooltip-content-available-width))] space-y-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-300">
          <Activity className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold leading-tight text-[var(--color-text)]">
            {t('members.runtimeTelemetry.title')}
          </div>
          <div className="mt-0.5 text-[10px] leading-snug text-[var(--color-text-muted)]">
            {t('members.runtimeTelemetry.description')}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-blue-200/80">
            <Cpu className="size-3" />
            {t('members.runtimeTelemetry.cpu')}
          </div>
          <div className="mt-1 text-[14px] font-semibold text-blue-100">
            {aggregateCpuLabel ?? 'unknown'}
          </div>
          {cpuSplit.length > 0 ? (
            <div className="mt-0.5 text-[10px] leading-snug text-blue-100/65">
              {cpuSplit.join(' · ')}
            </div>
          ) : null}
        </div>

        <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-emerald-200/80">
            <HardDrive className="size-3" />
            {t('members.runtimeTelemetry.memory')}
          </div>
          <div className="mt-1 text-[14px] font-semibold text-emerald-100">
            {rssLabel ?? 'unknown'}
          </div>
          <div className="mt-0.5 text-[10px] leading-snug text-emerald-100/65">
            {t('members.runtimeTelemetry.summedRss')}
          </div>
        </div>
      </div>

      {detailParts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {detailParts.map((part) => (
            <span
              key={part}
              className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--color-text-muted)]"
            >
              <Layers3 className="size-2.5" />
              {part}
            </span>
          ))}
        </div>
      ) : null}

      {runtimeEntry.runtimeLoadScope === 'shared-host' ? (
        <div className="flex gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-100/80">
          <Server className="mt-0.5 size-3 shrink-0" />
          {t('members.runtimeTelemetry.sharedHost')}
        </div>
      ) : null}

      {runtimeEntry.runtimeLoadTruncated ? (
        <div className="flex gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-100/80">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {t('members.runtimeTelemetry.processTreeCapped')}
        </div>
      ) : null}

      <div className="flex gap-1.5 border-t border-[var(--color-border)] pt-2 text-[10px] leading-snug text-[var(--color-text-muted)]">
        <Info className="mt-0.5 size-3 shrink-0" />
        {t('members.runtimeTelemetry.rssHint')}
      </div>
    </div>
  );
};

function buildTelemetryPoints(
  samples: readonly TeamAgentRuntimeResourceSample[],
  getValue: (sample: TeamAgentRuntimeResourceSample) => number | undefined,
  getY: (value: number, values: readonly number[]) => number
): TelemetryPoint[] {
  const values = samples.map(getValue).filter(isFiniteNonNegative);
  if (values.length < 2 || samples.length < 2) {
    return [];
  }
  return samples.flatMap((sample, index) => {
    const value = getValue(sample);
    if (!isFiniteNonNegative(value)) {
      return [];
    }
    return [
      {
        x: (index / (samples.length - 1)) * RUNTIME_TELEMETRY_WIDTH,
        y: getY(value, values),
      },
    ];
  });
}

function buildRuntimeTelemetryPaths(
  history: readonly TeamAgentRuntimeResourceSample[] | undefined,
  scale?: RuntimeTelemetryScale
): RuntimeTelemetryPaths | undefined {
  const samples = normalizeRuntimeTelemetrySamples(history).slice(-RUNTIME_TELEMETRY_SAMPLE_LIMIT);
  if (samples.length < 2) {
    return undefined;
  }

  const memoryPoints = buildTelemetryPoints(
    samples,
    (sample) => sample.rssBytes,
    (value, values) => {
      const cappedY = getCappedTelemetryY(value, scale?.memoryCapBytes, {
        bottomY: 15.25,
        amplitude: 4.4,
      });
      return (
        cappedY ??
        getRelativeTelemetryY(value, values, {
          bottomY: 15.25,
          amplitude: 4.4,
          fallbackRatio: 0.32,
        })
      );
    }
  );
  const cpuPoints = buildTelemetryPoints(
    samples,
    (sample) => sample.cpuPercent,
    (value, values) => {
      const cappedY = getCappedTelemetryY(value, scale?.cpuCapPercent, {
        bottomY: 16.1,
        amplitude: 5.2,
        curve: 'sqrt',
      });
      return (
        cappedY ??
        getRelativeTelemetryY(value, values, {
          bottomY: 16.1,
          amplitude: 5.2,
          fallbackRatio: 0,
          minimumSpan: 0.5,
        })
      );
    }
  );

  const memoryAreaPath = buildAreaPath(memoryPoints);
  const memoryLinePath = buildLinePath(memoryPoints);
  const cpuLinePath = buildLinePath(cpuPoints);
  if (!memoryAreaPath && !cpuLinePath) {
    return undefined;
  }
  return {
    memoryAreaPath,
    memoryLinePath,
    cpuLinePath,
  };
}

const MemberRuntimeTelemetryStrip = memo(function MemberRuntimeTelemetryStrip({
  runtimeEntry,
  scale,
}: {
  runtimeEntry?: TeamAgentRuntimeEntry;
  scale?: RuntimeTelemetryScale;
}): React.JSX.Element | null {
  const paths = useMemo(
    () => buildRuntimeTelemetryPaths(runtimeEntry?.resourceHistory, scale),
    [runtimeEntry?.resourceHistory, scale]
  );
  if (!paths) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      data-testid="member-runtime-telemetry-strip"
      className="runtime-telemetry-strip pointer-events-none absolute inset-x-0 bottom-0 z-0 h-5 overflow-hidden rounded-b opacity-0 transition-opacity duration-150"
      style={{
        WebkitMaskImage:
          'linear-gradient(to right, transparent 0, black 44px, black calc(100% - 44px), transparent 100%)',
        maskImage:
          'linear-gradient(to right, transparent 0, black 44px, black calc(100% - 44px), transparent 100%)',
      }}
    >
      <svg
        className="size-full"
        viewBox={`0 0 ${RUNTIME_TELEMETRY_WIDTH} ${RUNTIME_TELEMETRY_HEIGHT}`}
        preserveAspectRatio="none"
      >
        {paths.memoryAreaPath ? (
          <path d={paths.memoryAreaPath} fill="#22c55e" opacity="0.14" />
        ) : null}
        {paths.memoryLinePath ? (
          <path
            d={paths.memoryLinePath}
            fill="none"
            stroke="#4ade80"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="0.55"
            opacity="0.45"
          />
        ) : null}
        {paths.cpuLinePath ? (
          <path
            d={paths.cpuLinePath}
            fill="none"
            stroke="#3b82f6"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="0.62"
            opacity="0.62"
          />
        ) : null}
      </svg>
      <div
        className="absolute inset-x-0 bottom-0 h-1.5"
        style={{
          background:
            'linear-gradient(to top, color-mix(in srgb, var(--color-surface) 35%, transparent), transparent)',
        }}
      />
      <div className="absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-[var(--color-surface)] to-transparent opacity-80 blur-[1px]" />
      <div className="absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[var(--color-surface)] to-transparent opacity-80 blur-[1px]" />
    </div>
  );
});

interface MemberActionButtonProps {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
}

const MemberActionButton = memo(function MemberActionButton({
  label,
  children,
  onClick,
}: MemberActionButtonProps): React.JSX.Element {
  const [tooltipOpen, setTooltipOpen] = useState(false);

  return (
    <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          onClick={(e) => {
            e.stopPropagation();
            onClick?.();
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      {tooltipOpen ? <TooltipContent side="bottom">{label}</TooltipContent> : null}
    </Tooltip>
  );
});

interface MemberQuickActionsProps {
  onSendMessage?: () => void;
  onAssignTask?: () => void;
}

const MemberQuickActions = memo(function MemberQuickActions({
  onSendMessage,
  onAssignTask,
}: MemberQuickActionsProps): React.JSX.Element {
  const { t } = useAppTranslation('team');

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <MemberActionButton label={t('members.actions.sendMessage')} onClick={onSendMessage}>
        <MessageSquare size={13} />
      </MemberActionButton>
      <MemberActionButton label={t('members.actions.assignTask')} onClick={onAssignTask}>
        <Plus size={13} />
      </MemberActionButton>
    </div>
  );
});

interface MemberTaskProgressBadgeProps {
  showStartingSkeleton: boolean;
  memberTaskCount: number;
  completed: number;
  totalTasks: number;
  progressPercent: number;
}

const MemberTaskProgressBadge = memo(function MemberTaskProgressBadge({
  showStartingSkeleton,
  memberTaskCount,
  completed,
  totalTasks,
  progressPercent,
}: MemberTaskProgressBadgeProps): React.JSX.Element {
  if (showStartingSkeleton) {
    return (
      <div className="shrink-0" aria-hidden="true">
        <div
          className="skeleton-shimmer h-[18px] w-[62px] rounded-full border"
          style={{
            backgroundColor: 'var(--skeleton-base-dim)',
            borderColor: 'var(--color-border)',
          }}
        />
        <div
          className="skeleton-shimmer mx-1 mt-1 h-[2px] w-10 rounded-full"
          style={{ backgroundColor: 'var(--skeleton-base)' }}
        />
      </div>
    );
  }

  return (
    <div
      className="shrink-0"
      title={totalTasks > 0 ? `${completed}/${totalTasks} completed` : undefined}
    >
      <Badge
        variant="secondary"
        className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none"
      >
        {memberTaskCount} {memberTaskCount === 1 ? 'task' : 'tasks'}
      </Badge>
      {totalTasks > 0 && (
        <div className="mx-0.5 mt-0.5 h-[2px] rounded-full bg-[var(--color-border)]">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}
      {/* NOTE: lead context bar disabled - usage formula is inaccurate */}
    </div>
  );
});

export const MemberCard = memo(function MemberCard({
  teamName,
  member,
  memberColor,
  avatarUrl,
  fullBleedSurface = true,
  runtimeSummary,
  runtimeEntry,
  runtimeRunId,
  renderRuntimeTelemetryStrip = true,
  taskCounts,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  currentTask,
  reviewTask,
  currentTaskTimer,
  reviewTaskTimer,
  currentTaskTimerRunning = isTeamAlive !== false,
  reviewTaskTimerRunning = isTeamAlive !== false,
  isAwaitingReply,
  pendingDeliveryState,
  isRemoved,
  spawnStatus,
  spawnEntry,
  spawnError,
  spawnLivenessSource,
  spawnLaunchState,
  spawnRuntimeAlive,
  isLaunchSettling,
  runtimeTelemetryScale,
  onOpenTask,
  onOpenReviewTask,
  onClick,
  onSendMessage,
  onAssignTask,
  onRestartMember,
  onSkipMemberForLaunch,
  onRestoreMember,
}: MemberCardProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  // NOTE: lead context display disabled — usage formula is inaccurate
  // const teamName = useStore((s) => s.selectedTeamName);
  // const leadContext = useStore((s) =>
  //   member.agentType === 'team-lead' && teamName ? s.leadContextByTeam[teamName] : undefined
  // );
  const [retryingLaunch, setRetryingLaunch] = useState(false);
  const [retryLaunchError, setRetryLaunchError] = useState<string | null>(null);
  const [skippingLaunch, setSkippingLaunch] = useState(false);
  const [skipLaunchError, setSkipLaunchError] = useState<string | null>(null);
  const [restoringMember, setRestoringMember] = useState(false);
  const [restoreMemberError, setRestoreMemberError] = useState<string | null>(null);
  const bootstrapConfirmedProvisionedButNotAlive =
    isBootstrapConfirmedProvisionedButNotAliveFailure(spawnEntry);
  const hasUnsafeBootstrapConfirmedProvisionedButNotAlive =
    bootstrapConfirmedProvisionedButNotAlive &&
    hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(spawnEntry, runtimeEntry);
  const effectiveSpawnStatus = spawnStatus;
  const effectiveSpawnLaunchState = spawnLaunchState;
  const showTaskActivity = shouldDisplayMemberCurrentTask({
    member,
    isTeamAlive,
    spawnStatus: effectiveSpawnStatus,
    spawnLaunchState: effectiveSpawnLaunchState,
    spawnRuntimeAlive,
    spawnEntry,
    runtimeEntry,
  });
  const visibleCurrentTask = showTaskActivity ? currentTask : null;
  const visibleReviewTask = showTaskActivity ? reviewTask : null;
  const presentationMember =
    member.currentTaskId && !visibleCurrentTask
      ? {
          ...member,
          currentTaskId: null,
        }
      : member;
  const launchPresentation = buildMemberLaunchPresentation({
    member: presentationMember,
    spawnStatus: effectiveSpawnStatus,
    spawnLaunchState: effectiveSpawnLaunchState,
    spawnLivenessSource,
    spawnRuntimeAlive,
    spawnBootstrapConfirmed: spawnEntry?.bootstrapConfirmed,
    spawnBootstrapStalled: spawnEntry?.bootstrapStalled,
    spawnAgentToolAccepted: spawnEntry?.agentToolAccepted,
    spawnHardFailure: spawnEntry?.hardFailure,
    spawnHardFailureReason: spawnEntry?.hardFailureReason,
    spawnError: spawnEntry?.error,
    spawnRuntimeDiagnostic: spawnEntry?.runtimeDiagnostic,
    spawnLivenessKind: spawnEntry?.livenessKind,
    spawnRuntimeDiagnosticSeverity: spawnEntry?.runtimeDiagnosticSeverity,
    spawnFirstSpawnAcceptedAt: spawnEntry?.firstSpawnAcceptedAt,
    spawnUpdatedAt: spawnEntry?.updatedAt,
    runtimeEntry,
    runtimeAdvisory: member.runtimeAdvisory,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity,
  });
  const dotClass = launchPresentation.dotClass;
  const runtimeAdvisoryLabel = launchPresentation.runtimeAdvisoryLabel;
  const runtimeAdvisoryTitle = launchPresentation.runtimeAdvisoryTitle;
  const runtimeAdvisoryTone = launchPresentation.runtimeAdvisoryTone;
  const effectiveDeliveryState =
    pendingDeliveryState ?? (isAwaitingReply ? ('delivering' as const) : undefined);
  const presenceLabel = launchPresentation.presenceLabel;
  const spawnCardClass = launchPresentation.cardClass;
  const launchVisualState = launchPresentation.launchVisualState;
  const launchStatusLabel = launchPresentation.launchStatusLabel;
  const displayPresenceLabel =
    launchVisualState === 'queued' ||
    launchVisualState === 'starting_stale' ||
    launchVisualState === 'bootstrap_stalled' ||
    launchVisualState === 'runtime_pending' ||
    launchVisualState === 'permission_pending' ||
    launchVisualState === 'shell_only' ||
    launchVisualState === 'runtime_candidate' ||
    launchVisualState === 'registered_only' ||
    launchVisualState === 'stale_runtime'
      ? (launchStatusLabel ?? presenceLabel)
      : presenceLabel;
  const colors = getTeamColorSet(memberColor);
  const { isLight } = useTheme();
  const pending = taskCounts?.pending ?? 0;
  const inProgress = taskCounts?.inProgress ?? 0;
  const completed = taskCounts?.completed ?? 0;
  const totalTasks = pending + inProgress + completed;
  const progressPercent = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;
  const roleLabel = formatAgentRole(member.role) ?? formatAgentRole(member.agentType);
  const { summary: runtimeSummaryText, memory: memoryLabel } =
    splitRuntimeSummaryMemory(runtimeSummary);
  const memorySourceLabel = getRuntimeMemorySourceLabel(runtimeEntry);
  const isLead = isLeadMember(member);
  const workspacePath = member.cwd?.trim();
  const showWorkspaceBadge = !isLead && !isRemoved && member.isolation === 'worktree';
  const workspaceTooltipLines = [
    'Worktree isolation is enabled.',
    workspacePath ? `Path: ${workspacePath}` : 'Path is not available yet.',
    member.gitBranch ? `Branch: ${member.gitBranch}` : null,
  ].filter((line): line is string => Boolean(line));
  const activityTask = visibleCurrentTask ?? visibleReviewTask ?? null;
  const activityTitle = visibleCurrentTask
    ? `Current task: #${deriveTaskDisplayId(visibleCurrentTask.id)}`
    : visibleReviewTask
      ? `Reviewing task: #${deriveTaskDisplayId(visibleReviewTask.id)}`
      : undefined;
  const showRuntimeTelemetryTooltip = useMemo(
    () => hasRuntimeTelemetrySamples(runtimeEntry?.resourceHistory),
    [runtimeEntry?.resourceHistory]
  );
  const rowTitle = showRuntimeTelemetryTooltip ? undefined : activityTitle;
  const runtimeTelemetryTooltipIdRef = useRef<string | null>(null);
  if (runtimeTelemetryTooltipIdRef.current == null) {
    runtimeTelemetryTooltipIdRef.current = createRuntimeTelemetryTooltipId();
  }
  const runtimeTelemetryTooltipId = runtimeTelemetryTooltipIdRef.current;
  const runtimeTelemetryPointerBlockedRef = useRef(false);
  const runtimeTelemetryTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [runtimeTelemetryTooltipOpen, setRuntimeTelemetryTooltipOpen] = useState(false);
  const clearRuntimeTelemetryTooltipTimer = useCallback(() => {
    if (runtimeTelemetryTooltipTimerRef.current == null) {
      return;
    }
    clearTimeout(runtimeTelemetryTooltipTimerRef.current);
    runtimeTelemetryTooltipTimerRef.current = null;
  }, []);
  const closeRuntimeTelemetryTooltip = useCallback(() => {
    clearRuntimeTelemetryTooltipTimer();
    setRuntimeTelemetryTooltipOpen(false);
  }, [clearRuntimeTelemetryTooltipTimer]);
  const handleRuntimeTelemetryTooltipOpenChange = useCallback(
    (nextOpen: boolean) => {
      clearRuntimeTelemetryTooltipTimer();
      if (!nextOpen) {
        closeRuntimeTelemetryTooltip();
        return;
      }
      if (runtimeTelemetryPointerBlockedRef.current || runtimeTelemetryTooltipOpen) {
        return;
      }
      runtimeTelemetryTooltipTimerRef.current = setTimeout(() => {
        runtimeTelemetryTooltipTimerRef.current = null;
        notifyRuntimeTelemetryTooltipOpen(runtimeTelemetryTooltipId);
        setRuntimeTelemetryTooltipOpen(true);
      }, RUNTIME_TELEMETRY_TOOLTIP_DELAY_MS);
    },
    [
      clearRuntimeTelemetryTooltipTimer,
      closeRuntimeTelemetryTooltip,
      runtimeTelemetryTooltipId,
      runtimeTelemetryTooltipOpen,
    ]
  );
  useEffect(
    () => () => {
      clearRuntimeTelemetryTooltipTimer();
    },
    [clearRuntimeTelemetryTooltipTimer]
  );
  useEffect(() => {
    if (!showRuntimeTelemetryTooltip) {
      closeRuntimeTelemetryTooltip();
    }
  }, [closeRuntimeTelemetryTooltip, showRuntimeTelemetryTooltip]);
  useEffect(() => {
    if (!showRuntimeTelemetryTooltip || typeof window === 'undefined') {
      return;
    }

    const closeWhenAnotherRuntimeTooltipOpens = (event: Event): void => {
      const nextId = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (nextId && nextId !== runtimeTelemetryTooltipId) {
        closeRuntimeTelemetryTooltip();
      }
    };

    window.addEventListener(
      RUNTIME_TELEMETRY_TOOLTIP_OPEN_EVENT,
      closeWhenAnotherRuntimeTooltipOpens
    );
    return () => {
      window.removeEventListener(
        RUNTIME_TELEMETRY_TOOLTIP_OPEN_EVENT,
        closeWhenAnotherRuntimeTooltipOpens
      );
    };
  }, [closeRuntimeTelemetryTooltip, runtimeTelemetryTooltipId, showRuntimeTelemetryTooltip]);
  const handleRuntimeTelemetryPointerLeave = useCallback(() => {
    runtimeTelemetryPointerBlockedRef.current = false;
    if (showRuntimeTelemetryTooltip) {
      closeRuntimeTelemetryTooltip();
    }
  }, [closeRuntimeTelemetryTooltip, showRuntimeTelemetryTooltip]);
  const handleRuntimeTelemetryPointerBlockCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!showRuntimeTelemetryTooltip) {
        return;
      }
      const blocked = isRuntimeTelemetryTooltipBlockedTarget(event.currentTarget, event.target);
      runtimeTelemetryPointerBlockedRef.current = blocked;
      if (blocked) {
        closeRuntimeTelemetryTooltip();
      }
    },
    [closeRuntimeTelemetryTooltip, showRuntimeTelemetryTooltip]
  );
  const showStartingSkeleton =
    !isRemoved &&
    presenceLabel === 'starting' &&
    effectiveSpawnLaunchState !== 'failed_to_start' &&
    !activityTask &&
    !runtimeSummary;
  const usesLaunchSkeletonSurface = spawnCardClass.includes('member-waiting-shimmer');
  const rowSurfaceBleedClass = fullBleedSurface ? MEMBER_ROW_SURFACE_BLEED_CLASS : undefined;
  const showLaunchBadge =
    !isRemoved &&
    !runtimeAdvisoryLabel &&
    (presenceLabel === 'starting' ||
      presenceLabel === 'connecting' ||
      launchVisualState === 'queued' ||
      launchVisualState === 'starting_stale' ||
      launchVisualState === 'runtime_pending' ||
      launchVisualState === 'shell_only' ||
      launchVisualState === 'runtime_candidate' ||
      launchVisualState === 'registered_only' ||
      launchVisualState === 'stale_runtime');
  const launchBadgeLabel = presenceLabel === 'starting' ? presenceLabel : displayPresenceLabel;
  const launchDiagnosticsPayload = useMemo(
    () =>
      buildMemberLaunchDiagnosticsPayload({
        teamName,
        runId: runtimeRunId,
        memberName: member.name,
        member,
        spawnStatus: effectiveSpawnStatus,
        launchState: effectiveSpawnLaunchState,
        livenessSource: spawnLivenessSource,
        spawnEntry,
        runtimeEntry,
        runtimeAdvisory: member.runtimeAdvisory,
        runtimeAdvisoryLabel,
        runtimeAdvisoryTitle,
      }),
    [
      member,
      runtimeEntry,
      runtimeAdvisoryLabel,
      runtimeAdvisoryTitle,
      runtimeRunId,
      teamName,
      spawnEntry,
      effectiveSpawnLaunchState,
      spawnLivenessSource,
      effectiveSpawnStatus,
    ]
  );
  const showCopyDiagnostics =
    !isRemoved &&
    hasMemberLaunchDiagnosticsError(launchDiagnosticsPayload) &&
    hasMemberLaunchDiagnosticsDetails(launchDiagnosticsPayload);
  const showRuntimeAdvisoryDiagnostics =
    !isRemoved &&
    Boolean(runtimeAdvisoryLabel) &&
    runtimeAdvisoryTone === 'error' &&
    hasMemberLaunchDiagnosticsDetails(launchDiagnosticsPayload);
  const isFailedLaunch =
    (!bootstrapConfirmedProvisionedButNotAlive ||
      hasUnsafeBootstrapConfirmedProvisionedButNotAlive) &&
    (spawnStatus === 'error' || spawnLaunchState === 'failed_to_start');
  const isSkippedLaunch =
    spawnStatus === 'skipped' ||
    spawnLaunchState === 'skipped_for_launch' ||
    spawnEntry?.skippedForLaunch === true;
  const showFailedLaunchBadge = !isRemoved && isFailedLaunch;
  const showSkippedLaunchBadge = !isRemoved && isSkippedLaunch;
  const rawLaunchFailureReason =
    spawnError ??
    spawnEntry?.hardFailureReason ??
    spawnEntry?.runtimeDiagnostic ??
    spawnEntry?.error;
  const launchFailureReason = showFailedLaunchBadge
    ? normalizeMemberLaunchFailureReason(rawLaunchFailureReason)
    : null;
  const hasLiveLaunchControls =
    isTeamAlive === true || isTeamProvisioning === true || isLaunchSettling === true;
  const hasRestartMemberControl =
    !isRemoved &&
    !isLeadMember(member) &&
    Boolean(onRestartMember) &&
    hasLiveLaunchControls &&
    runtimeEntry?.restartable !== false;
  const openCodeRelaunchActionable = isOpenCodeRelaunchActionable({
    member,
    spawnEntry,
    runtimeEntry,
  });
  const canRelaunchOpenCode = hasRestartMemberControl && openCodeRelaunchActionable;
  const canRetryLaunch =
    (showFailedLaunchBadge || showSkippedLaunchBadge) && hasRestartMemberControl;
  const canSkipFailedLaunch =
    showFailedLaunchBadge &&
    !isLeadMember(member) &&
    Boolean(onSkipMemberForLaunch) &&
    hasLiveLaunchControls;
  const showRuntimeAdvisoryBadge =
    !isRemoved &&
    Boolean(runtimeAdvisoryLabel) &&
    !showLaunchBadge &&
    !isFailedLaunch &&
    !isSkippedLaunch &&
    (Boolean(activityTask) || !effectiveDeliveryState);
  const canRelaunchRuntimeAdvisoryOpenCode =
    Boolean(runtimeAdvisoryLabel) &&
    effectiveDeliveryState !== 'queued' &&
    effectiveDeliveryState !== 'delivered' &&
    runtimeAdvisoryTone === 'error' &&
    member.providerId === 'opencode' &&
    hasRestartMemberControl &&
    !showLaunchBadge &&
    !isFailedLaunch &&
    !isSkippedLaunch;
  const restartActionIdleLabel =
    canRelaunchOpenCode || canRelaunchRuntimeAdvisoryOpenCode
      ? 'Relaunch OpenCode'
      : 'Retry teammate';
  const restartActionBusyLabel =
    canRelaunchOpenCode || canRelaunchRuntimeAdvisoryOpenCode
      ? 'Relaunching OpenCode teammate'
      : 'Retrying teammate';
  const restartActionErrorFallback =
    canRelaunchOpenCode || canRelaunchRuntimeAdvisoryOpenCode
      ? 'Failed to relaunch OpenCode teammate'
      : 'Failed to retry teammate';
  const canRestoreMember = isRemoved && !isLeadMember(member) && Boolean(onRestoreMember);
  const handleRestartMember = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!onRestartMember || retryingLaunch) {
      return;
    }
    setRetryLaunchError(null);
    setRetryingLaunch(true);
    try {
      await onRestartMember(member.name);
    } catch (error) {
      setRetryLaunchError(error instanceof Error ? error.message : restartActionErrorFallback);
    } finally {
      setRetryingLaunch(false);
    }
  };
  const handleSkipFailedLaunch = async (
    event: React.MouseEvent<HTMLButtonElement>
  ): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!onSkipMemberForLaunch || skippingLaunch) {
      return;
    }
    setSkipLaunchError(null);
    setSkippingLaunch(true);
    try {
      await onSkipMemberForLaunch(member.name);
    } catch (error) {
      setSkipLaunchError(error instanceof Error ? error.message : 'Failed to skip teammate');
    } finally {
      setSkippingLaunch(false);
    }
  };
  const handleRestoreMember = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!onRestoreMember || restoringMember) {
      return;
    }
    setRestoreMemberError(null);
    setRestoringMember(true);
    try {
      await onRestoreMember(member.name);
    } catch (error) {
      setRestoreMemberError(error instanceof Error ? error.message : 'Failed to restore teammate');
    } finally {
      setRestoringMember(false);
    }
  };

  const cardContent = (
    <div
      className={cn(
        'rounded transition-opacity duration-300',
        usesLaunchSkeletonSurface && rowSurfaceBleedClass,
        isRemoved && 'opacity-50',
        spawnCardClass
      )}
      onPointerOverCapture={handleRuntimeTelemetryPointerBlockCapture}
      onPointerMoveCapture={handleRuntimeTelemetryPointerBlockCapture}
      onPointerLeave={handleRuntimeTelemetryPointerLeave}
    >
      <div
        className={cn(
          'group relative cursor-pointer overflow-hidden rounded py-1.5',
          rowSurfaceBleedClass
        )}
        style={undefined}
        title={rowTitle}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.();
          }
        }}
      >
        {!isRemoved && renderRuntimeTelemetryStrip ? (
          <MemberRuntimeTelemetryStrip runtimeEntry={runtimeEntry} scale={runtimeTelemetryScale} />
        ) : null}
        <div className="pointer-events-none absolute inset-0 z-10 rounded transition-colors group-hover:bg-white/5" />
        <div className="relative z-20 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1">
          <div className="relative shrink-0">
            <div
              className="rounded-full border-2 p-px"
              style={{
                borderColor: colors.border,
                boxShadow: isLight ? 'none' : `0 0 0 1px ${colors.badge}`,
              }}
            >
              <img
                src={avatarUrl ?? agentAvatarUrl(member.name)}
                alt={member.name}
                className="size-7 rounded-full bg-[var(--color-surface-raised)]"
                loading="lazy"
              />
            </div>
            <MemberPresenceDot className={`size-2.5 ${dotClass}`} label={displayPresenceLabel} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-sm">
              <span className="shrink-0 font-medium text-[var(--color-text)]">
                {displayMemberName(member.name)}
              </span>
              {member.gitBranch && !showWorkspaceBadge ? (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-[var(--color-text-muted)]">
                  <GitBranch size={10} />
                  {member.gitBranch}
                </span>
              ) : null}
              {showWorkspaceBadge ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="shrink-0 rounded border border-emerald-400/35 bg-emerald-400/10 px-1 py-0.5 text-[9px] font-semibold uppercase leading-none text-emerald-300"
                      data-runtime-telemetry-exempt="true"
                    >
                      {t('members.badges.worktree')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-sm text-xs leading-relaxed">
                    <div className="space-y-1">
                      {workspaceTooltipLines.map((line) => (
                        <p key={line} className="break-words">
                          {line}
                        </p>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {visibleCurrentTask ? (
                <CurrentTaskIndicator
                  task={visibleCurrentTask}
                  borderColor={colors.border}
                  activityLabel="working on"
                  activityTimer={currentTaskTimer}
                  isTimerRunning={currentTaskTimerRunning}
                  onOpenTask={onOpenTask}
                />
              ) : null}
              {visibleReviewTask ? (
                <CurrentTaskIndicator
                  task={visibleReviewTask}
                  borderColor={colors.border}
                  activityLabel={reviewTaskTimer ? 'reviewing' : 'review requested'}
                  activityTimer={reviewTaskTimer}
                  isTimerRunning={reviewTaskTimerRunning}
                  onOpenTask={onOpenReviewTask}
                />
              ) : null}
              {!activityTask && effectiveDeliveryState ? (
                <>
                  {effectiveDeliveryState === 'queued' ? (
                    <Clock3 className="size-3 shrink-0 text-amber-400" />
                  ) : effectiveDeliveryState === 'delivered' ? (
                    <Check className="size-3 shrink-0 text-emerald-400" />
                  ) : runtimeAdvisoryTone === 'error' ? (
                    <AlertTriangle className="size-3 shrink-0 text-red-400" />
                  ) : (
                    <SyncedLoader2
                      className={`size-3 shrink-0 ${runtimeAdvisoryLabel ? 'text-amber-400' : ''}`}
                      style={runtimeAdvisoryLabel ? undefined : { color: colors.border }}
                    />
                  )}
                  <span
                    className={`shrink-0 text-[10px] ${
                      effectiveDeliveryState === 'queued'
                        ? 'text-amber-300'
                        : effectiveDeliveryState === 'delivered'
                          ? 'text-emerald-300'
                          : runtimeAdvisoryTone === 'error'
                            ? 'text-red-300'
                            : runtimeAdvisoryLabel
                              ? 'text-amber-300'
                              : 'text-[var(--color-text-muted)]'
                    }`}
                    title={
                      effectiveDeliveryState === 'queued'
                        ? 'Queued - will be delivered after the team starts'
                        : effectiveDeliveryState === 'delivered'
                          ? 'The member runtime has read this message'
                          : (runtimeAdvisoryTitle ??
                            'Team is online - waiting for the member runtime to read this message')
                    }
                  >
                    {effectiveDeliveryState === 'queued'
                      ? 'Queued'
                      : effectiveDeliveryState === 'delivered'
                        ? 'Delivered'
                        : (runtimeAdvisoryLabel ?? 'Delivering')}
                  </span>
                  {canRelaunchRuntimeAdvisoryOpenCode ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={
                            retryingLaunch ? restartActionBusyLabel : restartActionIdleLabel
                          }
                          className="rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={retryingLaunch}
                          onClick={handleRestartMember}
                        >
                          {retryingLaunch ? (
                            <SyncedLoader2 className="size-3.5" />
                          ) : (
                            <RotateCcw className="size-3.5" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {retryLaunchError ??
                          (retryingLaunch
                            ? `${restartActionBusyLabel}...`
                            : restartActionIdleLabel)}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {showRuntimeAdvisoryDiagnostics ? (
                    <MemberLaunchDiagnosticsButton
                      payload={launchDiagnosticsPayload}
                      className="size-auto rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
                      attention
                    />
                  ) : null}
                </>
              ) : null}
            </div>
            {showStartingSkeleton ? (
              <div className="mt-1 flex items-center gap-1.5" aria-hidden="true">
                <div
                  className="skeleton-shimmer h-2 w-24 rounded-sm"
                  style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
                />
                <div
                  className="skeleton-shimmer h-2 w-16 rounded-sm"
                  style={{ backgroundColor: 'var(--skeleton-base)' }}
                />
              </div>
            ) : runtimeSummaryText || roleLabel || memoryLabel ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                {runtimeSummaryText ? (
                  <span className="min-w-0 truncate">{runtimeSummaryText}</span>
                ) : null}
                {runtimeSummaryText && roleLabel ? (
                  <span className="shrink-0 opacity-60">•</span>
                ) : null}
                {roleLabel ? <span className="shrink-0">{roleLabel}</span> : null}
                {(runtimeSummaryText || roleLabel) && memoryLabel ? (
                  <span className="shrink-0 opacity-60">•</span>
                ) : null}
                {memoryLabel ? (
                  <span className="shrink-0" title={memorySourceLabel}>
                    {memoryLabel}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2.5 justify-self-end">
            {showLaunchBadge ? (
              <span
                className="flex shrink-0 items-center gap-1"
                title={runtimeEntry?.runtimeDiagnostic}
              >
                {launchVisualState === 'starting_stale' ? (
                  <AlertTriangle
                    className="size-3.5 shrink-0 text-amber-400"
                    aria-label={launchBadgeLabel}
                  />
                ) : (
                  <SyncedLoader2
                    className="size-3.5 shrink-0 text-[var(--color-text-muted)]"
                    aria-label={launchBadgeLabel}
                  />
                )}
                <Badge
                  variant="secondary"
                  className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--color-text-muted)]"
                >
                  {launchBadgeLabel}
                </Badge>
                {canRelaunchOpenCode ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={
                          retryingLaunch ? restartActionBusyLabel : restartActionIdleLabel
                        }
                        className="rounded p-1 text-amber-300 transition-colors hover:bg-amber-500/10 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={retryingLaunch}
                        onClick={handleRestartMember}
                      >
                        {retryingLaunch ? (
                          <SyncedLoader2 className="size-3.5" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {retryLaunchError ??
                        (retryingLaunch ? restartActionBusyLabel : restartActionIdleLabel)}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </span>
            ) : showFailedLaunchBadge ? (
              <span className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex shrink-0 items-center gap-1">
                      <AlertTriangle className="size-3.5 shrink-0 text-red-400" />
                      <Badge
                        variant="secondary"
                        className="shrink-0 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-normal leading-none text-red-400"
                      >
                        {displayPresenceLabel}
                      </Badge>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{spawnError ?? 'Spawn failed'}</TooltipContent>
                </Tooltip>
                {showCopyDiagnostics ? (
                  <MemberLaunchDiagnosticsButton
                    payload={launchDiagnosticsPayload}
                    className="size-auto rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
                    attention
                  />
                ) : null}
                {canSkipFailedLaunch ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={skippingLaunch ? 'Skipping teammate' : 'Skip for this launch'}
                        className="rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={skippingLaunch || retryingLaunch}
                        onClick={handleSkipFailedLaunch}
                      >
                        {skippingLaunch ? (
                          <SyncedLoader2 className="size-3.5" />
                        ) : (
                          <Ban className="size-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {skipLaunchError ??
                        (skippingLaunch ? 'Skipping teammate...' : 'Skip for this launch')}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {canRetryLaunch ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={
                          retryingLaunch ? restartActionBusyLabel : restartActionIdleLabel
                        }
                        className="rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={retryingLaunch || skippingLaunch}
                        onClick={handleRestartMember}
                      >
                        {retryingLaunch ? (
                          <SyncedLoader2 className="size-3.5" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {retryLaunchError ??
                        (retryingLaunch ? `${restartActionBusyLabel}...` : restartActionIdleLabel)}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </span>
            ) : showSkippedLaunchBadge ? (
              <span className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex shrink-0 items-center gap-1">
                      <Ban className="size-3.5 shrink-0 text-zinc-400" />
                      <Badge
                        variant="secondary"
                        className="shrink-0 bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-normal leading-none text-zinc-300"
                      >
                        {displayPresenceLabel}
                      </Badge>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {spawnEntry?.skipReason ?? 'Skipped for this launch'}
                  </TooltipContent>
                </Tooltip>
                {canRetryLaunch ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={
                          retryingLaunch ? restartActionBusyLabel : restartActionIdleLabel
                        }
                        className="rounded p-1 text-zinc-300 transition-colors hover:bg-zinc-500/10 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={retryingLaunch}
                        onClick={handleRestartMember}
                      >
                        {retryingLaunch ? (
                          <SyncedLoader2 className="size-3.5" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {retryLaunchError ??
                        (retryingLaunch ? `${restartActionBusyLabel}...` : restartActionIdleLabel)}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </span>
            ) : showRuntimeAdvisoryBadge ? (
              <span className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex shrink-0 items-center gap-1">
                      <AlertTriangle
                        className={`size-3.5 shrink-0 ${
                          runtimeAdvisoryTone === 'error' ? 'text-red-400' : 'text-amber-400'
                        }`}
                      />
                      <Badge
                        variant="secondary"
                        className={`shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none ${
                          runtimeAdvisoryTone === 'error'
                            ? 'bg-red-500/15 text-red-300'
                            : 'bg-amber-500/15 text-amber-300'
                        }`}
                        title={runtimeAdvisoryTitle}
                      >
                        {runtimeAdvisoryLabel}
                      </Badge>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {runtimeAdvisoryTitle ?? runtimeAdvisoryLabel}
                  </TooltipContent>
                </Tooltip>
                {canRelaunchRuntimeAdvisoryOpenCode ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={
                          retryingLaunch ? restartActionBusyLabel : restartActionIdleLabel
                        }
                        className="rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={retryingLaunch}
                        onClick={handleRestartMember}
                      >
                        {retryingLaunch ? (
                          <SyncedLoader2 className="size-3.5" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {retryLaunchError ??
                        (retryingLaunch ? `${restartActionBusyLabel}...` : restartActionIdleLabel)}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {showRuntimeAdvisoryDiagnostics ? (
                  <MemberLaunchDiagnosticsButton
                    payload={launchDiagnosticsPayload}
                    className="size-auto rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
                    attention
                  />
                ) : null}
              </span>
            ) : !activityTask ? (
              <Badge
                variant="secondary"
                className={`shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none ${isRemoved ? 'bg-zinc-600 text-zinc-300' : 'text-[var(--color-text-muted)]'}`}
                title={isRemoved ? 'This member has been removed' : activityTitle}
              >
                {isRemoved ? 'removed' : displayPresenceLabel}
              </Badge>
            ) : null}
            <MemberTaskProgressBadge
              showStartingSkeleton={showStartingSkeleton}
              memberTaskCount={member.taskCount}
              completed={completed}
              totalTasks={totalTasks}
              progressPercent={progressPercent}
            />
            {!isRemoved && (
              <MemberQuickActions onSendMessage={onSendMessage} onAssignTask={onAssignTask} />
            )}
            {canRestoreMember ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={restoringMember ? 'Restoring teammate' : 'Restore teammate'}
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={restoringMember}
                    onClick={handleRestoreMember}
                  >
                    {restoringMember ? (
                      <SyncedLoader2 className="size-3.5" />
                    ) : (
                      <Undo2 className="size-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {restoreMemberError ?? (restoringMember ? 'Restoring teammate...' : 'Restore')}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          {launchFailureReason ? (
            <div
              data-testid="member-launch-failure-reason"
              className="col-span-2 col-start-2 min-w-0 whitespace-pre-wrap break-words text-[10px] font-medium leading-snug text-red-300/90"
              title={rawLaunchFailureReason}
            >
              <span>
                {renderLinkifiedText(launchFailureReason, {
                  linkClassName: 'underline underline-offset-2 hover:text-red-200',
                  stopPropagation: true,
                  getLinkLabel: getLaunchFailureLinkLabel,
                })}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  if (!showRuntimeTelemetryTooltip) {
    return cardContent;
  }

  return (
    <Tooltip
      delayDuration={0}
      open={runtimeTelemetryTooltipOpen}
      onOpenChange={handleRuntimeTelemetryTooltipOpenChange}
    >
      <TooltipTrigger asChild>{cardContent}</TooltipTrigger>
      {runtimeTelemetryTooltipOpen ? (
        <TooltipContent
          side="left"
          align="start"
          sideOffset={8}
          className="border-blue-400/20 bg-[var(--color-surface)] p-3 shadow-xl shadow-black/30"
        >
          <RuntimeTelemetryTooltipContent runtimeEntry={runtimeEntry} />
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
});
