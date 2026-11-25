import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useRetainedLegacyLaunch } from '@features/agent-backend/renderer';
import { api } from '@renderer/api';

import {
  addAndTestOpenCodeLocalModel,
  type OpenCodeLocalModelSetupResult,
  type OpenCodeLocalModelSetupTarget,
} from '../openCodeLocalModelSetup';

export type OpenCodeLocalModelSetupActionState =
  | OpenCodeLocalModelSetupResult
  | { status: 'adding'; message: string };

export function useOpenCodeLocalModelSetup({
  projectPath,
  addingMessage,
  chooseProjectMessage,
  autoSelectContextKey,
  onConfigured,
  onReady,
}: {
  projectPath: string | null;
  addingMessage: string;
  chooseProjectMessage: string;
  autoSelectContextKey: string;
  onConfigured: (projectPath: string) => void | Promise<void>;
  onReady: (modelRoute: string) => void;
}): {
  actionByRoute: Record<string, OpenCodeLocalModelSetupActionState>;
  addAndTest: (target: OpenCodeLocalModelSetupTarget) => Promise<void>;
} {
  const retained = useRetainedLegacyLaunch();
  const management = retained?.management;
  const normalizedProjectPath = projectPath?.trim() ?? '';
  const activeScopeKey = JSON.stringify([retained?.choice.scopeId, normalizedProjectPath]);
  const activeScopeRef = useRef(activeScopeKey);
  const mountedRef = useRef(true);
  const inFlightActionsRef = useRef(new Set<string>());
  const autoSelectContextRef = useRef({ key: autoSelectContextKey, revision: 0 });
  const [actionByRoute, setActionByRoute] = useState<
    Record<string, OpenCodeLocalModelSetupActionState>
  >({});

  useLayoutEffect(() => {
    if (autoSelectContextRef.current.key === autoSelectContextKey) return;
    autoSelectContextRef.current = {
      key: autoSelectContextKey,
      revision: autoSelectContextRef.current.revision + 1,
    };
  }, [autoSelectContextKey]);

  useEffect(() => {
    if (activeScopeRef.current === activeScopeKey) return;
    activeScopeRef.current = activeScopeKey;
    setActionByRoute({});
  }, [activeScopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addAndTest = useCallback(
    async (target: OpenCodeLocalModelSetupTarget): Promise<void> => {
      const actionScope = normalizedProjectPath;
      const actionIdentity = activeScopeKey;
      if (!actionScope) {
        setActionByRoute((current) => ({
          ...current,
          [target.modelRoute]: { status: 'error', message: chooseProjectMessage },
        }));
        return;
      }

      const actionKey = `${actionIdentity}\0${target.modelRoute}`;
      if (inFlightActionsRef.current.has(actionKey)) return;
      inFlightActionsRef.current.add(actionKey);
      const autoSelectRevision = autoSelectContextRef.current.revision;

      setActionByRoute((current) => ({
        ...current,
        [target.modelRoute]: { status: 'adding', message: addingMessage },
      }));
      const result = await addAndTestOpenCodeLocalModel({
        projectPath: actionScope,
        target,
        dependencies: {
          configureLocalProvider: (input) =>
            (management ?? api.runtimeProviderManagement).configureLocalProvider(input),
          prepareProvisioning: retained?.prepareProvisioning ?? api.teams.prepareProvisioning,
        },
        onConfigured: () => onConfigured(actionScope),
      });
      inFlightActionsRef.current.delete(actionKey);
      if (!mountedRef.current || activeScopeRef.current !== actionIdentity) return;

      setActionByRoute((current) => ({
        ...current,
        [target.modelRoute]: result,
      }));
      if (
        result.status === 'ready' &&
        autoSelectContextRef.current.revision === autoSelectRevision
      ) {
        onReady(target.modelRoute);
      }
    },
    [activeScopeKey, addingMessage, chooseProjectMessage, management, normalizedProjectPath, onConfigured, onReady, retained]
  );

  return { actionByRoute, addAndTest };
}
