import { useId, useRef, useState } from 'react';

import {
  DEFAULT_AUTONOMOUS_GOAL_OPTIONS,
  HostTeamOperationError,
  readAutonomousGoalOptions,
} from '@features/agent-backend/contracts';
import { controlAutonomousGoal } from '@features/agent-backend/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import { ActionModeSelector } from './ActionModeSelector';

import type {
  AutonomousGoalControl,
  AutonomousGoalOptions,
  AutonomousGoalStatus,
} from '@features/agent-backend/contracts';
import type { UseComposerDraftResult } from '@renderer/hooks/useComposerDraft';
import type { AgentActionMode } from '@shared/types';

const Limits = ({
  value,
  onChange,
  disabled,
  extending = false,
}: {
  value: AutonomousGoalOptions;
  onChange(value: AutonomousGoalOptions): void;
  disabled?: boolean;
  extending?: boolean;
}) => {
  const id = useId();
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label htmlFor={`${id}-hours`}>{extending ? 'Hours from now' : 'Hours'}</Label>
        <Input
          id={`${id}-hours`}
          type="number"
          min={1}
          max={24}
          step={1}
          value={value.durationHours}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, durationHours: Number(event.target.value) })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-attempts`}>
          {extending ? 'Total automatic attempts' : 'Automatic attempts'}
        </Label>
        <Input
          id={`${id}-attempts`}
          type="number"
          min={1}
          max={1000}
          step={1}
          value={value.maxAttempts}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, maxAttempts: Number(event.target.value) })}
        />
      </div>
    </div>
  );
};

function valid(options: AutonomousGoalOptions): boolean {
  try {
    readAutonomousGoalOptions(options);
    return true;
  } catch {
    return false;
  }
}

/** Explicit per-message selection; persistence belongs to the original composer draft. */
export const ContinueUntilDoneControl = ({
  value,
  onChange,
  disabled,
}: {
  value: AutonomousGoalOptions | undefined;
  onChange(value: AutonomousGoalOptions | undefined): void;
  disabled: boolean;
}) => {
  const id = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={value ? 'secondary' : 'ghost'}
          size="sm"
          disabled={disabled}
          className="h-7 text-xs"
        >
          Continue until done{value ? ' · On' : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={!!value}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(checked === true ? { ...DEFAULT_AUTONOMOUS_GOAL_OPTIONS } : undefined)
            }
          />
          <Label htmlFor={id}>Continue until done</Label>
        </div>
        <p>
          Keep working on this request until it is finished, needs your input, or reaches a limit.
        </p>
        {value ? (
          <>
            <Limits value={value} onChange={onChange} disabled={disabled} />
            {!valid(value) ? (
              <p role="alert">Choose 1–24 hours and 1–1,000 automatic attempts.</p>
            ) : null}
          </>
        ) : null}
        <p className="text-[var(--color-text-muted)]">
          Limits are shared by the whole team. Keep the app running. Tool and provider permissions
          still apply.
        </p>
      </PopoverContent>
    </Popover>
  );
};

const labels: Record<AutonomousGoalStatus['disposition'], string> = {
  active: 'Continuing work',
  finalizing: 'Checking the result',
  accepted: 'Publishing the result',
  stopped: 'Continuation stopped',
};

const reasons: Record<string, string> = {
  'deadline-reached': 'The time limit was reached. Extend it to allow more automatic work.',
  'attempt-limit-reached': 'The automatic attempt limit was reached. Extend it to allow more work.',
  'stopped-by-user': 'You stopped automatic continuation.',
  'runtime-stopped': 'The team was stopped. Resume the team before continuing this objective.',
  'verification-changed': 'The work changed during final checks. The team is checking it again.',
  'verification-waiting': 'Waiting for a required check before accepting the result.',
  'waiting-for-input-settlement': 'Waiting for running work to finish before accepting the result.',
};

/** Existing Team surface only; every control captures the displayed goal and revision. */
export const AutonomousGoalStatusNotice = ({
  teamName,
  goal,
}: {
  teamName: string;
  goal: AutonomousGoalStatus;
}) => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState<AutonomousGoalOptions>({
    durationHours: 12,
    maxAttempts: goal.attemptLimit,
  });
  const active = useRef(false);
  const original = useRef<{ commandId: string; request: AutonomousGoalControl } | null>(null);
  const currentGoal = useRef(goal);
  currentGoal.current = goal;
  const refresh = async () => {
    if (active.current) return;
    active.current = true;
    setPending(true);
    try {
      await useStore.getState().refreshTeamData(teamName);
      if (useStore.getState().selectedTeamName === teamName)
        setError(
          useStore.getState().selectedTeamError
            ? 'Team status could not be refreshed. Try again.'
            : null
        );
    } catch {
      if (useStore.getState().selectedTeamName === teamName)
        setError('Team status could not be refreshed. Try again.');
    } finally {
      active.current = false;
      setPending(false);
    }
  };
  const run = async (action: AutonomousGoalControl['action'], retry = false) => {
    if (active.current || (!retry && original.current)) return;
    const captured = goal;
    const store = useStore.getState();
    const contextId = store.activeContextId;
    const epoch = captureContextScopedRequestEpoch();
    const current = () => {
      const state = useStore.getState();
      return (
        !state.isContextSwitching &&
        state.activeContextId === contextId &&
        state.selectedTeamName === teamName &&
        isContextScopedRequestEpochCurrent(epoch) &&
        currentGoal.current.goalId === captured.goalId
      );
    };
    if (!current() || (!retry && action === 'extend' && !valid(limits))) return;
    const request: AutonomousGoalControl =
      retry && original.current
        ? original.current.request
        : {
            goalId: captured.goalId,
            expectedRevision: captured.revision,
            action,
            ...(action === 'extend'
              ? {
                  deadlineAt: new Date(
                    Math.max(
                      Date.parse(captured.deadlineAt),
                      Date.now() + limits.durationHours * 3_600_000
                    )
                  ).toISOString(),
                  attemptLimit: Math.max(captured.attemptLimit, limits.maxAttempts),
                }
              : {}),
          };
    if (!retry || !original.current) original.current = { commandId: crypto.randomUUID(), request };
    const commandId = original.current.commandId;
    active.current = true;
    setPending(true);
    setError(null);
    try {
      await controlAutonomousGoal({
        backend: api.agentBackend,
        teamName,
        commandId,
        request,
        isCurrent: current,
      });
      original.current = null;
      if (current()) {
        try {
          await useStore.getState().refreshTeamData(teamName);
          if (current() && useStore.getState().selectedTeamError)
            setError('The change was applied, but team status could not be refreshed.');
        } catch {
          if (current())
            setError('The change was applied, but team status could not be refreshed.');
        }
      }
    } catch (failure) {
      const refused = failure instanceof HostTeamOperationError && failure.outcome !== 'unknown';
      if (refused) original.current = null;
      if (current())
        setError(
          refused
            ? 'The change could not be applied. Refresh the current status before trying again.'
            : 'The change is not confirmed. Check the original request before making another change.'
        );
    } finally {
      active.current = false;
      setPending(false);
    }
  };
  const editable = goal.disposition !== 'accepted';
  return (
    <div
      className="space-y-2 rounded-md border border-[var(--color-border)] p-2 text-xs"
      role="status"
      aria-busy={pending}
    >
      <p>
        {goal.disposition === 'accepted' && goal.published ? 'Completed' : labels[goal.disposition]}{' '}
        · {goal.attemptsUsed}/{goal.attemptLimit} automatic attempts
      </p>
      <p className="text-[var(--color-text-muted)]">
        Until {new Date(goal.deadlineAt).toLocaleString()}
      </p>
      {goal.reason ? <p>{reasons[goal.reason] ?? goal.reason}</p> : null}
      {pending ? <p>Updating continuation…</p> : null}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {goal.disposition !== 'stopped' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || error !== null}
              onClick={() => void run('stop')}
            >
              Stop continuation
            </Button>
          ) : null}
          {goal.canResume ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || error !== null}
              onClick={() => void run('resume')}
            >
              Resume continuation
            </Button>
          ) : null}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending || error !== null}
              >
                Extend limits
              </Button>
            </PopoverTrigger>
            <PopoverContent className="space-y-3 text-xs">
              <p>Set a later deadline and a larger total attempt limit. Used attempts are kept.</p>
              <Limits
                value={limits}
                onChange={setLimits}
                disabled={pending || error !== null}
                extending
              />
              <Button
                type="button"
                size="sm"
                disabled={pending || error !== null || !valid(limits)}
                onClick={() => void run('extend')}
              >
                Apply extension
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-2">
          <p>{error}</p>
          {original.current ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void run(original.current!.request.action, true)}
            >
              Check original request
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void refresh()}
            >
              Refresh status
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
};

/** Existing execution modes and the one optional continuation selection share one toolbar slot. */
export const ComposerExecutionControls = ({
  actionMode,
  onModeChange,
  canDelegate,
  sending,
  goalEligible,
  draft,
}: {
  actionMode: AgentActionMode;
  onModeChange(value: AgentActionMode): void;
  canDelegate: boolean;
  sending: boolean;
  goalEligible: boolean;
  draft: Pick<UseComposerDraftResult, 'autonomousGoal' | 'setAutonomousGoal' | 'isLoaded'>;
}) => {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <ActionModeSelector
        value={actionMode}
        onChange={onModeChange}
        showDelegate={canDelegate}
        disabled={sending}
      />
      {goalEligible || draft.autonomousGoal ? (
        <ContinueUntilDoneControl
          value={draft.autonomousGoal}
          onChange={draft.setAutonomousGoal}
          disabled={sending || !draft.isLoaded}
        />
      ) : null}
    </div>
  );
};
