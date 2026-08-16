/* eslint-disable @typescript-eslint/naming-convention -- Component mock mirrors a PascalCase export. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  getTaskAttachmentData: vi.fn(),
}));

const lightboxMock = vi.hoisted(() => ({
  props: [] as Array<{
    slides: Array<{ src: string; alt: string }>;
    index: number;
  }>,
}));

vi.mock('@renderer/store', () => ({
  useStore: (
    selector: (state: { getTaskAttachmentData: typeof storeMock.getTaskAttachmentData }) => unknown
  ) => selector({ getTaskAttachmentData: storeMock.getTaskAttachmentData }),
}));

vi.mock('@renderer/components/team/attachments/ImageLightbox', () => ({
  ImageLightbox: (props: { slides: Array<{ src: string; alt: string }>; index: number }) => {
    lightboxMock.props.push(props);
    return React.createElement('div', {
      'data-testid': 'image-lightbox',
      'data-slide-count': props.slides.length,
      'data-slide-index': props.index,
    });
  },
}));

/* eslint-enable @typescript-eslint/naming-convention -- Re-enable after component mocks. */

import { estimateKanbanImageMosaicHeight } from './kanbanTaskAttachmentLayout';
import { KanbanTaskAttachmentMosaic } from './KanbanTaskAttachmentMosaic';

import type { TaskAttachmentMeta } from '@shared/types';

const roots: Array<ReturnType<typeof createRoot>> = [];

function attachment(index: number, mimeType = 'image/png'): TaskAttachmentMeta {
  return {
    id: `attachment-${index}`,
    filename: `screenshot-${index}.png`,
    mimeType,
    size: 1024,
    addedAt: '2026-08-16T12:00:00.000Z',
  };
}

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderMosaic(attachments: TaskAttachmentMeta[]): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);

  await act(async () => {
    root.render(
      <KanbanTaskAttachmentMosaic
        teamName="sandbox-team"
        task={{ id: 'task-with-images', attachments }}
      />
    );
    await flushReact();
  });

  return host;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  storeMock.getTaskAttachmentData.mockReset();
  lightboxMock.props.length = 0;
  vi.unstubAllGlobals();
});

describe('KanbanTaskAttachmentMosaic', () => {
  it.each([
    { count: 0, height: 0 },
    { count: 1, height: 104 },
    { count: 2, height: 96 },
    { count: 3, height: 104 },
    { count: 5, height: 140 },
  ])('estimates $height px of skeleton space for $count images', ({ count, height }) => {
    const attachments = Array.from({ length: count }, (_, index) => attachment(index + 1));
    expect(estimateKanbanImageMosaicHeight(attachments)).toBe(height);
  });

  it.each([
    { count: 1, layout: 'single', visible: 1 },
    { count: 2, layout: 'pair', visible: 2 },
    { count: 3, layout: 'trio', visible: 3 },
    { count: 5, layout: 'grid', visible: 4 },
  ])('renders the $layout layout for $count images', async ({ count, layout, visible }) => {
    storeMock.getTaskAttachmentData.mockImplementation(
      async (_teamName, _taskId, attachmentId) => `base64-${attachmentId}`
    );

    const host = await renderMosaic(
      Array.from({ length: count }, (_, index) => attachment(index + 1))
    );
    const mosaic = host.querySelector('[data-kanban-image-mosaic]');

    expect(mosaic?.getAttribute('data-image-count')).toBe(String(count));
    expect(mosaic?.getAttribute('data-mosaic-layout')).toBe(layout);
    expect(host.querySelectorAll('[data-mosaic-tile-index]')).toHaveLength(visible);
    expect(host.querySelectorAll('img')).toHaveLength(visible);
  });

  it('uses the fourth tile as a +N entry for more than four images', async () => {
    storeMock.getTaskAttachmentData.mockImplementation(
      async (_teamName, _taskId, attachmentId) => `base64-${attachmentId}`
    );
    const host = await renderMosaic(Array.from({ length: 5 }, (_, index) => attachment(index + 1)));

    const overflowTile = host.querySelector('[data-mosaic-tile-index="3"]');
    expect(overflowTile?.getAttribute('data-mosaic-overflow')).toBe('2');
    expect(overflowTile?.textContent).toContain('+2');
    expect(storeMock.getTaskAttachmentData).toHaveBeenCalledTimes(4);
  });

  it('loads hidden images lazily and opens the full gallery from the clicked tile', async () => {
    storeMock.getTaskAttachmentData.mockImplementation(
      async (_teamName, _taskId, attachmentId) => `base64-${attachmentId}`
    );
    const host = await renderMosaic(Array.from({ length: 5 }, (_, index) => attachment(index + 1)));
    const overflowTile = host.querySelector<HTMLButtonElement>('[data-mosaic-tile-index="3"]');
    expect(overflowTile).not.toBeNull();

    await act(async () => {
      overflowTile?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushReact();
    });

    expect(storeMock.getTaskAttachmentData).toHaveBeenCalledTimes(5);
    expect(lightboxMock.props.at(-1)).toMatchObject({ index: 3 });
    expect(lightboxMock.props.at(-1)?.slides).toHaveLength(5);
    expect(host.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
  });

  it('ignores non-image task attachments', async () => {
    storeMock.getTaskAttachmentData.mockResolvedValue('unused');
    const host = await renderMosaic([attachment(1, 'application/pdf')]);

    expect(host.querySelector('[data-kanban-image-mosaic]')).toBeNull();
    expect(storeMock.getTaskAttachmentData).not.toHaveBeenCalled();
  });
});
