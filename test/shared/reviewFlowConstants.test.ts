import { createRequire } from 'node:module';

import {
  DEFAULT_REVIEW_FLOW,
  isHumanApprovalFlow,
  MAX_REVIEW_FLOW_PROMPT_LENGTH,
  REVIEW_FLOWS,
} from '@shared/constants/kanban';
import { describe, expect, it } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const controllerStore = nodeRequire('../../agent-teams-controller/src/internal/kanbanStore.js') as {
  DEFAULT_REVIEW_FLOW: string;
  MAX_REVIEW_FLOW_PROMPT_LENGTH: number;
  REVIEW_FLOWS: readonly string[];
};

describe('review flow constants', () => {
  it('stay identical to the controller that owns the persisted contract', () => {
    expect([...REVIEW_FLOWS]).toEqual([...controllerStore.REVIEW_FLOWS]);
    expect(DEFAULT_REVIEW_FLOW).toBe(controllerStore.DEFAULT_REVIEW_FLOW);
    expect(MAX_REVIEW_FLOW_PROMPT_LENGTH).toBe(controllerStore.MAX_REVIEW_FLOW_PROMPT_LENGTH);
  });

  it('treat only human_approval as the human-only policy', () => {
    expect(isHumanApprovalFlow({ reviewFlow: 'human_approval' })).toBe(true);
    expect(isHumanApprovalFlow({ reviewFlow: 'agent_approval' })).toBe(false);
    expect(isHumanApprovalFlow({})).toBe(false);
    expect(isHumanApprovalFlow(null)).toBe(false);
  });
});
