import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import { parseHostTeamSelectionKey } from '../contracts/teamSelection';

import type { BackendHostRecoveryResult } from '../contracts/operations';
import type { api as OriginalApi, isElectronMode as OriginalIsElectronMode } from '@renderer/api';
import type { useStore as OriginalStore } from '@renderer/store';

interface HostBackendRetryActionProps {
  teamName: string;
  dependencies: {
    useStore: typeof OriginalStore;
    api: typeof OriginalApi;
    isElectronMode: typeof OriginalIsElectronMode;
  };
  onReady(teamName: string): Promise<void>;
  children: ReactNode;
}

/** Presentation only; Main independently validates the retained native owner. */
export function isWindowsHostTeamSelection(teamName: string, electronMode: boolean): boolean {
  if (!electronMode || typeof navigator === 'undefined' || !/^win/i.test(navigator.platform))
    return false;
  try {
    parseHostTeamSelectionKey(teamName);
    return true;
  } catch {
    return false;
  }
}

export function isHostReadUnavailable(
  teamName: string,
  error: unknown,
  electronMode: boolean
): boolean {
  return (
    (error === 'Host team read unavailable' || error === 'Host teams unavailable') &&
    isWindowsHostTeamSelection(teamName, electronMode)
  );
}

function recoveryResult(value: unknown): BackendHostRecoveryResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('phase' in value))
    throw new Error('Invalid Host recovery result');
  const fields = Object.keys(value);
  if (value.phase === 'ready' && fields.length === 1 && fields[0] === 'phase')
    return { phase: 'ready' };
  if (
    value.phase === 'captured' &&
    fields.length === 2 &&
    fields.includes('phase') &&
    fields.includes('capability') &&
    'capability' in value &&
    typeof value.capability === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.capability)
  )
    return { phase: 'captured', capability: value.capability };
  throw new Error('Invalid Host recovery result');
}

/** Explicit metadata refresh and separate recovery share one original UI request guard. */
export function HostBackendRetryAction({
  teamName,
  dependencies: { useStore, api, isElectronMode },
  onReady,
  children,
}: Readonly<HostBackendRetryActionProps>) {
  const { t } = useAppTranslation('common');
  const { t: teamText } = useAppTranslation('team');
  const contextId = useStore((state) => state.activeContextId);
  const switching = useStore((state) => state.isContextSwitching);
  const retained = useStore(
    (state) =>
      state.selectedTeamName === teamName && state.selectedTeamData?.teamName === teamName
  );
  const error = useStore((state) =>
    state.selectedTeamName === teamName ? state.selectedTeamError : null
  );
  const epoch = useStore(() => captureContextScopedRequestEpoch());
  const session = useMemo(
    () => ({ teamName, contextId, epoch, mounted: false, pending: false }),
    [teamName, contextId, epoch]
  );
  const currentSession = useRef(session);
  currentSession.current = session;
  const [state, setState] = useState({ session, pending: false, failed: false });
  useEffect(() => {
    session.mounted = true;
    return () => {
      session.mounted = false;
    };
  }, [session]);

  const unavailable = isHostReadUnavailable(teamName, error, isElectronMode());
  if (
    !isWindowsHostTeamSelection(teamName, isElectronMode()) ||
    (!retained && !unavailable) ||
    (error !== null && !unavailable)
  )
    return <>{children}</>;

  const isCurrent = () => {
    const current = useStore.getState();
    return (
      currentSession.current === session &&
      session.mounted &&
      isContextScopedRequestEpochCurrent(session.epoch) &&
      current.activeContextId === session.contextId &&
      current.selectedTeamName === session.teamName &&
      !current.isContextSwitching
    );
  };
  const run = async (action: 'refresh' | 'retry') => {
    if (session.pending || !isCurrent()) return;
    const current = useStore.getState();
    if (
      action === 'refresh'
        ? current.selectedTeamData?.teamName !== session.teamName
        : !isHostReadUnavailable(session.teamName, current.selectedTeamError, isElectronMode())
    )
      return;
    session.pending = true;
    setState({ session, pending: true, failed: false });
    try {
      if (action === 'refresh') {
        await onReady(session.teamName);
        return;
      }
      const handle = { handleId: parseHostTeamSelectionKey(session.teamName) };
      const commandId = crypto.randomUUID();
      const captured = await api.agentBackend.invoke({
        operation: 'host.recovery.capture',
        handle,
        commandId,
        payload: {},
      });
      if (!isCurrent()) return;
      if (!captured.ok) throw new Error('Host recovery unavailable');
      const result = recoveryResult(captured.value);
      if (result.phase === 'captured') {
        const started = await api.agentBackend.invoke({
          operation: 'host.recovery.start',
          handle,
          commandId,
          payload: { capability: result.capability },
        });
        if (!isCurrent()) return;
        if (!started.ok || recoveryResult(started.value).phase !== 'ready')
          throw new Error('Host recovery unavailable');
      }
      if (isCurrent()) await onReady(session.teamName);
    } catch {
      if (isCurrent()) setState({ session, pending: true, failed: true });
    } finally {
      session.pending = false;
      if (isCurrent())
        setState((previous) =>
          previous.session === session ? { ...previous, pending: false } : previous
        );
    }
  };
  const pending = state.session === session && state.pending;
  return (
    <div data-testid="host-backend-recovery" className="flex size-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-2">
        {retained && unavailable ? (
          <div role="alert" className="min-w-0 flex-1">
            <p className="text-sm font-medium text-red-400">{teamText('detail.loadFailed')}</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{error}</p>
          </div>
        ) : null}
        {retained ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={switching || pending}
            aria-busy={pending}
            onClick={() => {
              void run('refresh');
            }}
          >
            {t('actions.refresh')}
          </Button>
        ) : null}
        {unavailable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={switching || pending}
            aria-busy={pending}
            onClick={() => {
              void run('retry');
            }}
          >
            {t('actions.retry')}
          </Button>
        ) : null}
        {state.session === session && state.failed ? (
          <p role="alert" className="text-xs text-red-400">
            {t('states.error')}
          </p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
