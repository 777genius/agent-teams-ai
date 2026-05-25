import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import type { AgentActionMode } from '@shared/types';

const { protocols } = agentTeamsControllerModule;

const LEAD_DELEGATE_DESCRIPTION =
  'Strict orchestration mode for leads. Delegate the work and any needed investigation to teammates, coordinate it, and do not implement or personally research it yourself unless you are truly in SOLO MODE.';

const ACTION_MODE_BLOCKS: Record<AgentActionMode, string[]> = {
  do: [
    'TURN ACTION MODE: DO',
    '- This turn is full-execution mode.',
    '- You may discuss, read, edit files, change state, run commands/tools, and delegate if useful.',
    '- Agent tool policy for this mode: you MAY use the built-in Agent tool only as a normal Claude Code subagent helper, i.e. WITHOUT team_name.',
    '- If you use Agent in this mode, use it the same way normal Claude Code would use Agent: bounded helper work, parallel research, or implementation support when useful.',
    '- Even in DO mode, do NOT use Agent with team_name to create persistent teammates, and do NOT use Agent as a replacement for the team task board or normal teammate delegation.',
    '- No extra restrictions apply beyond your normal system/team rules.',
  ],
  ask: [
    'TURN ACTION MODE: ASK',
    '- This turn is STRICTLY read-only conversation mode.',
    '- ALLOWED: read/analyze/explain, answer questions, discuss options, and request clarification if needed.',
    '- FORBIDDEN: editing files, changing code, changing task/board state, delegating work, launching Agent/subagents, running commands/scripts/tools with side effects, or causing any non-communication state change.',
  ],
  delegate: [
    'TURN ACTION MODE: DELEGATE',
    '- This turn is STRICTLY delegation/orchestration mode.',
    '- If you are the team lead, stay at orchestration level: decompose the work, create/assign tasks fast, delegate triage/research to the best teammate, and monitor progress.',
    '- In this mode, do NOT inspect code, do root-cause research, or spend time narrowing scope yourself before delegating unless the human explicitly asked you for analysis/planning instead of delegation.',
    '- If the request is underspecified, create a coarse investigation/triage task for the most relevant teammate immediately; that teammate should inspect the codebase, refine scope, and create follow-up tasks if needed.',
    '- FORBIDDEN: implementing the work yourself, editing files yourself, running state-changing/code-changing commands yourself, launching Agent/subagents, or taking direct execution ownership unless you are truly in SOLO MODE.',
    '- In particular, do NOT use Agent as a shortcut for delegation in this mode. Use the team board, real teammates, and explicit task ownership instead.',
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
  return wrapAgentBlock(lines.join('\n'));
}

export function isAgentActionMode(value: unknown): value is AgentActionMode {
  return value === 'do' || value === 'ask' || value === 'delegate';
}
