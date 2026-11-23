import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { subscribeContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';

import {
  closeRetainedLegacyLaunch,
  createRetainedLegacyLaunchClient,
  RetainedLegacyLaunchError,
} from './retainedLegacyLaunch';
import {
  RetainedLegacyLaunchContext,
  RetainedLegacyProjectContext,
} from './RetainedLegacyLaunchContext';

import type { RetainedLegacyLaunchChoice } from './retainedLegacyLaunch';
import type { ReactNode } from 'react';

/** Temporary dialog ownership; the selected Host and saved settings remain separate. */
export const RetainedLegacyLaunchScope = ({
  choice,
  children,
}: {
  choice?: RetainedLegacyLaunchChoice;
  children: ReactNode;
}) => {
  const [selection, setSelection] = useState({ original: choice, selected: choice });
  const selected = selection.original === choice ? selection.selected : choice;
  const client = useMemo(
    () => (selected ? createRetainedLegacyLaunchClient(selected) : null),
    [selected]
  );
  const lifecycle = useRef({ revision: 0, active: client, mounted: false }).current;
  lifecycle.active = client;
  const rebindIntent = useRef<{
    scopeId: string;
    projectPath: string;
    intentId: string;
    pending: boolean;
  } | null>(null);
  if (rebindIntent.current && rebindIntent.current.scopeId !== client?.choice.scopeId)
    rebindIntent.current = null;
  useEffect(() => {
    lifecycle.mounted = true;
    const unsubscribe = subscribeContextScopedRequestEpoch(() => {
      void client?.close();
    });
    const revision = ++lifecycle.revision;
    return () => {
      lifecycle.mounted = false;
      unsubscribe();
      // Development effect replay keeps the mounted choice; a real unmount closes it.
      queueMicrotask(() => {
        if (lifecycle.revision === revision || lifecycle.active !== client) void client?.close();
      });
    };
  }, [client, lifecycle]);
  const rebind = useCallback(
    async (projectPath: string, apply: (path: string) => void) => {
      if (!client || !lifecycle.mounted || lifecycle.active !== client)
        throw new RetainedLegacyLaunchError(
          'not-dispatched',
          'Original runtime choice changed. Reopen Launch.'
        );
      const path = projectPath.trim();
      let intent = rebindIntent.current;
      if (
        intent &&
        (intent.scopeId !== client.choice.scopeId || intent.projectPath !== path || intent.pending)
      )
        throw new RetainedLegacyLaunchError(
          'unknown',
          'Recover the previous project change before choosing another project.'
        );
      intent ??= {
        scopeId: client.choice.scopeId,
        projectPath: path,
        intentId: crypto.randomUUID(),
        pending: false,
      };
      rebindIntent.current = intent;
      intent.pending = true;
      try {
        const next = await client.rebind(path, intent.intentId);
        if (!lifecycle.mounted || lifecycle.active !== client) {
          await closeRetainedLegacyLaunch(next);
          throw new RetainedLegacyLaunchError(
            'unknown',
            'Launch was closed while changing project. Reopen Launch.'
          );
        }
        apply(next.projectPath);
        setSelection({ original: choice, selected: next });
        if (rebindIntent.current === intent) rebindIntent.current = null;
      } catch (error) {
        if (
          error instanceof RetainedLegacyLaunchError &&
          error.outcome === 'not-dispatched' &&
          rebindIntent.current === intent
        )
          rebindIntent.current = null;
        throw error;
      } finally {
        intent.pending = false;
      }
    },
    [choice, client, lifecycle]
  );
  return (
    <RetainedLegacyLaunchContext.Provider value={client}>
      <RetainedLegacyProjectContext.Provider value={client ? rebind : null}>
        {children}
      </RetainedLegacyProjectContext.Provider>
    </RetainedLegacyLaunchContext.Provider>
  );
};
