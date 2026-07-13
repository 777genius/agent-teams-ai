import { isOAuthCredentialHint } from './runtimeProviderQuickConnect';

import type { RuntimeProviderDirectoryEntryDto, RuntimeProviderModelDto } from '../../contracts';

export type RuntimeProviderOnboardingPlanId =
  | 'supergrok'
  | 'zai-coding-plan'
  | 'minimax-token-plan'
  | 'github-copilot'
  | 'kimi-code-membership'
  | 'kiro'
  | 'cursor'
  | 'xiaomi-mimo-token-plan'
  | 'openai-plus-pro';

export type XiaomiMiMoTokenPlanProviderId =
  | 'xiaomi-token-plan-ams'
  | 'xiaomi-token-plan-sgp'
  | 'xiaomi-token-plan-cn';

export interface XiaomiMiMoTokenPlanResolution {
  readonly providerId: XiaomiMiMoTokenPlanProviderId;
  readonly regionLabel: 'Europe' | 'Singapore' | 'China';
  readonly canonicalBaseUrl: string;
}

export type XiaomiMiMoTokenPlanResolutionResult =
  | { readonly ok: true; readonly value: XiaomiMiMoTokenPlanResolution }
  | {
      readonly ok: false;
      readonly reason: 'empty' | 'invalid-url' | 'unsupported-url';
      readonly message: string;
    };

export type RuntimeProviderOnboardingStage =
  | 'connect'
  | 'verifying'
  | 'choose-model'
  | 'ready'
  | 'error';

export type RuntimeProviderConnectionStrategy =
  | { readonly kind: 'opencode-auth' }
  | {
      readonly kind: 'companion';
      readonly companionId: 'kiro-cli' | 'cursor-agent';
    }
  | { readonly kind: 'provider-selector'; readonly selectorId: 'xiaomi-mimo-base-url' };

export interface RuntimeProviderOnboardingPlan {
  readonly id: RuntimeProviderOnboardingPlanId;
  readonly providerId: string;
  readonly displayName: string;
  readonly description: string;
  readonly credentialKind: 'oauth' | 'subscription-key';
  readonly credentialUrl: string | null;
  readonly preferredModelFragments: readonly string[];
  readonly requireOAuthCredentialHint: boolean;
  readonly connectionStrategy: RuntimeProviderConnectionStrategy;
}

export interface RuntimeProviderOnboardingProgress {
  readonly schemaVersion: 1;
  readonly selectedPlanIds: readonly RuntimeProviderOnboardingPlanId[];
  readonly currentPlanId: RuntimeProviderOnboardingPlanId | null;
  readonly completedPlanIds: readonly RuntimeProviderOnboardingPlanId[];
  readonly selectedModels: Readonly<Partial<Record<RuntimeProviderOnboardingPlanId, string>>>;
  readonly updatedAt: string;
}

