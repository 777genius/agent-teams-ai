import { useLayoutEffect, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Loader2, RefreshCw, Stethoscope } from 'lucide-react';

import {
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  type HostedDiagnosticsResponse,
  type OperationalReferenceId,
} from '../../contracts';

import type { HostedDiagnosticsTransportPort } from '../ports/HostedDiagnosticsTransportPorts';

export interface HostedDiagnosticsPanelProps {
  /** Immutable caller-owned identity for the current principal/workspace scope. */
  readonly bindingKey: string;
  readonly referenceIds: readonly OperationalReferenceId[];
  readonly transport: HostedDiagnosticsTransportPort;
  readonly heading?: string;
}

interface DiagnosticsState {
  readonly bindingKey: string;
  readonly loading: boolean;
  readonly response: HostedDiagnosticsResponse | null;
}

export const HostedDiagnosticsPanel = ({
  bindingKey,
  referenceIds,
  transport,
  heading = 'Hosted diagnostics',
}: HostedDiagnosticsPanelProps): React.JSX.Element => {
  const [reloadSequence, setReloadSequence] = useState(0);
  const [state, setState] = useState<DiagnosticsState>(() => ({
    bindingKey,
    loading: true,
    response: null,
  }));
  // A prop rebind renders before effects. Never expose content retained for the previous authority.
  const visibleState = state.bindingKey === bindingKey ? state : null;

  useLayoutEffect(() => {
    const controller = new AbortController();
    setState({ bindingKey, loading: true, response: null });
    void transport
      .getDiagnostics(
        Object.freeze({
          schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
          referenceIds: Object.freeze([...referenceIds]),
        }),
        controller.signal
      )
      .then((response) => {
        if (!controller.signal.aborted) setState({ bindingKey, loading: false, response });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ bindingKey, loading: false, response: null });
      });
    return () => controller.abort();
  }, [bindingKey, referenceIds, reloadSequence, transport]);

  const response = visibleState?.response ?? null;
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Stethoscope aria-hidden="true" className="size-4" />
          <h2 className="text-sm font-semibold">{heading}</h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Refresh diagnostics"
          disabled={visibleState?.loading === true}
          onClick={() => setReloadSequence((value) => value + 1)}
        >
          {visibleState?.loading === true ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-4" />
          )}
        </Button>
      </div>

      {visibleState === null || visibleState.loading ? (
        <p role="status" className="mt-3 text-sm text-[var(--color-text-muted)]">
          Loading diagnostics…
        </p>
      ) : null}
      {visibleState !== null && !visibleState.loading && response === null ? (
        <p role="alert" className="mt-3 text-sm text-red-500">
          Diagnostics are temporarily unavailable.
        </p>
      ) : null}
      {response?.kind === 'error' ? (
        <p role="alert" className="mt-3 text-sm text-red-500">
          Diagnostics are temporarily unavailable ({response.error.reason}).
        </p>
      ) : null}
      {response?.kind === 'success' ? (
        response.items.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-text-muted)]">No diagnostics found.</p>
        ) : (
          <ul aria-label="Hosted diagnostic items" className="mt-3 space-y-2">
            {response.items.map((item) => (
              <li
                key={item.referenceId}
                data-diagnostic-reference-id={item.referenceId}
                className="rounded-md bg-[var(--color-surface-raised)] p-3 text-xs"
              >
                <p className="font-medium">
                  {item.kind}: {item.outcome}
                </p>
                <p className="mt-1 text-[var(--color-text-muted)]">{item.referenceId}</p>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
};
