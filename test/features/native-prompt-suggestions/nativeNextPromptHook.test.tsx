import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNativeNextPrompt } from '../../../src/features/native-prompt-suggestions/renderer/hooks/useNativeNextPrompt';
import { NativeNextPromptRow } from '../../../src/features/native-prompt-suggestions/renderer/ui/NativeNextPromptRow';
import { SettingsToggle } from '../../../src/renderer/components/settings/components/SettingsToggle';

import { verifyCurrentNativeSuggestion } from '../../../src/features/native-prompt-suggestions/renderer/hooks/verifyCurrentNativeSuggestion';

import type { NativeNextPromptCandidate } from '../../../src/features/native-prompt-suggestions/contracts';

const transport = vi.hoisted(() => ({
  listeners: new Set<(value: NativeNextPromptCandidate) => void>(),
  current: true,
}));
vi.mock('../../../src/features/native-prompt-suggestions/renderer/hooks/verifyCurrentNativeSuggestion', () => ({
  verifyCurrentNativeSuggestion: vi.fn(async () => transport.current),
}));
vi.mock('@renderer/api', () => ({
  api: {
    nativePromptSuggestions: {
      onUpdated(callback: (value: NativeNextPromptCandidate) => void) {
        transport.listeners.add(callback);
        return () => transport.listeners.delete(callback);
      },
    },
  },
}));

const ownerHandle = 'host-team:TEST-handle-A';
const origin: NativeNextPromptCandidate = {
  ownerHandle,
  teamId: 'TEST-team-A',
  runId: 'TEST-run-A',
  memberId: 'TEST-member-alice',
  memberName: 'alice',
  generation: 'TEST-generation-A',
  conversationRef: 'direct:alice',
  suggestionId: 'TEST-suggestion-A',
  messageId: 'TEST-human-message-A',
  inputId: 'TEST-input-A',
  operationRef: 'TEST-operation-A',
  completedTurnRef: 'TEST-native-turn-A',
  provider: 'claude',
  text: 'Review the tests and open a PR',
};

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  transport.listeners.clear();
  transport.current = true;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onInsert = vi.fn();
  const input = {
    teamName: ownerHandle,
    recipient: 'alice',
    memberId: origin.memberId,
    latestDirectMessageId: origin.messageId as string | null,
    editable: true,
    draftText: '',
    hasAttachments: false,
    hasChips: false,
    editingQueueOrRevision: false,
  };
  let hook: ReturnType<typeof useNativeNextPrompt> | undefined;
  const Probe = (props: typeof input) => {
    hook = useNativeNextPrompt({ ...props, onInsert });
    return hook.candidate ? (
      <NativeNextPromptRow
        text={hook.candidate.text}
        insertLabel="Insert" dismissLabel="Dismiss"
        shortcutLabel="Tab"
        onInsert={() => { hook?.insert(); }} onDismiss={hook.dismiss}
      />
    ) : null;
  };
  const render = () => act(() => root.render(<Probe {...input} />));
  const emit = (candidate: NativeNextPromptCandidate) => act(() => {
    transport.listeners.forEach(callback => callback(candidate));
  });
  render();
  return { host, input, render, emit, onInsert, getHook: () => hook };
}

