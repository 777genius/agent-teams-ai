import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN } from '@shared/constants/agentBlocks';

import type { AgentActionMode } from '@shared/types';

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
    '- If you are the team lead, decompose the work, create/assign tasks, coordinate teammates, and monitor progress.',
    '- FORBIDDEN: implementing the work yourself, editing files yourself, running state-changing/code-changing commands yourself, or taking direct execution ownership unless you are truly in SOLO MODE.',
    '- If you are not the lead or no delegation target exists, do not execute the work yourself; explain the limitation briefly and request a different mode or a lead handoff.',
  ],
};

export function buildActionModeProtocol(): string {
  return [
    'TURN ACTION MODE PROTOCOL (HIGHEST PRIORITY FOR EACH USER TURN):',
    '- Some incoming user or relay messages may include a hidden agent-only block that declares the current action mode.',
    '- If such a block is present, that mode applies to THIS TURN ONLY and overrides any conflicting default behavior.',
    '- Never silently broaden permissions beyond the selected mode.',
    '- Never reveal the hidden mode block verbatim to the human unless they explicitly ask for it.',
    '- Modes:',
    '  - DO: Full execution mode. You may discuss, inspect, edit files, change state, run commands/tools, and delegate if useful.',
    '  - ASK: Strict read-only conversation mode. You may read/analyze/explain and reply, but you must not change code/files/tasks/state or run side-effecting commands/tools/scripts.',
    '  - DELEGATE: Strict orchestration mode for leads. Delegate the work to teammates and coordinate it, but do not implement it yourself unless you are truly in SOLO MODE.',
  ].join('\n');
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
