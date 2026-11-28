import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { OptionalSettingsSection } from '@renderer/components/team/dialogs/OptionalSettingsSection';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));

type LaunchObservation = (selected: object) => Promise<void>;
let makeObservation: (environment: Record<string, unknown>) => LaunchObservation;
const unmounts: (() => void)[] = [];

beforeAll(async () => {
  const source = (await readFile('scripts/legacy-agent-host/desktop-emulated-selection-ui.ts', 'utf8'))
    .replace(/\r\n/gu, '\n');
  const begin = '  const openLaunch = async (', end = '  const launch = async (';
  for (const marker of [begin, end]) expect(source.split(marker)).toHaveLength(2);
  const actual = stripTypeScriptTypes(source.slice(source.indexOf(begin), source.indexOf(end)));
  makeObservation = Function('environment', `'use strict';
    const {assert,ui,literal,record,cdp,fill,installer}=environment;
    ${actual}
    return openLaunch;`) as typeof makeObservation;
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  vi.restoreAllMocks();
});

function fixture(options: { provider?: string; effort?: string; editable?: boolean; duplicateOnExpand?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(
    <div role="dialog">
      <OptionalSettingsSection title="Optional launch settings" description="Original project settings"
        summary={[`Provider: ${options.provider ?? 'Codex'}`, 'Model: TEST-model-next', `Effort: ${options.effort ?? 'high'}`]}>
        <div data-role="lead-row">
          {options.editable && <button id="lead-effort">High</button>}
        </div>
        <textarea id="dialog-prompt" />
      </OptionalSettingsSection>
      <button id="dialog-skip-permissions" data-state="unchecked" />
      <button>Launch team</button>
    </div>
  ));
  unmounts.push(() => { act(() => root.unmount()); container.remove(); });
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  const button = dialog.querySelector<HTMLButtonElement>('button[aria-controls]')!;
  Object.defineProperty(dialog, 'getAnimations', { value: () => [] });
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ x: 1, y: 1, width: 200, height: 40 } as DOMRect);
  const observations: string[] = [];
  const evaluate = (expression: string): unknown => Function('document', `return (${expression});`)(document);
  const open = makeObservation({
    assert, literal: JSON.stringify, installer: false,
    record: (value: unknown) => { assert.ok(value && typeof value === 'object'); return value; },
    cdp: { evaluate }, fill: vi.fn(async () => undefined),
    ui: {
      async click(selector: string, label: string) {
        observations.push(label);
        if (label === 'open original saved Team Launch') return;
        expect(label).toBe('expand original saved launch settings');
        expect(document.querySelector(selector)).toBe(button);
        act(() => button.click());
        if (options.duplicateOnExpand) dialog.appendChild(button.cloneNode(true));
      },
      async scrollTo() {},
      async waitRead(expression: string, label: string, _timeout?: number, accept: (value: unknown) => boolean = Boolean) {
        for (let sample = 0; sample < 3; sample++) {
          const value = evaluate(expression);
          if (accept(value)) { observations.push(label); return value; }
        }
        throw new Error(label);
      },
    },
  });
  return { button, observations, run: () => open({ projectDefinition: true, model: 'TEST-model-next',
    effort: 'high', owner: async () => ({ runtimeCaptures: [] }) }) };
}

describe('native selection observes the original project Launch component', () => {
  it('checks the exact compact provider/model/effort chips before expansion and then the read-only roster', async () => {
    const current = fixture();
    expect([...current.button.querySelectorAll('span.truncate.rounded-md')].map(chip => chip.textContent))
      .toEqual(['Codex', 'TEST-model-next', 'high']);
    await current.run();
    expect(current.button.getAttribute('aria-expanded')).toBe('true');
    expect(current.button.querySelectorAll('span.truncate.rounded-md')).toHaveLength(0);
    expect(current.observations).toEqual([
      'open original saved Team Launch', 'saved model hydrates original Launch',
      'authored model and effort hydrate the original collapsed project Launch summary',
      'expand original saved launch settings', 'original project Launch keeps its shared roster read-only',
      'original selected model preflight',
    ]);
  });

  it.each([{ provider: 'OpenCode' }, { effort: 'low' }])('refuses a different authored choice before expanding: %j', async choice => {
    const current = fixture(choice);
    await expect(current.run()).rejects.toThrow('original collapsed project Launch summary');
    expect(current.button.getAttribute('aria-expanded')).toBe('false');
    expect(current.observations).not.toContain('expand original saved launch settings');
  });

  it.each([{ editable: true }, { duplicateOnExpand: true }])('refuses an editable roster or ambiguous original trigger after expansion: %j', async defect => {
    const current = fixture(defect);
    await expect(current.run()).rejects.toThrow('original project Launch keeps its shared roster read-only');
    expect(current.observations).not.toContain('original selected model preflight');
  });
});