describe('native next-prompt setting accessibility', () => {
  it('exposes an accessible switch name and changes only on user activation', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const onChange = vi.fn();
    act(() => root.render(
      <SettingsToggle enabled={false} ariaLabel="Native next-prompt suggestions" onChange={onChange} />
    ));
    const control = host.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(control?.getAttribute('aria-label')).toBe('Native next-prompt suggestions');
    expect(control?.getAttribute('aria-checked')).toBe('false');
    expect(onChange).not.toHaveBeenCalled();
    act(() => control?.click());
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('native next prompt UX in the actual feature hook + row', () => {
  it('accepts exact human direct suggestion as editable draft, never auto-sends', async () => {
    const x = fixture();
    x.emit(origin);
    const row = x.host.querySelector('[data-testid="native-next-prompt-row"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain(origin.text);
    await act(async () => { x.host.querySelector<HTMLButtonElement>('[aria-label="Insert"]')!.click(); });
    expect(verifyCurrentNativeSuggestion).toHaveBeenCalledOnce();
    expect(x.onInsert).toHaveBeenCalledOnce();
    expect(x.onInsert).toHaveBeenCalledWith(origin.text);
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    x.emit(origin);
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
  });

  it('rejects acceptance-time Runtime mismatch without mutating a draft', async () => {
    const x = fixture();
    transport.current = false;
    x.emit(origin);
    await act(async () => { x.host.querySelector<HTMLButtonElement>('[aria-label="Insert"]')!.click(); });
    expect(x.onInsert).not.toHaveBeenCalled();
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
  });

  it('rejects user edits while the Runtime read is in flight', async () => {
    const x = fixture();
    x.emit(origin);
    let release: (() => void) | undefined;
    vi.mocked(verifyCurrentNativeSuggestion).mockImplementationOnce(() =>
      new Promise<boolean>(resolve => { release = () => resolve(true); })
    );
    act(() => x.host.querySelector<HTMLButtonElement>('[aria-label="Insert"]')!.click());
    x.input.draftText = 'Actual user draft';
    x.render();
    await act(async () => { release?.(); });
    expect(x.onInsert).not.toHaveBeenCalled();
  });

  it('uses the captured native provider even when UI model metadata is unavailable', () => {
    const x = fixture();
    x.emit({ ...origin, provider: 'codex', completedTurnRef: 'TEST-codex-native-turn' });
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).not.toBeNull();
    expect(x.getHook()?.candidate?.provider).toBe('codex');
  });

  it('dismisses via a real button and rejects candidate from another teammate and chat', () => {
    const x = fixture();
    x.emit({ ...origin, memberId: 'TEST-bob' });
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    x.emit({ ...origin, conversationRef: 'direct:bob' });
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    x.emit(origin);
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).not.toBeNull();
    act(() => x.host.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click());
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    expect(x.onInsert).not.toHaveBeenCalled();
  });

  it('hides old suggestion after a new user message or an existing draft without overwriting it', () => {
    const x = fixture();
    x.emit(origin);
    x.input.latestDirectMessageId = 'TEST-next-human-message';
    x.render();
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    x.input.latestDirectMessageId = origin.messageId;
    x.input.draftText = 'My draft is authoritative';
    x.render();
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    expect(x.onInsert).not.toHaveBeenCalled();
  });

  it('does not accept if a member draft or owner changes after the event', () => {
    const x = fixture();
    x.emit(origin);
    x.input.memberId = 'TEST-other-member';
    x.render();
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    expect(x.getHook()?.insert()).toBe(false);
    expect(x.onInsert).not.toHaveBeenCalled();
  });

  it('rejects a late SDK offer when user already typed then cleared a draft', () => {
    const x = fixture();
    // No candidate exists yet: a new draft edit still invalidates the
    // completed human message rather than merely clearing visible React state.
    act(() => x.getHook()?.invalidate());
    x.emit(origin);
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    x.input.latestDirectMessageId = 'TEST-human-message-B';
    x.render();
    const next = {
      ...origin, messageId: 'TEST-human-message-B',
      operationRef: 'TEST-operation-B', completedTurnRef: 'TEST-native-turn-B',
      suggestionId: 'TEST-suggestion-B',
    };
    x.emit(next);
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).not.toBeNull();
  });

  it('does not resurrect an old suggestion after teammate stops and restarts', () => {
    const x = fixture();
    x.emit(origin);
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).not.toBeNull();
    x.input.editable = false;
    x.render();
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    x.input.editable = true;
    x.render();
    x.emit(origin);
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
  });

  it('retains an early offer until the matching human inbox message is readable', () => {
    const x = fixture();
    x.input.latestDirectMessageId = 'TEST-human-message-A-older';
    x.render();
    const next = { ...origin, messageId: 'TEST-human-message-B',
      operationRef: 'TEST-operation-B', completedTurnRef: 'TEST-native-turn-B' };
    x.emit(next);
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    x.input.latestDirectMessageId = next.messageId;
    x.render();
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).not.toBeNull();
  });

  it('unsubscribes on disposal, including same-named members from other teams', () => {
    const x = fixture();
    expect(transport.listeners.size).toBe(1);
    x.emit({ ...origin, ownerHandle: 'host-team:TEST-other' });
    expect(x.host.querySelector('[data-testid="native-next-prompt-row"]')).toBeNull();
    act(() => roots.splice(0).forEach(root => root.unmount()));
    expect(transport.listeners.size).toBe(0);
  });
});
