import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { HostedDashboardPalette, type HostedDashboardPaletteProps } from '@renderer/hosted/dashboard/HostedDashboardPalette';
import {
  parseBootId,
  parseDeploymentId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedTeamDirectoryReadState } from '@features/team-lifecycle/renderer';
import type { HostedWorkspaceDto } from '@features/workspace-registry/contracts';

const bootId = parseBootId(`boot_${'b'.repeat(32)}`);
const deploymentId = parseDeploymentId(`deployment_${'d'.repeat(32)}`);
const workspaceId = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const teamId = parseTeamId(`team_${'b'.repeat(32)}`);
const workspace: HostedWorkspaceDto = {
  workspaceId,
  label: 'Workspace 1',
  registrationRevision: 1,
  mount: { bootId, mountGeneration: 1, observedAt: 1, health: 'healthy', capabilities: [] },
};

const directory = (readEpoch: number): HostedTeamDirectoryReadState => ({
  scopeKey: workspaceId,
  freshness: 'fresh',
  snapshot: {
    readEpoch,
    revision: 'revision_palette' as never,
    readStartedAtWatermark: 0,
    items: [{ workspaceId, teamId, displayName: 'Test team' } as never],
  },
  failure: null,
  watermark: 0,
  runtime: { phase: 'complete', byTeamId: new Map() },
});

let node: HTMLDivElement;
let root: Root;
let props: HostedDashboardPaletteProps;

async function renderPalette(): Promise<void> {
  await act(async () => { root.render(<HostedDashboardPalette {...props} />); });
}

async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => { button!.click(); });
}

async function typeQuery(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Find a workspace"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  props = {
    open: true,
    onClose: vi.fn(),
    authorityKey: 'grant-1',
    authAvailable: true,
    runtimeIdentity: { bootId, deploymentId },
    workspaces: [workspace],
    selectedWorkspaceId: null,
    directory: null,
    teamOpenAvailable: false,
    loadRecent: vi.fn().mockResolvedValue({
      schemaVersion: 1, kind: 'recent-projects', bootId, deploymentId,
      readAt: 1, completeness: 'complete', projects: [],
    }),
    onSelectWorkspace: vi.fn().mockResolvedValue({ kind: 'opened' }),
    onSelectTeam: vi.fn(),
  };
  await renderPalette();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  node.remove();
  vi.unstubAllGlobals();
});

describe('Hosted Dashboard palette navigation', () => {
  it('keeps failed rows unreachable by keyboard and offers touch retry', async () => {
    const select = vi.fn()
      .mockResolvedValueOnce({ kind: 'failed', message: 'Selection failed.' })
      .mockResolvedValueOnce({ kind: 'opened' });
    props = { ...props, onSelectWorkspace: select };
    await renderPalette();
    await click('Workspace 1');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Selection failed.');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find a workspace"]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(select).toHaveBeenCalledTimes(1);
    await click('Retry');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await click('Workspace 1');
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('clears selection errors when the query or grant changes', async () => {
    props = { ...props, onSelectWorkspace: vi.fn().mockResolvedValue({
      kind: 'stale_target',
    }) };
    await renderPalette();
    await click('Workspace 1');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Workspace changed');
    await typeQuery('Workspace');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await click('Workspace 1');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Workspace changed');
    props = { ...props, authorityKey: 'grant-2' };
    await renderPalette();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('selects a workspace, then opens only a team from the current directory epoch', async () => {
    expect(document.body.textContent).not.toContain('Sessions');
    expect(document.body.textContent).not.toContain('Global search');
    await click('Workspace 1');
    expect(props.onSelectWorkspace).toHaveBeenCalledWith(workspaceId, undefined);
    props = { ...props, selectedWorkspaceId: workspaceId,
      directory: directory(1), teamOpenAvailable: true };
    await renderPalette();
    expect(document.body.textContent).toContain('Test team');
    await click('Test team');
    expect(props.onSelectTeam).toHaveBeenCalledWith(teamId);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('hides old team results as soon as grant authority changes', async () => {
    await click('Workspace 1');
    props = { ...props, selectedWorkspaceId: workspaceId,
      directory: directory(1), teamOpenAvailable: true };
    await renderPalette();
    expect(document.body.textContent).toContain('Test team');
    props = { ...props, authorityKey: 'grant-2', directory: null, teamOpenAvailable: false };
    await renderPalette();
    expect(document.body.textContent).not.toContain('Test team');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find a team"]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(props.onSelectTeam).not.toHaveBeenCalled();
  });

  it('refuses a late recent-project response from an earlier grant', async () => {
    let resolveOld!: (value: Awaited<ReturnType<HostedDashboardPaletteProps['loadRecent']>>) => void;
    const old = new Promise<Awaited<ReturnType<HostedDashboardPaletteProps['loadRecent']>>>(
      (resolve) => { resolveOld = resolve; }
    );
    props = { ...props, authorityKey: 'grant-a', loadRecent: vi.fn(() => old) };
    await renderPalette();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(props.loadRecent).toHaveBeenCalledOnce();

    props = { ...props, authorityKey: 'grant-b', loadRecent: vi.fn().mockResolvedValue({
      schemaVersion: 1, kind: 'recent-projects', bootId, deploymentId,
      readAt: 2, completeness: 'complete', projects: [],
    }) };
    await renderPalette();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { resolveOld({
      schemaVersion: 1, kind: 'recent-projects', bootId, deploymentId,
      readAt: 1, completeness: 'complete', projects: [{
        workspaceId, label: 'Workspace 1', registrationRevision: 1,
        mountGeneration: 1, sources: [{
          provider: 'codex', observedAt: 1, confirmedAt: 1, freshness: 'fresh',
        }], openAvailability: 'available',
      }],
    }); });
    expect(document.body.textContent).not.toContain('Recent');
  });
});
