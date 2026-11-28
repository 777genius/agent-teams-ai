import { useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { Button } from '@renderer/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { useStore } from '@renderer/store';

import { HostMemberActivityLog } from './members/HostMemberActivityLog';
import { teamSessionLabel } from './teamSessionHistory';

import type {
  BackendTeamSessionPage,
  HostTeamSessionStream,
  HostTeamSessionSummary,
} from '@features/agent-backend/contracts';

const SessionDetails = ({ teamName, sessionId }: { teamName: string; sessionId: string }) => {
  const contextId = useStore((state) => state.activeContextId);
  const [stream, setStream] = useState<HostTeamSessionStream>('conversation');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [index, setIndex] = useState(0);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const scope = JSON.stringify([contextId, teamName, sessionId, stream, cursors[index], reload]);
  const [state, setState] = useState<{
    scope: string;
    page?: BackendTeamSessionPage;
    error?: string;
  }>({ scope: '' });
  const revision = useRef<{ source: string; value: string } | null>(null);
  const source = JSON.stringify([contextId, teamName, sessionId, stream]);
  const cursor = cursors[index];
  useEffect(() => {
    let cancelled = false;
    setState({ scope });
    setExpanded(true);
    void (async () => {
      try {
        if (!api.teams.getHostTeamSessionPage)
          throw new Error('Team session history is unavailable.');
        const page = await api.teams.getHostTeamSessionPage(teamName, sessionId, stream, cursor);
        if (cancelled) return;
        if (
          page.kind !== 'team-session-page' ||
          page.sessionId !== sessionId ||
          page.stream !== stream ||
          (revision.current?.source === source && revision.current.value !== page.revision)
        )
          throw new Error('Session history changed. Refresh to read the current history.');
        revision.current = { source, value: page.revision };
        setState({ scope, page });
      } catch (error) {
        if (!cancelled)
          setState({
            scope,
            error: error instanceof Error ? error.message : 'Session history is unavailable.',
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, source, teamName, sessionId, stream, cursor]);
  const visible = state.scope === scope ? state : null;
  const page = visible?.page;
  const refresh = () => {
    revision.current = null;
    setCursors([undefined]);
    setIndex(0);
    setReload((value) => value + 1);
  };
  return (
    <div className="space-y-3 border-t border-[var(--color-border)] p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={stream}
          onValueChange={(value) => {
            setStream(value as HostTeamSessionStream);
            setCursors([undefined]);
            setIndex(0);
          }}
        >
          <TabsList>
            <TabsTrigger value="inputs">Inputs</TabsTrigger>
            <TabsTrigger value="conversation">Responses</TabsTrigger>
            <TabsTrigger value="activity">Activity and usage</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" variant="ghost" onClick={refresh}>
          Refresh history
        </Button>
      </div>
      {!visible?.error && !page && <p role="status">Loading session history…</p>}
      {visible?.error && (
        <p role="alert" className="text-amber-500">
          {visible.error}
        </p>
      )}
      {page && (
        <>
          {page.gaps.length > 0 && (
            <p role="status" className="text-amber-500">
              Partial history: {page.gaps.join('; ')}
            </p>
          )}
          {page.log && (
            <HostMemberActivityLog
              log={page.log}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
            />
          )}
          {page.messages.map((message) => (
            <section
              key={message.messageId + ':' + message.part}
              className="space-y-2 rounded border border-[var(--color-border)] p-3"
            >
              <p className="text-[var(--color-text-muted)]">
                {page.stream === 'inputs' ? 'Input to ' : ''}
                {message.memberName} ·{' '}
                {message.observedAt === null ? (
                  'Time not recorded'
                ) : (
                  <time dateTime={message.observedAt}>
                    {new Date(message.observedAt).toLocaleString()}
                  </time>
                )}
                {message.phase ? ' · delivery ' + message.phase : ''}
                {message.parts > 1 ? ' · part ' + (message.part + 1) + ' of ' + message.parts : ''}
              </p>
              <MarkdownViewer
                content={message.text}
                copyable
                maxHeight="max-h-96"
                itemId={message.messageId + ':' + message.part}
              />
            </section>
          ))}
          {!page.log && page.messages.length === 0 && (
            <p>
              No retained {page.stream === 'inputs' ? 'inputs' : 'responses'} are available on this
              page.
            </p>
          )}
        </>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={index === 0}
          onClick={() => setIndex((value) => value - 1)}
        >
          Previous page
        </Button>
        <span>Page {index + 1}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={!page?.nextCursor}
          onClick={() => {
            const next = page?.nextCursor;
            if (!next) return;
            if (cursors.slice(0, index + 1).includes(next)) {
              setState({
                scope,
                error: 'History continuation repeated. Refresh before continuing.',
              });
              return;
            }
            setCursors((previous) => [...previous.slice(0, index + 1), next]);
            setIndex((value) => value + 1);
          }}
        >
          Next page
        </Button>
      </div>
    </div>
  );
};

/** The existing Sessions surface reads its original Host history even without a legacy project index. */
export const HostTeamSessionsSection = ({
  teamName,
  sessions,
  sessionsLoading,
  sessionsError,
  selectedSessionId,
  onSelectSession,
  onRefresh,
}: {
  teamName: string;
  sessions: HostTeamSessionSummary[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  selectedSessionId: string | null;
  onSelectSession(id: string | null): void;
  onRefresh?(): void;
}) => {
  const contextId = useStore((state) => state.activeContextId);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => setOpened(null), [contextId, teamName]);
  return (
    <div className="space-y-3 text-xs">
      <div className="flex justify-end gap-2">
        {selectedSessionId && (
          <Button size="sm" variant="ghost" onClick={() => onSelectSession(null)}>
            Show all tasks
          </Button>
        )}
        {onRefresh && (
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            Refresh sessions
          </Button>
        )}
      </div>
      {sessionsLoading && <p role="status">Loading team sessions…</p>}
      {sessionsError && (
        <p role="alert" className="text-amber-500">
          {sessionsError}
        </p>
      )}
      {!sessionsLoading && !sessionsError && sessions.length === 0 && (
        <p>No sessions have been recorded for this team yet.</p>
      )}
      {sessions.map((session) => (
        <section key={session.id} className="rounded border border-[var(--color-border)]">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3">
            <div>
              <p>
                {teamSessionLabel(session)}
                {session.isOngoing === true ? ' · Active' : ''}
              </p>
              <p className="text-[var(--color-text-muted)]">
                {session.members} members · {session.generations} retained runs
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                aria-expanded={opened === session.id}
                onClick={() => setOpened((value) => (value === session.id ? null : session.id))}
              >
                View history
              </Button>
              <Button
                size="sm"
                variant={selectedSessionId === session.id ? 'secondary' : 'ghost'}
                disabled={session.clock !== 'qualified' || session.window === null}
                onClick={() =>
                  onSelectSession(selectedSessionId === session.id ? null : session.id)
                }
              >
                Filter tasks
              </Button>
            </div>
          </div>
          {session.clock !== 'qualified' && (
            <p role="status" className="px-3 pb-3 text-amber-500">
              Task filtering is unavailable because the launch time boundaries are incomplete.
              Session history is available below.
            </p>
          )}
          {opened === session.id && (
            <SessionDetails
              key={JSON.stringify([contextId, teamName, session.id])}
              teamName={teamName}
              sessionId={session.id}
            />
          )}
        </section>
      ))}
    </div>
  );
};
