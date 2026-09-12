import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  parseHostedTeamConfigurationIdempotencyKey,
} from '../../../../src/features/team-configuration/contracts';
import { HostedTeamConfigurationPanel } from '../../../../src/features/team-configuration/renderer/ui/HostedTeamConfigurationPanel';
import {
  createSafeAppError,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '../../../../src/shared/contracts/hosted';

import type { HostedTeamConfigurationTransport } from '../../../../src/features/team-configuration/renderer';

const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const teamId = parseTeamId(`team_${'2'.repeat(32)}`);
const revision = parseRevision('revision_roster-editor');

function input(host: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`input-not-found:${label}`);
  return found;
}

function buttons(host: ParentNode, text: string): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter(
    (candidate) => candidate.textContent?.trim() === text
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function change(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectRadixOption(
  host: ParentNode,
  triggerLabel: string,
  optionText: string
): Promise<void> {
  const trigger = host.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${triggerLabel}"]`
  );
  if (!trigger) throw new Error(`select-trigger-not-found:${triggerLabel}`);
  await click(trigger);
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.trim() === optionText
  );
  if (!option) throw new Error(`select-option-not-found:${optionText}`);
  await click(option);
}

async function renderPanel(
  transport: HostedTeamConfigurationTransport,
  selectedTeamId: typeof teamId | null,
  createIdempotencyKey: () => ReturnType<typeof parseHostedTeamConfigurationIdempotencyKey> = () =>
    parseHostedTeamConfigurationIdempotencyKey('idempotency_roster-editor-default')
): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HostedTeamConfigurationPanel
        workspaceId={workspaceId}
        teamId={selectedTeamId}
        transport={transport}
        onTeamCreated={vi.fn()}
        onTeamDeleted={vi.fn()}
        createIdempotencyKey={createIdempotencyKey}
      />
    );
  });
  return { host, root };
}

