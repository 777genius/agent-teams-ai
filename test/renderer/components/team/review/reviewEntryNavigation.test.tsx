import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { acceptChunk } from '@codemirror/merge';
import {
  canMutateReviewHunk,
  getReviewDiskPath,
  getReviewNavigationFiles,
} from '@renderer/components/team/review/reviewEntryNavigation';
import { useDiffNavigation } from '@renderer/hooks/useDiffNavigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary } from '@shared/types/review';

vi.mock('@codemirror/merge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@codemirror/merge')>()),
  acceptChunk: vi.fn(),
}));
vi.mock('@renderer/components/team/review/CodeMirrorDiffUtils', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@renderer/components/team/review/CodeMirrorDiffUtils')
  >()),
  computeChunkIndexAtPos: vi.fn(() => 0),
}));

const diskPath = '/sandbox/review/new.ts';
const files: FileChangeSummary[] = [
  {
    filePath: diskPath,
    relativePath: 'new.ts',
    changeKey: 'rename:/sandbox/review/old.ts->/sandbox/review/new.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  },
  {
    filePath: diskPath,
    relativePath: 'new.ts',
    changeKey: 'path:/sandbox/review/new.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  },
];

describe('duplicate review keyboard navigation', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(acceptChunk).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('rejects Cmd/Ctrl+Y for either ambiguous entry before changing the editor or decision', () => {
    const decisions = vi.fn();
    const view = {
      hasFocus: true,
      state: { selection: { main: { head: 0 } } },
    } as EditorView;
    const editorViewMapRef = { current: new Map([[files[0].changeKey!, view]]) };
    const onHunkAccepted = vi.fn((entryKey: string, index: number) => {
      if (!canMutateReviewHunk(files, entryKey)) return false;
      decisions(entryKey, index);
      return true;
    });

    function Harness(): null {
      useDiffNavigation(
        getReviewNavigationFiles(files),
        files[0].changeKey!,
        vi.fn(),
        { current: view },
        true,
        onHunkAccepted,
        undefined,
        undefined,
        undefined,
        {
          editorViewMapRef,
          activeFilePath: files[0].changeKey!,
          scrollToFile: vi.fn(),
          enabled: true,
        }
      );
      return null;
    }

    act(() => root.render(<Harness />));
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', ctrlKey: true }))
    );

    expect(onHunkAccepted).toHaveBeenCalledWith(files[0].changeKey, 0);
    expect(decisions).not.toHaveBeenCalled();
    expect(acceptChunk).not.toHaveBeenCalled();
    expect(canMutateReviewHunk(files, diskPath)).toBe(false);
    expect(canMutateReviewHunk([files[0]], diskPath)).toBe(true);
  });

  it('saves the active entry through its disk path and scrolls to distinct section keys', () => {
    const navigationFiles = getReviewNavigationFiles(files);
    const scrollToFile = vi.fn();
    const saveFile = vi.fn();
    const editorViewMapRef = { current: new Map<string, EditorView>() };
    let navigation!: ReturnType<typeof useDiffNavigation>;

    function Harness({ activeEntryKey }: { activeEntryKey: string }): null {
      navigation = useDiffNavigation(
        navigationFiles,
        activeEntryKey,
        scrollToFile,
        { current: null },
        true,
        undefined,
        undefined,
        undefined,
        () => {
          const path = getReviewDiskPath(files, activeEntryKey);
          if (path) saveFile(path);
        },
        { editorViewMapRef, activeFilePath: activeEntryKey, scrollToFile, enabled: true }
      );
      return null;
    }

    act(() => root.render(<Harness activeEntryKey={files[0].changeKey!} />));
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', ctrlKey: true }))
    );
    expect(saveFile).toHaveBeenCalledWith(diskPath);

    act(() => navigation.goToNextFile());
    expect(scrollToFile).toHaveBeenLastCalledWith(files[1].changeKey);
    act(() => root.render(<Harness activeEntryKey={files[1].changeKey!} />));
    act(() => navigation.goToPrevFile());
    expect(scrollToFile).toHaveBeenLastCalledWith(files[0].changeKey);
    expect(navigationFiles.map((file) => file.filePath)).toEqual(
      files.map((file) => file.changeKey)
    );
  });
});
