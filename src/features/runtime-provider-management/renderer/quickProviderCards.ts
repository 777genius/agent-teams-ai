import type { RuntimeProviderQuickCardViewModel } from './ui/RuntimeProviderQuickConnectView';

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
