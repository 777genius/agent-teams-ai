/* eslint-disable @typescript-eslint/naming-convention -- vi.mock component exports must stay PascalCase. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  LeadActivityState,
  ResolvedTeamMember,
  TeamProvisioningProgress,
} from '@shared/types';

const draftHarness = vi.hoisted(() => {
  const initialState = {
    text: 'hello teammate',
    chips: [] as unknown[],
    attachments: [] as unknown[],
    actionMode: 'do',
    isSaved: true,
    isLoaded: true,
    editorContext: { kind: 'plain' } as
      | { kind: 'plain' }
      | {
          kind: 'revision';
          originalMessageId: string;
          recipient: string;
          requestId: string;
        },
    localEditCounter: 0,
  };
  const state = { ...initialState };
  const methods = {
    addChip: vi.fn(),
    addFiles: vi.fn().mockResolvedValue(undefined),
    clearAttachmentError: vi.fn(),
    clearAttachments: vi.fn(),
    clearDraft: vi.fn(async () => {
      state.text = '';
      state.chips = [];
      state.attachments = [];
    }),
    clearRevision: vi.fn(() => {
      state.editorContext = { kind: 'plain' };
    }),
    handleDrop: vi.fn(),
    handlePaste: vi.fn(),
    beginAttempt: vi.fn(),
    removeAttachment: vi.fn(),
    removeChip: vi.fn(),
    setRevision: vi.fn((context: typeof state.editorContext, content: { text: string; actionMode: string }) => {
      if (state.text.length > 0) return false;
      state.editorContext = context;
      state.text = content.text;
      state.actionMode = content.actionMode;
      return true;
    }),
    setActionMode: vi.fn((mode: string) => {
      state.actionMode = mode;
    }),
    setText: vi.fn((text: string) => {
      state.text = text;
      state.localEditCounter += 1;
    }),
    snapshot: vi.fn(() => ({
      text: state.text,
      chips: state.chips,
      attachments: state.attachments,
      actionMode: state.actionMode,
    })),
    stashWorking: vi.fn(),
    restoreRecovery: vi.fn(),
    moveWorkingAsNew: vi.fn(),
    adoptWorking: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  };

  return {
    methods,
    reset: () => {
      Object.assign(state, initialState);
      for (const method of Object.values(methods)) {
        method.mockClear();
      }
    },
    state,
  };
});

const provisioningHarness = vi.hoisted(() => {
  const state = {
    active: false,
    progress: null as TeamProvisioningProgress | null,
    leadActivity: undefined as LeadActivityState | undefined,
    currentRunId: undefined as string | undefined,
  };
  return {
    reset: () => {
      state.active = false;
      state.progress = null;
      state.leadActivity = undefined;
      state.currentRunId = undefined;
    },
    state,
  };
});

interface SuggestionHookOptions {
  enabled?: boolean;
}

const suggestionHarness = vi.hoisted(() => {
  const state = {
    taskOptions: [] as SuggestionHookOptions[],
    teamOptions: [] as SuggestionHookOptions[],
  };
  return {
    reset: () => {
      state.taskOptions = [];
      state.teamOptions = [];
    },
    state,
  };
});

const storeHarness = vi.hoisted(() => {
  const state = {
    activeContextId: 'local',
    isContextSwitching: false,
    crossTeamTargets: [] as {
      teamName: string;
      displayName: string;
      description?: string;
      color?: string;
      leadName?: string;
      leadColor?: string;
      members?: { name: string; role?: string; color?: string }[];
      isOnline?: boolean;
    }[],
  };
  const methods = {
    // Returns a resolved Promise<boolean> to match the store contract: the composer
    // chains `.then()` on this to clear its dedup ref and retry on failure.
    fetchCrossTeamTargets: vi.fn().mockResolvedValue(true),
    fetchSkillsCatalog: vi.fn(),
  };
  return {
    methods,
    reset: () => {
      state.crossTeamTargets = [];
      state.activeContextId = 'local';
      state.isContextSwitching = false;
      methods.fetchCrossTeamTargets.mockClear();
      methods.fetchSkillsCatalog.mockClear();
    },
    state,
  };
});

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      aliveList: vi.fn(() => new Promise<string[]>(() => undefined)),
    },
  },
}));

vi.mock('@renderer/components/team/attachments/AttachmentPreviewList', () => ({
  AttachmentPreviewList: () => null,
}));

vi.mock('@renderer/components/team/attachments/DropZoneOverlay', () => ({
  DropZoneOverlay: () => null,
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

vi.mock('@renderer/components/team/messages/ActionModeSelector', () => ({
  ActionModeSelector: ({ disabled }: { disabled?: boolean }) =>
    React.createElement('button', { disabled, type: 'button' }, 'Do'),
}));

vi.mock('@renderer/components/team/messages/OpenCodeDeliveryWarning', () => ({
  OpenCodeDeliveryWarning: () => null,
}));

vi.mock('@renderer/components/ui/MentionableTextarea', () => {
  const MockMentionableTextarea = React.forwardRef<
    HTMLTextAreaElement,
    {
      value: string;
      placeholder?: string;
      disabled?: boolean;
      className?: string;
      surfaceClassName?: string;
      footerClassName?: string;
      cornerAction?: React.ReactNode;
      cornerActionLeft?: React.ReactNode;
      footerRight?: React.ReactNode;
      onBlur?: React.FocusEventHandler<HTMLTextAreaElement>;
      onFocus?: React.FocusEventHandler<HTMLTextAreaElement>;
    }
  >(
    (
      {
        value,
        placeholder,
        disabled,
        className,
        surfaceClassName,
        footerClassName,
        cornerAction,
        cornerActionLeft,
        footerRight,
        onBlur,
        onFocus,
      },
      ref
    ) =>
      React.createElement(
        'div',
        null,
        React.createElement(
          'div',
          { className: surfaceClassName },
          React.createElement('textarea', {
            'aria-label': 'Message',
            className,
            disabled,
            onBlur,
            onFocus,
            readOnly: true,
            ref,
            value,
            placeholder,
          }),
          React.createElement('div', null, cornerActionLeft),
          React.createElement('div', null, cornerAction)
        ),
        React.createElement('div', { className: footerClassName }, footerRight)
      )
  );
  MockMentionableTextarea.displayName = 'MockMentionableTextarea';
  return { MentionableTextarea: MockMentionableTextarea };
});

vi.mock('@renderer/components/ui/popover', () => {
  const PopoverContext = React.createContext<{
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
  }>({});
  return {
    Popover: ({
      children,
      onOpenChange,
      open,
    }: {
      children: React.ReactNode;
      onOpenChange?: (open: boolean) => void;
      open?: boolean;
    }) => React.createElement(PopoverContext.Provider, { value: { onOpenChange, open } }, children),
    PopoverContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    PopoverTrigger: ({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) => {
      const context = React.useContext(PopoverContext);
      return React.cloneElement(children, {
        onClick: () => {
          children.props.onClick?.();
          context.onOpenChange?.(!context.open);
        },
      });
    },
  };
});

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

/* eslint-enable @typescript-eslint/naming-convention -- End PascalCase vi.mock component exports. */

