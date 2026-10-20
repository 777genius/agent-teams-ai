import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createLogger } from '@shared/utils/logger';

import { listGatewayBindings, unbindGatewayMember } from '../adapters/gatewayProviderApi';

import { createGatewayBindingDraft } from './GatewayBindingDraft';

import type { GatewayMemberBindingDto } from '../../contracts';

const NO_MEMBERS: ReadonlySet<string> = new Set();

export interface GatewayMemberBindingsState {
  boundMemberNames: ReadonlySet<string>;
  pending: boolean;
  error: string | null;
  refresh(binding?: GatewayMemberBindingDto): Promise<void>;
  onBindingPendingChange?: (pending: boolean) => void;
  runBinding?(operation: () => Promise<GatewayMemberBindingDto>): Promise<GatewayMemberBindingDto>;
}

/** Dialog-local gateway facts and draft ownership; main revalidates credentials on launch. */
export function useGatewayMemberBindings(
  teamName?: string,
  draft?: {
    memberNames: readonly string[];
    mode: 'roster' | 'addition';
  }
): GatewayMemberBindingsState & {
  run<T>(operation: () => T | Promise<T>, confirmedNames?: readonly string[]): Promise<T>;
  markSaved(names: readonly string[]): void;
} {
  const name = teamName?.trim() ?? '';
  const mounted = useRef(true);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [bindingRequests, setBindingRequests] = useState(0);
  const onBindingPendingChange = useCallback((pending: boolean) => {
    if (mounted.current) setBindingRequests((count) => Math.max(0, count + (pending ? 1 : -1)));
  }, []);
  const draftSession = useRef<ReturnType<typeof createGatewayBindingDraft> | null>(null);
  if (!draftSession.current)
    draftSession.current = createGatewayBindingDraft(unbindGatewayMember, (error) => {
      createLogger('GatewayBindingDraft').warn(
        `Could not discard a draft gateway binding: ${String(error)}`
      );
      if (mounted.current) setDraftError(error instanceof Error ? error.message : String(error));
    });
  const session = draftSession.current;
  const run = useCallback(
    async <T>(operation: () => T | Promise<T>, confirmedNames?: readonly string[]): Promise<T> => {
      onBindingPendingChange(true);
      try {
        return await session.run(operation, confirmedNames);
      } finally {
        onBindingPendingChange(false);
      }
    },
    [session, onBindingPendingChange]
  );
  const draftMode = draft?.mode;
  const memberNamesKey = JSON.stringify(
    draft?.memberNames.map((member) => member.trim()).filter(Boolean) ?? []
  );
  useEffect(() => {
    session.update(
      name && draftMode
        ? { teamName: name, memberNames: JSON.parse(memberNamesKey) as string[], mode: draftMode }
        : null
    );
  }, [session, name, memberNamesKey, draftMode]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      session.discard();
    };
  }, [session]);
  const sequence = useRef(0);
  const [state, setState] = useState<{
    teamName: string;
    names: ReadonlySet<string>;
    error: string | null;
  } | null>(null);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!name) return;
    try {
      const bindings = await listGatewayBindings(name);
      if (sequence.current === request) {
        if (draftMode) session.observe(name, bindings);
        setState({
          teamName: name,
          names: new Set(bindings.map((binding) => binding.memberName)),
          error: null,
        });
      }
    } catch (error) {
      if (sequence.current === request) {
        setState({
          teamName: name,
          names: NO_MEMBERS,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }, [name, session, draftMode]);
  useEffect(() => {
    if (!name) setState(null);
    void refresh().catch(() => undefined);
    return () => {
      sequence.current += 1;
    };
  }, [refresh, name]);
  const current = state?.teamName === name ? state : null;
  return useMemo(
    () => ({
      boundMemberNames: current?.names ?? NO_MEMBERS,
      pending: Boolean(name) && (!current || Boolean(current.error) || bindingRequests > 0),
      error: current?.error ?? draftError,
      run,
      runBinding: session.runBinding,
      onBindingPendingChange,
      markSaved: (names: readonly string[]) =>
        session.markSaved(name, names, draftMode === 'roster'),
      refresh,
    }),
    [
      current,
      name,
      refresh,
      draftError,
      session,
      draftMode,
      bindingRequests,
      onBindingPendingChange,
      run,
    ]
  );
}
