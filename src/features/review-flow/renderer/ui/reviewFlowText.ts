import type { ReviewFlow } from '../../contracts/types';

/** i18n keys (namespace `team`) of the review-flow settings UI, shared by every surface. */
export const FLOW_TEXT_KEYS = {
  agent_approval: {
    label: 'reviewFlow.flows.agent_approval.label',
    description: 'reviewFlow.flows.agent_approval.description',
  },
  human_approval: {
    label: 'reviewFlow.flows.human_approval.label',
    description: 'reviewFlow.flows.human_approval.description',
  },
} as const satisfies Record<ReviewFlow, { label: string; description: string }>;