vi.mock('@renderer/hooks/useComposerDraft', () => ({
  useComposerDraft: (address: { contextId: string; teamName: string; target: { kind: string } }) => ({
    text: draftHarness.state.text,
    setText: draftHarness.methods.setText,
    chips: draftHarness.state.chips,
    addChip: draftHarness.methods.addChip,
    removeChip: draftHarness.methods.removeChip,
    attachments: draftHarness.state.attachments,
    attachmentError: null,
    canAddMore: true,
    addFiles: draftHarness.methods.addFiles,
    removeAttachment: draftHarness.methods.removeAttachment,
    clearAttachments: draftHarness.methods.clearAttachments,
    clearAttachmentError: draftHarness.methods.clearAttachmentError,
    handlePaste: draftHarness.methods.handlePaste,
    handleDrop: draftHarness.methods.handleDrop,
    actionMode: draftHarness.state.actionMode,
    setActionMode: draftHarness.methods.setActionMode,
    editorContext: draftHarness.state.editorContext,
    revisionContext:
      draftHarness.state.editorContext.kind === 'revision'
        ? draftHarness.state.editorContext
        : null,
    setRevision: draftHarness.methods.setRevision,
    clearRevision: draftHarness.methods.clearRevision,
    isSaved: draftHarness.state.isSaved,
    isLoaded: draftHarness.state.isLoaded,
    isRestoring: false,
    persistenceStatus: 'durable',
    readError: null,
    address,
    addressKey: JSON.stringify(address),
    renderedAddressKey: JSON.stringify(address),
    workingRevision: 'revision-1',
    localEditCounter: draftHarness.state.localEditCounter,
    loadGeneration: 1,
    canSubmit: draftHarness.state.isLoaded,
    snapshot: draftHarness.methods.snapshot,
    clearDraft: draftHarness.methods.clearDraft,
    flush: draftHarness.methods.flush,
    beginAttempt: async (attemptId: string, preparedRequest: unknown) => {
      draftHarness.methods.beginAttempt(attemptId, preparedRequest);
      return {
        result: {
          kind: 'prepared',
          workingCleared: true,
          currentWorkingRevision: 'attempt-revision',
          status: 'durable',
        },
        address,
        attempt: {
          attemptId,
          snapshot: {
            content: draftHarness.methods.snapshot(),
            editorContext: draftHarness.state.editorContext,
          },
          preparedRequest,
          createdAt: 1,
        },
        localEditCounter: draftHarness.state.localEditCounter,
      };
    },
    stashWorking: draftHarness.methods.stashWorking,
    restoreRecovery: draftHarness.methods.restoreRecovery,
    moveWorkingAsNew: draftHarness.methods.moveWorkingAsNew,
    adoptWorking: draftHarness.methods.adoptWorking,
  }),
}));

