import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';

import type { HostedCreateTaskSession } from '../composition/HostedCreateTaskSession';

interface HostedCreateTaskControlsProps {
  readonly session: HostedCreateTaskSession;
  readonly mutationsEnabled: boolean;
  readonly canObserve: boolean;
  readonly boardBusy: boolean;
  readonly hasBasis: boolean;
  readonly onConflict: () => void;
}

export const HostedCreateTaskControls = ({
  session,
  mutationsEnabled,
  canObserve,
  boardBusy,
  hasBasis,
  onConflict,
}: HostedCreateTaskControlsProps): React.JSX.Element | null => {
  const snapshot = useSyncExternalStore(
    session.controller.subscribe,
    session.controller.getSnapshot
  );
  const [subject, setSubject] = useState('');
  const draftToken = useRef(0);
  const submittedToken = useRef<number | null>(null);

  useEffect(() => {
    if (snapshot.phase !== 'confirmed' || submittedToken.current === null) return;
    if (submittedToken.current === draftToken.current) setSubject('');
    submittedToken.current = null;
  }, [snapshot.phase]);

  const createBusy = snapshot.phase === 'preparing' || snapshot.phase === 'submitting';
  const canSubmit =
    ['idle', 'not_applied', 'conflict', 'dismissed_unconfirmed'].includes(snapshot.phase) &&
    snapshot.availability.available &&
    !boardBusy &&
    hasBasis &&
    subject.trim().length > 0;
  if (!mutationsEnabled && snapshot.phase === 'idle') return null;

  return (
    <>
      <form
        className="mt-4 grid gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const submittedSubject = subject.trim();
          if (!canSubmit || !submittedSubject) return;
          submittedToken.current = draftToken.current;
          void session.controller.submit({ subject: submittedSubject }).then((outcome) => {
            if (outcome.phase === 'conflict') onConflict();
          });
        }}
      >
        <Input
          aria-label="New task title"
          disabled={createBusy || !mutationsEnabled}
          maxLength={200}
          placeholder="Task title"
          required
          value={subject}
          onChange={(event) => {
            draftToken.current += 1;
            setSubject(event.target.value);
          }}
        />
        <Button type="submit" className="justify-self-end" disabled={!canSubmit}>
          Save task
        </Button>
      </form>
      {snapshot.phase === 'uncertain' && snapshot.envelope !== null ? (
        <div
          role="alert"
          className="mt-3 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
        >
          <p>
            The create result is unknown. The original task may already exist. Do not submit a
            second task until you check it.
          </p>
          <p>
            Original title:{' '}
            {snapshot.envelope.body.kind === 'hosted' ? snapshot.envelope.body.command.subject : ''}
          </p>
          <p>
            Command: <code>{snapshot.envelope.identity.commandId}</code>
          </p>
          <div className="flex flex-wrap gap-2">
            {snapshot.recovery === 'exact_replay' && snapshot.availability.available ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void session.controller.retryExact()}
              >
                Retry original command
              </Button>
            ) : null}
            {canObserve ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void session.controller.observe()}
              >
                Check original task
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => session.controller.dismissUnresolved()}
            >
              Dismiss unresolved command
            </Button>
          </div>
          {snapshot.recovery === 'operator_required' ? (
            <p>
              Automatic checks could not confirm the write. Check the original command in the team
              task records before creating another task.
            </p>
          ) : null}
        </div>
      ) : null}
      {snapshot.phase === 'confirmed' && snapshot.confirmed !== null ? (
        <div
          role="status"
          className="mt-3 space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm"
        >
          <p>
            {snapshot.confirmed.recordState === 'deleted'
              ? 'This task was created and later deleted.'
              : 'Task creation confirmed.'}{' '}
            Task ID: <code>{snapshot.confirmed.reference.taskId}</code>
          </p>
          {snapshot.confirmed.origin === 'observed_task_record' ? (
            <p>
              The task record was observed. This does not confirm delivery of any additional
              messages.
            </p>
          ) : null}
          {snapshot.freshness === 'failed' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void session.controller.refresh()}
            >
              Refresh board data
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => session.controller.acknowledgeConfirmed()}
          >
            Create another task
          </Button>
        </div>
      ) : null}
      {snapshot.phase === 'conflict' ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
        >
          The board changed before this create was applied. Review the refreshed board and submit
          again.
        </p>
      ) : null}
      {snapshot.phase === 'not_applied' ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm"
        >
          Task creation was not applied. Check the title and connection, then submit again.
        </p>
      ) : null}
      {snapshot.phase === 'dismissed_unconfirmed' ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
        >
          The original outcome is still unconfirmed. A new submission may create a duplicate.
        </p>
      ) : null}
    </>
  );
};
