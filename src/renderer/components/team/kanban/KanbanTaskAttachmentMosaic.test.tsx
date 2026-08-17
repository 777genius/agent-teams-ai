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

import {
  buildKanbanAttachmentPresentation,
  estimateKanbanAttachmentPreviewHeight,
} from './kanbanTaskAttachmentLayout';
import { KanbanTaskAttachmentMosaic } from './KanbanTaskAttachmentMosaic';

import type { TaskAttachmentMeta, TeamTaskWithKanban } from '@shared/types';

const roots: Array<ReturnType<typeof createRoot>> = [];
type MosaicTask = Pick<
  TeamTaskWithKanban,
  'id' | 'attachments' | 'comments' | 'sourceMessage' | 'sourceMessageId'
>;

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

async function renderMosaic(task: Omit<MosaicTask, 'id'>): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);

  await act(async () => {
    root.render(
      <KanbanTaskAttachmentMosaic
        teamName="sandbox-team"
        task={{ id: 'task-with-images', ...task }}
      />
    );
    await flushReact();
  });

  return host;
}

async function rerenderMosaic(task: Omit<MosaicTask, 'id'>): Promise<void> {
  const root = roots.at(-1);
  if (!root) throw new Error('Mosaic root is not mounted');
  await act(async () => {
    root.render(
      <KanbanTaskAttachmentMosaic
        teamName="sandbox-team"
        task={{ id: 'task-with-images', ...task }}
      />
    );
    await flushReact();
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'electronAPI');
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
    expect(estimateKanbanAttachmentPreviewHeight({ attachments })).toBe(height);
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

    const host = await renderMosaic({
      attachments: Array.from({ length: count }, (_, index) => attachment(index + 1)),
    });
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
    const host = await renderMosaic({
      attachments: Array.from({ length: 5 }, (_, index) => attachment(index + 1)),
    });

    const overflowTile = host.querySelector('[data-mosaic-tile-index="3"]');
    expect(overflowTile?.getAttribute('data-mosaic-overflow')).toBe('2');
    expect(overflowTile?.textContent).toContain('+2');
    expect(storeMock.getTaskAttachmentData).toHaveBeenCalledTimes(4);
  });

  it('loads hidden images lazily and opens the full gallery from the clicked tile', async () => {
    storeMock.getTaskAttachmentData.mockImplementation(
      async (_teamName, _taskId, attachmentId) => `base64-${attachmentId}`
    );
    const host = await renderMosaic({
      attachments: Array.from({ length: 5 }, (_, index) => attachment(index + 1)),
    });
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

  it('adds source-message images after task images and deduplicates matching metadata', async () => {
    const directImage = attachment(1);
    storeMock.getTaskAttachmentData.mockResolvedValue('direct-base64');
    const getAttachments = vi.fn().mockResolvedValue([
      { id: 'source-duplicate', mimeType: 'image/png', data: 'duplicate-base64' },
      { id: 'source-unique-1', mimeType: 'image/jpeg', data: 'source-base64-1' },
      { id: 'source-unique-2', mimeType: 'image/webp', data: 'source-base64-2' },
    ]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { teams: { getAttachments } },
    });

    const host = await renderMosaic({
      attachments: [directImage],
      sourceMessageId: 'source-message-1',
      sourceMessage: {
        text: 'Build this task from the screenshots',
        from: 'user',
        timestamp: '2026-08-16T12:00:00.000Z',
        attachments: [
          {
            id: 'source-duplicate',
            filename: directImage.filename,
            mimeType: directImage.mimeType,
            size: directImage.size,
          },
          {
            id: 'source-unique-1',
            filename: 'source-unique-1.jpg',
            mimeType: 'image/jpeg',
            size: 2048,
          },
          {
            id: 'source-unique-2',
            filename: 'source-unique-2.webp',
            mimeType: 'image/webp',
            size: 4096,
          },
        ],
      },
    });

    expect(host.querySelector('[data-kanban-image-mosaic]')?.getAttribute('data-image-count')).toBe(
      '3'
    );
    expect(host.querySelectorAll('[data-attachment-source="task"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-attachment-source="source-message"]')).toHaveLength(2);
    expect(host.querySelectorAll('img')).toHaveLength(3);
    expect(storeMock.getTaskAttachmentData).toHaveBeenCalledTimes(1);
    expect(getAttachments).toHaveBeenCalledTimes(1);
    expect(getAttachments).toHaveBeenCalledWith('sandbox-team', 'source-message-1');
  });

  it('preserves matching metadata within the same attachment source', () => {
    const first = attachment(1);
    const taskPresentation = buildKanbanAttachmentPresentation({
      attachments: [first, { ...first, id: 'task-copy' }],
    });
    const sourcePresentation = buildKanbanAttachmentPresentation({
      sourceMessageId: 'source-message-1',
      sourceMessage: {
        text: 'Two distinct files with matching metadata',
        from: 'user',
        timestamp: '2026-08-16T12:00:00.000Z',
        attachments: [
          {
            id: 'source-1',
            filename: first.filename,
            mimeType: first.mimeType,
            size: first.size,
          },
          {
            id: 'source-2',
            filename: first.filename,
            mimeType: first.mimeType,
            size: first.size,
          },
        ],
      },
    });

    expect(taskPresentation.images).toHaveLength(2);
    expect(sourcePresentation.images).toHaveLength(2);
  });

  it('reloads a preview when attachment metadata changes under the same id', async () => {
    storeMock.getTaskAttachmentData
      .mockResolvedValueOnce('initial-base64')
      .mockResolvedValueOnce('updated-base64');
    const initial = attachment(1);
    const host = await renderMosaic({ attachments: [initial] });
    expect(host.querySelector('img')?.getAttribute('src')).toContain('initial-base64');

    await rerenderMosaic({
      attachments: [{ ...initial, filename: 'updated.png', size: initial.size + 1 }],
    });

    expect(storeMock.getTaskAttachmentData).toHaveBeenCalledTimes(2);
    expect(host.querySelector('img')?.getAttribute('src')).toContain('updated-base64');
  });

  it('shows a comment-image indicator without mixing comment images into the mosaic', async () => {
    storeMock.getTaskAttachmentData.mockResolvedValue('direct-base64');
    const host = await renderMosaic({
      attachments: [attachment(1)],
      comments: [
        {
          id: 'comment-1',
          author: 'alice',
          text: 'Two visual references',
          createdAt: '2026-08-16T12:00:00.000Z',
          type: 'regular',
          attachments: [attachment(2), attachment(3, 'application/pdf')],
        },
        {
          id: 'comment-2',
          author: 'bob',
          text: 'One more image',
          createdAt: '2026-08-16T12:01:00.000Z',
          type: 'regular',
          attachments: [attachment(4, 'image/webp')],
        },
      ],
    });

    expect(host.querySelector('[data-kanban-image-mosaic]')?.getAttribute('data-image-count')).toBe(
      '1'
    );
    const indicator = host.querySelector('[data-kanban-comment-image-count="2"]');
    expect(indicator?.textContent).toContain('2 images');
    expect(storeMock.getTaskAttachmentData).toHaveBeenCalledTimes(1);
  });

  it('reserves skeleton space for source images and the comment-image indicator', () => {
    const directImage = attachment(1);
    expect(
      estimateKanbanAttachmentPreviewHeight({
        attachments: [directImage],
        sourceMessageId: 'source-message-1',
        sourceMessage: {
          text: 'Task source',
          from: 'user',
          timestamp: '2026-08-16T12:00:00.000Z',
          attachments: [
            {
              id: 'duplicate',
              filename: directImage.filename,
              mimeType: directImage.mimeType,
              size: directImage.size,
            },
            {
              id: 'source-unique',
              filename: 'source.jpg',
              mimeType: 'image/jpeg',
              size: 2048,
            },
          ],
        },
        comments: [
          {
            id: 'comment-1',
            author: 'alice',
            text: 'Visual note',
            createdAt: '2026-08-16T12:02:00.000Z',
            type: 'regular',
            attachments: [attachment(2)],
          },
        ],
      })
    ).toBe(118);
  });

  it('ignores non-image task attachments', async () => {
    storeMock.getTaskAttachmentData.mockResolvedValue('unused');
    const host = await renderMosaic({ attachments: [attachment(1, 'application/pdf')] });

    expect(host.querySelector('[data-kanban-image-mosaic]')).toBeNull();
    expect(storeMock.getTaskAttachmentData).not.toHaveBeenCalled();
  });
});
