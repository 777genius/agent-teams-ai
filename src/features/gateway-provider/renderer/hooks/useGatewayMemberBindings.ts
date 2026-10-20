import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listGatewayBindings } from '../adapters/gatewayProviderApi';

const NO_MEMBERS: ReadonlySet<string> = new Set();

export interface GatewayMemberBindingsState {
  boundMemberNames: ReadonlySet<string>;
  pending: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

/** Dialog-local facts only; main revalidates exact credentials before every launch. */
export function useGatewayMemberBindings(teamName?: string): GatewayMemberBindingsState {
  const name = teamName?.trim() ?? '';
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
  }, [name]);
  useEffect(() => {
    void refresh().catch(() => undefined);
    return () => {
      sequence.current += 1;
    };
  }, [refresh]);
  const current = state?.teamName === name ? state : null;
  return useMemo(
    () => ({
      boundMemberNames: current?.names ?? NO_MEMBERS,
      pending: Boolean(name) && (!current || Boolean(current.error)),
      error: current?.error ?? null,
      refresh,
    }),
    [current, name, refresh]
  );
}
