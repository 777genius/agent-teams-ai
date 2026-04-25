import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember, SendMessageResult } from '@shared/types';

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => React.createElement('div', null, content),
}));

vi.mock('@renderer/components/team/attachments/AttachmentPreviewList', () => ({
  AttachmentPreviewList: () => null,
}));

vi.mock('@renderer/components/team/attachments/DropZoneOverlay', () => ({
  DropZoneOverlay: () => null,
}));

vi.mock('@renderer/components/team/messages/ActionModeSelector', () => ({
  ActionModeSelector: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) =>
    React.createElement(
      'select',
      {
        'aria-label': 'Action mode',
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
      },
      React.createElement('option', { value: 'do' }, 'Do'),
      React.createElement('option', { value: 'ask' }, 'Ask'),
      React.createElement('option', { value: 'delegate' }, 'Delegate')
    ),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { role: 'dialog' }, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
  }) => React.createElement('label', { htmlFor }, children),
}));

vi.mock('@renderer/components/ui/MemberSelect', () => ({
  MemberSelect: ({
    members,
    value,
    onChange,
  }: {
    members: ResolvedTeamMember[];
    value: string | null;
    onChange: (value: string | null) => void;
  }) =>
    React.createElement(
      'select',
      {
        'aria-label': 'Recipient',
        value: value ?? '',
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onChange(event.target.value || null),
      },
      React.createElement('option', { value: '' }, 'Select member...'),
      ...members.map((member) =>
        React.createElement('option', { key: member.name, value: member.name }, member.name)
      )
    ),
}));

vi.mock('@renderer/components/ui/MentionableTextarea', () => ({
  MentionableTextarea: ({
    value,
    onValueChange,
    placeholder,
    disabled,
    cornerAction,
    footerRight,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    cornerAction?: React.ReactNode;
    footerRight?: React.ReactNode;
  }) =>
    React.createElement(
      'div',
      null,
      React.createElement('textarea', {
        'aria-label': 'Message',
        placeholder,
        value,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onValueChange(event.target.value),
      }),
      React.createElement('div', null, cornerAction),
      React.createElement('div', null, footerRight)
    ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/hooks/useAttachments', () => ({
  useAttachments: () => ({
    attachments: [],
    error: null,
    canAddMore: true,
    addFiles: vi.fn().mockResolvedValue(undefined),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    clearError: vi.fn(),
    handlePaste: vi.fn(),
    handleDrop: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/hooks/useTeamSuggestions', () => ({
  useTeamSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { selectedTeamData: null }) => unknown) =>
    selector({ selectedTeamData: null }),
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

import { SendMessageDialog } from '@renderer/components/team/dialogs/SendMessageDialog';

const members: ResolvedTeamMember[] = [
  {
    name: 'team-lead',
    status: 'idle',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    agentType: 'team-lead',
    role: 'Team Lead',
  },
  {
    name: 'jack',
    status: 'idle',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    agentType: 'developer',
    role: 'Developer',
  },
];

function renderDialog(props: Partial<React.ComponentProps<typeof SendMessageDialog>> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const onSend = vi.fn<React.ComponentProps<typeof SendMessageDialog>['onSend']>();

  act(() => {
    root.render(
      React.createElement(SendMessageDialog, {
        open: true,
        teamName: 'team-a',
        members,
        defaultRecipient: 'jack',
        isTeamAlive: true,
        sending: false,
        sendError: null,
        sendWarning: null,
        sendDebugDetails: null,
        lastResult: null,
        onClose,
        onSend,
        ...props,
      })
    );
  });

  return { host, root, onClose, onSend };
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

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('HTMLTextAreaElement value setter not found');
  }
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SendMessageDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('preserves draft text when async send fails', async () => {
    let rejectSend: (error: Error) => void = () => undefined;
    const failedSend = new Promise<SendMessageResult | void>((_resolve, reject) => {
      rejectSend = reject;
    });
    const onSend = vi.fn(() => failedSend);
    const { host, root } = renderDialog({ onSend, teamName: 'team-runtime-failed' });

    const textarea = host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(textarea, 'Please verify the OpenCode delivery path');
      await Promise.resolve();
    });

    expect(getSendButton(host).disabled).toBe(false);

    await act(async () => {
      getSendButton(host).click();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith(
      'jack',
      'Please verify the OpenCode delivery path',
      'Please verify the OpenCode delivery path',
      undefined,
      'do',
      []
    );

    await act(async () => {
      rejectSend(new Error('runtime delivery failed'));
      await failedSend.catch(() => undefined);
      await Promise.resolve();
    });

    expect(textarea.value).toBe('Please verify the OpenCode delivery path');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('preserves draft text when OpenCode runtime delivery fails after persistence', async () => {
    const onSend = vi.fn<React.ComponentProps<typeof SendMessageDialog>['onSend']>(() =>
      Promise.resolve({
        deliveredToInbox: true,
        messageId: 'm-opencode-failed',
        runtimeDelivery: {
          providerId: 'opencode',
          attempted: true,
          delivered: false,
          reason: 'runtime_delivery_failed',
        },
      })
    );
    const { host, root } = renderDialog({ onSend });

    const textarea = host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(textarea, 'Keep this text if live delivery fails');
      await Promise.resolve();
    });

    await act(async () => {
      getSendButton(host).click();
      await Promise.resolve();
    });

    expect(textarea.value).toBe('Keep this text if live delivery fails');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows live delivery warning without closing the dialog', async () => {
    const warning =
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete.';
    const { host, root, onClose } = renderDialog({
      sendWarning: warning,
      sendDebugDetails: {
        messageId: 'm-opencode-1',
        providerId: 'opencode',
        delivered: false,
        responsePending: false,
        responseState: 'failed',
        ledgerStatus: 'failed',
        acceptanceUnknown: false,
        reason: 'runtime_delivery_failed',
        diagnostics: ['runtime_delivery_failed'],
      },
    });

    expect(host.textContent).toContain(warning);
    expect(host.textContent).not.toContain('ledgerStatus');
    expect(host.textContent).not.toContain('runtime_delivery_failed');

    const detailsButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Details')
    );
    expect(detailsButton).toBeTruthy();

    await act(async () => {
      detailsButton?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('ledgerStatus');
    expect(host.textContent).toContain('responseState');
    expect(host.textContent).toContain('runtime_delivery_failed');
    expect(host.textContent).toContain('Send Message');
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
