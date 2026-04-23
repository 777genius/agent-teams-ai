import { execCli } from '@main/utils/childProcess';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { filterVisibleProviderRuntimeModels } from '@shared/utils/providerModelVisibility';

import { buildProviderAwareCliEnv } from './providerAwareCliEnv';
import {
  buildProviderModelProbeArgs,
  classifyProviderModelProbeFailure,
  getProviderModelProbeTimeoutMs,
  isProviderModelProbeSuccessOutput,
  normalizeProviderModelProbeFailureReason,
} from './providerModelProbe';

import type { CliProviderId, CliProviderModelAvailability, CliProviderStatus } from '@shared/types';

const logger = createLogger('CliProviderModelAvailabilityService');
const MODEL_PROBE_CONCURRENCY = 3;

export interface ProviderModelAvailabilityContext {
  binaryPath: string;
  installedVersion: string | null;
  provider: Pick<
    CliProviderStatus,
    | 'providerId'
    | 'models'
    | 'supported'
    | 'authenticated'
    | 'authMethod'
    | 'selectedBackendId'
    | 'resolvedBackendId'
    | 'capabilities'
    | 'backend'
  >;
}

export interface ProviderModelAvailabilitySnapshot {
  signature: string | null;
  modelVerificationState: 'idle' | 'verifying' | 'verified';
  modelAvailability: CliProviderModelAvailability[];
}

interface ProviderModelAvailabilityCacheEntry {
  providerId: CliProviderId;
  signature: string;
  snapshot: ProviderModelAvailabilitySnapshot;
  cliEnvPromise: Promise<{ env: NodeJS.ProcessEnv; providerArgs: string[] }>;
}

type ProviderAvailabilityUpdateHandler = (
  providerId: CliProviderId,
  signature: string,
  snapshot: ProviderModelAvailabilitySnapshot
) => void;

function cloneModelAvailabilitySnapshot(
  snapshot: ProviderModelAvailabilitySnapshot
): ProviderModelAvailabilitySnapshot {
  return {
    signature: snapshot.signature,
    modelVerificationState: snapshot.modelVerificationState,
    modelAvailability: snapshot.modelAvailability.map((item) => ({ ...item })),
  };
}

function createIdleSnapshot(): ProviderModelAvailabilitySnapshot {
  return {
    signature: null,
    modelVerificationState: 'idle',
    modelAvailability: [],
  };
}

function createCheckingSnapshot(
  signature: string,
  models: string[]
): ProviderModelAvailabilitySnapshot {
  return {
    signature,
    modelVerificationState: models.length > 0 ? 'verifying' : 'verified',
    modelAvailability: models.map((modelId) => ({
      modelId,
      status: 'checking',
      reason: null,
      checkedAt: null,
    })),
  };
}

function isFinalModelAvailabilityStatus(status: CliProviderModelAvailability['status']): boolean {
  return status !== 'checking';
}

function buildProviderSignature(
  context: ProviderModelAvailabilityContext,
  visibleModels: string[]
): string {
  return JSON.stringify({
    binaryPath: context.binaryPath,
    installedVersion: context.installedVersion ?? null,
    providerId: context.provider.providerId,
    authMethod: context.provider.authMethod ?? null,
    selectedBackendId: context.provider.selectedBackendId ?? null,
    resolvedBackendId: context.provider.resolvedBackendId ?? null,
    endpointLabel: context.provider.backend?.endpointLabel ?? null,
    models: visibleModels,
  });
}

function isProviderEligibleForModelVerification(
  context: ProviderModelAvailabilityContext,
  visibleModels: string[]
): boolean {
  return (
    (context.provider.providerId === 'codex' || context.provider.providerId === 'gemini') &&
    visibleModels.length > 0 &&
    context.provider.supported === true &&
    context.provider.authenticated === true &&
    context.provider.capabilities.oneShot === true
  );
}

function classifyFailedProbe(
  modelId: string,
  error: unknown
): Pick<CliProviderModelAvailability, 'status' | 'reason'> {
  const message = getErrorMessage(error).trim();
  const normalizedReason = normalizeProviderModelProbeFailureReason(message);
  const lower = message.toLowerCase();

  if (classifyProviderModelProbeFailure(message) === 'unavailable') {
    return {
      status: 'unavailable',
      reason: normalizedReason,
    };
  }

  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('429') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504')
  ) {
    return {
      status: 'unknown',
      reason: normalizedReason,
    };
  }

  logger.warn(`Model probe inconclusive providerModel=${modelId}: ${message}`);
  return {
    status: 'unknown',
    reason: normalizedReason,
  };
}

