import { memo } from 'react';

import { formatDistanceToNowStrict } from 'date-fns';
import { ExternalLink, Square, Terminal } from 'lucide-react';

import { MemberBadge } from './MemberBadge';

import type { ResolvedTeamMember, TeamProcess } from '@shared/types';

function formatShortTime(date: Date): string {
  const distance = formatDistanceToNowStrict(date, { addSuffix: false });
  return distance
    .replace(' seconds', 's')
    .replace(' second', 's')
    .replace(' minutes', 'm')
    .replace(' minute', 'm')
    .replace(' hours', 'h')
    .replace(' hour', 'h')
    .replace(' days', 'd')
    .replace(' day', 'd')
    .replace(' weeks', 'w')
    .replace(' week', 'w')
    .replace(' months', 'mo')
    .replace(' month', 'mo')
    .replace(' years', 'y')
    .replace(' year', 'y');
}

interface ProcessesSectionProps {
  teamName: string;
  members: ResolvedTeamMember[];
  processes: TeamProcess[];
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
      leftProcess.stoppedAt !== rightProcess.stoppedAt
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
}: ProcessesSectionProps): React.JSX.Element | null {
  if (!teamName || processes.length === 0) return null;

  const memberColorMap = new Map(members.map((m) => [m.name, m.color]));

  const sorted = [...processes].sort((a, b) => {
    const aAlive = !a.stoppedAt;
    const bAlive = !b.stoppedAt;
    if (aAlive !== bAlive) return aAlive ? -1 : 1;
    return Date.parse(b.registeredAt) - Date.parse(a.registeredAt);
  });

  return (
    <div className="space-y-0.5">
      {sorted.map((proc) => {
        const alive = !proc.stoppedAt;
        const timeStr = alive
          ? `${formatShortTime(new Date(proc.registeredAt))} ago`
          : `stopped ${formatShortTime(new Date(proc.stoppedAt!))} ago`;

        return (
          <div
            key={proc.id}
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-raised)] ${!alive ? 'opacity-50' : ''}`}
          >
            {/* Status indicator */}
            <span
              className="relative inline-flex size-2 shrink-0"
              title={alive ? 'Running' : 'Stopped'}
            >
              {alive && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              )}
              <span
                className={`relative inline-flex size-2 rounded-full ${alive ? 'bg-emerald-400' : 'bg-zinc-500'}`}
              />
            </span>

            {/* Icon + label — takes available space */}
            <Terminal size={12} className="shrink-0 text-[var(--color-text-muted)]" />
            <span
              className="min-w-0 truncate font-medium text-[var(--color-text)]"
              title={proc.label}
            >
              {proc.label}
            </span>

            {/* Port + URL inline — only when present */}
            {(proc.port != null || proc.url) && (
              <span className="min-w-0 truncate text-[var(--color-text-secondary)]">
                {proc.port != null && !proc.url && `:${proc.port}`}
                {proc.url && (
                  <button
                    type="button"
                    className="text-[var(--color-text-secondary)] underline decoration-dotted underline-offset-2 transition-colors hover:text-blue-400"
                    onClick={() => void window.electronAPI.openExternal(proc.url!)}
                    title={proc.url}
                  >
                    {proc.url}
                  </button>
                )}
              </span>
            )}

            {/* Right-aligned group: Kill button, Open button, member badge, PID, time */}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {alive && (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-red-400 transition-colors hover:bg-red-500/10"
                  onClick={() => void window.electronAPI.teams.killProcess(teamName, proc.pid)}
                  title="Stop process (SIGTERM)"
                >
                  <Square size={8} className="fill-current" />
                  Kill
                </button>
              )}
              {alive && proc.url && (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-blue-400 transition-colors hover:bg-blue-500/10"
                  onClick={() => void window.electronAPI.openExternal(proc.url!)}
                  title="Open in browser"
                >
                  <ExternalLink size={10} />
                  Open
                </button>
              )}
              <span className="font-mono text-[var(--color-text-muted)]">PID{proc.pid}</span>
              {proc.registeredBy && (
                <MemberBadge
                  name={proc.registeredBy}
                  color={memberColorMap.get(proc.registeredBy)}
                  teamName={teamName}
                />
              )}
              <span className="text-[var(--color-text-muted)]">{timeStr}</span>
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
    areMembersEquivalent(prev.members, next.members) &&
    areProcessesEquivalent(prev.processes, next.processes)
  );
}
