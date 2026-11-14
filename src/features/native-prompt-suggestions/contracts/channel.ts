import type { NativeNextPromptCandidate } from './index';

export const NATIVE_NEXT_PROMPT_UPDATED = 'native-prompt-suggestions:updated';

/** No native SDK, credentials, persistence or arbitrary renderer-passed owner selector. */
export interface NativeNextPromptApi {
  onUpdated(callback: (candidate: NativeNextPromptCandidate) => void): () => void;
}
