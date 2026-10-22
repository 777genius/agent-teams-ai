import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}|${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(';')}`
        : key,
  }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));
vi.mock('@renderer/hooks/useFileSuggestions', () => ({
  useFileSuggestions: () => ({ suggestions: [], loading: false }),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

import { CreateTeamPromptField } from '@renderer/components/team/dialogs/CreateTeamPromptField';
import {
  createEncodedTaskReference,
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';

import type { MentionSuggestion } from '@renderer/types/mention';

const TEAM_SUGGESTION: MentionSuggestion = {
  id: 'team:design-crew',
  name: 'Design Crew',
  subtitle: 'online',
  color: 'blue',
  type: 'team',
  isOnline: true,
};

const TASK_INSERT_TEXT = createEncodedTaskReference('T-12', 'task-1', 'Design Team');
const TASK_SUGGESTION: MentionSuggestion = {
  id: 'task:Design Team:task-1',
  name: 'T-12',
  subtitle: 'Ship APIs',
  type: 'task',
  taskId: 'task-1',
  teamName: 'Design Team',
  teamDisplayName: 'Design Team',
  insertText: TASK_INSERT_TEXT,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onSuggestionsNeeded: ReturnType<typeof vi.fn>;
let capturedValues: string[];

function Harness({
  teamSuggestions,
  taskSuggestions,
}: Readonly<{
  teamSuggestions: MentionSuggestion[];
  taskSuggestions: MentionSuggestion[];
}>): React.JSX.Element {
  const [value, setValue] = React.useState('');
  return (
    <CreateTeamPromptField
      promptDraft={{
        value,
        isSaved: false,
        setValue: (next: string) => {
          capturedValues.push(next);
          setValue(next);
        },
      }}
      chipDraft={{
        chips: [],
        removeChip: () => undefined,
        addChip: () => undefined,
      }}
      soloTeam={false}
      mentionSuggestions={[]}
      teamSuggestions={teamSuggestions}
      taskSuggestions={taskSuggestions}
      projectPath={null}
      onSuggestionsNeeded={onSuggestionsNeeded}
    />
  );
}

function renderField(teamSuggestions: MentionSuggestion[], taskSuggestions: MentionSuggestion[]) {
  root.render(<Harness teamSuggestions={teamSuggestions} taskSuggestions={taskSuggestions} />);
}

/** Lets the initial render commit before interactions. */
async function flushRender(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function promptTextarea(): HTMLTextAreaElement {
  const found = host.querySelector<HTMLTextAreaElement>('textarea#team-prompt');
  if (!found) throw new Error('expected the team prompt textarea to be rendered');
  return found;
}

/** Bypass React's value tracker so the controlled textarea registers the edit. */
function typeIntoPrompt(value: string): void {
  const textarea = promptTextarea();
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (!descriptor?.set) throw new Error('expected the native value setter to exist');
  descriptor.set.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function optionByText(text: string): HTMLElement {
  const options = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
  const found = options.find((option) => option.textContent?.includes(text));
  if (!found) {
    throw new Error(
      `expected a suggestion option containing "${text}"; got: ${options
        .map((option) => option.textContent)
        .join(' | ')}`
    );
  }
  return found;
}

function focusPrompt(): void {
  act(() => {
    promptTextarea().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

function selectOption(text: string): void {
  act(() => {
    optionByText(text).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    );
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onSuggestionsNeeded = vi.fn();
  capturedValues = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('CreateTeamPromptField suggestion initialization', () => {
  it('never initializes suggestions until the prompt is focused', async () => {
    renderField([TEAM_SUGGESTION], [TASK_SUGGESTION]);
    await flushRender();

    expect(onSuggestionsNeeded).not.toHaveBeenCalled();

    focusPrompt();
    expect(onSuggestionsNeeded).toHaveBeenCalledTimes(1);

    // The dialog's enable handler is idempotent; repeated focuses only re-report.
    focusPrompt();
    expect(onSuggestionsNeeded).toHaveBeenCalledTimes(2);
  });
});

describe('CreateTeamPromptField structured reference insertion', () => {
  it('displays cross-team mention suggestions and inserts the mention reference on select', async () => {
    renderField([TEAM_SUGGESTION], [TASK_SUGGESTION]);
    await flushRender();
    focusPrompt();

    act(() => {
      typeIntoPrompt('@');
    });

    const option = optionByText('Design Crew');
    expect(option.getAttribute('role')).toBe('option');

    selectOption('Design Crew');
    // Team mentions insert the "@<name> " token that mention linkification
    // later encodes as a team:// reference — plain display text plus trigger.
    expect(capturedValues.at(-1)).toBe('@Design Crew ');
  });

  it('inserts the zero-width encoded task reference when a # suggestion is selected', async () => {
    renderField([TEAM_SUGGESTION], [TASK_SUGGESTION]);
    await flushRender();
    focusPrompt();

    act(() => {
      typeIntoPrompt('#');
    });

    optionByText('Ship APIs');
    selectOption('Ship APIs');

    expect(capturedValues.at(-1)).toBe(`${TASK_INSERT_TEXT} `);
    const inserted = capturedValues.at(-1) ?? '';
    // The structured payload survives the round trip — not just the visible
    // "#T-12" label. Decode it with the repository's own parser.
    expect(extractTaskRefsFromText(inserted, [TASK_SUGGESTION])).toEqual([
      { taskId: 'task-1', displayId: 'T-12', teamName: 'Design Team' },
    ]);
    expect(stripEncodedTaskReferenceMetadata(inserted)).toBe('#T-12 ');
  });
});
