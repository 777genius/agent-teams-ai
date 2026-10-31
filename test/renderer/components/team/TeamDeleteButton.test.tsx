import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

import { TeamDeleteButton } from '@renderer/components/team/TeamDeleteButton';
import { runTeamDeleteOnce } from '@renderer/components/team/teamDeleteProgress';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function deleteButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
}

describe('TeamDeleteButton', () => {
  it('is disabled and shows that the team is being stopped while the trash request runs', async () => {
    const onClick = vi.fn();
    await act(async () =>
      root.render(
        <>
          <TeamDeleteButton
            teamName="demo-team"
            placement="card"
            label="list.actions.deleteTeam"
            onClick={onClick}
          />
          <TeamDeleteButton
            teamName="demo-team"
            placement="header"
            label="list.moveToTrash.title"
            onClick={onClick}
          />
          <TeamDeleteButton
            teamName="other-team"
            placement="card"
            label="list.actions.deleteTeam"
            onClick={onClick}
          />
        </>
      )
    );
    const [card, header, other] = deleteButtons();
    expect(card.disabled).toBe(false);
    expect(card.getAttribute('aria-label')).toBe('list.actions.deleteTeam');

    let finishDelete!: () => void;
    const deleteTeam = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        })
    );
    let request!: Promise<boolean>;
    await act(async () => {
      request = runTeamDeleteOnce('demo-team', deleteTeam);
      await Promise.resolve();
    });

    for (const button of [card, header]) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.getAttribute('aria-label')).toBe('list.actions.stopping');
      expect(button.textContent).toBe('list.actions.stopping');
    }
    expect(other.disabled).toBe(false);
    expect(other.getAttribute('aria-label')).toBe('list.actions.deleteTeam');

    // A second request for the same team does not reach the store again.
    const repeatedDelete = vi.fn(async () => undefined);
    await expect(runTeamDeleteOnce('demo-team', repeatedDelete)).resolves.toBe(false);
    expect(repeatedDelete).not.toHaveBeenCalled();
    await act(async () => card.click());
    expect(onClick).not.toHaveBeenCalled();

    await act(async () => {
      finishDelete();
      await request;
    });
    await expect(request).resolves.toBe(true);
    expect(card.disabled).toBe(false);
    expect(card.getAttribute('aria-label')).toBe('list.actions.deleteTeam');
    expect(header.getAttribute('aria-label')).toBe('list.moveToTrash.title');
    expect(deleteTeam).toHaveBeenCalledTimes(1);
  });

  it('becomes available again after a failed request so the user can retry', async () => {
    await act(async () =>
      root.render(
        <TeamDeleteButton
          teamName="demo-team"
          placement="header"
          label="list.moveToTrash.title"
          onClick={vi.fn()}
        />
      )
    );
    const [header] = deleteButtons();

    await act(async () => {
      await expect(
        runTeamDeleteOnce('demo-team', () => Promise.reject(new Error('Team is busy')))
      ).rejects.toThrow('Team is busy');
    });

    expect(header.disabled).toBe(false);
    expect(header.getAttribute('aria-busy')).toBe('false');
    const retry = vi.fn(async () => undefined);
    await act(async () => {
      await expect(runTeamDeleteOnce('demo-team', retry)).resolves.toBe(true);
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
