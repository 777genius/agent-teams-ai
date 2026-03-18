import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN } from '@shared/constants/agentBlocks';

import type { AgentActionMode } from '@shared/types';

import * as agentTeamsControllerModule from 'agent-teams-controller';

const { protocols } = agentTeamsControllerModule;

const LEAD_DELEGATE_DESCRIPTION =
  'Strict orchestration mode for leads. Delegate the work and any needed investigation to teammates, coordinate it, and do not implement or personally research it yourself unless you are truly in SOLO MODE.';

const ACTION_MODE_BLOCKS: Record<AgentActionMode, string[]> = {
  do: [
    'TURN ACTION MODE: DO',
    '- This turn is full-execution mode.',
    '- You may discuss, read, edit files, change state, run commands/tools, and delegate if useful.',
    '- No extra restrictions apply beyond your normal system/team rules.',
  ],
  ask: [
    'TURN ACTION MODE: ASK',
    '- This turn is STRICTLY read-only conversation mode.',
    '- ALLOWED: read/analyze/explain, answer questions, discuss options, and request clarification if needed.',
    '- FORBIDDEN: editing files, changing code, changing task/board state, delegating work, running commands/scripts/tools with side effects, or causing any non-communication state change.',
  ],
  delegate: [
    'TURN ACTION MODE: DELEGATE',
    '- This turn is STRICTLY delegation/orchestration mode.',
    '- If you are the team lead, stay at orchestration level: decompose the work, create/assign tasks fast, delegate triage/research to the best teammate, and monitor progress.',
    '- In this mode, do NOT inspect code, do root-cause research, or spend time narrowing scope yourself before delegating unless the human explicitly asked you for analysis/planning instead of delegation.',
    '- If the request is underspecified, create a coarse investigation/triage task for the most relevant teammate immediately; that teammate should inspect the codebase, refine scope, and create follow-up tasks if needed.',
    '- FORBIDDEN: implementing the work yourself, editing files yourself, running state-changing/code-changing commands yourself, or taking direct execution ownership unless you are truly in SOLO MODE.',
    '- If you are not the lead or no delegation target exists, do not execute the work yourself; explain the limitation briefly and request a different mode or a lead handoff.',
  ],
};

export function buildActionModeProtocol(): string {
  return protocols.buildActionModeProtocolText(LEAD_DELEGATE_DESCRIPTION);
}

export function buildActionModeAgentBlock(mode: AgentActionMode | undefined): string {
  if (!mode) {
    return '';
  }

  const lines = ACTION_MODE_BLOCKS[mode];
  return `${AGENT_BLOCK_OPEN}\n${lines.join('\n')}\n${AGENT_BLOCK_CLOSE}`;
}

export function isAgentActionMode(value: unknown): value is AgentActionMode {
  return value === 'do' || value === 'ask' || value === 'delegate';
}