export const RUNTIME_PROVIDER_ONBOARDING_PLANS: readonly RuntimeProviderOnboardingPlan[] = [
  {
    id: 'supergrok',
    providerId: 'xai',
    displayName: 'SuperGrok',
    description: 'Use your SuperGrok subscription with secure xAI browser sign-in.',
    credentialKind: 'oauth',
    credentialUrl: null,
    preferredModelFragments: ['grok-4.3', 'grok-code', 'grok-4'],
    requireOAuthCredentialHint: true,
    connectionStrategy: { kind: 'opencode-auth' },
  },
  {
    id: 'zai-coding-plan',
    providerId: 'zai-coding-plan',
    displayName: 'Z.AI Coding Plan',
    description: 'Use the dedicated key from your GLM Coding Plan.',
    credentialKind: 'subscription-key',
    credentialUrl: 'https://z.ai/manage-apikey/apikey-list',
    preferredModelFragments: [
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'glm-5-turbo',
      'glm-4.7',
      'glm-4.5-air',
    ],
    requireOAuthCredentialHint: false,
    connectionStrategy: { kind: 'opencode-auth' },
  },
  {
    id: 'minimax-token-plan',
    providerId: 'minimax-coding-plan',
    displayName: 'MiniMax Token Plan',
    description: 'Use your MiniMax Token Plan Subscription Key, not a pay-as-you-go key.',
    credentialKind: 'subscription-key',
    credentialUrl: 'https://platform.minimax.io/console/plan',
    preferredModelFragments: ['minimax-m3', 'minimax-m2.7-highspeed', 'minimax-m2.7'],
    requireOAuthCredentialHint: false,
    connectionStrategy: { kind: 'opencode-auth' },
  },
  {
    id: 'github-copilot',
    providerId: 'github-copilot',
    displayName: 'GitHub Copilot',
    description:
      'Use GitHub Copilot through OpenCode. Compatible models are verified automatically for your plan, including Copilot Free.',
    credentialKind: 'oauth',
    credentialUrl: null,
    // gpt-4.1 is available on Copilot Free while gpt-5-mini can be catalogued
    // but rejected by that tier. Keep paid/premium routes as fallbacks.
    preferredModelFragments: ['gpt-4.1', 'gpt-5-mini', 'gpt-5', 'claude-sonnet', 'gemini'],
    requireOAuthCredentialHint: false,
    connectionStrategy: { kind: 'opencode-auth' },
  },
  {
    id: 'kimi-code-membership',
    providerId: 'kimi-for-coding',
    displayName: 'Kimi Code Membership',
    description: 'Use an API key from Kimi Code Console with your membership quota.',
    credentialKind: 'subscription-key',
    credentialUrl: 'https://www.kimi.com/code/console',
    preferredModelFragments: [
      'kimi-for-coding/kimi-for-coding',
      'kimi-for-coding/kimi-for-coding-highspeed',
    ],
    requireOAuthCredentialHint: false,
    connectionStrategy: { kind: 'opencode-auth' },
  },
  {
    id: 'kiro',
    providerId: 'kiro',
    displayName: 'Amazon Q Developer / Kiro',
    description: 'Use your Kiro subscription through the managed OpenCode Kiro plugin.',
    credentialKind: 'oauth',
    credentialUrl: null,
    preferredModelFragments: ['kiro/auto', 'kiro/claude-opus', 'kiro/claude-sonnet'],
    requireOAuthCredentialHint: false,
    connectionStrategy: { kind: 'companion', companionId: 'kiro-cli' },
  },
  {
    id: 'cursor',
    providerId: 'cursor-acp',
    displayName: 'Cursor',
    description: 'Use your Cursor subscription through the managed OpenCode Cursor plugin.',
    credentialKind: 'oauth',
    credentialUrl: null,
    preferredModelFragments: ['cursor-acp/auto'],
    requireOAuthCredentialHint: false,
    connectionStrategy: { kind: 'companion', companionId: 'cursor-agent' },
  },
  {
    id: 'openai-plus-pro',
    providerId: 'openai',
    displayName: 'ChatGPT Plus / Pro',
    description: 'Optional OpenCode route using your ChatGPT subscription.',
    credentialKind: 'oauth',
    credentialUrl: null,
    preferredModelFragments: ['gpt-5', 'codex'],
    requireOAuthCredentialHint: true,
    connectionStrategy: { kind: 'opencode-auth' },
  },
];

export const XIAOMI_MIMO_TOKEN_PLAN_CREDENTIAL_URL =
  'https://platform.xiaomimimo.com/console/plan-manage';

const XIAOMI_MIMO_TOKEN_PLAN_REGIONS: Readonly<
  Record<
    string,
    {
      readonly providerId: XiaomiMiMoTokenPlanProviderId;
      readonly regionLabel: XiaomiMiMoTokenPlanResolution['regionLabel'];
    }
  >
> = {
  'token-plan-ams.xiaomimimo.com': {
    providerId: 'xiaomi-token-plan-ams',
    regionLabel: 'Europe',
  },
  'token-plan-sgp.xiaomimimo.com': {
    providerId: 'xiaomi-token-plan-sgp',
    regionLabel: 'Singapore',
  },
  'token-plan-cn.xiaomimimo.com': {
    providerId: 'xiaomi-token-plan-cn',
    regionLabel: 'China',
  },
};

function createXiaomiMiMoTokenPlan(
  resolution: XiaomiMiMoTokenPlanResolution
): RuntimeProviderOnboardingPlan {
  return {
    id: 'xiaomi-mimo-token-plan',
    providerId: resolution.providerId,
    displayName: `Xiaomi MiMo Token Plan - ${resolution.regionLabel}`,
    description: `Use the Dedicated API Key shown next to ${resolution.canonicalBaseUrl}.`,
    credentialKind: 'subscription-key',
    credentialUrl: XIAOMI_MIMO_TOKEN_PLAN_CREDENTIAL_URL,
    preferredModelFragments: [
      `${resolution.providerId}/mimo-v2.5-pro`,
      `${resolution.providerId}/mimo-v2.5`,
    ],
    requireOAuthCredentialHint: false,
    connectionStrategy: { kind: 'provider-selector', selectorId: 'xiaomi-mimo-base-url' },
  };
}

