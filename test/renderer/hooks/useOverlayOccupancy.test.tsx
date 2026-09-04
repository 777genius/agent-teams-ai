import { act,StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ConflictDialog } from '@renderer/components/team/review/ConflictDialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import {
  getOverlaySnapshot,
  useOverlayOccupancy,
  useOverlaySnapshot,
} from '@renderer/hooks/useOverlayOccupancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

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
  expect(getOverlaySnapshot().count).toBe(0);
});

function Blocker({ active }: { active: boolean }): null {
  useOverlayOccupancy(active);
  return null;
}
function Observer(): React.JSX.Element {
  const { count } = useOverlaySnapshot();
  return <output>{count}</output>;
}

function Modal({ open, blocks = true }: { open: boolean; blocks?: boolean }): React.JSX.Element {
  return (
    <Dialog open={open}>
      <DialogContent blocksAnnouncements={blocks} aria-describedby={undefined}>
        <DialogTitle>Test overlay</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

describe('overlay occupancy', () => {
  it('counts concurrent lifetimes, not rerenders, and balances StrictMode cleanup', async () => {
    const render = async (second: boolean): Promise<void> => {
      await act(async () =>
        root.render(
          <StrictMode>
            <Blocker active />
            <Blocker active={second} />
            <Observer />
          </StrictMode>
        )
      );
    };
    await render(true);
    expect(container.textContent).toBe('2');
    const occupied = getOverlaySnapshot();
    await render(true);
    expect(getOverlaySnapshot()).toBe(occupied);
    await render(false);
    expect(container.textContent).toBe('1');
    expect(getOverlaySnapshot().generation).toBeGreaterThan(occupied.generation);
  });

  it('does not count mounted closed Radix wrappers and honors announcement optout', async () => {
    await act(async () => root.render(<Modal open={false} />));
    expect(getOverlaySnapshot().count).toBe(0);
    await act(async () => root.render(<Modal open />));
    expect(getOverlaySnapshot().count).toBe(1);
    await act(async () => root.render(<Modal open blocks={false} />));
    expect(getOverlaySnapshot().count).toBe(0);
    await act(async () => root.render(<Modal open={false} />));
    expect(getOverlaySnapshot().count).toBe(0);
  });
  it('counts force-mounted closed content until it is actually removed', async () => {
    await act(async () =>
      root.render(
        <Dialog open={false}>
          <DialogContent forceMount aria-describedby={undefined}>
            <DialogTitle>Forced</DialogTitle>
          </DialogContent>
        </Dialog>
      )
    );
    expect(getOverlaySnapshot().count).toBe(1);
    await act(async () => root.render(<Modal open={false} />));
    expect(getOverlaySnapshot().count).toBe(0);
  });

  it('tracks alert dialog content and releases it on close', async () => {
    const render = async (open: boolean): Promise<void> => {
      await act(async () =>
        root.render(
          <AlertDialog open={open}>
            <AlertDialogContent>
              <AlertDialogTitle>Alert</AlertDialogTitle>
              <AlertDialogDescription>Confirm this test.</AlertDialogDescription>
            </AlertDialogContent>
          </AlertDialog>
        )
      );
    };
    await render(false);
    expect(getOverlaySnapshot().count).toBe(0);
    await render(true);
    expect(getOverlaySnapshot().count).toBe(1);
    await render(false);
    expect(getOverlaySnapshot().count).toBe(0);
  });

  it('tracks a raw conflict blocker that does not use the shared dialog primitive', async () => {
    const render = async (open: boolean): Promise<void> => {
      await act(async () =>
        root.render(
          <>
            <ConflictDialog
              open={open}
              onOpenChange={vi.fn()}
              filePath="src/example.ts"
              conflictContent="<<<<<<< current\n=======\n>>>>>>> original"
              onResolveKeepCurrent={vi.fn()}
              onResolveUseOriginal={vi.fn()}
              onResolveManual={vi.fn()}
            />
            <Observer />
          </>
        )
      );
    };
    await render(false);
    expect(container.textContent).toBe('0');
    await render(true);
    expect(getOverlaySnapshot().count).toBe(1);
    await render(false);
    expect(container.textContent).toBe('0');
  });
});
