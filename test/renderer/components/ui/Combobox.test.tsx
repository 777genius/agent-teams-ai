import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { Combobox, type ComboboxOption } from '@renderer/components/ui/combobox';

const PROJECT_CHOICE_ID = '/workspace/fixtures/test-project';
const PROJECT_RESET_CHOICE_ID = '__reset__';

const projectOptions: ComboboxOption[] = [
  {
    value: PROJECT_CHOICE_ID,
    label: 'TEST-project',
    description: PROJECT_CHOICE_ID,
  },
];

describe('Combobox', () => {
  it('binds its trigger to the popup listbox and selects options by cmdk value', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    try {
      flushSync(() => {
        root.render(
          <Combobox
            options={projectOptions}
            value=""
            onValueChange={onValueChange}
            placeholder="All Projects"
            searchPlaceholder="Search projects..."
          />
        );
      });

      const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]');
      expect(trigger).not.toBeNull();
      flushSync(() => trigger!.click());

      const popup = document.getElementById(trigger!.getAttribute('aria-controls') ?? '');
      expect(popup).not.toBeNull();

      const listbox = popup?.querySelector<HTMLElement>('[cmdk-list][role="listbox"]');
      expect(listbox).not.toBeNull();

      const option = Array.from(
        listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
      ).find((candidate) => candidate.getAttribute('data-value') === PROJECT_CHOICE_ID);
      expect(option).toBeDefined();
      expect(option?.textContent).toContain('TEST-project');
      expect(option?.textContent).toContain(PROJECT_CHOICE_ID);

      flushSync(() => option!.click());
      expect(onValueChange).toHaveBeenCalledWith(PROJECT_CHOICE_ID);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });

  it('uses the Combobox reset choice for the project reset action', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onReset = vi.fn();

    try {
      flushSync(() => {
        root.render(
          <Combobox
            options={projectOptions}
            value={PROJECT_CHOICE_ID}
            onValueChange={vi.fn()}
            resetLabel="All Projects"
            onReset={onReset}
          />
        );
      });

      const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]');
      flushSync(() => trigger!.click());

      const popup = document.getElementById(trigger!.getAttribute('aria-controls') ?? '');
      const resetOption = Array.from(
        popup?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
      ).find(
        (candidate) => candidate.getAttribute('data-value') === PROJECT_RESET_CHOICE_ID
      );
      expect(resetOption).toBeDefined();
      expect(resetOption?.textContent).toContain('All Projects');

      flushSync(() => resetOption!.click());
      expect(onReset).toHaveBeenCalledOnce();
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });
});
