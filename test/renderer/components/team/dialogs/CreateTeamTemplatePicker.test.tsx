import '@features/localization/renderer/composition/createI18nextInstance';

import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { CreateTeamSurface } from '@renderer/components/team/dialogs/CreateTeamSurface';
import { CreateTeamTemplatePicker } from '@renderer/components/team/dialogs/CreateTeamTemplatePicker';
import { buildDefaultTeamDescription } from '@renderer/components/team/dialogs/createTeamDescription';
import { createMemberDraft } from '@renderer/components/team/members/membersEditorUtils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { TeamProviderId } from '@shared/types';

vi.mock('@renderer/store', () => ({ useStore: () => true }));

interface DraftState {
  members: MemberDraft[];
  description: string;
  prompt: string;
  chips: string[];
  runtimeProviderId?: TeamProviderId;
  runtimeModel?: string;
  launchTeam: boolean;
  soloTeam: boolean;
  syncModelsWithLead: boolean;
  teamName: string;
  project: string;
}

const pristine: DraftState = {
  members: [],
  description: buildDefaultTeamDescription(),
  prompt: '',
  chips: [],
  launchTeam: true,
  soloTeam: false,
  syncModelsWithLead: true,
  teamName: 'sandbox-team',
  project: '/tmp/TEST-template-project',
};

function Form({ initial }: { initial: DraftState }): React.JSX.Element {
  const [draft, setDraft] = useState(initial);
  const update = (patch: Partial<DraftState>) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <CreateTeamSurface
      presentation="page"
      open
      isCopy={false}
      onClose={() => {}}
      overlay={null}
      headerActions={
        <CreateTeamTemplatePicker
          form={{
            ...draft,
            isLoaded: true,
            setRuntimeSelection: () =>
              update({ runtimeProviderId: undefined, runtimeModel: undefined }),
            setLaunchTeam: (launchTeam) => update({ launchTeam }),
            setSoloTeam: (soloTeam) => update({ soloTeam }),
            setSyncModelsWithLead: (syncModelsWithLead) => update({ syncModelsWithLead }),
            setMembers: (members) => update({ members }),
          }}
          descriptionDraft={{
            value: draft.description,
            isLoaded: true,
            setValue: (description) => update({ description }),
          }}
          promptDraft={{
            value: draft.prompt,
            isLoaded: true,
            setValue: (prompt) => update({ prompt }),
          }}
          defaultDescription={buildDefaultTeamDescription()}
          hasPromptChips={draft.chips.length > 0}
          clearPromptChips={() => update({ chips: [] })}
        />
      }
    >
      <output data-testid="draft">{JSON.stringify(draft)}</output>
    </CreateTeamSurface>
  );
}

describe('create team template replacement', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const readDraft = (): DraftState => JSON.parse(host.querySelector('output')!.textContent!);
  const selectTemplate = async () => {
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === 'Software Product Team'
    )!;
    expect(option).toBeDefined();
    await act(async () => option.click());
  };
  const clickDialogButton = async (label: string) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')
    ).find((item) => item.textContent === label)!;
    expect(button).toBeDefined();
    await act(async () => button.click());
  };

  // RED if pristine creation prompts unnecessarily or the picker is moved back into the form body.
  it('applies immediately to a pristine lead-only form from the header', async () => {
    await act(async () => root.render(createElement(Form, { initial: pristine })));
    expect(host.querySelector('header [role="combobox"]')).not.toBeNull();
    expect(readDraft().description).toBe('');
    await selectTemplate();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    const applied = readDraft();
    expect(applied.members.map((member) => member.name)).toEqual(['designer', 'engineer', 'qa']);
    expect(applied.description).toBe(
      'Design, build and validate apps, websites and digital products.'
    );
    expect(applied.prompt).toContain('Coordinate a small software product team.');
    expect(applied.launchTeam).toBe(false);
    expect(applied.teamName).toBe(pristine.teamName);
    expect(applied.project).toBe(pristine.project);
  });

  // RED if choosing a template destroys an edited draft before the user confirms.
  it('preserves every field on cancel and applies the template only after confirmation', async () => {
    const edited: DraftState = {
      ...pristine,
      members: [
        createMemberDraft({
          name: 'custom-worker',
          workflow: 'Keep my instructions',
          model: 'custom-model',
        }),
      ],
      description: 'Custom description',
      prompt: 'Custom prompt',
      chips: ['saved-file-chip'],
      runtimeProviderId: 'codex',
      runtimeModel: 'gpt-5.5',
      soloTeam: true,
      syncModelsWithLead: false,
    };
    await act(async () => root.render(createElement(Form, { initial: edited })));
    await selectTemplate();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Apply team template?');
    expect(readDraft()).toEqual(edited);
    await clickDialogButton('Cancel');
    expect(readDraft()).toEqual(edited);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await selectTemplate();
    await clickDialogButton('Apply template');
    const applied = readDraft();
    expect(applied.members.map((member) => member.name)).toEqual(['designer', 'engineer', 'qa']);
    expect(applied.chips).toEqual([]);
    expect(applied.runtimeProviderId).toBeUndefined();
    expect(applied.runtimeModel).toBeUndefined();
    expect(applied.soloTeam).toBe(false);
    expect(applied.syncModelsWithLead).toBe(true);
    expect(applied.launchTeam).toBe(false);
    expect(applied.description).toBe(
      'Design, build and validate apps, websites and digital products.'
    );
    expect(applied.prompt).toContain('Coordinate a small software product team.');
    expect(applied.teamName).toBe(edited.teamName);
    expect(applied.project).toBe(edited.project);
  });

  // RED if any individual edited field incorrectly bypasses replacement confirmation.
  it.each([
    { members: [createMemberDraft({ name: 'added-teammate' })] },
    { description: 'Edited team description' },
    { prompt: 'Custom instructions' },
    { chips: ['attachment'] },
    { runtimeProviderId: 'codex' as const },
    { soloTeam: true },
    { syncModelsWithLead: false },
  ])('protects each non-default replacement field: %o', async (patch) => {
    const edited = { ...pristine, ...patch };
    await act(async () => root.render(createElement(Form, { initial: edited })));
    await selectTemplate();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await clickDialogButton('Cancel');
    expect(readDraft()).toEqual(edited);
  });
});
