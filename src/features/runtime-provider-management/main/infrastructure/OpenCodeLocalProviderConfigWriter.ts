import { promises as fs } from 'node:fs';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { findNodeAtLocation, type ParseError, parseTree } from 'jsonc-parser';

import { buildRuntimeLocalProviderModelRoute } from '../../core/domain';

import {
  assertGatewayProviderTarget,
  containsProviderReference,
  gatewayOwnershipLocation,
  gatewayOwnershipMatches,
  gatewayProviderDigest,
  gatewayProviderInputDigest,
  gatewayProviderUnchanged,
  type OpenCodeGatewayProviderRetireTarget,
  ownershipConflict,
  readGatewayOwnership,
  writeGatewayOwnership,
} from './OpenCodeGatewayArtifactOwnership';
import { readOpenCodeConfigTarget } from './openCodeGlobalConfigOverrides';
import {
  createModelRecord,
  hasDuplicateObjectProperties,
  type LocalProviderConfigWriteInput,
  type LocalProviderConfigWriteResult,
  mergeAvailableConfiguredModelIds,
  setJsoncValue,
  updateJsoncProviderModels,
} from './openCodeLocalProviderConnectorUtils';
import {
  assertProviderApiKeyReplacement,
  commitProviderConfigWithCredential,
  containsStringReference,
  createProviderApiKeyReference,
  LocalProviderOperationError,
  removeManagedProviderCredential,
} from './OpenCodeLocalProviderSupport';

/** One serialized writer for local provider edits and gateway artifact retirement. */
export class OpenCodeLocalProviderConfigWriter {
  private configWriteChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly homePath: string,
    private readonly getEnvironment: () => NodeJS.ProcessEnv
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.configWriteChain.then(operation, operation);
    this.configWriteChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async writeConfig(input: LocalProviderConfigWriteInput): Promise<LocalProviderConfigWriteResult> {
    return this.serialize(() => this.writeConfigNow(input));
  }

  retireGatewayProvider(
    target: OpenCodeGatewayProviderRetireTarget
  ): Promise<{ retired: boolean }> {
    assertGatewayProviderTarget(target);
    return this.serialize(async () => {
      const config = await readOpenCodeConfigTarget({
        scope: 'global',
        homePath: this.homePath,
        getEnvironment: this.getEnvironment,
        inlineContext: { providerId: target.providerId },
      });
      const errors: ParseError[] = [];
      const tree = parseTree(config.raw ?? '{}', errors, { allowTrailingComma: true });
      if (!tree || tree.type !== 'object' || errors.length || hasDuplicateObjectProperties(tree)) {
        throw ownershipConflict();
      }
      const location = await gatewayOwnershipLocation(
        this.homePath,
        config.configPath,
        target.providerId
      );
      const ownership = await readGatewayOwnership(location.markerPath);
      const provider = findNodeAtLocation(tree, ['provider', target.providerId]);
      if (ownership && !gatewayOwnershipMatches(ownership, target, config.configPath))
        return { retired: false };
      if (provider && (!ownership || !gatewayProviderUnchanged(tree, ownership)))
        return { retired: false };
      const remaining = setJsoncValue(
        config.raw ?? '{}',
        ['provider', target.providerId],
        undefined
      );
      const remainingTree = parseTree(remaining)!;
      if (
        containsProviderReference(remainingTree, target.providerId) ||
        (ownership &&
          containsStringReference(remainingTree, ownership.credentialReference, location.directory))
      ) {
        return { retired: false };
      }
      if (!ownership) return { retired: !provider };
      if (provider)
        await atomicWriteAsync(config.configPath, `${remaining.trimEnd()}\n`, {
          mode: config.mode ?? 0o600,
        });
      // Keep the marker after any failure so the next call can finish cleanup.
      const retired = await removeManagedProviderCredential(
        location.directory,
        ownership.credentialReference,
        {
          configPath: config.configPath,
          providerId: target.providerId,
        }
      );
      if (!retired) return { retired: false };
      await fs.unlink(location.markerPath);
      return { retired: true };
    });
  }

