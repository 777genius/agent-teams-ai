import { getRuntimeProviderOnboardingPlan } from '../core/domain';

import type { RuntimeProviderOnboardingPlanId } from '../core/domain';
import type { RuntimeProviderQuickCardViewModel } from './ui/RuntimeProviderQuickConnectView';

interface OpenCodePlanDefinition {
  id: RuntimeProviderOnboardingPlanId;
  providerId: string;
  displayName: string;
  descriptionKey:
    | 'superGrokDescription'
    | 'zaiDescription'
    | 'miniMaxDescription'
    | 'copilotDescription'
    | 'kimiDescription'
    | 'kiroDescription'
    | 'cursorDescription';
  requiresOAuthCredential?: boolean;
  connectionStrategy: ReturnType<typeof getRuntimeProviderOnboardingPlan>['connectionStrategy'];
}

interface OpenCodeGatewayDefinition {
  id: 'openrouter' | 'vercel';
  providerId: 'openrouter' | 'vercel';
  displayName: string;
  description: string;
}

const OPEN_CODE_PLAN_PRESENTATION: readonly Pick<
  OpenCodePlanDefinition,
  'id' | 'descriptionKey' | 'requiresOAuthCredential'
>[] = [
  {
    id: 'supergrok',
    descriptionKey: 'superGrokDescription',
    requiresOAuthCredential: true,
  },
  {
    id: 'zai-coding-plan',
    descriptionKey: 'zaiDescription',
  },
  {
    id: 'minimax-token-plan',
    descriptionKey: 'miniMaxDescription',
  },
  {
    id: 'github-copilot',
    descriptionKey: 'copilotDescription',
  },
  {
    id: 'kimi-code-membership',
    descriptionKey: 'kimiDescription',
  },
  {
    id: 'kiro',
    descriptionKey: 'kiroDescription',
  },
  {
    id: 'cursor',
    descriptionKey: 'cursorDescription',
  },
];

export const OPEN_CODE_PLANS: readonly OpenCodePlanDefinition[] = OPEN_CODE_PLAN_PRESENTATION.map(
  (presentation) => {
    const plan = getRuntimeProviderOnboardingPlan(presentation.id);
    return {
      ...presentation,
      providerId: plan.providerId,
      displayName: plan.displayName,
      connectionStrategy: plan.connectionStrategy,
    };
  }
);

export const OPEN_CODE_GATEWAYS: readonly OpenCodeGatewayDefinition[] = [
  {
    id: 'openrouter',
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    description: 'Use one API key to access models from many providers through OpenRouter.',
  },
  {
    id: 'vercel',
    providerId: 'vercel',
    displayName: 'Vercel AI Gateway',
    description:
      'Use Vercel AI Gateway to access OpenAI, Anthropic, Google, xAI, and other models.',
  },
];

const QUICK_CONNECT_CARD_ORDER = [
  'github-copilot',
  'supergrok',
  'zai-coding-plan',
  'kimi-code-membership',
  'kiro',
  'cursor',
  'minimax-token-plan',
  'xiaomi-mimo-token-plan',
  'openrouter',
  'vercel',
] as const;

const QUICK_CONNECT_CARD_RANK = new Map<string, number>(
  QUICK_CONNECT_CARD_ORDER.map((id, index) => [id, index])
);

export function sortQuickConnectCards(
  cards: readonly RuntimeProviderQuickCardViewModel[]
): RuntimeProviderQuickCardViewModel[] {
  return [...cards].sort(
    (left, right) =>
      (QUICK_CONNECT_CARD_RANK.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (QUICK_CONNECT_CARD_RANK.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  );
}
