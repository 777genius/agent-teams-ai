import { getErrorMessage } from '@shared/utils/errorHandling';

import type { RuntimeProviderManagementPort } from '../../core/application';
import type {
  RuntimeProviderCompanionRegistry,
  RuntimeProviderCompanionRegistryEntry,
} from '../infrastructure/cli-companion/types';
import type {
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
} from '@features/runtime-provider-management/contracts';

export class RuntimeProviderCompanionCoordinator {
  readonly #port: RuntimeProviderManagementPort;
  readonly #registry: RuntimeProviderCompanionRegistry;

  constructor(port: RuntimeProviderManagementPort, registry: RuntimeProviderCompanionRegistry) {
    this.#port = port;
    this.#registry = registry;
  }

  async getStatus(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto> {
    return this.#getEntry(input).service.getStatus();
  }

  async installAndConnect(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto> {
    const entry = this.#getEntry(input);
    return this.#verifyConnectedCompanion(input, entry, await entry.service.installAndConnect());
  }

  async connect(input: RuntimeProviderCompanionInput): Promise<RuntimeProviderCompanionStatusDto> {
    const entry = this.#getEntry(input);
    return this.#verifyConnectedCompanion(input, entry, await entry.service.connect());
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
