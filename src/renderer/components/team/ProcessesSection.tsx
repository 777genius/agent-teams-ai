import { memo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { formatCompactRelativeTime } from '@renderer/utils/formatters';
import { ExternalLink, Square, Terminal } from 'lucide-react';

import { MemberBadge } from './MemberBadge';

import type { ResolvedTeamMember, TeamProcess } from '@shared/types';

interface ProcessesSectionProps {
  teamName: string;
  members: ResolvedTeamMember[];
  processes: TeamProcess[];
  isTeamAlive?: boolean;
}

function areMembersEquivalent(
  left: readonly ResolvedTeamMember[],
  right: readonly ResolvedTeamMember[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].name !== right[index].name || left[index].color !== right[index].color) {
      return false;
    }
  }
  return true;
}

function areProcessesEquivalent(
  left: readonly TeamProcess[],
  right: readonly TeamProcess[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftProcess = left[index];
    const rightProcess = right[index];
    if (
      leftProcess.id !== rightProcess.id ||
      leftProcess.port !== rightProcess.port ||
      leftProcess.url !== rightProcess.url ||
      leftProcess.label !== rightProcess.label ||
      leftProcess.pid !== rightProcess.pid ||
      leftProcess.registeredBy !== rightProcess.registeredBy ||
      leftProcess.registeredAt !== rightProcess.registeredAt ||
      leftProcess.stoppedAt !== rightProcess.stoppedAt ||
      leftProcess.processRef !== rightProcess.processRef ||
      leftProcess.observation !== rightProcess.observation ||
      leftProcess.canTerminate !== rightProcess.canTerminate ||
      leftProcess.pendingStop?.commandId !== rightProcess.pendingStop?.commandId ||
      leftProcess.pendingStop?.originalProcessRef !==
        rightProcess.pendingStop?.originalProcessRef ||
      leftProcess.pendingStop?.native !== rightProcess.pendingStop?.native
    ) {
      return false;
    }
  }
  return true;
}

export const ProcessesSection = memo(function ProcessesSection({
  teamName,
  members,
  processes,
  isTeamAlive,
}: ProcessesSectionProps): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  if (!teamName || processes.length === 0) return null;

  const memberColorMap = new Map(members.map((m) => [m.name, m.color]));

  const isAlive = (proc: TeamProcess) =>
    proc.processRef ? proc.observation === 'same-live' : isTeamAlive === true && !proc.stoppedAt;
  const sorted = [...processes].sort((a, b) => {
    const aAlive = isAlive(a);
    const bAlive = isAlive(b);
    if (aAlive !== bAlive) return aAlive ? -1 : 1;
    return Date.parse(b.registeredAt) - Date.parse(a.registeredAt);
  });

  return (
    <div className="space-y-0.5">
      {sorted.map((proc) => {
        const alive = isAlive(proc);
        const status =
          proc.processRef && proc.observation !== 'same-live' && proc.observation !== 'absent'
            ? 'Unknown'
            : alive
              ? t('processes.running')
              : t('processes.stopped');
        const canStop = proc.processRef ? proc.canTerminate === true || !!proc.pendingStop : alive;
        const timeStr =
          alive || proc.processRef
            ? t('processes.ago', {
                time: formatCompactRelativeTime(new Date(proc.registeredAt)),
              })
            : proc.stoppedAt
              ? t('processes.stoppedAgo', {
                  time: formatCompactRelativeTime(new Date(proc.stoppedAt)),
                })
              : '';

        return (
          <div
            key={proc.id}
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-raised)] ${!alive ? 'opacity-50' : ''}`}
          >
            {/* Status indicator */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="relative inline-flex size-2 shrink-0">
                  {alive && (
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                  )}
                  <span
                    className={`relative inline-flex size-2 rounded-full ${alive ? 'bg-emerald-400' : 'bg-zinc-500'}`}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>{status}</TooltipContent>
            </Tooltip>

            {/* Icon + label — takes available space */}
            <Terminal size={12} className="shrink-0 text-[var(--color-text-muted)]" />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate font-medium text-[var(--color-text)]">
                  {proc.label}
                </span>
              </TooltipTrigger>
              <TooltipContent>{proc.label}</TooltipContent>
            </Tooltip>

            {/* Port + URL inline — only when present */}
            {(proc.port != null || proc.url) && (
              <span className="min-w-0 truncate text-[var(--color-text-secondary)]">
                {proc.port != null && !proc.url && `:${proc.port}`}
                {proc.url && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-[var(--color-text-secondary)] underline decoration-dotted underline-offset-2 transition-colors hover:text-blue-400"
                        onClick={() => void window.electronAPI.openExternal(proc.url!)}
                      >
                        {proc.url}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{proc.url}</TooltipContent>
                  </Tooltip>
                )}
              </span>
            )}

            {/* Right-aligned group: Kill button, Open button, member badge, PID, time */}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {canStop && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-red-400 transition-colors hover:bg-red-500/10"
                      onClick={() =>
                        void (proc.processRef
                          ? api.teams.killProcess(
                              teamName,
                              proc.pid,
                              proc.pendingStop
                                ? {
                                    processRef: proc.pendingStop.originalProcessRef,
                                    originalCommandId: proc.pendingStop.commandId,
                                  }
                                : { processRef: proc.processRef }
                            )
                          : api.teams.killProcess(teamName, proc.pid))
                      }
                    >
                      <Square size={8} className="fill-current" />
                      {t('processes.kill')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {proc.pendingStop ? 'Query original process stop' : t('processes.stopProcess')}
                  </TooltipContent>
                </Tooltip>
              )}
              {alive && proc.url && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-blue-400 transition-colors hover:bg-blue-500/10"
                      onClick={() => void window.electronAPI.openExternal(proc.url!)}
                    >
                      <ExternalLink size={10} />
                      {t('processes.open')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('processes.openInBrowser')}</TooltipContent>
                </Tooltip>
              )}
              <span className="font-mono text-[var(--color-text-muted)]">
                {t('processes.pid', { pid: proc.pid })}
              </span>
              {proc.registeredBy && (
                <MemberBadge
                  name={proc.registeredBy}
                  color={memberColorMap.get(proc.registeredBy)}
                  teamName={teamName}
                />
              )}
              {timeStr ? <span className="text-[var(--color-text-muted)]">{timeStr}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}, areProcessesSectionPropsEqual);

function areProcessesSectionPropsEqual(
  prev: Readonly<ProcessesSectionProps>,
  next: Readonly<ProcessesSectionProps>
): boolean {
  return (
    prev.teamName === next.teamName &&
    prev.isTeamAlive === next.isTeamAlive &&
    areMembersEquivalent(prev.members, next.members) &&
    areProcessesEquivalent(prev.processes, next.processes)
  );
}
