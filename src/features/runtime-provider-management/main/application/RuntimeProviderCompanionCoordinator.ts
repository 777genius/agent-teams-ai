import { getErrorMessage } from '@shared/utils/errorHandling';

import type { RuntimeProviderManagementPort } from '../../core/application';
import type {
  RuntimeProviderCompanionRegistry,
  RuntimeProviderCompanionRegistryEntry,
} from '../infrastructure/cli-companion/types';
import type {
  RuntimeProviderCompanionIdDto,
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
} from '@features/runtime-provider-management/contracts';

interface CompanionOperationQueue {
  tail: Promise<void>;
  activeByRequest: Map<string, Promise<RuntimeProviderCompanionStatusDto>>;
}

export class RuntimeProviderCompanionCoordinator {
  readonly #port: RuntimeProviderManagementPort;
  readonly #registry: RuntimeProviderCompanionRegistry;
  readonly #operationQueues = new Map<RuntimeProviderCompanionIdDto, CompanionOperationQueue>();

  constructor(port: RuntimeProviderManagementPort, registry: RuntimeProviderCompanionRegistry) {
    this.#port = port;
    this.#registry = registry;
  }

  async getStatus(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto> {
    const entry = this.#getEntry(input);
    if (this.#operationQueues.has(input.companionId)) {
      return entry.service.getCurrentStatus();
    }
    return entry.service.getStatus();
  }

  async installAndConnect(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto> {
    const entry = this.#getEntry(input);
    return this.#runCompanionOperation(input, 'install-and-connect', async () =>
      this.#verifyConnectedCompanion(input, entry, await entry.service.installAndConnect())
    );
  }

  async connect(input: RuntimeProviderCompanionInput): Promise<RuntimeProviderCompanionStatusDto> {
    const entry = this.#getEntry(input);
    return this.#runCompanionOperation(input, 'connect', async () =>
      this.#verifyConnectedCompanion(input, entry, await entry.service.connect())
    );
  }

  #runCompanionOperation(
    input: RuntimeProviderCompanionInput,
    operation: 'connect' | 'install-and-connect',
    run: () => Promise<RuntimeProviderCompanionStatusDto>
  ): Promise<RuntimeProviderCompanionStatusDto> {
    const requestKey = `${operation}\0${input.projectPath?.trim() ?? ''}`;
    let queue = this.#operationQueues.get(input.companionId);
    if (!queue) {
      queue = { tail: Promise.resolve(), activeByRequest: new Map() };
      this.#operationQueues.set(input.companionId, queue);
    }
    const active = queue.activeByRequest.get(requestKey);
    if (active) return active;

    const promise = queue.tail.then(run);
    queue.activeByRequest.set(requestKey, promise);
    queue.tail = promise.then(
      () => undefined,
      () => undefined
    );
    const clearRequest = (): void => {
      if (queue.activeByRequest.get(requestKey) === promise) {
        queue.activeByRequest.delete(requestKey);
      }
      if (
        queue.activeByRequest.size === 0 &&
        this.#operationQueues.get(input.companionId) === queue
      ) {
        this.#operationQueues.delete(input.companionId);
      }
    };
    void promise.then(clearRequest, clearRequest);
    return promise;
  }

  #getEntry(input: RuntimeProviderCompanionInput): RuntimeProviderCompanionRegistryEntry {
    const entry = this.#registry.get(input.companionId);
    if (!entry) throw new Error('Unsupported runtime provider companion');
    return entry;
  }

  async #verifyConnectedCompanion(
    input: RuntimeProviderCompanionInput,
    entry: RuntimeProviderCompanionRegistryEntry,
    status: RuntimeProviderCompanionStatusDto
  ): Promise<RuntimeProviderCompanionStatusDto> {
    if (!status.authenticated) return status;
    entry.service.setModelVerificationPending();
    let response;
    try {
      response = await this.#port.testModel({
        runtimeId: 'opencode',
        providerId: entry.verification.providerId,
        modelId: entry.verification.modelId,
        projectPath: input.projectPath ?? null,
      });
    } catch (error) {
      return entry.service.setModelVerificationResult(false, getErrorMessage(error));
    }
    const ok = response.result?.ok === true && response.result.availability === 'available';
    const detail =
      response.result?.message ??
      response.error?.message ??
      (ok
        ? `${entry.verification.modelId} completed a verified OpenCode request.`
        : `OpenCode could not verify ${entry.verification.modelId}.`);
    return entry.service.setModelVerificationResult(ok, detail);
  }
}