vi.mock('@renderer/components/team/messages/composerSubmission', () => ({
  runComposerSubmission: vi.fn(
    async ({ prepare, isContextCurrent, transport }: {
      prepare: () => Promise<unknown>;
      isContextCurrent: () => boolean;
      transport: () => Promise<{
        deliveredToInbox?: boolean;
        deliveredViaStdin?: boolean;
        messageId?: string;
      }>;
    }) => {
      const prepared = await prepare();
      if (!prepared || !isContextCurrent()) return { kind: 'blocked' };
      try {
        const result = await transport();
        return {
          kind:
            result?.deliveredToInbox === true || result?.deliveredViaStdin === true
              ? 'accepted'
              : 'unconfirmed',
          messageId: result?.messageId,
        };
      } catch (error) {
        return {
          kind: 'unconfirmed',
          detail: error instanceof Error ? error.message : 'Transport failed',
        };
      }
    }
  ),
}));

vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: (_teamName: string | null, options: SuggestionHookOptions = {}) => {
    suggestionHarness.state.taskOptions.push(options);
    return { suggestions: [] };
  },
}));

vi.mock('@renderer/hooks/useTeamSuggestions', () => ({
  useTeamSuggestions: (_teamName: string | null, options: SuggestionHookOptions = {}) => {
    suggestionHarness.state.teamOptions.push(options);
    return { suggestions: [] };
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        activeContextId: storeHarness.state.activeContextId,
        isContextSwitching: storeHarness.state.isContextSwitching,
        crossTeamTargets: storeHarness.state.crossTeamTargets,
        fetchCrossTeamTargets: storeHarness.methods.fetchCrossTeamTargets,
        fetchSkillsCatalog: storeHarness.methods.fetchSkillsCatalog,
        selectedTeamData: null,
        selectedTeamName: null,
        skillsProjectCatalogByProjectPath: {},
        skillsUserCatalog: [],
        leadActivityByTeam: { 'team-alpha': provisioningHarness.state.leadActivity },
        currentRuntimeRunIdByTeam: { 'team-alpha': provisioningHarness.state.currentRunId },
      }),
    {
      getState: () => ({
        activeContextId: storeHarness.state.activeContextId,
        isContextSwitching: storeHarness.state.isContextSwitching,
      }),
    }
  ),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: () => provisioningHarness.state.active,
  getCurrentProvisioningProgressForTeam: () => provisioningHarness.state.progress,
}));

import { MessageComposer } from './MessageComposer';

const members: ResolvedTeamMember[] = [
  {
    agentType: 'developer',
    currentTaskId: null,
    lastActiveAt: null,
    messageCount: 0,
    name: 'alice',
    role: 'Developer',
    status: 'idle',
    taskCount: 0,
  },
  {
    agentType: 'developer',
    currentTaskId: null,
    lastActiveAt: null,
    messageCount: 0,
    name: 'bob',
    role: 'Developer',
    status: 'idle',
    taskCount: 0,
  },
];