describe('Hosted initial roster editor', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('adds, removes, and reorders mixed lanes/members and sends exact complete configuration', async () => {
    const createDraft = vi.fn<HostedTeamConfigurationTransport['createDraft']>(async () => ({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'error' as const,
      error: createSafeAppError({ code: 'unavailable', reason: 'team_configuration_unavailable' }),
      retryable: true,
    }));
    const transport = {
      getSavedRequest: vi.fn(),
      createDraft,
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
    } as HostedTeamConfigurationTransport;
    let key = 0;
    const { host, root } = await renderPanel(transport, null, () =>
      parseHostedTeamConfigurationIdempotencyKey(`idempotency_roster-editor-${++key}-request`)
    );

    await change(input(host, 'Team name'), 'Mixed Team');
    await change(input(host, 'Lane 1 member 1 instructions'), 'Coordinate.');
    await click(buttons(host, 'Add member')[0]!);
    await change(input(host, 'Lane 1 member 2 name'), 'reviewer');
    await change(input(host, 'Lane 1 member 2 model'), 'gpt-5.6-terra');
    await change(input(host, 'Lane 1 member 2 instructions'), 'Review.');
    await click(buttons(host, 'Move member up')[1]!);
    await click(buttons(host, 'Add member')[0]!);
    expect(input(host, 'Lane 1 member 3 name').value).toBe('');
    await click(buttons(host, 'Remove member').at(-1)!);
    expect(host.querySelector('[aria-label="Lane 1 member 3 name"]')).toBeNull();

    await click(buttons(host, 'Add Gemini lane')[0]!);
    await click(buttons(host, 'Remove lane').at(-1)!);
    await click(buttons(host, 'Add OpenCode lane')[0]!);
    expect(host.querySelector('[aria-label="Lane 2 effort"]')?.textContent).toContain(
      'Not specified'
    );
    await change(input(host, 'Lane 2 OpenCode model'), 'openai/gpt-5.6');
    await change(input(host, 'Lane 2 member 1 name'), 'builder');
    await change(input(host, 'Lane 2 member 1 model'), 'github-copilot/gpt-5.6-sol');
    await change(input(host, 'Lane 2 member 1 instructions'), 'Build.');
    await click(buttons(host, 'Move lane up')[1]!);
    await click(buttons(host, 'Create draft')[0]!);

    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledOnce());
    expect(createDraft.mock.calls[0]?.[0]).toMatchObject({
      name: 'Mixed Team',
      members: [{ name: 'builder' }, { name: 'reviewer' }, { name: 'lead' }],
      configuration: {
        schemaVersion: 1,
        toolApprovalMode: 'auto',
        lanes: [
          {
            kind: 'opencode',
            provider: 'opencode',
            selectedModel: 'openai/gpt-5.6',
            members: [
              { name: 'builder', prompt: 'Build.', model: 'github-copilot/gpt-5.6-sol' },
            ],
          },
          {
            kind: 'native',
            provider: 'codex',
            members: [
              { name: 'reviewer', prompt: 'Review.', model: 'gpt-5.6-terra' },
              { name: 'lead', prompt: 'Coordinate.', model: 'gpt-5.6-sol', effort: 'medium' },
            ],
          },
        ],
      },
    });
    expect(input(host, 'Lane 1 member 1 instructions').value).toBe('Build.');
    await vi.waitFor(() => expect(host.textContent).toContain('could not be completed'));
    act(() => root.unmount());
  });

  it('restores OpenCode-only fields after actual runtime selector changes', async () => {
    const createDraft = vi.fn<HostedTeamConfigurationTransport['createDraft']>(async () => ({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'error' as const,
      error: createSafeAppError({ code: 'unavailable', reason: 'team_configuration_unavailable' }),
      retryable: true,
    }));
    const transport = {
      getSavedRequest: vi.fn(), createDraft, updateDraft: vi.fn(), deleteDraft: vi.fn(),
    } as HostedTeamConfigurationTransport;
    const { host, root } = await renderPanel(transport, null);

    await change(input(host, 'Team name'), 'Provider Switch Team');
    await change(input(host, 'Lane 1 member 1 instructions'), 'Coordinate.');
    await click(buttons(host, 'Add OpenCode lane')[0]!);
    await change(input(host, 'Lane 2 OpenCode model'), 'openai/gpt-5.6');
    await selectRadixOption(host, 'Lane 2 effort', 'high');
    await change(input(host, 'Lane 2 member 1 name'), 'builder');
    await change(input(host, 'Lane 2 member 1 model'), 'github-copilot/gpt-5.6-sol');
    await change(input(host, 'Lane 2 member 1 instructions'), 'Build.');

    await selectRadixOption(host, 'Lane 2 runtime', 'Codex');
    expect(host.querySelector('[aria-label="Lane 2 OpenCode model"]')).toBeNull();
    expect(host.querySelector('[aria-label="Lane 2 effort"]')).toBeNull();
    await click(buttons(host, 'Create draft')[0]!);
    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    const nativeConfiguration = createDraft.mock.calls[0]?.[0].configuration;
    expect(nativeConfiguration?.lanes[1]).toEqual({
      kind: 'native',
      provider: 'codex',
      members: [
        {
          name: 'builder',
          prompt: 'Build.',
          model: 'github-copilot/gpt-5.6-sol',
        },
      ],
    });
    await vi.waitFor(() => expect(host.textContent).toContain('could not be completed'));

    await selectRadixOption(host, 'Lane 2 runtime', 'OpenCode');
    expect(input(host, 'Lane 2 OpenCode model').value).toBe('openai/gpt-5.6');
    expect(host.querySelector('[aria-label="Lane 2 effort"]')?.textContent).toContain('high');
    await click(buttons(host, 'Create draft')[0]!);
    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledTimes(2));
    expect(createDraft.mock.calls[1]?.[0].configuration).toEqual({
      schemaVersion: 1,
      toolApprovalMode: 'auto',
      lanes: [
        {
          kind: 'native',
          provider: 'codex',
          members: [
            {
              name: 'lead',
              prompt: 'Coordinate.',
              model: 'gpt-5.6-sol',
              effort: 'medium',
            },
          ],
        },
        {
          kind: 'opencode',
          provider: 'opencode',
          selectedModel: 'openai/gpt-5.6',
          effort: 'high',
          members: [
            {
              name: 'builder',
              prompt: 'Build.',
              model: 'github-copilot/gpt-5.6-sol',
            },
          ],
        },
      ],
    });
    act(() => root.unmount());
  });

  it('rejects incomplete state locally and changes the operation key only when full intent changes', async () => {
    const createDraft = vi.fn<HostedTeamConfigurationTransport['createDraft']>(async () => ({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'error' as const,
      error: createSafeAppError({ code: 'unavailable', reason: 'team_configuration_unavailable' }),
      retryable: true,
    }));
    const transport = {
      getSavedRequest: vi.fn(), createDraft, updateDraft: vi.fn(), deleteDraft: vi.fn(),
    } as HostedTeamConfigurationTransport;
    let key = 0;
    const { host, root } = await renderPanel(transport, null, () =>
      parseHostedTeamConfigurationIdempotencyKey(`idempotency_roster-fingerprint-${++key}`)
    );

    await change(input(host, 'Team name'), 'Intent Team');
    await click(buttons(host, 'Create draft')[0]!);
    expect(createDraft).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Member “lead” needs instructions.');

    await change(input(host, 'Lane 1 member 1 instructions'), 'First prompt.');
    await click(buttons(host, 'Create draft')[0]!);
    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(host.textContent).toContain('could not be completed'));
    await click(buttons(host, 'Create draft')[0]!);
    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.textContent).toContain('could not be completed'));
    expect(createDraft.mock.calls[1]?.[0].idempotencyKey).toBe(
      createDraft.mock.calls[0]?.[0].idempotencyKey
    );

    await change(input(host, 'Lane 1 member 1 model'), 'gpt-5.6-luna');
    await click(buttons(host, 'Create draft')[0]!);
    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledTimes(3));
    expect(createDraft.mock.calls[2]?.[0].idempotencyKey).not.toBe(
      createDraft.mock.calls[1]?.[0].idempotencyKey
    );
    act(() => root.unmount());
  });

  it('renders saved manual configuration read-only and leaves missing configuration visibly incomplete', async () => {
    const getSavedRequest = vi.fn(async () => ({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'found' as const,
      draft: {
        workspaceId,
        teamId,
        revision,
        metadata: { name: 'Manual Team' },
        members: [
          { name: 'lead' },
          { name: 'coder' },
          { name: 'researcher' },
          { name: 'builder' },
        ],
        configuration: {
          schemaVersion: 1 as const,
          toolApprovalMode: 'manual' as const,
          lanes: [
            {
              kind: 'native' as const,
              provider: 'anthropic' as const,
              members: [
                {
                  name: 'lead',
                  prompt: 'Coordinate.\nReview every result.\nPreserve all saved instructions.',
                  model: 'claude-opus-4-6',
                  effort: 'max' as const,
                },
              ],
            },
            {
              kind: 'native' as const,
              provider: 'codex' as const,
              members: [
                {
                  name: 'coder',
                  prompt: 'Implement.',
                  model: 'gpt-5.6-sol',
                  effort: 'medium' as const,
                },
              ],
            },
            {
              kind: 'native' as const,
              provider: 'gemini' as const,
              members: [
                {
                  name: 'researcher',
                  prompt: 'Preserve me.',
                  model: 'gemini-2.5-pro',
                  effort: 'high' as const,
                },
              ],
            },
            {
              kind: 'opencode' as const,
              provider: 'opencode' as const,
              selectedModel: 'z-ai/glm-5',
              effort: 'low' as const,
              members: [
                {
                  name: 'builder',
                  prompt: 'Build.',
                  model: 'openrouter/model-x',
                  effort: 'high' as const,
                },
              ],
            },
          ],
        },
      },
    }));
    const transport = {
      getSavedRequest, createDraft: vi.fn(), updateDraft: vi.fn(), deleteDraft: vi.fn(),
    } as HostedTeamConfigurationTransport;
    const { host, root } = await renderPanel(transport, teamId);

    await vi.waitFor(() =>
      expect(input(host, 'Lane 1 member 1 instructions').value).toBe(
        'Coordinate.\nReview every result.\nPreserve all saved instructions.'
      )
    );
    expect(host.querySelector('[aria-label="Lane 1 runtime"]')?.textContent).toContain(
      'Claude / Anthropic'
    );
    expect(host.querySelector('[aria-label="Lane 2 runtime"]')?.textContent).toContain('Codex');
    expect(host.querySelector('[aria-label="Lane 3 runtime"]')?.textContent).toContain('Gemini');
    expect(host.querySelector('[aria-label="Lane 4 runtime"]')?.textContent).toContain('OpenCode');
    expect(input(host, 'Lane 2 member 1 model').value).toBe('gpt-5.6-sol');
    expect(input(host, 'Lane 3 member 1 instructions').value).toBe('Preserve me.');
    expect(input(host, 'Lane 3 member 1 model').value).toBe('gemini-2.5-pro');
    expect(input(host, 'Lane 4 OpenCode model').value).toBe('z-ai/glm-5');
    expect(input(host, 'Lane 4 member 1 model').value).toBe('openrouter/model-x');
    expect(
      host.querySelector<HTMLElement>('[aria-label="Lane 1 member 1 effort"]')?.textContent
    ).toContain('max');
    const savedInstructions = input(host, 'Lane 1 member 1 instructions');
    const savedModel = input(host, 'Lane 2 member 1 model');
    expect(savedInstructions).toMatchObject({ disabled: false, readOnly: true });
    expect(savedModel).toMatchObject({ disabled: false, readOnly: true });
    savedInstructions.focus();
    expect(document.activeElement).toBe(savedInstructions);
    savedModel.focus();
    expect(document.activeElement).toBe(savedModel);
    expect(buttons(host, 'Add member')).toHaveLength(0);
    expect(buttons(host, 'Add OpenCode lane')).toHaveLength(0);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Lane 1 runtime"]')?.disabled).toBe(
      true
    );
    expect(host.textContent).toContain('This saved draft uses manual approval.');
    expect(host.textContent).toContain('remains readable and unchanged');
    act(() => root.unmount());

    const incompleteTransport = {
      ...transport,
      getSavedRequest: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: {
          workspaceId,
          teamId,
          revision,
          metadata: { name: 'Historical Team' },
          members: [{ name: 'lead' }, { name: 'researcher' }],
        },
      })),
    } as HostedTeamConfigurationTransport;
    const incomplete = await renderPanel(incompleteTransport, teamId);
    await vi.waitFor(() => expect(incomplete.host.textContent).toContain('configuration is missing'));
    expect(incomplete.host.textContent).toContain('Saved member order: lead, researcher');
    expect(incomplete.host.textContent).toContain('cannot be launched');
    act(() => incomplete.root.unmount());
  });
});