export function getXiaomiMiMoTokenPlanResolutionByProviderId(
  providerId: string
): XiaomiMiMoTokenPlanResolution | null {
  const regionEntry = Object.entries(XIAOMI_MIMO_TOKEN_PLAN_REGIONS).find(
    ([, candidate]) => candidate.providerId === providerId.trim().toLowerCase()
  );
  if (!regionEntry) {
    return null;
  }
  const [hostname, region] = regionEntry;
  return {
    ...region,
    canonicalBaseUrl: `https://${hostname}/v1`,
  };
}

function getXiaomiMiMoTokenPlanByProviderId(
  providerId: string
): RuntimeProviderOnboardingPlan | null {
  const resolution = getXiaomiMiMoTokenPlanResolutionByProviderId(providerId);
  if (!resolution) {
    return null;
  }
  return createXiaomiMiMoTokenPlan(resolution);
}

export function resolveXiaomiMiMoTokenPlanProvider(
  baseUrl: string
): XiaomiMiMoTokenPlanResolutionResult {
  const value = baseUrl.trim();
  if (!value) {
    return {
      ok: false,
      reason: 'empty',
      message: 'Paste the Dedicated Base URL from your Xiaomi MiMo Token Plan page.',
    };
  }

  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return {
      ok: false,
      reason: 'invalid-url',
      message: 'Enter a valid Xiaomi MiMo Dedicated Base URL.',
    };
  }

  const normalizedPath = url.pathname.replace(/\/+$/, '').toLowerCase();
  const region = XIAOMI_MIMO_TOKEN_PLAN_REGIONS[url.hostname.toLowerCase()];
  const valid =
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    (normalizedPath === '/v1' || normalizedPath === '/anthropic') &&
    Boolean(region);
  if (!valid || !region) {
    return {
      ok: false,
      reason: 'unsupported-url',
      message:
        'This Base URL is not recognized yet. Copy the Dedicated Base URL exactly as shown in your Token Plan dashboard.',
    };
  }

  return {
    ok: true,
    value: {
      ...region,
      canonicalBaseUrl: `https://${url.hostname.toLowerCase()}/v1`,
    },
  };
}

const PLAN_ID_SET = new Set<RuntimeProviderOnboardingPlanId>(
  RUNTIME_PROVIDER_ONBOARDING_PLANS.map((plan) => plan.id)
);

export function getRuntimeProviderOnboardingPlan(
  planId: RuntimeProviderOnboardingPlanId
): RuntimeProviderOnboardingPlan {
  const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS.find((entry) => entry.id === planId);
  if (!plan) {
    throw new Error(`Unknown runtime provider onboarding plan: ${planId}`);
  }
  return plan;
}

export function findRuntimeProviderOnboardingPlanByProviderId(
  providerId: string
): RuntimeProviderOnboardingPlan | null {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const xiaomiPlan = getXiaomiMiMoTokenPlanByProviderId(normalizedProviderId);
  if (xiaomiPlan) {
    return xiaomiPlan;
  }
  return (
    RUNTIME_PROVIDER_ONBOARDING_PLANS.find(
      (plan) => plan.providerId.toLowerCase() === normalizedProviderId
    ) ?? null
  );
}

export function getRuntimeProviderCredentialUrl(providerId: string): string | null {
  const normalizedProviderId = providerId.trim().toLowerCase();
  return findRuntimeProviderOnboardingPlanByProviderId(normalizedProviderId)?.credentialUrl ?? null;
}

export function isRuntimeProviderOnboardingPlanConnected(
  plan: RuntimeProviderOnboardingPlan,
  entry: RuntimeProviderDirectoryEntryDto | null | undefined
): boolean {
  if (entry?.state !== 'connected' || entry.metadata.configuredAuthless) {
    return false;
  }
  if (!plan.requireOAuthCredentialHint) {
    return true;
  }
  return isOAuthCredentialHint(entry.connectedAuthHint);
}

export function isRuntimeProviderOnboardingPlanRoutable(
  plan: RuntimeProviderOnboardingPlan,
  entry: RuntimeProviderDirectoryEntryDto | null | undefined
): boolean {
  if (isRuntimeProviderOnboardingPlanConnected(plan, entry)) {
    return true;
  }
  return Boolean(
    (plan.id === 'kiro' || plan.id === 'cursor') &&
    entry?.metadata.configuredAuthless === true &&
    entry.modelCount !== 0
  );
}

function modelCanBeProbed(model: RuntimeProviderModelDto): boolean {
  const normalizedModelId = model.modelId.toLowerCase();
  const generationOnlyModel = /(?:^|[-_/])(video|image|audio|speech|music|tts)(?:[-_/]|$)/.test(
    normalizedModelId
  );
  return (
    !generationOnlyModel &&
    model.availability !== 'unavailable' &&
    model.availability !== 'not-authenticated' &&
    model.accessKind !== 'not_authenticated' &&
    model.accessKind !== 'execution_failed'
  );
}

