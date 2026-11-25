import { ManagementCommandError } from '../management/commandRecords.js';
import type { LocalModelReadinessOrigin } from '../management/commandRecords.js';
import { nativeLocalReadinessPurpose } from '../management/ModelProbeOwner.js';
import type { ModelProbeInput, NativeModelProbe, NativeModelProbePurpose } from '../management/ModelProbeOwner.js';
import type { OpenCodeManagementProfile } from '../management/profile.js';
import type { RegisteredProcessRootSource } from '../process/registeredProcessContracts.js';
import type { OpenCodeManagementHost } from '../adapters/providers/OpenCodeManagementHost.js';
import { withOpenCodeModelLimits } from '../adapters/providers/withOpenCodeModelLimits.js';
import { selectedOpenCodeManagedLimits } from './openCodeManagedPreferences.js';
import { readOpenCodeCatalog } from '../adapters/providers/readOpenCodeCatalog.js';
import { createOpenCodeV2ModelProbe } from '../adapters/providers/OpenCodeV2ModelProbe.js';
import { createV1CoordinationProbe } from '../adapters/providers/OpenCodeCoordinationProbe.js';
import type { OpenCodeV1Coordination } from '../adapters/providers/OpenCodeCoordinationProbe.js';
import { createOpenCodeLocalModelReadiness } from '../adapters/providers/OpenCodeLocalModelReadiness.js';
import type { NativeReadinessCoordination } from '../adapters/providers/OpenCodeLocalModelReadiness.js';
import { closeCoordinationByDeadline } from '../adapters/providers/OpenCodeCoordinationEndpoint.js';
import type { AcceptedOpenCodeV2FileKey } from '../adapters/providers/OpenCodeV2SelectedFileKey.js';

interface ProviderModelProbePreparationPorts {
  processCustody: RegisteredProcessRootSource | undefined;
  assertCurrent(): void;
  captureTargetCurrent(current: () => boolean): () => boolean;
  withHost(operation: { deadline: number; signal: AbortSignal; commandId: string; isCurrent(): boolean },
    action: (host: OpenCodeManagementHost, options: { signal: AbortSignal; timeoutMs: number }) => Promise<boolean>): Promise<boolean>;
  createHost(profile: OpenCodeManagementProfile, coordination?: OpenCodeV1Coordination): OpenCodeManagementHost;
  retireHost(host: OpenCodeManagementHost): Promise<boolean>;
  beginReplacement(): void;
  publishHost(host: OpenCodeManagementHost): void;
  endReplacement(): void;
}

