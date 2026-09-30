import { buildActionModeAgentBlock } from '@main/services/team/actionModeInstructions';

import type { ActionModeInstructionsPort } from '../../../core/application/ports/TeamMessageDeliveryPorts';
import type { AgentActionMode } from '@shared/types';

export class LegacyActionModeInstructions implements ActionModeInstructionsPort {
  buildAgentBlock(mode: AgentActionMode | undefined): string {
    return buildActionModeAgentBlock(mode);
  }
}
