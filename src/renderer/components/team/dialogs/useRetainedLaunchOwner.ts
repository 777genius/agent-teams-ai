import { useCallback, useEffect, useMemo, useRef } from 'react';

import { closeRetainedLegacyLaunch } from '@features/agent-backend/renderer';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { RetainedLegacyLaunchChoice } from '@features/agent-backend/renderer';

interface Intent {
  generation: number;
  key: string;
  epoch: ReturnType<typeof captureContextScopedRequestEpoch>;
  signal: AbortSignal;
}
const createOwner = (key: string) => ({
  mounted: false,
  generation: 0,
  key,
  choice: undefined as RetainedLegacyLaunchChoice | undefined,
  abort: new AbortController(),
});
const closeOwner = (owner: ReturnType<typeof createOwner>) => {
  owner.generation += 1;
  owner.abort.abort();
  void closeRetainedLegacyLaunch(owner.choice);
  owner.choice = undefined;
};
/** Close owns pending opens as well as the currently visible dialog. */
export function useRetainedLaunchOwner(key = '') {
  const currentOwner = useRef(createOwner(key));
  if (currentOwner.current.key !== key) currentOwner.current = createOwner(key);
  const owner = currentOwner.current;
  const close = useCallback(() => closeOwner(owner), [owner]);
  useEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      closeOwner(owner);
    };
  }, [owner]);
  const begin = useCallback((): Intent => {
    owner.abort.abort();
    owner.abort = new AbortController();
    return {
      generation: ++owner.generation,
      key: owner.key,
      epoch: captureContextScopedRequestEpoch(),
      signal: owner.abort.signal,
    };
  }, [owner]);
  const current = useCallback(
    (intent: Intent) =>
      owner.mounted &&
      currentOwner.current === owner &&
      owner.key === intent.key &&
      owner.generation === intent.generation &&
      isContextScopedRequestEpochCurrent(intent.epoch),
    [owner]
  );
  const adopt = useCallback(
    (choice: RetainedLegacyLaunchChoice | undefined) => {
      if (owner.choice?.scopeId !== choice?.scopeId) void closeRetainedLegacyLaunch(owner.choice);
      owner.choice = choice;
    },
    [owner]
  );
  return useMemo(() => ({ close, begin, current, adopt }), [close, begin, current, adopt]);
}
