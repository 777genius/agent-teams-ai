/* eslint-disable @typescript-eslint/naming-convention -- vi.mock component exports must stay PascalCase. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

const draftHarness = vi.hoisted(() => {
  const initialState = {
    text: 'hello teammate',
    chips: [] as unknown[],
    attachments: [] as unknown[],
    actionMode: 'do',
    isSaved: true,
    isLoaded: true,
  };
  const state = { ...initialState };
  const methods = {
    addChip: vi.fn(),
    addFiles: vi.fn().mockResolvedValue(undefined),
    clearAttachmentError: vi.fn(),
    clearAttachments: vi.fn(),
    clearDraft: vi.fn(() => {
      state.text = '';
      state.chips = [];
      state.attachments = [];
    }),
    finalizePendingSendClear: vi.fn(),
    handleDrop: vi.fn(),
    handlePaste: vi.fn(),
    hideDraftForPendingSend: vi.fn((_content: { text: string }) => {
      state.text = '';
      state.chips = [];
      state.attachments = [];
    }),
    removeAttachment: vi.fn(),
    removeChip: vi.fn(),
    restoreDraft: vi.fn((content: { text: string }) => {
      state.text = content.text;
    }),
    setActionMode: vi.fn((mode: string) => {
      state.actionMode = mode;
    }),
    setText: vi.fn((text: string) => {
      state.text = text;
    }),
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
  };
  return {
    reset: () => {
      state.active = false;
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
    crossTeamTargets: [] as {
      teamName: string;
      displayName: string;
      description?: string;
      color?: string;
      leadName?: string;
      leadColor?: string;
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
      disabled?: boolean;
      cornerAction?: React.ReactNode;
      cornerActionLeft?: React.ReactNode;
      footerRight?: React.ReactNode;
      onBlur?: React.FocusEventHandler<HTMLTextAreaElement>;
      onFocus?: React.FocusEventHandler<HTMLTextAreaElement>;
    }
  >(({ value, disabled, cornerAction, cornerActionLeft, footerRight, onBlur, onFocus }, ref) =>
    React.createElement(
      'div',
      null,
      React.createElement('textarea', {
        'aria-label': 'Message',
        disabled,
        onBlur,
        onFocus,
        readOnly: true,
        ref,
        value,
      }),
      React.createElement('div', null, cornerActionLeft),
      React.createElement('div', null, cornerAction),
      React.createElement('div', null, footerRight)
    )
  );
  MockMentionableTextarea.displayName = 'MockMentionableTextarea';
  return { MentionableTextarea: MockMentionableTextarea };
});

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

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
  useComposerDraft: () => ({
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
    isSaved: draftHarness.state.isSaved,
    isLoaded: draftHarness.state.isLoaded,
    clearDraft: draftHarness.methods.clearDraft,
    hideDraftForPendingSend: draftHarness.methods.hideDraftForPendingSend,
    finalizePendingSendClear: draftHarness.methods.finalizePendingSendClear,
    restoreDraft: draftHarness.methods.restoreDraft,
  }),
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
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      crossTeamTargets: storeHarness.state.crossTeamTargets,
      fetchCrossTeamTargets: storeHarness.methods.fetchCrossTeamTargets,
      fetchSkillsCatalog: storeHarness.methods.fetchSkillsCatalog,
      selectedTeamData: null,
      selectedTeamName: null,
      skillsProjectCatalogByProjectPath: {},
      skillsUserCatalog: [],
    }),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: () => provisioningHarness.state.active,
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
  const onSend = vi.fn();
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
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === 'Send'
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Send button not found');
  }
  return button;
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

  it('hides the submitted draft when sending starts and finalizes it on success', () => {
    const { host, onSend, render, root } = renderComposer();

    act(() => {
      getSendButton(host).click();
    });
    expect(onSend).toHaveBeenCalledWith(
      'alice',
      'hello teammate',
      'hello teammate',
      undefined,
      'do',
      []
    );
    expect(draftHarness.methods.hideDraftForPendingSend).not.toHaveBeenCalled();

    render({ sending: true });

    expect(draftHarness.methods.hideDraftForPendingSend).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello teammate',
        actionMode: 'do',
        pendingSendId: expect.any(String) as string,
      })
    );
    expect(draftHarness.state.text).toBe('');
    expect(getTextarea(host).disabled).toBe(false);
    expect(getSendButton(host).disabled).toBe(true);

    render({ sending: false });

    expect(draftHarness.methods.finalizePendingSendClear).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        text: 'hello teammate',
        actionMode: 'do',
        pendingSendId: expect.any(String) as string,
      })
    );
    expect(draftHarness.methods.restoreDraft).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it('restores the submitted draft when sending fails after the optimistic hide', () => {
    const { host, render, root } = renderComposer();

    act(() => {
      getSendButton(host).click();
    });
    render({ sending: true });
    render({ sending: false, sendError: 'runtime failed' });

    expect(draftHarness.methods.restoreDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello teammate' })
    );
    expect(draftHarness.state.text).toBe('hello teammate');
    expect(draftHarness.methods.finalizePendingSendClear).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it('does not consume a new pending send before a sending transition is observed', () => {
    const { host, render, root } = renderComposer({
      lastResult: { deliveredToInbox: true, messageId: 'previous-message' },
    });

    act(() => {
      getSendButton(host).click();
    });
    render({
      lastResult: { deliveredToInbox: true, messageId: 'previous-message' },
      sending: false,
    });

    expect(draftHarness.methods.hideDraftForPendingSend).not.toHaveBeenCalled();
    expect(draftHarness.methods.finalizePendingSendClear).not.toHaveBeenCalled();
    expect(draftHarness.methods.clearDraft).not.toHaveBeenCalled();
    expect(draftHarness.state.text).toBe('hello teammate');

    act(() => {
      root.unmount();
    });
  });

  it('clears the draft when a fast send completes before a sending render is observed', () => {
    const previousResult = { deliveredToInbox: true, messageId: 'previous-message' };
    const { host, render, root } = renderComposer({ lastResult: previousResult });

    act(() => {
      getSendButton(host).click();
    });
    render({
      lastResult: { deliveredToInbox: true, messageId: 'new-message' },
      sending: false,
    });

    expect(draftHarness.methods.clearDraft).toHaveBeenCalledOnce();
    expect(draftHarness.methods.hideDraftForPendingSend).not.toHaveBeenCalled();
    expect(draftHarness.methods.finalizePendingSendClear).not.toHaveBeenCalled();
    expect(draftHarness.state.text).toBe('');

    act(() => {
      root.unmount();
    });
  });

  it('restores a revision request into the composer', () => {
    const revisionRequest = {
      requestId: 'rev-1',
      originalMessageId: 'msg-123',
      originalText: 'incomplete message',
      recipient: 'bob',
      actionMode: 'ask' as const,
    };
    const { render, root } = renderComposer();

    render({ revisionRequest });

    expect(draftHarness.methods.restoreDraft).toHaveBeenCalledWith({
      text: 'incomplete message',
      chips: [],
      attachments: [],
      actionMode: 'ask',
    });
    expect(draftHarness.state.text).toBe('incomplete message');
    expect(draftHarness.state.actionMode).toBe('ask');

    act(() => {
      root.unmount();
    });
  });

  it('wraps the next send as a correction for the revised message', () => {
    const revisionRequest = {
      requestId: 'rev-1',
      originalMessageId: 'msg-123',
      originalText: 'incomplete message',
      recipient: 'bob',
      actionMode: 'ask' as const,
    };
    const { host, onSend, render, root } = renderComposer();

    render({ revisionRequest });
    render({ revisionRequest });

    act(() => {
      getSendButton(host).click();
    });

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

  it('keeps revision mode when sending the correction fails', () => {
    const onRevisionComplete = vi.fn();
    const revisionRequest = {
      requestId: 'rev-1',
      originalMessageId: 'msg-123',
      originalText: 'incomplete message',
      recipient: 'bob',
      actionMode: 'ask' as const,
    };
    const { host, render, root } = renderComposer({ onRevisionComplete });

    render({ revisionRequest });
    render({ revisionRequest });
    draftHarness.methods.restoreDraft.mockClear();

    act(() => {
      getSendButton(host).click();
    });
    render({ revisionRequest, sending: true });
    render({ revisionRequest, sending: false, sendError: 'runtime failed' });

    expect(onRevisionComplete).not.toHaveBeenCalled();
    expect(draftHarness.methods.restoreDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'incomplete message' })
    );

    act(() => {
      root.unmount();
    });
  });

  it('keeps send enabled when stale provisioning state remains after the team is alive', () => {
    provisioningHarness.state.active = true;
    const { host, onSend, root } = renderComposer({ isTeamAlive: true });

    expect(getSendButton(host).disabled).toBe(false);

    act(() => {
      getSendButton(host).click();
    });

    expect(onSend).toHaveBeenCalledOnce();

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
