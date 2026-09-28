import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';
import {
  createHostedTaskBoardTransport,
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  HOSTED_TASK_BOARD_PAGE_HTTP_PATH,
} from '@features/team-task-board/renderer/hosted';

import type {
  HostedTaskBoardFetchPort,
  HostedTaskBoardPageProps,
  HostedTaskBoardTransport,
} from '@features/team-task-board/renderer/hosted';
import type { TeamId } from '@shared/contracts/hosted';

interface HostedTaskBoardInvalidationBus {
  subscribe(
    resource: 'team_task_board',
    teamId: TeamId,
    listener: (event: Readonly<{ teamId: TeamId }>) => void
  ): () => void;
}

function advertisesTaskBoardMutations(response: object): boolean {
  try {
    if (Reflect.get(response, 'status') !== 200) return false;
    const candidate = Reflect.get(response, 'headers');
    const headers = candidate !== null && typeof candidate === 'object' ? candidate : null;
    const get = headers === null ? null : Reflect.get(headers, 'get');
    return (
      typeof get === 'function' &&
      Reflect.apply(get, headers, [HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement]) ===
        'enabled'
    );
  } catch {
    return false;
  }
}

export function useHostedTaskBoardTransport(
  input: Readonly<{
    fetch: HostedTaskBoardFetchPort;
    getCsrfToken: () => string | null;
    createScope: HostedTaskBoardPageProps['createScope'];
    invalidationBus: HostedTaskBoardInvalidationBus;
    authEffectsAvailable: boolean;
    onProtectedAuthFailure?: () => void;
  }>
): Readonly<{ transport: HostedTaskBoardTransport; resetCapability: () => void }> {
  const {
    authEffectsAvailable,
    createScope,
    fetch,
    getCsrfToken,
    invalidationBus,
    onProtectedAuthFailure,
  } = input;
  const [advertisedScopeVersion, setAdvertisedScopeVersion] = useState<number | null>(null);
  const authEffectsAvailableRef = useRef(authEffectsAvailable);
  authEffectsAvailableRef.current = authEffectsAvailable;
  const authGenerationRef = useRef({ available: authEffectsAvailable, generation: 0 });
  if (authGenerationRef.current.available !== authEffectsAvailable) {
    authGenerationRef.current = {
      available: authEffectsAvailable,
      generation: authGenerationRef.current.generation + 1,
    };
  }
  const protectedAuthFailureRef = useRef(onProtectedAuthFailure);
  protectedAuthFailureRef.current = onProtectedAuthFailure;
  const mountRef = useRef({ mounted: false, generation: 0 });
  useLayoutEffect(() => {
    mountRef.current = { mounted: true, generation: mountRef.current.generation + 1 };
    return () => {
      mountRef.current = { mounted: false, generation: mountRef.current.generation + 1 };
    };
  }, []);
  useEffect(() => {
    if (!authEffectsAvailable) setAdvertisedScopeVersion(null);
  }, [authEffectsAvailable]);
  const pageRequestGeneration = useRef(0);
  const scopeRef = useRef({
    key: createScope.key,
    authorityEpoch: createScope.authorityEpoch,
    version: 0,
  });
  if (
    scopeRef.current.key !== createScope.key ||
    scopeRef.current.authorityEpoch !== createScope.authorityEpoch
  ) {
    scopeRef.current = {
      key: createScope.key,
      authorityEpoch: createScope.authorityEpoch,
      version: scopeRef.current.version + 1,
    };
    pageRequestGeneration.current += 1;
  }
  const scopeVersion = scopeRef.current.version;
  const resetCapability = (): void => {
    pageRequestGeneration.current += 1;
    setAdvertisedScopeVersion(null);
  };
  const transport = useMemo<HostedTaskBoardTransport>(() => {
    const base = createHostedTaskBoardTransport({
      fetch: async (path, init) => {
        const requestMountGeneration = mountRef.current.generation;
        const requestAuthGeneration = authGenerationRef.current.generation;
        const canApplyScope = (): boolean =>
          mountRef.current.mounted &&
          mountRef.current.generation === requestMountGeneration &&
          authGenerationRef.current.generation === requestAuthGeneration &&
          scopeRef.current.version === scopeVersion &&
          scopeRef.current.key === createScope.key &&
          scopeRef.current.authorityEpoch === createScope.authorityEpoch;
        const pageGeneration =
          path === HOSTED_TASK_BOARD_PAGE_HTTP_PATH ? pageRequestGeneration.current + 1 : null;
        if (pageGeneration !== null) pageRequestGeneration.current = pageGeneration;
        const canApplyPageAdvertisement = (): boolean =>
          pageGeneration !== null &&
          pageGeneration === pageRequestGeneration.current &&
          canApplyScope() &&
          !init.signal?.aborted;
        try {
          const response = await fetch(path, init);
          if (canApplyPageAdvertisement()) {
            setAdvertisedScopeVersion(
              authEffectsAvailableRef.current && advertisesTaskBoardMutations(response)
                ? scopeVersion
                : null
            );
          }
          if (
            authEffectsAvailableRef.current &&
            (response.status === 401 || response.status === 403) &&
            (pageGeneration !== null ? canApplyPageAdvertisement() : canApplyScope())
          ) {
            protectedAuthFailureRef.current?.();
          }
          if (
            path === HOSTED_TASK_BOARD_MUTATION_ROUTE &&
            canApplyScope() &&
            (response.status === 401 || response.status === 403 || response.status === 503)
          ) {
            setAdvertisedScopeVersion(null);
          }
          return response;
        } catch (error) {
          if (
            canApplyPageAdvertisement() ||
            (path === HOSTED_TASK_BOARD_MUTATION_ROUTE && canApplyScope())
          ) {
            setAdvertisedScopeVersion(null);
          }
          throw error;
        }
      },
      getCsrfToken,
      mutationsEnabled: authEffectsAvailable && advertisedScopeVersion === scopeVersion,
    });
    return Object.freeze({
      getPage: (...args: Parameters<typeof base.getPage>) => base.getPage(...args),
      ...(!authEffectsAvailable || base.observeCreation === undefined
        ? {}
        : {
            observeCreation: async (
              ...args: Parameters<NonNullable<typeof base.observeCreation>>
            ) => {
              const requestMountGeneration = mountRef.current.generation;
              const requestAuthGeneration = authGenerationRef.current.generation;
              const result = await base.observeCreation!(...args);
              return mountRef.current.mounted &&
                mountRef.current.generation === requestMountGeneration &&
                authGenerationRef.current.available &&
                authGenerationRef.current.generation === requestAuthGeneration &&
                scopeRef.current.version === scopeVersion
                ? result
                : Object.freeze({ kind: 'unavailable' as const });
            },
          }),
      ...(base.executeMutation === undefined
        ? {}
        : {
            executeMutation: (...args: Parameters<NonNullable<typeof base.executeMutation>>) =>
              base.executeMutation!(...args),
          }),
      subscribeToInvalidations: (
        teamId: TeamId,
        listener: (event: Readonly<{ teamId: TeamId }>) => void
      ) => invalidationBus.subscribe('team_task_board', teamId, listener),
    });
  }, [
    advertisedScopeVersion,
    authEffectsAvailable,
    createScope,
    fetch,
    getCsrfToken,
    invalidationBus,
    scopeVersion,
  ]);
  return { transport, resetCapability };
}