/** Preparation only. The Coordinator retains the admitted process selection, queue and cache. */
export function prepareOpenCodeModelProbe(profile: OpenCodeManagementProfile, input: ModelProbeInput,
  isCurrent: () => boolean, ports: ProviderModelProbePreparationPorts,
  purpose?: NativeModelProbePurpose,
  observeProvider?: (provider: unknown, fileProof?: AcceptedOpenCodeV2FileKey) => boolean,
  origin?: LocalModelReadinessOrigin): NativeModelProbe {
  if (purpose === nativeLocalReadinessPurpose) {
    const model = input.modelId.startsWith(input.providerId + '/') ? input.modelId : input.providerId + '/' + input.modelId;
    const limits = profile.nativeGeneration === 'v2' ? undefined
      : input.limits ?? selectedOpenCodeManagedLimits(profile.managedPreferences, model);
    const selected = { ...input, ...(limits ? { limits } : {}) };
    return createOpenCodeLocalModelReadiness(profile, selected, isCurrent, {
      ordinary: (observe, current) => prepareOpenCodeModelProbe(profile, selected, current, ports, undefined, observe),
      coordination: (provider, key, current) => profile.nativeGeneration === 'v2'
        ? createOpenCodeV2ModelProbe(profile, selected, current, {
          ...(ports.processCustody ? { processCustody: ports.processCustody } : {}),
          coordination: true, readiness: { expectedProvider: provider } })
        : prepareCoordination(profile, selected, current, ports, { provider, ...(key === undefined ? {} : { key }) }),
    }, origin);
  }
  if (profile.nativeGeneration === 'v2') {
    return createOpenCodeV2ModelProbe(profile, input, ports.captureTargetCurrent(isCurrent), { ...(ports.processCustody ? { processCustody: ports.processCustody } : {}),
      ...(purpose ? { coordination: true } : {}), ...(observeProvider ? { readiness: { observeProvider } } : {}) });
  }
  const timeoutMs = profile.modelProbeTimeoutMs ?? 90000;
  let deadline = Date.now() + timeoutMs;
  let host: OpenCodeManagementHost | undefined;
  const qualifiedModel = input.modelId.startsWith(input.providerId + '/')
    ? input.modelId : `${input.providerId}/${input.modelId}`;
  const limits = input.limits ?? selectedOpenCodeManagedLimits(profile.managedPreferences, qualifiedModel);
  if (purpose) {
    const coordination = prepareCoordination(profile, { ...input, ...(limits ? { limits } : {}) }, isCurrent, ports);
    if (!coordination) throw new ManagementCommandError('held');
    return coordination;
  }
  if (!limits)
    return {
      timeoutMs,
      run: (signal, originalDeadline) => {
        if (observeProvider) {
          if (originalDeadline === undefined) throw new ManagementCommandError('invalid');
          deadline = originalDeadline;
        }
        return ports.withHost({ deadline, signal, commandId: input.commandId, isCurrent }, (selected, options) => {
          host = selected;
          return selected.probeModel(
            {
              providerId: input.providerId,
              modelId: input.modelId,
              ...(profile.variant === undefined ? {} : { variant: profile.variant }),
            },
            options.signal,
            options.timeoutMs,
            isCurrent,
            observeProvider ? { deadline, observeProvider } : undefined
          );
        });
      },
      close: () => {
        const work = host ? ports.retireHost(host) : Promise.resolve(true);
        return observeProvider ? closeCoordinationByDeadline(work, deadline) : work;
      },
    };
  // Construction allocates no process. Durable admission must precede native calls.
  const limited = ports.createHost(
    withOpenCodeModelLimits(profile, { ...input, limits })
  );
  return {
    timeoutMs,
    run: (signal, originalDeadline) => {
      if (observeProvider) {
        if (originalDeadline === undefined) throw new ManagementCommandError('invalid');
        deadline = originalDeadline;
      }
      return ports.withHost({ deadline, signal, commandId: input.commandId, isCurrent }, async (selected, options) => {
        host = selected;
        ports.beginReplacement();
        const catalog = await selected.run(
          (client) => readOpenCodeCatalog(client, input, input.providerId),
          observeProvider ? { ...options, deadline } : options
        );
        if (!isCurrent()) throw new ManagementCommandError('held');
        const provider = catalog.providers.find((row) => row.providerId === input.providerId);
        const modelId = input.modelId.startsWith(input.providerId + '/')
          ? input.modelId.slice(input.providerId.length + 1)
          : input.modelId;
        if (
          !provider || (input.limits && !provider.configuredAuthless) ||
          !provider.models.some((row) => row.modelId === modelId) ||
          !(await ports.retireHost(selected))
        )
          throw new ManagementCommandError('held');
        options.signal.throwIfAborted();
        ports.assertCurrent();
        if (!isCurrent() || Date.now() >= deadline) throw new ManagementCommandError('held');
        ports.publishHost(limited);
        return limited.probeModel(
          {
            providerId: input.providerId,
            modelId: input.modelId,
            limits,
            ...(profile.variant === undefined ? {} : { variant: profile.variant }),
          },
          options.signal,
          deadline - Date.now(),
          isCurrent,
          observeProvider ? { deadline, observeProvider } : undefined
        );
      });
    },
    close: async () => {
      const closed = await Promise.all([
        host ? ports.retireHost(host) : Promise.resolve(true),
        ports.retireHost(limited),
      ]);
      if (closed.every(Boolean)) ports.endReplacement();
      return closed.every(Boolean);
    },
  };
}

function prepareCoordination(profile: OpenCodeManagementProfile, input: ModelProbeInput,
  isCurrent: () => boolean, ports: ProviderModelProbePreparationPorts,
  general?: { provider: Record<string, unknown>; key?: string }): NativeReadinessCoordination | undefined {
  const current = ports.captureTargetCurrent(isCurrent);
  const selected = input.limits ? withOpenCodeModelLimits(profile, { ...input, limits: input.limits }) : profile;
  return createV1CoordinationProbe(selected, input, current, {
    withHost: (operation, action) => ports.withHost(operation, action),
    create: (derived, coordination) => ports.createHost(derived, coordination),
    retire: host => ports.retireHost(host),
    begin: () => ports.beginReplacement(),
    publish: host => ports.publishHost(host),
    release: () => ports.endReplacement(),
  }, general);
}
