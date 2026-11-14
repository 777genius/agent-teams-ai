import { describe, expect, it } from 'vitest';

import {
  canDisplayNativeNextPrompt,
  mayAcceptNativeNextPromptWithTab,
} from '../../../src/features/native-prompt-suggestions/core/domain/policy';

import type {
  NativeNextPromptCandidate,
  NativeNextPromptViewContext,
} from '../../../src/features/native-prompt-suggestions/contracts';

const candidate: NativeNextPromptCandidate = {
  ownerHandle: 'TEST-owner-1',
  teamId: 'TEST-team-1',
  runId: 'TEST-run-1',
  memberId: 'TEST-member-codex',
  generation: 'TEST-gen-1',
  conversationRef: 'direct:alice',
  suggestionId: 'TEST-suggestion-1',
  memberName: 'alice',
  messageId: 'TEST-human-message-1',
  inputId: 'TEST-input-1',
  operationRef: 'TEST-original-operation-1',
  completedTurnRef: 'TEST-native-turn-1',
  provider: 'codex',
  text: 'Review tests and open the PR',
};

const view: NativeNextPromptViewContext = {
  ownerHandle: candidate.ownerHandle,
  teamId: candidate.teamId,
  runId: candidate.runId,
  memberId: candidate.memberId,
  generation: candidate.generation,
  conversationRef: candidate.conversationRef,
  provider: 'codex',
  latestDirectMessageId: candidate.messageId,
  latestExecutedOperationRef: candidate.operationRef,
  latestCompletedTurnRef: candidate.completedTurnRef,
  userEnabled: true,
  isHumanDirectConversation: true,
  isEditable: true,
  hasAttachments: false,
  hasChips: false,
  isEditingQueueOrRevision: false,
  hasOpenMentionOrCommand: false,
  draftText: '',
};

describe('native teammate next-prompt policy', () => {
  it('accepts the exact member-owned completed human DM regardless of lead/peer role', () => {
    expect(canDisplayNativeNextPrompt(candidate, view)).toBe(true);
    expect(canDisplayNativeNextPrompt(
      { ...candidate, provider: 'claude' },
      { ...view, provider: 'claude' },
    )).toBe(true);
  });

  it.each([
    ['other teammate', { memberId: 'TEST-other-member' }],
    ['other team with same-named member', { teamId: 'TEST-team-2' }],
    ['other owner', { ownerHandle: 'TEST-owner-2' }],
    ['other launch', { runId: 'TEST-run-2' }],
    ['stale runtime generation', { generation: 'TEST-gen-2' }],
    ['other direct chat', { conversationRef: 'direct:bob' }],
    ['new direct human message', { latestDirectMessageId: 'TEST-human-message-2' }],
    ['new executed operation', { latestExecutedOperationRef: 'TEST-next-operation' }],
    ['new completed native turn', { latestCompletedTurnRef: 'TEST-native-turn-2' }],
    ['disabled', { userEnabled: false }],
    ['not a human personal chat', { isHumanDirectConversation: false }],
    ['unavailable native provider', { provider: 'unsupported' }],
    ['typed draft', { draftText: 'I am typing' }],
    ['attachment', { hasAttachments: true }],
    ['inline chip', { hasChips: true }],
    ['queued edit or revision', { isEditingQueueOrRevision: true }],
    ['active slash/mention/task menu', { hasOpenMentionOrCommand: true }],
    ['locked editor', { isEditable: false }],
  ] as const)('suppresses %s', (_name, mutation) => {
    expect(canDisplayNativeNextPrompt(candidate, { ...view, ...mutation })).toBe(false);
  });

  it('keeps Main-projected owner handles within the same bounded UI policy', () => {
    const selected = 'host-team:' + 'a'.repeat(450);
    expect(canDisplayNativeNextPrompt(
      { ...candidate, ownerHandle: selected },
      { ...view, ownerHandle: selected },
    )).toBe(true);
    const oversized = 'host-team:' + 'a'.repeat(503);
    expect(canDisplayNativeNextPrompt(
      { ...candidate, ownerHandle: oversized },
      { ...view, ownerHandle: oversized },
    )).toBe(false);
  });

  it('rejects invalid, control-character, overlong and stale provider candidates', () => {
    expect(canDisplayNativeNextPrompt({ ...candidate, text: '   ' }, view)).toBe(false);
    expect(canDisplayNativeNextPrompt({ ...candidate, text: '\u0000danger' }, view)).toBe(false);
    expect(canDisplayNativeNextPrompt({ ...candidate, text: 'a'.repeat(513) }, view)).toBe(false);
    expect(canDisplayNativeNextPrompt({ ...candidate, provider: 'claude' }, view)).toBe(false);
    expect(canDisplayNativeNextPrompt({ ...candidate, operationRef: 'TEST-old-operation' }, view)).toBe(false);
  });

  it('Tab requires empty focused editor and no active IME/keyboard menu; Shift+Tab never inserts', () => {
    const base = {
      visible: true, editorFocused: true, isComposing: false, shiftKey: false,
      ctrlKey: false, altKey: false, metaKey: false, hasActiveEditorKeyboardMenu: false,
    };
    expect(mayAcceptNativeNextPromptWithTab(base)).toBe(true);
    for (const key of [
      'visible', 'editorFocused', 'isComposing', 'shiftKey',
      'ctrlKey', 'altKey', 'metaKey', 'hasActiveEditorKeyboardMenu',
    ] as const) {
      expect(mayAcceptNativeNextPromptWithTab({ ...base, [key]: !base[key] })).toBe(false);
    }
  });
});
