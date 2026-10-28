import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedInstallationState } from '../../../src/features/extension-management/renderer/ui/ManagedInstallationState';
import { ManagementOperationView } from '../../../src/features/extension-management/renderer/ui/ManagementOperationView';
import { ManagementPlanDialog } from '../../../src/features/extension-management/renderer/ui/ManagementPlanDialog';

import type {
  ManagementEnvironment,
  ManagementOperation,
  ManagementPlan,
  ManagementSession,
} from '../../../src/features/extension-management/contracts';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const targets: ManagementSession['targets'] = [
  {
    id: 'native-opencode',
    client: 'opencode',
    scope: 'user',
    label: 'OpenCode personal profile',
    displayPath: '/fixture/profile',
    available: true,
  },
];
const entry = (): ManagementEnvironment['entries'][number] => ({
  alias: 'example-skill',
  kind: 'skill',
  source: 'publisher/source@immutable-revision',
  declared: true,
  updateStatus: 'check_unavailable',
  bindings: [
    {
      targetId: 'native-opencode',
      client: 'opencode',
      scope: 'user',
      status: 'installed',
      managedPaths: ['/fixture/profile/skills/example-skill'],
      readiness: {
        materialization: 'materialized',
        activation: 'active',
        authentication: 'not_checked',
        policy: 'allowed',
        verification: 'not_run',
      },
    },
  ],
});

function renderInstallation(value = entry()) {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(
    <ManagedInstallationState entry={value} targets={targets} />
  );
  return root;
}

// textContent includes collapsed content in the DOM; inspect the actual primary presentation.
function visibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const details of clone.querySelectorAll('details:not([open])')) {
    details.replaceWith(details.querySelector('summary')!.cloneNode(true));
  }
  return clone.textContent ?? '';
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('compact managed extension presentation', () => {
  it('shows the captured client and installation state while keeping technical facts in closed details', () => {
    const root = renderInstallation();
    const primary = visibleText(root);
    expect(primary).toContain('OpenCode personal profile · uap.installed');
    expect(primary).not.toMatch(/ready/i);
    expect(primary).not.toContain('publisher/source');
    expect(primary).not.toContain('not_checked');
    expect(primary).not.toContain('/fixture/profile');
    expect(primary).not.toContain('uap.updateStatus.check_unavailable');
    const details = root.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('publisher/source@immutable-revision');
    expect(details.textContent).toContain('authentication: not_checked');
    expect(details.textContent).toContain('/fixture/profile/skills/example-skill');
    expect(details.textContent).toContain('uap.updateStatus.check_unavailable');
  });

  it('keeps incomplete bindings and manual, authentication, policy and unknown states visible', () => {
    const value = entry();
    value.bindings[0].status = 'incomplete';
    value.bindings[0].readiness = {
      materialization: 'degraded',
      activation: 'manual_activation_required',
      authentication: 'auth_pending',
      policy: 'blocked',
      verification: 'future_check_required',
    };
    const primary = visibleText(renderInstallation(value));
    expect(primary).toContain('OpenCode personal profile · incomplete');
    expect(primary).not.toContain('uap.installed');
    for (const value of [
      'materialization: degraded',
      'activation: manual activation required',
      'authentication: auth pending',
      'policy: blocked',
      'verification: future check required',
    ]) {
      expect(primary).toContain(value);
    }
  });

  it('does not present an outside-context binding as installed or ready', () => {
    const value = entry();
    value.bindings[0].status = 'outside_context';
    delete value.bindings[0].readiness;
    value.updateStatus = 'blocked';
    const primary = visibleText(renderInstallation(value));
    expect(primary).toContain('OpenCode personal profile · outside context');
    expect(primary).toContain('uap.updateStatus.blocked');
    expect(primary).not.toContain('uap.installed');
    expect(primary).not.toMatch(/ready/i);
  });

  it('leads the real review dialog with typed actions and captured labels without hiding versions or conflicts', async () => {
    const plan: ManagementPlan = {
      planId: 'plan-a',
      contextId: 'context-a',
      action: 'sync',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      confirmable: false,
      actions: [
        {
          action: 'update',
          alias: 'example-skill',
          targetId: 'native-opencode',
          description: 'no matching environment-owned binding',
          destinationPath: '/fixture/profile/skills/example-skill',
          fromVersion: '1.0.0',
          toVersion: '2.0.0',
        },
      ],
      warnings: [{ code: 'PIN', severity: 'warning', message: 'Pinned versions are preserved.' }],
      conflicts: [{ code: 'BUSY', severity: 'error', message: 'Stop the active run first.' }],
    };
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        root.render(
          <ManagementPlanDialog
            plan={plan}
            targets={targets}
            busy={false}
            error={null}
            uncertain={false}
            onClose={() => {}}
            onApply={() => {}}
          />
        );
      });
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const primary = visibleText(dialog);
      expect(primary).toContain('uap.update example-skill');
      expect(primary).toContain('OpenCode personal profile');
      expect(primary).toContain('1.0.0 → 2.0.0');
      expect(primary).toContain('Pinned versions are preserved.');
      expect(primary).toContain('Stop the active run first.');
      expect(primary).not.toContain('no matching environment-owned binding');
      expect(primary).not.toContain('/fixture/profile/skills/example-skill');
      const details = dialog.querySelector('details')!;
      expect(details.open).toBe(false);
      expect(details.textContent).toContain('no matching environment-owned binding');
      expect(details.textContent).toContain('/fixture/profile/skills/example-skill');
      const apply = [...dialog.querySelectorAll('button')].find(
        (button) => button.textContent === 'uap.apply'
      )!;
      expect(apply.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(['succeeded', 'partial'] as const)(
    'keeps exact native next steps visible with the appropriate %s tone',
    (state) => {
      const instruction =
        'Restart the native client to load the installed plugin.\nKeep this instruction verbatim.';
      const operation: ManagementOperation = {
        operationId: 'operation-a',
        requestId: 'request-a',
        planId: 'plan-a',
        contextId: 'context-a',
        environmentId: 'environment-a',
        action: 'install',
        state,
        phase: 'done',
        completed: 1,
        total: 1,
        items: [],
        diagnostics: [],
        createdAt: '2026-10-25T00:00:00Z',
        updatedAt: '2026-10-25T00:00:00Z',
        result: {
          outcome: state,
          mutated: true,
          items: [],
          nextActions: [{ kind: 'manual', reason: instruction }],
          message: '',
        },
      };
      const root = document.createElement('div');
      root.innerHTML = renderToStaticMarkup(
        <ManagementOperationView
          operation={operation}
          busy={false}
          onCancel={() => {}}
          onRecover={() => {}}
        />
      );
      expect(visibleText(root)).toContain(instruction);
      const nextStep = [...root.querySelectorAll('p')].find(
        (paragraph) => paragraph.textContent === instruction
      )!;
      expect(nextStep.classList.contains('text-amber-400')).toBe(state === 'partial');
      expect(nextStep.classList.contains('text-text-secondary')).toBe(state === 'succeeded');
      expect(visibleText(root).includes('uap.recover')).toBe(state === 'partial');
    }
  );
});
