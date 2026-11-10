import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import { HostMemberActivityLog } from '../members/HostMemberActivityLog';

import type {
  HostTaskActivityView,
  HostTaskExactLogs,
  HostTaskLogDetail,
  HostTaskLogStream,
  HostTaskLogSummary,
} from '@shared/types/teamActivity';

/** Original Task tabs consume normalized Host observations directly, without transcript chunks/clocks. */
export const HostTaskActivityIndex = ({
  teamName,
  value,
  mode,
}: {
  teamName: string;
  value: HostTaskActivityView | HostTaskExactLogs;
  mode: 'activity' | 'exact';
}) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<HostTaskLogDetail | null>(null);
  const [status, setStatus] = useState('');
  const serial = useRef(0);
  const revision = value.items.map((item) => item.sourceGeneration).join('|');
  const invalidate = useCallback(() => {
    serial.current++;
  }, []);
  useEffect(() => {
    invalidate();
    setExpanded(null);
    setDetail(null);
    setStatus('');
    return invalidate;
  }, [teamName, value.taskId, revision, invalidate]);
  async function toggle(item: HostTaskLogSummary) {
    if (expanded === item.id) {
      serial.current++;
      setExpanded(null);
      setDetail(null);
      return;
    }
    const request = ++serial.current;
    setExpanded(item.id);
    setDetail(null);
    setStatus('Loading retained activity...');
    try {
      const result =
        mode === 'exact'
          ? await api.teams.getTaskExactLogDetail(
              teamName,
              value.taskId,
              item.id,
              item.sourceGeneration
            )
          : await api.teams.getTaskActivityDetail(teamName, value.taskId, item.id);
      if (serial.current !== request) return;
      if (result.status !== 'ok') {
        setStatus(
          result.status === 'stale'
            ? 'Retained source changed. Refresh the list before reopening.'
            : 'This retained input is no longer available.'
        );
        return;
      }
      if (
        !('kind' in result.detail) ||
        result.detail.kind !== 'host_task_log_detail' ||
        result.detail.taskId !== value.taskId ||
        result.detail.id !== item.id ||
        result.detail.sourceGeneration !== item.sourceGeneration
      )
        throw new Error('Retained activity source changed.');
      setDetail(result.detail);
      setStatus('');
    } catch (error) {
      if (serial.current === request)
        setStatus(error instanceof Error ? error.message : 'Retained activity unavailable.');
    }
  }
  return (
    <div className="space-y-3 text-xs">
      <p className="text-[var(--color-text-muted)]">
        Original Task input observations. Native timestamps and complete lifetime activity are
        unavailable.
      </p>
      {value.gaps.length > 0 && (
        <p role="status" className="text-amber-500">
          Partial activity: {value.gaps.join('; ')}
        </p>
      )}
      {'historyEvents' in value && value.historyEvents && (
        <section aria-label="Canonical task history" className="space-y-1">
          {value.historyEvents.map((event) => (
            <div key={event.id}>
              <time dateTime={event.timestamp}>{event.timestamp}</time>
              {' · '}
              {event.actor ?? 'Unknown actor'}
              {' · '}
              {event.type.replaceAll('_', ' ')}
              <pre className="whitespace-pre-wrap">{JSON.stringify(event, null, 2)}</pre>
            </div>
          ))}
        </section>
      )}
      {value.items.length === 0 && <p>No retained input facts are available for this Task.</p>}
      {value.items.map((item) => (
        <div key={item.id} className="rounded-md border border-[var(--color-border)]">
          <button
            type="button"
            className="w-full px-3 py-2 text-left"
            aria-expanded={expanded === item.id}
            onClick={() => void toggle(item)}
          >
            {item.memberName} · Captured Task input · generation {item.generation} ·{' '}
            {item.eventCount} retained facts
          </button>
          {expanded === item.id && (
            <div className="border-t border-[var(--color-border)] p-3">
              {status && <p role="status">{status}</p>}
              {detail && (
                <HostMemberActivityLog
                  log={detail.log}
                  expanded={true}
                  onToggle={() => void toggle(item)}
                />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
export const HostTaskActivityStream = ({ value }: { value: HostTaskLogStream }) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => setExpanded(null), [value.taskId]);
  return (
    <div className="space-y-3 text-xs">
      <p className="text-[var(--color-text-muted)]">
        Task-scoped retained Runtime observations from original input causes; native clocks and
        transcript files are unavailable.
      </p>
      {value.gaps.length > 0 && (
        <p role="status" className="text-amber-500">
          Partial activity: {value.gaps.join('; ')}
        </p>
      )}
      {value.logs.map((log) => (
        <HostMemberActivityLog
          key={log.sessionId}
          log={log}
          expanded={expanded === log.sessionId}
          onToggle={() => setExpanded(expanded === log.sessionId ? null : log.sessionId)}
        />
      ))}
    </div>
  );
};