function renderComposer(overrides: Partial<React.ComponentProps<typeof MessageComposer>> = {}): {
  host: HTMLDivElement;
  render: (next?: Partial<React.ComponentProps<typeof MessageComposer>>) => void;
  root: ReturnType<typeof createRoot>;
  onSend: ReturnType<typeof vi.fn>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onSend = vi.fn().mockResolvedValue({
    deliveredToInbox: true,
    deliveredViaStdin: false,
    messageId: 'message-1',
  });
  const baseProps: React.ComponentProps<typeof MessageComposer> = {
    teamName: 'team-alpha',
    members,
    isTeamAlive: true,
    sending: false,
    sendError: null,
    sendWarning: null,
    sendDebugDetails: null,
    lastResult: null,
    onSend,
  };

  const render = (next: Partial<React.ComponentProps<typeof MessageComposer>> = {}): void => {
    act(() => {
      root.render(React.createElement(MessageComposer, { ...baseProps, ...overrides, ...next }));
    });
  };
  render();

  return { host, render, root, onSend };
}

function getSendButton(host: HTMLElement): HTMLButtonElement {
  const button = findSendButton(host);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Send button not found');
  }
  return button;
}

function findSendButton(host: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === 'Send'
  );
}

function getSendSlot(host: HTMLElement): HTMLElement {
  const slot = host.querySelector('.message-composer-send-slot');
  if (!(slot instanceof HTMLElement)) {
    throw new Error('Send animation slot not found');
  }
  return slot;
}

function getTextarea(host: HTMLElement): HTMLTextAreaElement {
  const textarea = host.querySelector('textarea[aria-label="Message"]');
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Message textarea not found');
  }
  return textarea;
}

