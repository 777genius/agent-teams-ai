import React, { useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';

import type { OpenCodeStartupCleanupRecoveryStatus } from '@shared/types/openCodeStartupCleanup';

const messages: Record<OpenCodeStartupCleanupRecoveryStatus['state'], string> = {
  unavailable: '',
  pending: 'OpenCode startup cleanup is still running. Check again to observe its progress.',
  unknown:
    'OpenCode cleanup completion is unconfirmed. Check for the original response; this cannot recover lost runtime evidence or start a team.',
  partial:
    'OpenCode startup cleanup was partial. You can retry cleanup here; start the team separately.',
  complete: 'OpenCode cleanup finished. You can start the team manually.',
  stopped: 'OpenCode startup cleanup is unavailable during shutdown.',
};

/** Recovery only: this control never holds or retries a team launch. */
export const OpenCodeStartupCleanupRecovery = (): React.JSX.Element | null => {
  const [status, setStatus] = useState<OpenCodeStartupCleanupRecoveryStatus>({
    state: 'unavailable',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    void api.startup
      ?.getOpenCodeCleanupStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  if (status.state === 'unavailable') return null;
  const retry = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (!api.startup) throw new Error('Desktop startup cleanup is unavailable');
      setStatus(
        await (status.state === 'pending'
          ? api.startup.getOpenCodeCleanupStatus()
          : api.startup.retryOpenCodeCleanup())
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-xs">
      <p role="status">{messages[status.state]}</p>
      {error ? <p role="alert">{error}</p> : null}
      {status.requestId ? (
        <p className="break-all text-[var(--color-text-muted)]">
          Cleanup request: {status.requestId}
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        disabled={busy || status.state === 'stopped'}
        onClick={() => void retry()}
      >
        {busy
          ? 'Checking cleanup…'
          : status.state === 'pending' || status.state === 'unknown'
            ? 'Check cleanup'
            : 'Retry OpenCode cleanup'}
      </Button>
    </div>
  );
};