export function rankRecommendedRuntimeProviderModels(
  plan: RuntimeProviderOnboardingPlan,
  models: readonly RuntimeProviderModelDto[]
): RuntimeProviderModelDto[] {
  const candidates = models.filter(modelCanBeProbed);
  const ranked: RuntimeProviderModelDto[] = [];
  const seen = new Set<string>();
  const add = (model: RuntimeProviderModelDto | undefined): void => {
    if (!model || seen.has(model.modelId)) {
      return;
    }
    seen.add(model.modelId);
    ranked.push(model);
  };
  for (const fragment of plan.preferredModelFragments) {
    const exactMatch = candidates.find(
      (model) => model.modelId.toLowerCase() === fragment.toLowerCase()
    );
    add(exactMatch);
    candidates
      .filter((model) =>
        `${model.modelId} ${model.displayName}`.toLowerCase().includes(fragment.toLowerCase())
      )
      .forEach(add);
  }
  add(candidates.find((model) => model.default));
  candidates.forEach(add);
  return ranked;
}

export function selectRecommendedRuntimeProviderModel(
  plan: RuntimeProviderOnboardingPlan,
  models: readonly RuntimeProviderModelDto[]
): RuntimeProviderModelDto | null {
  return rankRecommendedRuntimeProviderModels(plan, models)[0] ?? null;
}

function normalizePlanIds(value: unknown): RuntimeProviderOnboardingPlanId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: RuntimeProviderOnboardingPlanId[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !PLAN_ID_SET.has(item as RuntimeProviderOnboardingPlanId)) {
      continue;
    }
    const planId = item as RuntimeProviderOnboardingPlanId;
    if (!result.includes(planId)) {
      result.push(planId);
    }
  }
  return result;
}

export function createRuntimeProviderOnboardingProgress(
  selectedPlanIds: readonly RuntimeProviderOnboardingPlanId[],
  now = new Date()
): RuntimeProviderOnboardingProgress {
  const normalizedPlanIds = normalizePlanIds(selectedPlanIds);
  return {
    schemaVersion: 1,
    selectedPlanIds: normalizedPlanIds,
    currentPlanId: normalizedPlanIds[0] ?? null,
    completedPlanIds: [],
    selectedModels: {},
    updatedAt: now.toISOString(),
  };
}

export function normalizeRuntimeProviderOnboardingProgress(
  value: unknown
): RuntimeProviderOnboardingProgress | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<RuntimeProviderOnboardingProgress>;
  if (candidate.schemaVersion !== 1) {
    return null;
  }
  const selectedPlanIds = normalizePlanIds(candidate.selectedPlanIds);
  if (selectedPlanIds.length === 0) {
    return null;
  }
  const completedPlanIds = normalizePlanIds(candidate.completedPlanIds).filter((planId) =>
    selectedPlanIds.includes(planId)
  );
  const currentPlanId =
    typeof candidate.currentPlanId === 'string' && selectedPlanIds.includes(candidate.currentPlanId)
      ? candidate.currentPlanId
      : (selectedPlanIds.find((planId) => !completedPlanIds.includes(planId)) ?? null);
  const selectedModels: Partial<Record<RuntimeProviderOnboardingPlanId, string>> = {};
  if (candidate.selectedModels && typeof candidate.selectedModels === 'object') {
    for (const planId of selectedPlanIds) {
      const modelId = candidate.selectedModels[planId];
      if (typeof modelId === 'string' && modelId.trim()) {
        selectedModels[planId] = modelId.trim();
      }
    }
  }

  return {
    schemaVersion: 1,
    selectedPlanIds,
    currentPlanId,
    completedPlanIds,
    selectedModels,
    updatedAt:
      typeof candidate.updatedAt === 'string' && candidate.updatedAt
        ? candidate.updatedAt
        : new Date(0).toISOString(),
  };
}

export function completeRuntimeProviderOnboardingPlan(
  progress: RuntimeProviderOnboardingProgress,
  planId: RuntimeProviderOnboardingPlanId,
  modelId: string,
  now = new Date()
): RuntimeProviderOnboardingProgress {
  const completedPlanIds = progress.completedPlanIds.includes(planId)
    ? [...progress.completedPlanIds]
    : [...progress.completedPlanIds, planId];
  const currentPlanId =
    progress.selectedPlanIds.find((candidate) => !completedPlanIds.includes(candidate)) ?? null;
  return {
    ...progress,
    currentPlanId,
    completedPlanIds,
    selectedModels: {
      ...progress.selectedModels,
      [planId]: modelId,
    },
    updatedAt: now.toISOString(),
  };
}