function getButtonContainingText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button containing "${text}" not found`);
  }
  return button;
}

describe('MessageComposer pending send lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    draftHarness.reset();
    provisioningHarness.reset();
    suggestionHarness.reset();
    storeHarness.reset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the footer below the flat composer card', () => {
    const { host, root } = renderComposer();
    const layout = host.querySelector('.message-composer-flat-layout');
    const toolbar = layout?.querySelector('.message-composer-flat-toolbar');
    const body = layout?.querySelector('.message-composer-flat-body');
    const footer = layout?.querySelector('.message-composer-flat-footer');
    const sendButton = getSendButton(host);
    const teamSelector = getButtonContainingText(host, 'team-alpha');
    const recipientSelector = host.querySelector('.message-composer-recipient-selector');
    const targetSelectors = host.querySelector('.message-composer-target-selectors');

    expect(layout).not.toBeNull();
    expect(toolbar).not.toBeNull();
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(body?.contains(footer ?? null)).toBe(false);
    expect(body?.className).not.toContain('message-composer-orbit-surface');
    expect(sendButton.className).toContain('message-composer-send-button');
    expect(teamSelector.className).toContain('justify-end');
    expect(targetSelectors?.className).toContain('w-fit');
    expect(targetSelectors?.className).toContain('max-w-full');
    expect(teamSelector.className).not.toContain('flex-1');
    expect(recipientSelector?.className).not.toContain('flex-1');
    expect(recipientSelector?.className).not.toContain('shrink-0');
    expect(toolbar?.textContent).toContain('Group chat');
    expect(toolbar?.textContent).toContain('Group chat');

    act(() => {
      root.unmount();
    });
  });

  it('uses the toolbar width for the target selector instead of offline status', () => {
    const { host, root } = renderComposer({ isTeamAlive: false });
    const toolbar = host.querySelector('.message-composer-flat-toolbar');

    expect(toolbar?.textContent).toContain('team-alpha');
    expect(toolbar?.textContent).toContain('Group chat');
    expect(toolbar?.textContent?.toLowerCase()).not.toContain('offline');
    expect(toolbar?.className).toContain('grid-cols-[32px_minmax(0,1fr)]');

    act(() => {
      root.unmount();
    });
  });

  it('returns to the current team group chat after leaving a locked direct chat', async () => {
    const { host, onSend, render, root } = renderComposer({ lockedRecipient: 'bob' });

    expect(host.querySelector('.message-composer-target-selectors')?.textContent).toContain('bob');
    render({ lockedRecipient: undefined });
    await act(async () => undefined);

    const selectors = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.message-composer-target-selectors > button')
    );
    expect(selectors.map((button) => button.textContent?.trim())).toEqual([
      'team-alpha',
      'Group chat',
    ]);
    await act(async () => getSendButton(host).click());
    expect(onSend).toHaveBeenCalledWith(
      'alice',
      'hello teammate',
      'hello teammate',
      undefined,
      'do',
      []
    );

    act(() => {
      root.unmount();
    });
  });

  it('sends to the lead after switching from a teammate back to the group chat', async () => {
    const { host, onSend, root } = renderComposer();

    act(() => {
      getButtonContainingText(host, 'bob').click();
    });
    const groupChatOptions = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter(
      (button) => button.textContent?.trim() === 'Group chat'
    );
    act(() => {
      groupChatOptions.at(-1)?.click();
    });
    await act(async () => getSendButton(host).click());

    expect(onSend).toHaveBeenCalledWith(
      'alice',
      'hello teammate',
      'hello teammate',
      undefined,
      'do',
      []
    );

    act(() => {
      root.unmount();
    });
  });

  it('prepares the exact snapshot before invoking transport', async () => {
    const { host, onSend, root } = renderComposer();
    await act(async () => getSendButton(host).click());
    expect(draftHarness.methods.beginAttempt).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith(
      'alice',
      'hello teammate',
      'hello teammate',
      undefined,
      'do',
      []
    );
    act(() => root.unmount());
  });

  it('does not show stale global send diagnostics after draft address navigation', async () => {
    const failedSend = vi.fn().mockRejectedValue(new Error('Alice delivery failed'));
    const { host, render, root } = renderComposer({
      lockedRecipient: 'alice',
      onSend: failedSend,
    });

    await act(async () => getSendButton(host).click());
    expect(host.textContent).toContain('Alice delivery failed');

    render({ lockedRecipient: 'bob', sendError: 'stale Alice send failure' });
    await act(async () => undefined);

    expect(host.textContent).not.toContain('Alice delivery failed');
    expect(host.textContent).not.toContain('stale Alice send failure');
    act(() => root.unmount());
  });

  it('restores a revision request into the composer', async () => {
    const revisionRequest = {
      requestId: 'rev-1',
      originalMessageId: 'msg-123',
      originalText: 'incomplete message',
      recipient: 'bob',
      actionMode: 'ask' as const,
    };
    draftHarness.state.text = '';
    const { render, root } = renderComposer();

    render({ revisionRequest });
    await act(async () => undefined);

    expect(draftHarness.methods.setRevision).toHaveBeenCalled();
    expect(draftHarness.state.text).toBe('incomplete message');
    expect(draftHarness.state.actionMode).toBe('ask');

    act(() => {
      root.unmount();
    });
  });

  it('wraps the next send as a correction for the revised message', async () => {
    const revisionRequest = {
      requestId: 'rev-1',
      originalMessageId: 'msg-123',
      originalText: 'incomplete message',
      recipient: 'bob',
      actionMode: 'ask' as const,
    };
    draftHarness.state.text = '';
    const { host, onSend, render, root } = renderComposer();

    render({ revisionRequest });
    render({ revisionRequest });

    await act(async () => getSendButton(host).click());

    expect(onSend).toHaveBeenCalledWith(
      'bob',
      [
        'Correction for my previous message (MessageId: msg-123).',
        '',
        'Please use this corrected version instead:',
        '',
        'incomplete message',
      ].join('\n'),
      'Correction for MessageId: msg-123',
      undefined,
      'ask',
      []
    );

    act(() => {
      root.unmount();
    });
  });

  it('cancels revision mode without clearing the draft', () => {
    const onRevisionCancel = vi.fn();
    const revisionRequest = {
      requestId: 'rev-1',
      originalMessageId: 'msg-123',
      originalText: 'incomplete message',
      recipient: 'bob',
      actionMode: 'ask' as const,
    };
    draftHarness.state.text = '';
    const { host, render, root } = renderComposer({ onRevisionCancel });

    render({ revisionRequest });
    render({ revisionRequest });

    act(() => {
      getButtonContainingText(host, 'Cancel').click();
    });

    expect(onRevisionCancel).toHaveBeenCalledOnce();
    expect(draftHarness.methods.clearDraft).not.toHaveBeenCalled();
    expect(draftHarness.state.text).toBe('incomplete message');

    act(() => {
      root.unmount();
    });
  });

  it('keeps send enabled when stale provisioning state remains after the team is alive', async () => {
    provisioningHarness.state.active = true;
    const { host, onSend, root } = renderComposer({ isTeamAlive: true });

    expect(getSendButton(host).disabled).toBe(false);

    await act(async () => getSendButton(host).click());

    expect(onSend).toHaveBeenCalledOnce();

    act(() => {
      root.unmount();
    });
  });

  it('does not render send until the draft contains non-whitespace text', () => {
    draftHarness.state.text = '   ';
    const { host, render, root } = renderComposer();

    expect(findSendButton(host)).toBeUndefined();
    expect(getSendSlot(host).dataset.visible).toBe('false');

    draftHarness.state.text = 'ready';
    render();

    expect(getSendButton(host).disabled).toBe(false);
    expect(getSendSlot(host).dataset.visible).toBe('true');

    act(() => {
      root.unmount();
    });
  });

  it('keeps send disabled while provisioning before the team is alive', () => {
    provisioningHarness.state.active = true;
    const { host, onSend, root } = renderComposer({ isTeamAlive: false });

    expect(getSendButton(host).disabled).toBe(true);

    act(() => {
      getSendButton(host).click();
    });

    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it.each([false, true])(
    'shows working startup copy without changing the alive=%s send gate',
    (isTeamAlive) => {
      provisioningHarness.state.active = true;
      provisioningHarness.state.progress = {
        runId: 'run-current',
        teamName: 'team-alpha',
        state: 'finalizing',
        startedAt: '2026-09-06T12:00:00Z',
        updatedAt: '2026-09-06T12:00:05Z',
        message: 'Auditing bootstrap truth',
      };
      provisioningHarness.state.leadActivity = 'active';
      provisioningHarness.state.currentRunId = 'run-current';
      const { host, onSend, root } = renderComposer({ isTeamAlive });
      expect(getSendButton(host).disabled).toBe(!isTeamAlive);
      if (!isTeamAlive) {
        expect(getTextarea(host).placeholder).toContain(
          'Lead is working. Startup checks are finishing'
        );
        expect(getTextarea(host).placeholder).toContain('sending is not yet available');
        expect(getTextarea(host).placeholder).not.toContain('will be queued');
        act(() => getSendButton(host).click());
        expect(onSend).not.toHaveBeenCalled();
      } else {
        expect(getTextarea(host).placeholder).not.toContain('Startup checks');
      }
      act(() => root.unmount());
    }
  );

  it('does not autofocus the textarea until a chat thread is opened', () => {
    const { host, root } = renderComposer();
    expect(document.activeElement).not.toBe(getTextarea(host));
    act(() => {
      root.unmount();
    });
  });

  it('autofocuses the textarea when a chat thread is opened', async () => {
    const { host, root } = renderComposer({ autoFocusKey: Date.parse('2026-09-18T09:00:00.000Z') });
    const textarea = getTextarea(host);

    await act(async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    expect(document.activeElement).toBe(textarea);

    act(() => {
      root.unmount();
    });
  });

  it('returns focus to the textarea after sending', () => {
    const { host, root } = renderComposer();
    const sendButton = getSendButton(host);
    const textarea = getTextarea(host);

    sendButton.focus();
    expect(document.activeElement).toBe(sendButton);

    act(() => {
      sendButton.click();
    });

    expect(document.activeElement).toBe(textarea);

    act(() => {
      root.unmount();
    });
  });

  it('returns focus to the textarea after selecting a recipient member', () => {
    const { host, root } = renderComposer();
    const bobButton = getButtonContainingText(host, 'bob');
    const textarea = getTextarea(host);

    bobButton.focus();
    expect(document.activeElement).toBe(bobButton);

    act(() => {
      bobButton.click();
    });

    expect(document.activeElement).toBe(textarea);

    act(() => {
      root.unmount();
    });
  });

  it('returns focus to the textarea after selecting a cross-team recipient', () => {
    storeHarness.state.crossTeamTargets = [
      {
        teamName: 'team-beta',
        displayName: 'Beta Team',
        members: [{ name: 'carol', role: 'Reviewer', color: '#abcdef' }],
      },
    ];
    const { host, root } = renderComposer({ onCrossTeamSend: vi.fn() });
    const betaTeamButton = getButtonContainingText(host, 'Beta Team');
    const textarea = getTextarea(host);

    betaTeamButton.focus();
    expect(document.activeElement).toBe(betaTeamButton);

    act(() => {
      betaTeamButton.click();
    });

    expect(document.activeElement).toBe(textarea);

    const carolButton = getButtonContainingText(host, 'carol');
    act(() => {
      carolButton.click();
    });

    expect(document.activeElement).toBe(textarea);

    act(() => {
      root.unmount();
    });
  });

  it('shows exact cross-team group and member draft markers in the selectors', async () => {
    storeHarness.state.crossTeamTargets = [
      {
        teamName: 'team-beta',
        displayName: 'Beta Team',
        members: [{ name: 'carol', role: 'Reviewer', color: '#abcdef' }],
      },
    ];
    const baseSummary = {
      version: 1 as const,
      workingRevision: 'draft-1',
      updatedAt: 1,
      attachmentCount: 0,
      chipCount: 0,
      editorKind: 'plain' as const,
    };
    const { host, root } = renderComposer({
      onCrossTeamSend: vi.fn(),
      workingDraftSummaries: [
        {
          ...baseSummary,
          address: {
            contextId: 'local',
            teamName: 'team-alpha',
            target: { kind: 'cross-team', toTeam: 'team-beta', toMember: null },
          },
          preview: 'group draft',
        },
        {
          ...baseSummary,
          workingRevision: 'draft-2',
          address: {
            contextId: 'local',
            teamName: 'team-alpha',
            target: { kind: 'cross-team', toTeam: 'team-beta', toMember: 'carol' },
          },
          preview: 'member draft',
        },
      ],
    });

    expect(getButtonContainingText(host, 'Beta Team').textContent).toContain('Draft: group draft');
    expect(getButtonContainingText(host, 'Beta Team').textContent).toContain('+1');
    act(() => getButtonContainingText(host, 'Beta Team').click());
    await act(async () => undefined);
    expect(getButtonContainingText(host, 'carol').textContent).toContain('Draft: member draft');
    act(() => root.unmount());
  });

  it('sends to the selected teammate of another team', async () => {
    storeHarness.state.crossTeamTargets = [
      {
        teamName: 'team-beta',
        displayName: 'Beta Team',
        members: [{ name: 'carol', role: 'Reviewer', color: '#abcdef' }],
      },
    ];
    const onCrossTeamSend = vi.fn().mockResolvedValue({
      deliveredToInbox: true,
      messageId: 'cross-1',
    });
    const { host, render, root } = renderComposer({ onCrossTeamSend });

    act(() => {
      getButtonContainingText(host, 'Beta Team').click();
    });
    render();
    await act(async () => undefined);
    act(() => {
      getButtonContainingText(host, 'carol').click();
    });
    await act(async () => undefined);
    render();
    await act(async () => getSendButton(host).click());

    expect(onCrossTeamSend).toHaveBeenCalledWith(
      'team-beta',
      'hello teammate',
      'hello teammate',
      'do',
      [],
      'carol'
    );

    act(() => {
      root.unmount();
    });
  });

  it('leaves Delegate mode when a cross-team direct recipient is selected', async () => {
    storeHarness.state.crossTeamTargets = [
      {
        teamName: 'team-beta',
        displayName: 'Beta Team',
        members: [{ name: 'carol', role: 'Reviewer', color: '#abcdef' }],
      },
    ];
    const { host, render, root } = renderComposer({ onCrossTeamSend: vi.fn() });
    act(() => getButtonContainingText(host, 'Beta Team').click());
    await act(async () => undefined);
    expect(draftHarness.methods.setActionMode).toHaveBeenCalledWith('delegate');
    render();
    act(() => getButtonContainingText(host, 'carol').click());
    await act(async () => undefined);

    expect(draftHarness.methods.setActionMode).toHaveBeenLastCalledWith('do');
    act(() => root.unmount());
  });

  it('refreshes cross-team targets every time the team picker reopens', async () => {
    const { host, root } = renderComposer();
    const teamSelector = getButtonContainingText(host, 'team-alpha');

    await act(async () => {
      teamSelector.click();
      await Promise.resolve();
    });
    expect(storeHarness.methods.fetchCrossTeamTargets).toHaveBeenCalledTimes(1);

    act(() => teamSelector.click());
    await act(async () => {
      teamSelector.click();
      await Promise.resolve();
    });
    expect(storeHarness.methods.fetchCrossTeamTargets).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
  });

  it('falls back to the destination group chat when the selected member disappears', async () => {
    storeHarness.state.crossTeamTargets = [
      {
        teamName: 'team-beta',
        displayName: 'Beta Team',
        members: [{ name: 'carol', role: 'Reviewer', color: '#abcdef' }],
      },
    ];
    const onCrossTeamSend = vi.fn().mockResolvedValue({
      deliveredToInbox: true,
      messageId: 'cross-1',
    });
    const { host, render, root } = renderComposer({ onCrossTeamSend });

    act(() => getButtonContainingText(host, 'Beta Team').click());
    act(() => getButtonContainingText(host, 'carol').click());
    storeHarness.state.crossTeamTargets = [
      { teamName: 'team-beta', displayName: 'Beta Team', members: [] },
    ];
    render();
    await act(async () => undefined);
    await act(async () => getSendButton(host).click());

    expect(onCrossTeamSend).toHaveBeenCalledWith(
      'team-beta',
      'hello teammate',
      'hello teammate',
      'do',
      [],
      undefined
    );
    act(() => root.unmount());
  });

  it('clears cross-team routing state when a local direct chat is locked', async () => {
    storeHarness.state.crossTeamTargets = [
      {
        teamName: 'team-beta',
        displayName: 'Beta Team',
        members: [{ name: 'carol', role: 'Reviewer', color: '#abcdef' }],
      },
    ];
    const { host, render, root } = renderComposer({ onCrossTeamSend: vi.fn() });

    act(() => {
      getButtonContainingText(host, 'Beta Team').click();
    });
    expect(getTextarea(host).placeholder).toContain('Beta Team');

    render({ lockedRecipient: 'bob' });
    await act(async () => undefined);

    expect(getTextarea(host).placeholder).not.toContain('Beta Team');

    act(() => {
      root.unmount();
    });
  });

  it('defers expensive mention data until the matching trigger is typed', () => {
    draftHarness.state.text = '';
    const { host, render, root } = renderComposer();

    expect(suggestionHarness.state.taskOptions.at(-1)?.enabled).toBe(false);
    expect(suggestionHarness.state.teamOptions.at(-1)?.enabled).toBe(false);
    expect(storeHarness.methods.fetchSkillsCatalog).not.toHaveBeenCalled();
    expect(storeHarness.methods.fetchCrossTeamTargets).not.toHaveBeenCalled();

    act(() => {
      getTextarea(host).focus();
    });

    expect(suggestionHarness.state.taskOptions.at(-1)?.enabled).toBe(false);
    expect(suggestionHarness.state.teamOptions.at(-1)?.enabled).toBe(false);
    expect(storeHarness.methods.fetchSkillsCatalog).not.toHaveBeenCalled();
    expect(storeHarness.methods.fetchCrossTeamTargets).not.toHaveBeenCalled();

    draftHarness.state.text = '#';
    render();

    expect(suggestionHarness.state.taskOptions.at(-1)?.enabled).toBe(true);
    expect(suggestionHarness.state.teamOptions.at(-1)?.enabled).toBe(false);
    expect(storeHarness.methods.fetchSkillsCatalog).not.toHaveBeenCalled();

    draftHarness.state.text = '@';
    render();

    expect(suggestionHarness.state.taskOptions.at(-1)?.enabled).toBe(false);
    expect(suggestionHarness.state.teamOptions.at(-1)?.enabled).toBe(true);
    expect(storeHarness.methods.fetchSkillsCatalog).not.toHaveBeenCalled();

    draftHarness.state.text = '/';
    render();

    expect(storeHarness.methods.fetchSkillsCatalog).toHaveBeenCalledTimes(1);
    expect(storeHarness.methods.fetchCrossTeamTargets).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
