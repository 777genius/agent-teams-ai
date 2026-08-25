import { randomBytes, randomUUID } from 'node:crypto';

import {
  ExecuteRuntimeIngress,
  RevokeRuntimeIngressCredential,
} from '../../core/application/runtime-ingress';
import { RuntimeIngressHttpInputAdapter } from '../adapters/input/runtime-ingress/RuntimeIngressHttpInputAdapter';
import {
  RuntimeIngressRateLimiter,
  type RuntimeIngressRateLimitPolicy,
} from '../adapters/input/runtime-ingress/RuntimeIngressRateLimiter';
import {
  FileRuntimeIngressDurableStore,
  type RuntimeIngressStoreKeyring,
  type RuntimeIngressStoreLimits,
} from '../adapters/output/runtime-ingress/FileRuntimeIngressDurableStore';
import { FixedScopeRuntimeIngressRelay } from '../adapters/output/runtime-ingress/FixedScopeRuntimeIngressRelay';

import type {
  RuntimeIngressClockPort,
  RuntimeIngressDurableAntiRollbackFencePort,
  RuntimeIngressRelayAuthoritySourcePort,
} from '../../core/application/runtime-ingress';
import type { RuntimeIngressRelaySecretSource } from '../adapters/output/runtime-ingress/InheritedFdRuntimeIngressSecretSource';

export interface RuntimeIngressFeatureClock extends RuntimeIngressClockPort {
  nowEpochMs(): number;
}

export interface CreateRuntimeIngressFeatureDeps {
  readonly snapshotPath: string;
  readonly keyring: RuntimeIngressStoreKeyring;
  readonly antiRollbackFence: RuntimeIngressDurableAntiRollbackFencePort;
  readonly relaySecretSource: RuntimeIngressRelaySecretSource;
  readonly relayAuthoritySource: RuntimeIngressRelayAuthoritySourcePort;
  readonly storeLimits?: Partial<RuntimeIngressStoreLimits>;
  readonly clock?: RuntimeIngressFeatureClock;
  readonly rateLimitPolicy?: RuntimeIngressRateLimitPolicy;
  readonly bodyLimitBytes?: number;
  readonly nextRequestId?: () => string;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export function createRuntimeIngressFeature(deps: CreateRuntimeIngressFeatureDeps) {
  const clock = deps.clock ?? systemClock();
  const store = new FileRuntimeIngressDurableStore(
    deps.snapshotPath,
    deps.keyring,
    deps.antiRollbackFence,
    deps.storeLimits
  );
  const executeRuntimeIngress = new ExecuteRuntimeIngress(store, clock);
  const revokeRuntimeIngressCredential = new RevokeRuntimeIngressCredential(store);
  const rateLimiter = new RuntimeIngressRateLimiter(() => clock.nowEpochMs(), deps.rateLimitPolicy);
  const httpInput = new RuntimeIngressHttpInputAdapter({
    executeRuntimeIngress,
    credentialContext: store,
    rateLimiter,
    nextRequestId: deps.nextRequestId ?? (() => `runtime-request:${randomUUID()}`),
    bodyLimitBytes: deps.bodyLimitBytes,
  });
  const relay = new FixedScopeRuntimeIngressRelay({
    store,
    commandOrchestration: httpInput,
    authoritySource: deps.relayAuthoritySource,
    secretSource: deps.relaySecretSource,
    clock,
    randomBytes: deps.randomBytes ?? randomBytes,
  });
  return Object.freeze({
    store,
    executeRuntimeIngress,
    revokeRuntimeIngressCredential,
    httpInput,
    relay,
  });
}

function systemClock(): RuntimeIngressFeatureClock {
  return Object.freeze({
    nowIso: () => new Date().toISOString(),
    nowEpochMs: () => Date.now(),
  });
}
