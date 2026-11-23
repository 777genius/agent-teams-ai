import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import {
  capturedLegacyChoiceTransport,
  closeRetainedLegacyIntent,
  closeRetainedLegacyLaunch,
  isRetainedLegacyChoice,
  retainLegacyChoice,
} from './retainedLegacyChoices';
import { createRetainedLegacyResource } from './retainedLegacyResource';
import { RetainedLegacyLaunchError, retainedLegacyValue as value } from './retainedLegacyTransport';

import type {
  RetainedLegacyLaunchChoice,
  RetainedLegacyLaunchRequest,
  RetainedLegacyLaunchResult,
  RetainedLegacyLaunchValueMap,
} from '../contracts/retainedLegacyLaunch';
import type { RetainedLegacyResource } from './retainedLegacyResource';
import type { RetainedLegacyTransport as Transport } from './retainedLegacyTransport';
import type { RuntimeProviderManagementApi } from '@features/runtime-provider-management/contracts';
import type { TeamsAPI } from '@shared/types/api';

type ScopedRequest = Extract<RetainedLegacyLaunchRequest, { scopeId: string }>;

export function createRetainedLegacyLaunchClient(
  choice: RetainedLegacyLaunchChoice,
  suppliedTransport?: Transport,
  current: () => boolean = (() => {
    const epoch = captureContextScopedRequestEpoch();
    return () => isContextScopedRequestEpochCurrent(epoch);
  })()
) {
  const send: Transport =
    suppliedTransport ??
    capturedLegacyChoiceTransport(choice) ??
    (async () => ({ ok: false, reason: 'source-changed', outcome: 'not-dispatched' }));
  if (suppliedTransport) retainLegacyChoice(choice, suppliedTransport);
  const epoch = captureContextScopedRequestEpoch();
  let closed = false;
  let closing: Promise<void> | undefined;
  let rebindIntent:
    | { projectPath: string; intentId: string; pending?: Promise<RetainedLegacyLaunchChoice> }
    | undefined;
  const pending = new Map<string, Promise<unknown>>();
  const modelGroups = new Set<string>();
  const resources = new Map<string, RetainedLegacyResource<unknown>>();
  async function request<K extends ScopedRequest['action']>(
    input: { action: K } & Omit<Extract<ScopedRequest, { action: K }>, 'scopeId'>
  ): Promise<RetainedLegacyLaunchValueMap[K]> {
    const stopOnly = input.action === 'cancelModels';
    if (!stopOnly && (closed || !current()))
      throw new RetainedLegacyLaunchError(
        'not-dispatched',
        'Team context changed. Close and reopen Launch.'
      );
    let result: RetainedLegacyLaunchResult;
    try {
      result = await send({ ...input, scopeId: choice.scopeId } as ScopedRequest);
    } catch {
      throw new RetainedLegacyLaunchError(
        'unknown',
        'Original runtime response was lost. Check the team before trying again.'
      );
    }
    if (
      !stopOnly &&
      (!current() || (closed && input.action !== 'launch' && input.action !== 'roster'))
    ) {
      throw new RetainedLegacyLaunchError(
        'unknown',
        'Team context changed while the request was running. Check the team before trying again.'
      );
    }
    return value(result, input.action);
  }
  function read<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = pending.get(key);
    if (existing) return existing as Promise<T>;
    const next = operation().finally(() => {
      if (pending.get(key) === next) pending.delete(key);
    });
    pending.set(key, next);
    return next;
  }
  const refuseSettingsChange = async (): Promise<never> => {
    throw new Error(
      'Connection settings are fixed for this launch. Close Launch before changing the original runtime connection.'
    );
  };
  const management: RuntimeProviderManagementApi = {
    probeLocalProvider: refuseSettingsChange,
    configureLocalProvider: refuseSettingsChange,
    getCompanionStatus: refuseSettingsChange,
    installAndConnectCompanion: refuseSettingsChange,
    connectCompanion: refuseSettingsChange,
    runCompanionAction: refuseSettingsChange,
    onCompanionProgress: () => () => undefined,
    loadView: refuseSettingsChange,
    loadSetupForm: refuseSettingsChange,
    connectProvider: refuseSettingsChange,
    connectWithApiKey: refuseSettingsChange,
    forgetCredential: refuseSettingsChange,
    testModel: refuseSettingsChange,
    cancelModelTest: refuseSettingsChange,
    setDefaultModel: refuseSettingsChange,
    clearProjectDefaultModel: refuseSettingsChange,
    configureModelLimits: refuseSettingsChange,
    submitOAuthCode: refuseSettingsChange,
    cancelOAuth: refuseSettingsChange,
    onOAuthProgress: () => () => undefined,
    loadModels: (input) => {
      if (closed || !current())
        return Promise.reject(
          new RetainedLegacyLaunchError('not-dispatched', 'Original runtime choice is closed.')
        );
      if (input.requestGroupId) modelGroups.add(input.requestGroupId);
      return request({ action: 'models', input });
    },
    cancelModelLoad: (input) => {
      if (!modelGroups.has(input.requestGroupId))
        return Promise.reject(
          new RetainedLegacyLaunchError(
            'not-dispatched',
            'Model load does not belong to this original runtime choice.'
          )
        );
      return request({ action: 'cancelModels', input });
    },
    loadProviderDirectory: (input) => request({ action: 'directory', input }),
    listLocalProviders: (input) => request({ action: 'localProviders', input }),
    scanLocalProviders: (input) => request({ action: 'scanLocalProviders', input }),
  };
  const prepareProvisioning: TeamsAPI['prepareProvisioning'] = (...args) =>
    request({ action: 'prepare', args });
  const replaceMembers: TeamsAPI['replaceMembers'] = async (teamName, replacement) => {
    if (teamName !== choice.teamName)
      throw new RetainedLegacyLaunchError(
        'not-dispatched',
        'Original team selection changed. Reopen Launch.'
      );
    await request({ action: 'roster', request: replacement });
  };
  return {
    choice,
    management,
    prepareProvisioning,
    replaceMembers,
    rebind(projectPath: string, intentId: string): Promise<RetainedLegacyLaunchChoice> {
      if (closed || !current())
        return Promise.reject(
          new RetainedLegacyLaunchError('not-dispatched', 'Original runtime choice is closed.')
        );
      if (
        rebindIntent &&
        (rebindIntent.intentId !== intentId || rebindIntent.projectPath !== projectPath)
      )
        return Promise.reject(
          new RetainedLegacyLaunchError(
            'unknown',
            'Recover the previous project change before choosing another project.'
          )
        );
      rebindIntent ??= { projectPath, intentId };
      const intent = rebindIntent;
      if (intent.pending) return intent.pending;
      const operation = (async () => {
        try {
          const next = await request({ action: 'rebind', projectPath, intentId });
          if (!isRetainedLegacyChoice(next, choice.teamName) || next.scopeId === choice.scopeId) {
            await closeRetainedLegacyIntent(choice.teamName, intentId, send, epoch);
            throw new RetainedLegacyLaunchError(
              'unknown',
              'Project change could not be verified. Close Launch.'
            );
          }
          retainLegacyChoice(next, send, intentId, epoch);
          if (rebindIntent === intent) rebindIntent = undefined;
          return next;
        } catch (error) {
          if (closed || !current())
            await closeRetainedLegacyIntent(choice.teamName, intentId, send, epoch);
          if (
            error instanceof RetainedLegacyLaunchError &&
            error.outcome === 'not-dispatched' &&
            rebindIntent === intent
          )
            rebindIntent = undefined;
          throw error;
        }
      })().finally(() => {
        if (intent.pending === operation) intent.pending = undefined;
      });
      intent.pending = operation;
      return operation;
    },
    resource<T>(key: string, load: () => Promise<T>): RetainedLegacyResource<T> {
      const existing = resources.get(key);
      if (existing) return existing as RetainedLegacyResource<T>;
      const created = createRetainedLegacyResource(load);
      if (closed) created.retire();
      resources.set(key, created);
      return created;
    },
    read: () => read('read', () => request({ action: 'read' })),
    status: (projectPath: string) =>
      read('status:' + projectPath, () => request({ action: 'status', projectPath })),
    account: () => read('account', () => request({ action: 'account' })),
    opencodeRuntime: () => read('opencodeRuntime', () => request({ action: 'opencodeRuntime' })),
    codexRuntime: () => read('codexRuntime', () => request({ action: 'codexRuntime' })),
    launch: (input: Parameters<TeamsAPI['launchTeam']>[0]) => {
      if (input.teamName !== choice.teamName)
        return Promise.reject(
          new RetainedLegacyLaunchError(
            'not-dispatched',
            'Original team selection changed. Reopen Launch.'
          )
        );
      return request({ action: 'launch', request: input });
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const resource of resources.values()) resource.retire();
      const intent = rebindIntent;
      closing = (async () => {
        if (intent) await closeRetainedLegacyIntent(choice.teamName, intent.intentId, send, epoch);
        await closeRetainedLegacyLaunch(choice);
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}

export type RetainedLegacyLaunchClient = ReturnType<typeof createRetainedLegacyLaunchClient>;
export type { RetainedLegacyLaunchChoice } from '../contracts/retainedLegacyLaunch';
export { closeRetainedLegacyLaunch, openRetainedLegacyLaunch } from './retainedLegacyChoices';
export { RetainedLegacyLaunchError } from './retainedLegacyTransport';
