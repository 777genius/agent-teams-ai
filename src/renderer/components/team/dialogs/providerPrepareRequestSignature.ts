import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

type RuntimeProviderStatusById = ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>;
type SelectedModelChecksByProvider = ReadonlyMap<TeamProviderId, readonly string[]>;

function normalizeModelIds(modelIds: readonly string[] | null | undefined): string[] {
  return Array.from(
    new Set((modelIds ?? []).map((modelId) => modelId.trim()).filter(Boolean))
  ).sort();
}

export function buildProviderPrepareMembersSignature(members: readonly MemberDraft[]): string {
  return JSON.stringify(
    members.map((member) => ({
      id: member.id,
      providerId: member.providerId ?? null,
      model: member.model?.trim() || null,
      effort: member.effort ?? null,
      removed: Boolean(member.removedAt),
    }))
  );
}

export function buildProviderPrepareModelChecksSignature(
  modelChecksByProvider: SelectedModelChecksByProvider
): string {
  return JSON.stringify(
    Array.from(modelChecksByProvider.entries())
      .map(([providerId, modelIds]) => ({
        providerId,
        modelIds: normalizeModelIds(modelIds),
      }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId))
  );
}

export function buildProviderPrepareRuntimeStatusSignature(
  providerIds: readonly TeamProviderId[],
  runtimeProviderStatusById: RuntimeProviderStatusById
): string {
  return JSON.stringify(
    Array.from(new Set(providerIds))
      .sort()
      .map((providerId) => {
        const provider = runtimeProviderStatusById.get(providerId) ?? null;
        return {
          providerId,
          supported: provider?.supported ?? null,
          authenticated: provider?.authenticated ?? null,
          authMethod: provider?.authMethod ?? null,
          selectedBackendId: provider?.selectedBackendId ?? null,
          resolvedBackendId: provider?.resolvedBackendId ?? null,
          models: normalizeModelIds(provider?.models),
          modelCatalogSource: provider?.modelCatalog?.source ?? null,
          modelCatalogStatus: provider?.modelCatalog?.status ?? null,
          modelCatalogModels: normalizeModelIds(
            provider?.modelCatalog?.models?.map((model) => model.id)
          ),
          connection: provider?.connection
            ? {
                supportsOAuth: provider.connection.supportsOAuth,
                supportsApiKey: provider.connection.supportsApiKey,
                configuredAuthMode: provider.connection.configuredAuthMode ?? null,
                apiKeyConfigured: provider.connection.apiKeyConfigured,
                apiKeySource: provider.connection.apiKeySource ?? null,
                codex: provider.connection.codex
                  ? {
                      preferredAuthMode: provider.connection.codex.preferredAuthMode,
                      effectiveAuthMode: provider.connection.codex.effectiveAuthMode,
                      appServerState: provider.connection.codex.appServerState,
                      managedAccountType: provider.connection.codex.managedAccount?.type ?? null,
                      managedAccountEmail: provider.connection.codex.managedAccount?.email ?? null,
                      requiresOpenaiAuth: provider.connection.codex.requiresOpenaiAuth ?? null,
                      localAccountArtifactsPresent:
                        provider.connection.codex.localAccountArtifactsPresent ?? null,
                      localActiveChatgptAccountPresent:
                        provider.connection.codex.localActiveChatgptAccountPresent ?? null,
                      loginStatus: provider.connection.codex.login?.status ?? null,
                      launchAllowed: provider.connection.codex.launchAllowed,
                      launchIssueMessage: provider.connection.codex.launchIssueMessage ?? null,
                      launchReadinessState: provider.connection.codex.launchReadinessState,
                    }
                  : null,
              }
            : null,
          availableBackends: (provider?.availableBackends ?? [])
            .map((backend) => ({
              id: backend.id,
              available: backend.available,
              selectable: backend.selectable,
              state: backend.state ?? null,
              recommended: backend.recommended,
              audience: backend.audience ?? null,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        };
      })
  );
}

export function buildProviderPrepareRequestSignature(input: {
  cwd: string;
  selectedProviderId: TeamProviderId;
  selectedModel: string;
  selectedMemberProviders: readonly TeamProviderId[];
  limitContext?: boolean;
  runtimeStatusSignature: string;
  membersSignature?: string;
  modelChecksSignature?: string;
}): string {
  return JSON.stringify({
    cwd: input.cwd,
    selectedProviderId: input.selectedProviderId,
    selectedModel: input.selectedModel.trim(),
    selectedMemberProviders: Array.from(new Set(input.selectedMemberProviders)).sort(),
    limitContext: Boolean(input.limitContext),
    runtimeStatusSignature: input.runtimeStatusSignature,
    membersSignature: input.membersSignature ?? null,
    modelChecksSignature: input.modelChecksSignature ?? null,
  });
}