export class CliProviderModelAvailabilityService {
  private readonly cache = new Map<string, ProviderModelAvailabilityCacheEntry>();
  private readonly queue: (() => void)[] = [];
  private activeProbeCount = 0;

  constructor(private readonly onUpdate?: ProviderAvailabilityUpdateHandler) {}

  invalidate(): void {
    this.cache.clear();
    this.queue.length = 0;
  }

  getSnapshot(context: ProviderModelAvailabilityContext): ProviderModelAvailabilitySnapshot {
    const visibleModels = filterVisibleProviderRuntimeModels(
      context.provider.providerId,
      context.provider.models
    );
    if (!isProviderEligibleForModelVerification(context, visibleModels)) {
      return createIdleSnapshot();
    }

    const signature = buildProviderSignature(context, visibleModels);
    const existing = this.cache.get(signature);
    if (existing) {
      return cloneModelAvailabilitySnapshot(existing.snapshot);
    }

    const entry: ProviderModelAvailabilityCacheEntry = {
      providerId: context.provider.providerId,
      signature,
      snapshot: createCheckingSnapshot(signature, visibleModels),
      cliEnvPromise: buildProviderAwareCliEnv({
        binaryPath: context.binaryPath,
        providerId: context.provider.providerId,
      }).then((result) => ({
        env: result.env,
        providerArgs: result.providerArgs ?? [],
      })),
    };
    this.cache.set(signature, entry);
    this.startProbes(context, entry);

    return cloneModelAvailabilitySnapshot(entry.snapshot);
  }

  private startProbes(
    context: ProviderModelAvailabilityContext,
    entry: ProviderModelAvailabilityCacheEntry
  ): void {
    for (const modelId of entry.snapshot.modelAvailability.map((item) => item.modelId)) {
      this.enqueue(async () => {
        const result = await this.probeModel(context, entry, modelId);
        const index = entry.snapshot.modelAvailability.findIndex(
          (item) => item.modelId === modelId
        );
        if (index < 0) {
          return;
        }

        entry.snapshot.modelAvailability[index] = {
          modelId,
          checkedAt: new Date().toISOString(),
          ...result,
        };
        if (
          entry.snapshot.modelAvailability.every((item) =>
            isFinalModelAvailabilityStatus(item.status)
          )
        ) {
          entry.snapshot.modelVerificationState = 'verified';
        }

        this.onUpdate?.(
          entry.providerId,
          entry.signature,
          cloneModelAvailabilitySnapshot(entry.snapshot)
        );
      });
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue.push(() => {
      this.activeProbeCount += 1;
      void task()
        .catch((error) => {
          logger.warn(`Model verification task failed: ${getErrorMessage(error)}`);
        })
        .finally(() => {
          this.activeProbeCount = Math.max(0, this.activeProbeCount - 1);
          this.drainQueue();
        });
    });
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.activeProbeCount < MODEL_PROBE_CONCURRENCY) {
      const next = this.queue.shift();
      if (!next) {
        return;
      }
      next();
    }
  }

  private async probeModel(
    context: ProviderModelAvailabilityContext,
    entry: ProviderModelAvailabilityCacheEntry,
    modelId: string
  ): Promise<Pick<CliProviderModelAvailability, 'status' | 'reason'>> {
    try {
      const { env, providerArgs } = await entry.cliEnvPromise;
      const { stdout } = await execCli(
        context.binaryPath,
        [...providerArgs, ...buildProviderModelProbeArgs(modelId)],
        {
          timeout: getProviderModelProbeTimeoutMs(context.provider.providerId),
          env,
        }
      );
      const output = stdout.trim();
      if (isProviderModelProbeSuccessOutput(output)) {
        return {
          status: 'available',
          reason: null,
        };
      }

      return {
        status: 'unknown',
        reason: output || 'Model verification returned an unexpected response.',
      };
    } catch (error) {
      return classifyFailedProbe(modelId, error);
    }
  }
}