  private async writeConfigNow(
    input: LocalProviderConfigWriteInput
  ): Promise<LocalProviderConfigWriteResult> {
    const configTarget = await readOpenCodeConfigTarget({
      scope: input.scope,
      projectPath: input.projectPath,
      homePath: this.homePath,
      getEnvironment: this.getEnvironment,
      ensureGlobalDirectory: true,
      inlineContext: input,
    });
    const configPath = configTarget.configPath;
    const raw = configTarget.raw ?? '{}\n';
    const isNewConfig = configTarget.raw === null;
    const parseErrors: ParseError[] = [];
    const configTree = parseTree(raw, parseErrors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (parseErrors.length > 0 || !configTree || configTree.type !== 'object') {
      throw new LocalProviderOperationError(
        'config-invalid',
        'The existing OpenCode config contains invalid JSON or JSONC.'
      );
    }
    if (hasDuplicateObjectProperties(configTree)) {
      throw new LocalProviderOperationError(
        'config-invalid',
        'The existing OpenCode config contains duplicate object keys and must be fixed manually.'
      );
    }

    const providerRootNode = findNodeAtLocation(configTree, ['provider']);
    if (providerRootNode && providerRootNode.type !== 'object') {
      throw new LocalProviderOperationError(
        'config-invalid',
        'The existing OpenCode provider configuration must be an object.'
      );
    }

    const location =
      input.gatewayOwner || input.providerId.startsWith('gateway-')
        ? await gatewayOwnershipLocation(this.homePath, configPath, input.providerId)
        : null;
    const ownership = location ? await readGatewayOwnership(location.markerPath) : null;
    const existingProvider = findNodeAtLocation(configTree, ['provider', input.providerId]);
    if (input.gatewayOwner) {
      const target = { ...input.gatewayOwner, providerId: input.providerId };
      assertGatewayProviderTarget(target);
      if (ownership && !gatewayOwnershipMatches(ownership, target, configPath))
        throw ownershipConflict();
      if (existingProvider) {
        if (
          !ownership ||
          !gatewayProviderUnchanged(configTree, ownership) ||
          ownership.inputDigest !== gatewayProviderInputDigest(input)
        )
          throw ownershipConflict();
        // A source's endpoint/key are immutable; later runs may select another model.
        // Add routes while retaining every model an older live consumer can still use.
        const nextRaw = updateJsoncProviderModels(
          raw,
          findNodeAtLocation(configTree, ['provider', input.providerId, 'models']),
          input.providerId,
          input.modelIds,
          input.defaultModelId,
          null,
          false
        );
        if (nextRaw !== raw) {
          await writeGatewayOwnership(location!.markerPath, {
            ...ownership,
            previousProviderDigest: gatewayProviderDigest(configTree, input.providerId),
            providerDigest: gatewayProviderDigest(parseTree(nextRaw)!, input.providerId),
          });
          await atomicWriteAsync(configPath, `${nextRaw.trimEnd()}\n`, {
            mode: configTarget.mode ?? 0o600,
          });
        }
        return { configPath, modelIds: input.modelIds };
      }
      if (ownership) {
        // Finish an interrupted retirement before creating this immutable source again.
        if (
          containsStringReference(configTree, ownership.credentialReference, location!.directory) ||
          !(await removeManagedProviderCredential(
            location!.directory,
            ownership.credentialReference,
            {
              configPath,
              providerId: input.providerId,
            }
          ))
        )
          throw ownershipConflict();
      }
    } else if (ownership) {
      // The local-provider editor cannot silently mutate a live gateway source.
      throw ownershipConflict();
    }
    const previousApiKeyReference = assertProviderApiKeyReplacement(configTree, input);
    const apiKeyReference = input.apiKey
      ? createProviderApiKeyReference({
          configPath,
          providerId: input.providerId,
        })
      : null;
    let nextRaw = raw;
    if (isNewConfig) {
      nextRaw = setJsoncValue(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
    }
    const providerNode = findNodeAtLocation(configTree, ['provider', input.providerId]);
    const modelsNode = findNodeAtLocation(configTree, ['provider', input.providerId, 'models']);
    const persistedModelIds =
      input.replaceModels && input.preserveAvailableConfiguredModels
        ? mergeAvailableConfiguredModelIds(input.modelIds, input.availableModelIds, modelsNode)
        : input.modelIds;
    if (!providerNode || providerNode.type !== 'object') {
      nextRaw = setJsoncValue(nextRaw, ['provider', input.providerId], {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: input.baseUrl,
          ...(apiKeyReference ? { apiKey: apiKeyReference } : {}),
        },
        models: createModelRecord(
          persistedModelIds,
          input.defaultModelId,
          input.selectedModelConfig
        ),
      });
    } else {
      nextRaw = setJsoncValue(
        nextRaw,
        ['provider', input.providerId, 'npm'],
        '@ai-sdk/openai-compatible'
      );
      const optionsNode = findNodeAtLocation(configTree, ['provider', input.providerId, 'options']);
      nextRaw =
        optionsNode && optionsNode.type !== 'object'
          ? setJsoncValue(nextRaw, ['provider', input.providerId, 'options'], {
              baseURL: input.baseUrl,
              ...(apiKeyReference ? { apiKey: apiKeyReference } : {}),
            })
          : setJsoncValue(
              nextRaw,
              ['provider', input.providerId, 'options', 'baseURL'],
              input.baseUrl
            );
      if (apiKeyReference && (!optionsNode || optionsNode.type === 'object')) {
        nextRaw = setJsoncValue(
          nextRaw,
          ['provider', input.providerId, 'options', 'apiKey'],
          apiKeyReference
        );
      }

      nextRaw = updateJsoncProviderModels(
        nextRaw,
        modelsNode,
        input.providerId,
        persistedModelIds,
        input.defaultModelId,
        input.selectedModelConfig,
        input.replaceModels
      );
    }
    if (input.setAsDefault) {
      const modelRoute = buildRuntimeLocalProviderModelRoute(
        input.providerId,
        input.defaultModelId
      );
      nextRaw = setJsoncValue(nextRaw, ['model'], modelRoute);
    }
    if (input.setAsSmallModel) {
      nextRaw = setJsoncValue(
        nextRaw,
        ['small_model'],
        buildRuntimeLocalProviderModelRoute(input.providerId, input.defaultModelId)
      );
    }
    await commitProviderConfigWithCredential({
      homePath: this.homePath,
      configPath,
      providerId: input.providerId,
      apiKey: input.apiKey,
      apiKeyReference,
      previousApiKeyReference,
      contents: `${nextRaw.trimEnd()}\n`,
      mode: configTarget.mode ?? 0o600,
      ...(input.gatewayOwner
        ? {
            beforeConfigCommit: async (contents: string, credentialReference: string) => {
              const tree = parseTree(contents)!;
              await writeGatewayOwnership(location!.markerPath, {
                schemaVersion: 1,
                owner: 'agent-teams-gateway',
                ...input.gatewayOwner!,
                providerId: input.providerId,
                configPath,
                credentialReference,
                providerDigest: gatewayProviderDigest(tree, input.providerId),
                inputDigest: gatewayProviderInputDigest(input),
              });
            },
          }
        : {}),
    });
    return { configPath, modelIds: persistedModelIds };
  }
}
