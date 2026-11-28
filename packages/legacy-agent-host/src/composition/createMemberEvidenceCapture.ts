import { createClaudeEvidenceCapture } from './createClaudeEvidenceCapture.js';
import { createCodexEvidenceCapture } from './createCodexEvidenceCapture.js';
import { createOpenCodeEvidenceCapture } from './createOpenCodeEvidenceCapture.js';
/** Finite provider composition only; each capture owns its provider-specific native boundary. */
export function createMemberEvidenceCapture(
  options: Parameters<typeof createClaudeEvidenceCapture>[0]
) {
  const toolEvidence = createClaudeEvidenceCapture(options);
  const codexEvidence = createCodexEvidenceCapture(options);
  const opencodeEvidence = createOpenCodeEvidenceCapture(options);
  return { ...(toolEvidence ? { toolEvidence } : {}), ...(codexEvidence ? { codexEvidence } : {}), ...(opencodeEvidence ? { opencodeEvidence } : {}) };
}
