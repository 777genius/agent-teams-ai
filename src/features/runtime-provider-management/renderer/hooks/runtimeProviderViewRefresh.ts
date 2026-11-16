import { api } from '@renderer/api';

import { selectInitialProviderId } from '../../core/domain';

import * as connectionForm from './runtimeProviderConnectInput';
import { presentManagementView } from './runtimeProviderManagementPresentation';

import type { useRuntimeProviderProjectContext } from './useRuntimeProviderProjectContext';
import type {
  RuntimeProviderManagementErrorDiagnosticsDto,
  RuntimeProviderManagementRuntimeId,
  RuntimeProviderManagementViewDto,
} from '@features/runtime-provider-management/contracts';
import type { Dispatch, SetStateAction } from 'react';

type RefreshContext = ReturnType<typeof useRuntimeProviderProjectContext> & {
  enabled: boolean;
  runtimeId: RuntimeProviderManagementRuntimeId;
  connectionContextToken?: string;
  viewRequestedRef: { current: boolean };
  viewLoadRequestSeq: { current: number };
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setErrorDiagnostics: Dispatch<SetStateAction<RuntimeProviderManagementErrorDiagnosticsDto | null>>;
  setView: Dispatch<SetStateAction<RuntimeProviderManagementViewDto | null>>;
  setSelectedModelId: Dispatch<SetStateAction<string | null>>;
  setSelectedProviderId: Dispatch<SetStateAction<string | null>>;
};

type ViewLoadPhase =
  | 'start'
  | 'response-checked'
  | 'response-error'
  | 'view-set'
  | 'error-checked'
  | 'finished';

const diagnosticOwners = new WeakMap<object, number>();
let nextDiagnosticOwner = 0;
const inheritanceFieldNames = [
  'configuredModels',
  'projectPath',
  'projectDefaultModel',
  'allProjectsDefaultModel',
  'defaultModelSource',
] as const;

/** The original refresh operation; passive records never control its result or currentness. */
export async function refreshRuntimeProviderView(
  context: RefreshContext,
  input: { silent?: boolean } = {}
): Promise<boolean> {
  if (!context.enabled) {
    return true;
  }
  context.viewRequestedRef.current = true;
  const projectContext = context.getProjectContextSnapshot();
  const requestSeq = context.viewLoadRequestSeq.current + 1;
  context.viewLoadRequestSeq.current = requestSeq;
  let sequenceCurrent: boolean | null = null;
  let contextCurrent: boolean | null = null;
  const requestIsCurrent = (): boolean => {
    sequenceCurrent = context.viewLoadRequestSeq.current === requestSeq;
    contextCurrent = null;
    if (!sequenceCurrent) {
      return false;
    }
    contextCurrent = context.isProjectContextCurrent(projectContext);
    return contextCurrent;
  };
  const silent = input.silent === true;
  const observe = (
    phase: ViewLoadPhase,
    view?: RuntimeProviderManagementViewDto | null,
    loadingFalseSet: boolean | null = null
  ): void => {
    try {
      if (!Number.isSafeInteger(requestSeq) || requestSeq <= 0) {
        return;
      }
      let owner = diagnosticOwners.get(context.viewLoadRequestSeq);
      if (owner === undefined) {
        const nextOwner = nextDiagnosticOwner + 1;
        if (!Number.isSafeInteger(nextOwner)) {
          return;
        }
        diagnosticOwners.set(context.viewLoadRequestSeq, nextOwner);
        nextDiagnosticOwner = nextOwner;
        owner = nextOwner;
      }
      const inheritanceFields = view
        ? inheritanceFieldNames.reduce(
            (mask, field, index) => mask + (Object.hasOwn(view, field) ? 2 ** index : 0),
            0
          )
        : null;
      console.debug(
        JSON.stringify({
          kind: 'runtime-provider-view-load-v1',
          owner,
          request: requestSeq,
          phase,
          silent,
          sequenceCurrent: phase === 'finished' && silent ? null : sequenceCurrent,
          contextCurrent: phase === 'finished' && silent ? null : contextCurrent,
          viewPresent: view === undefined ? null : view !== null,
          inheritanceFields,
          loadingFalseSet,
        })
      );
    } catch {
      // Diagnostic bookkeeping, projection or emission cannot replace the original operation.
    }
  };
  if (!silent) {
    context.setLoading(true);
  }
  context.setError(null);
  context.setErrorDiagnostics(null);
  try {
    observe('start');
    const response = await api.runtimeProviderManagement.loadView({
      ...connectionForm.runtimeProviderContext(
        context.runtimeId,
        projectContext.path,
        context.connectionContextToken
      ),
    });
    const current = requestIsCurrent();
    observe('response-checked');
    if (!current) {
      return false;
    }
    if (response.error) {
      if (!silent) {
        context.setView(null);
      }
      context.setError(response.error.message);
      context.setErrorDiagnostics(response.error.diagnostics ?? null);
      observe('response-error');
      return false;
    }
    const nextView = presentManagementView(response.view ?? null);
    context.setView(nextView);
    context.setSelectedModelId(nextView?.defaultModel ?? null);
    context.setSelectedProviderId((current) => {
      if (current && nextView?.providers.some((provider) => provider.providerId === current)) {
        return current;
      }
      return selectInitialProviderId(nextView);
    });
    observe('view-set', nextView);
    return true;
  } catch (loadError) {
    const current = requestIsCurrent();
    observe('error-checked');
    if (!current) {
      return false;
    }
    if (!silent) {
      context.setView(null);
    }
    context.setError(loadError instanceof Error ? loadError.message : 'Failed to load providers');
    context.setErrorDiagnostics(null);
    return false;
  } finally {
    let loadingFalseSet = false;
    if (!silent && requestIsCurrent()) {
      context.setLoading(false);
      loadingFalseSet = true;
    }
    observe('finished', undefined, loadingFalseSet);
  }
}
