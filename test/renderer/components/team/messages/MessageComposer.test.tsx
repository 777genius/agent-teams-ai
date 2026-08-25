/* eslint-disable @typescript-eslint/naming-convention -- mocked React component exports are PascalCase */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

const aliveListReadHarness = vi.hoisted(() => ({
  listAliveTeams: vi.fn<() => Promise<string[]>>(),
}));

const storeHarness = vi.hoisted(() => ({
  crossTeamTargets: [] as {
    teamName: string;
    displayName: string;
    description?: string;
    color?: string;
  }[],
  fetchCrossTeamTargets: vi.fn<() => Promise<boolean>>(),
  fetchSkillsCatalog: vi.fn(),
}));

vi.mock('@renderer/composition/team/createTeamAliveListReadPort', () => ({
  createTeamAliveListReadPort: () => ({
    listAliveTeams: aliveListReadHarness.listAliveTeams,
  }),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@renderer/components/team/attachments/AttachmentPreviewList', () => ({
  AttachmentPreviewList: () => null,
}));

vi.mock('@renderer/components/team/attachments/DropZoneOverlay', () => ({
  DropZoneOverlay: () => null,
}));

vi.mock('@renderer/components/team/composer/ComposerSurface', () => {
  const ComposerSurface = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
    (props, ref) => React.createElement('div', { ...props, ref })
  );
  const ComposerTextarea = React.forwardRef<
    HTMLTextAreaElement,
    {
      cornerAction?: React.ReactNode;
      cornerActionLeft?: React.ReactNode;
      footerRight?: React.ReactNode;
      value?: string;
    }
  >(({ cornerAction, cornerActionLeft, footerRight, value }, ref) =>
    React.createElement(
      'div',
      null,
      React.createElement('textarea', { readOnly: true, ref, value }),
      cornerActionLeft,
      cornerAction,
      footerRight
    )
  );
  ComposerSurface.displayName = 'MockComposerSurface';
  ComposerTextarea.displayName = 'MockComposerTextarea';
  return { ComposerSurface, ComposerTextarea };
});

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

vi.mock('@renderer/components/team/messages/ActionModeSelector', () => ({
  ActionModeSelector: () => null,
}));

vi.mock('@renderer/components/team/messages/OpenCodeDeliveryWarning', () => ({
  OpenCodeDeliveryWarning: () => null,
}));

vi.mock('@renderer/components/ui/popover', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  interface PopoverContextValue {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }
  const PopoverContext = ReactModule.createContext<PopoverContextValue>({ open: false });

  function Popover({
    children,
    open = false,
    onOpenChange,
  }: React.PropsWithChildren<{
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }>): React.JSX.Element {
    return ReactModule.createElement(
      PopoverContext.Provider,
      { value: { open, onOpenChange } },
      children
    );
  }

  function PopoverTrigger({ children }: React.PropsWithChildren): React.JSX.Element {
    const context = ReactModule.useContext(PopoverContext);
    if (!ReactModule.isValidElement<{ onClick?: React.MouseEventHandler }>(children)) {
      return ReactModule.createElement(ReactModule.Fragment, null, children);
    }
    const childOnClick = children.props.onClick;
    return ReactModule.cloneElement(children, {
      onClick: (event: React.MouseEvent) => {
        childOnClick?.(event);
        context.onOpenChange?.(!context.open);
      },
    });
  }

  function PopoverContent({ children }: React.PropsWithChildren): React.JSX.Element | null {
    return ReactModule.useContext(PopoverContext).open
      ? ReactModule.createElement('div', null, children)
      : null;
  }

  return { Popover, PopoverContent, PopoverTrigger };
});

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/hooks/useComposerDraft', () => ({
  useComposerDraft: () => ({
    text: '',
    setText: vi.fn(),
    chips: [],
    addChip: vi.fn(),
    removeChip: vi.fn(),
    attachments: [],
    attachmentError: null,
    canAddMore: true,
    addFiles: vi.fn().mockResolvedValue(undefined),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    clearAttachmentError: vi.fn(),
    handlePaste: vi.fn(),
    handleDrop: vi.fn(),
    actionMode: 'do',
    setActionMode: vi.fn(),
    isSaved: true,
    isLoaded: true,
    clearDraft: vi.fn(),
    hideDraftForPendingSend: vi.fn(),
    finalizePendingSendClear: vi.fn(),
    restoreDraft: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/hooks/useTeamSuggestions', () => ({
  useTeamSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      crossTeamTargets: storeHarness.crossTeamTargets,
      fetchCrossTeamTargets: storeHarness.fetchCrossTeamTargets,
      fetchSkillsCatalog: storeHarness.fetchSkillsCatalog,
      selectedTeamData: null,
      selectedTeamName: null,
      skillsProjectCatalogByProjectPath: {},
      skillsUserCatalog: [],
    }),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: () => false,
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertCircle: Icon,
    Check: Icon,
    ChevronDown: Icon,
    Mic: Icon,
    Paperclip: Icon,
    Search: Icon,
    Send: Icon,
  };
});

import { MessageComposer } from '@renderer/components/team/messages/MessageComposer';

const members: ResolvedTeamMember[] = [
  {
    agentType: 'team-lead',
    currentTaskId: null,
    lastActiveAt: null,
    messageCount: 0,
    name: 'team-lead',
    role: 'Team Lead',
    status: 'idle',
    taskCount: 0,
  },
];

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function getTeamSelector(host: HTMLElement): HTMLButtonElement {
  const selector = host.querySelector('.message-composer-target-selectors button');
  if (!(selector instanceof HTMLButtonElement)) {
    throw new Error('Team selector not found');
  }
  return selector;
}

describe('MessageComposer alive-team selector refresh', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    aliveListReadHarness.listAliveTeams.mockReset();
    storeHarness.fetchCrossTeamTargets.mockReset();
    storeHarness.fetchSkillsCatalog.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('refreshes alive teams on every open and retries target loading after a failed open', async () => {
    aliveListReadHarness.listAliveTeams
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(['team-beta']);
    storeHarness.fetchCrossTeamTargets.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <MessageComposer
          teamName="team-alpha"
          members={members}
          isTeamAlive
          sending={false}
          sendError={null}
          onSend={vi.fn()}
        />
      );
      await flushEffects();
    });

    expect(aliveListReadHarness.listAliveTeams).not.toHaveBeenCalled();
    expect(storeHarness.fetchCrossTeamTargets).not.toHaveBeenCalled();

    await act(async () => {
      getTeamSelector(host).click();
      await flushEffects();
    });

    expect(aliveListReadHarness.listAliveTeams).toHaveBeenCalledTimes(1);
    expect(storeHarness.fetchCrossTeamTargets).toHaveBeenCalledTimes(1);

    await act(async () => {
      getTeamSelector(host).click();
      await flushEffects();
      getTeamSelector(host).click();
      await flushEffects();
    });

    expect(aliveListReadHarness.listAliveTeams).toHaveBeenCalledTimes(2);
    expect(storeHarness.fetchCrossTeamTargets).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
    });
  });
});
