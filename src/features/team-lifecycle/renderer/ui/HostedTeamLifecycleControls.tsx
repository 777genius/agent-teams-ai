import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';

import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  parseHostedLifecycleCommandId,
  parseHostedLifecycleIdempotencyKey,
} from '../../contracts/hosted-lifecycle-commands';

import type {
  HostedLifecycleCommand,
  HostedLifecycleCommandAction,
  HostedLifecycleControlState,
  HostedLifecyclePreparedState,
  HostedLifecycleProvisioningStatus,
} from '../../contracts/hosted-lifecycle-commands';
import type { HostedTeamLifecycleTransport } from '../createHostedTeamLifecycleTransport';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedTeamLifecycleControlsProps {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly transport: Pick<
    HostedTeamLifecycleTransport,
    'execute' | 'getControlState' | 'getProgress' | 'prepare'
  >;
  readonly healthPollIntervalMs?: number;
  readonly createCommandIdentity?: () => Readonly<{
    commandId: ReturnType<typeof parseHostedLifecycleCommandId>;
    idempotencyKey: ReturnType<typeof parseHostedLifecycleIdempotencyKey>;
  }>;
}

let identitySequence = 0;
function createIdentity() {
  const suffix =
    globalThis.crypto?.randomUUID?.() ?? `fallback-${Date.now()}-${++identitySequence}`;
  return Object.freeze({
    commandId: parseHostedLifecycleCommandId(`lifecycle-command_browser-${suffix}`),
    idempotencyKey: parseHostedLifecycleIdempotencyKey(`idempotency_browser-${suffix}`),
  });
}

function toControlState(
  value: HostedLifecyclePreparedState | HostedLifecycleProvisioningStatus
): HostedLifecycleControlState {
  return Object.freeze({ ...value, kind: 'control_state' });
}

export const HostedTeamLifecycleControls = ({
  workspaceId,
  teamId,
  transport,
  createCommandIdentity = createIdentity,
  healthPollIntervalMs = 2_000,
}: HostedTeamLifecycleControlsProps): React.JSX.Element => {
  const healthGeneration = useRef(0);
  const healthInFlight = useRef(false);
  const healthSettled = useRef<Promise<void>>(Promise.resolve());
  const commandInFlight = useRef(false);
  const authoritativeRefreshQueued = useRef(false);
  const commandGeneration = useRef(0);
  const mounted = useRef(true);
  const [state, setState] = useState<HostedLifecycleControlState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Recovering lifecycle status…');
  const request = useMemo(
    () =>
      Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        workspaceId,
        teamId,
      }),
    [teamId, workspaceId]
  );

  const refresh = useCallback(
    async (announce = true) => {
      if (commandInFlight.current) {
        authoritativeRefreshQueued.current = true;
        return;
      }
      if (healthInFlight.current) return;
      const generation = ++healthGeneration.current;
      healthInFlight.current = true;
      let settleHealth!: () => void;
      healthSettled.current = new Promise<void>((resolve) => {
        settleHealth = resolve;
      });
      const result = await transport.getControlState(request).catch(() => null);
      healthInFlight.current = false;
      settleHealth();
      if (!mounted.current || generation !== healthGeneration.current) return;
      if (result?.kind === 'control_state') {
        setState(result);
        if (announce) setMessage('Lifecycle owner is available.');
      } else {
        setState(null);
        setMessage('Lifecycle controls are temporarily unavailable.');
      }
    },
    [request, transport]
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = globalThis.setInterval(() => void refresh(false), healthPollIntervalMs);
    return () => {
      globalThis.clearInterval(interval);
      mounted.current = false;
      healthGeneration.current += 1;
    };
  }, [healthPollIntervalMs, refresh]);

  const beginCommand = (): number => {
    // Fence an older health response immediately. The command completion waits
    // for its request to settle before issuing one authoritative replacement.
    healthGeneration.current += 1;
    commandInFlight.current = true;
    return ++commandGeneration.current;
  };

  const refreshAfterCommand = async (): Promise<void> => {
    commandInFlight.current = false;
    await healthSettled.current;
    if (!mounted.current) return;
    authoritativeRefreshQueued.current = false;
    await refresh(false);
  };

  const prepare = async (): Promise<void> => {
    if (state === null) return;
    const generation = beginCommand();
    setBusy(true);
    try {
      const result = await transport.prepare(request).catch(() => null);
      if (!mounted.current || generation !== commandGeneration.current) return;
      setBusy(false);
      if (result?.kind === 'prepared') {
        setState(toControlState(result));
        setMessage('Lifecycle controls prepared.');
      } else setMessage('Lifecycle preparation is unavailable.');
    } finally {
      if (generation === commandGeneration.current) await refreshAfterCommand();
    }
  };

  const progress = async (): Promise<void> => {
    if (state === null) return;
    const generation = beginCommand();
    setBusy(true);
    try {
      const result = await transport.getProgress(request).catch(() => null);
      if (!mounted.current || generation !== commandGeneration.current) return;
      setBusy(false);
      if (result?.kind !== 'provisioning_status') {
        setState(null);
        setMessage('Lifecycle controls are temporarily unavailable.');
        return;
      }
      setState(toControlState(result));
      const pending = result.recentCommands.find(
        ({ result: commandResult }) =>
          commandResult.kind === 'started' || commandResult.kind === 'operator_required'
      );
      setMessage(
        pending === undefined
          ? 'Lifecycle status is current.'
          : pending.result.kind === 'operator_required'
            ? 'Lifecycle recovery needs operator attention.'
            : 'A lifecycle command is still in progress.'
      );
    } finally {
      if (generation === commandGeneration.current) await refreshAfterCommand();
    }
  };

  const execute = async (action: HostedLifecycleCommandAction): Promise<void> => {
    if (state === null || (action !== 'launch' && state.runId === null)) return;
    const generation = beginCommand();
    const command = Object.freeze({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      action,
      ...createCommandIdentity(),
      workspaceId,
      teamId,
      expectedRevision: state.resourceRevision,
      ...(action === 'launch' ? {} : { runId: state.runId }),
    }) as HostedLifecycleCommand;
    setBusy(true);
    try {
      const result = await transport.execute(command).catch(() => null);
      if (!mounted.current || generation !== commandGeneration.current) return;
      setMessage(
        result?.kind === 'accepted' || result?.kind === 'idempotent_replay'
          ? 'Lifecycle command accepted.'
          : result?.kind === 'started'
            ? 'Lifecycle command is still in progress.'
            : 'Lifecycle command was not accepted.'
      );
      setBusy(false);
    } finally {
      if (generation === commandGeneration.current) await refreshAfterCommand();
    }
  };

  return (
    <section aria-labelledby="hosted-team-lifecycle-controls-title" className="space-y-3 p-4">
      <h2 id="hosted-team-lifecycle-controls-title" className="text-base font-semibold">
        Team lifecycle
      </h2>
      <p role="status" className="text-sm">
        {message}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || state === null}
          onClick={() => void prepare()}
        >
          Prepare
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !state?.availableActions.includes('launch')}
          onClick={() => void execute('launch')}
        >
          Launch
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || state === null}
          onClick={() => void progress()}
        >
          Progress
        </Button>
        {(['cancel', 'stop', 'recover'] as const).map((action) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant={action === 'stop' ? 'destructive' : 'outline'}
            disabled={busy || !state?.availableActions.includes(action)}
            onClick={() => void execute(action)}
          >
            {action === 'recover' ? 'Restart / recover' : action[0].toUpperCase() + action.slice(1)}
          </Button>
        ))}
      </div>
    </section>
  );
};
