import { type ParsedMessage, type SemanticStep } from '../types';

/**
 * Calculate context for each step using its source message's usage data.
 * Each step's context is calculated independently from its source message.
 */
export function calculateStepContext(steps: SemanticStep[], messages: ParsedMessage[]): void {
  for (const step of steps) {
    // Find source message for this step
    const msg = messages.find((m) => m.uuid === step.sourceMessageId);

    // Calculate context from message usage
    if (msg?.usage) {
      const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      const cacheCreation = msg.usage.cache_creation_input_tokens ?? 0;
      const inputTokens = msg.usage.input_tokens ?? 0;

      // Context = input tokens sent to API (cache_read + cache_creation + regular input)
      step.accumulatedContext = inputTokens + cacheRead + cacheCreation;
    } else if (step.tokens) {
      // For steps that already have token info (like subagents)
      step.accumulatedContext = (step.tokens.input ?? 0) + (step.tokens.cached ?? 0);
    }

    // Individual step doesn't contribute tokens (message-level tracking)
    step.contextTokens = 0;
    step.tokenBreakdown = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
  }
}
