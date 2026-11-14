import type {
  NativeNextPromptCandidate,
  NativeNextPromptIdentity,
  NativeNextPromptViewContext,
} from '../../contracts';

const MAX_SUGGESTION_BYTES = 512;
const INVALID_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const SAME_ORIGIN_FIELDS = [
  'ownerHandle', 'teamId', 'runId', 'memberId', 'generation', 'conversationRef',
] as const satisfies readonly (keyof NativeNextPromptIdentity)[];

function validIdentity(candidate: NativeNextPromptCandidate): boolean {
  return SAME_ORIGIN_FIELDS.every((key) => {
    const value = candidate[key];
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
  });
}

function validSuggestion(candidate: NativeNextPromptCandidate): boolean {
  return (
    typeof candidate.suggestionId === 'string' &&
    candidate.suggestionId.length > 0 &&
    candidate.suggestionId.length <= 256 &&
    typeof candidate.operationRef === 'string' &&
    candidate.operationRef.length > 0 &&
    candidate.operationRef.length <= 256 &&
    typeof candidate.completedTurnRef === 'string' &&
    candidate.completedTurnRef.length > 0 &&
    candidate.completedTurnRef.length <= 256 &&
    typeof candidate.text === 'string' &&
    candidate.text.trim().length > 0 &&
    !INVALID_CHARACTERS.test(candidate.text) &&
    new TextEncoder().encode(candidate.text).length <= MAX_SUGGESTION_BYTES
  );
}

/** No role/lead gating: every selected Claude or qualified Codex teammate may offer. */
export function canDisplayNativeNextPrompt(
  candidate: NativeNextPromptCandidate | null | undefined,
  context: NativeNextPromptViewContext,
): boolean {
  if (
    !candidate ||
    !context.userEnabled ||
    !context.isHumanDirectConversation ||
    !context.isEditable ||
    context.hasAttachments ||
    context.hasChips ||
    context.isEditingQueueOrRevision ||
    context.hasOpenMentionOrCommand ||
    context.draftText.length > 0 ||
    (context.provider !== 'claude' && context.provider !== 'codex') ||
    candidate.provider !== context.provider ||
    !validIdentity(candidate) ||
    !validSuggestion(candidate)
  ) {
    return false;
  }

  if (
    candidate.operationRef !== context.latestExecutedOperationRef ||
    candidate.completedTurnRef !== context.latestCompletedTurnRef
  ) {
    return false;
  }

  return SAME_ORIGIN_FIELDS.every((key) => candidate[key] === context[key]);
}

/** The editor owns Tab/IME/menu arbitration, not the passive preview. */
export function mayAcceptNativeNextPromptWithTab(input: {
  readonly visible: boolean;
  readonly editorFocused: boolean;
  readonly isComposing: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly hasActiveEditorKeyboardMenu: boolean;
}): boolean {
  return input.visible &&
    input.editorFocused &&
    !input.isComposing &&
    !input.shiftKey &&
    !input.ctrlKey &&
    !input.altKey &&
    !input.metaKey &&
    !input.hasActiveEditorKeyboardMenu;
}
