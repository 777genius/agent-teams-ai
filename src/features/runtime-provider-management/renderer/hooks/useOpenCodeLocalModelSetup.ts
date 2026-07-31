import { useCallback, useEffect, useRef, useState } from 'react';

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
  onConfigured,
  onReady,
}: {
  projectPath: string | null;
  addingMessage: string;
  chooseProjectMessage: string;
  onConfigured: (projectPath: string) => void | Promise<void>;
  onReady: (modelRoute: string) => void;
}): {
  actionByRoute: Record<string, OpenCodeLocalModelSetupActionState>;
  addAndTest: (target: OpenCodeLocalModelSetupTarget) => Promise<void>;
} {
  const normalizedProjectPath = projectPath?.trim() ?? '';
  const activeScopeRef = useRef(normalizedProjectPath);
  const [actionByRoute, setActionByRoute] = useState<
    Record<string, OpenCodeLocalModelSetupActionState>
  >({});

  useEffect(() => {
    if (activeScopeRef.current === normalizedProjectPath) return;
    activeScopeRef.current = normalizedProjectPath;
    setActionByRoute({});
  }, [normalizedProjectPath]);

  const addAndTest = useCallback(
    async (target: OpenCodeLocalModelSetupTarget): Promise<void> => {
      const actionScope = normalizedProjectPath;
      if (!actionScope) {
        setActionByRoute((current) => ({
          ...current,
          [target.modelRoute]: { status: 'error', message: chooseProjectMessage },
        }));
        return;
      }

      setActionByRoute((current) => ({
        ...current,
        [target.modelRoute]: { status: 'adding', message: addingMessage },
      }));
      const result = await addAndTestOpenCodeLocalModel({
        projectPath: actionScope,
        target,
        dependencies: {
          configureLocalProvider: (input) =>
            api.runtimeProviderManagement.configureLocalProvider(input),
          prepareProvisioning: (...args) => api.teams.prepareProvisioning(...args),
          testModel: (input) => api.runtimeProviderManagement.testModel(input),
        },
        onConfigured: () => onConfigured(actionScope),
      });
      if (activeScopeRef.current !== actionScope) return;

      setActionByRoute((current) => ({
        ...current,
        [target.modelRoute]: result,
      }));
      if (result.status !== 'error') {
        void (async () => {
          try {
            await onConfigured(actionScope);
          } catch {
            // The in-memory verification result remains valid; a later refresh can catch up.
          }
        })();
      }
      if (result.status === 'ready') {
        onReady(target.modelRoute);
      }
    },
    [addingMessage, chooseProjectMessage, normalizedProjectPath, onConfigured, onReady]
  );

  return { actionByRoute, addAndTest };
}
